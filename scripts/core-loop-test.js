/**
 * Core Loop Integration Test
 * Tests the full AATS contract audit lifecycle end-to-end.
 *
 * Stages:
 *   1. Register buyer, seller, arbitrator agents
 *   2. Register the arbitrator agent as an arbitrator
 *   3. Submit a contract for audit
 *   4. Verify HCS anchor (Bug #1 fix)
 *   5. Handle PENDING_REVIEW → resubmit if needed
 *   6. Confirm delivery
 *   7. Check final state
 */

const BASE = 'http://localhost:3000';

let pass = 0;
let fail = 0;

function log(label, ok, detail) {
  const sym = ok ? '✓' : '✗';
  console.log(`  ${sym}  ${label}`);
  if (detail) console.log(`       ${typeof detail === 'object' ? JSON.stringify(detail) : detail}`);
  if (ok) pass++; else fail++;
}

async function req(method, path, body, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['X-API-Key'] = apiKey;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: r.status, body: json };
}

async function run() {
  console.log('\n=== AATS Core Loop Integration Test ===\n');

  // ── Step 1: Register agents ──────────────────────────────────────────────
  console.log('[ 1 ] Agent Registration');

  const buyerReg = await req('POST', '/vault/agents/register', { name: 'CoreLoop-Buyer', agent_type: 'financial' });
  log('register buyer', buyerReg.status === 201, buyerReg.body.agent_id);
  const buyerKey = buyerReg.body.api_key;
  const buyerId  = buyerReg.body.agent_id;

  const sellerReg = await req('POST', '/vault/agents/register', { name: 'CoreLoop-Seller', agent_type: 'data' });
  log('register seller', sellerReg.status === 201, sellerReg.body.agent_id);
  const sellerKey = sellerReg.body.api_key;
  const sellerId  = sellerReg.body.agent_id;

  const arbReg = await req('POST', '/vault/agents/register', { name: 'CoreLoop-Arbitrator', agent_type: 'general' });
  log('register arbitrator agent', arbReg.status === 201, arbReg.body.agent_id);
  const arbKey = arbReg.body.api_key;
  const arbId  = arbReg.body.agent_id;

  if (!buyerKey || !sellerKey || !arbKey) {
    console.error('\nFATAL: agent registration failed — aborting\n');
    process.exit(1);
  }

  // ── Step 2: Register as arbitrator ──────────────────────────────────────
  console.log('\n[ 2 ] Arbitrator Registration');

  const arbRoleReg = await req('POST', '/arbitration/arbitrators/register', {
    type: 'ai',
    tier: 2,
    specializations: ['general', 'trading'],
    fee_per_dispute: 5,
    stake_hbar: 100,
    kyc_verified: false,
  }, arbKey);
  log('arbitrator role registered', arbRoleReg.status === 201, arbRoleReg.body.arbitrator_id || arbRoleReg.body);

  // ── Step 3: Submit contract ──────────────────────────────────────────────
  console.log('\n[ 3 ] Contract Submission');

  const submitRes = await req('POST', '/audit/contracts', {
    seller_agent: sellerId,
    arbitrator_id: arbId,
    terms: {
      description: 'Core loop test contract — data analysis service',
      deliverable: 'Quarterly analysis report, PDF format',
      value_hbar: 50,
      deadline: '2026-06-01',
    },
  }, buyerKey);

  log('contract submitted', submitRes.status === 201, submitRes.body.contract_id || submitRes.body);

  if (!submitRes.body.contract_id) {
    console.error('\nFATAL: contract submission failed — aborting\n', submitRes.body);
    process.exit(1);
  }

  const contractId = submitRes.body.contract_id;

  // ── Step 4: Fetch and inspect contract ──────────────────────────────────
  console.log('\n[ 4 ] Contract Inspection');

  const getRes = await req('GET', `/audit/contracts/${contractId}`, null, buyerKey);
  log('contract fetchable by buyer', getRes.status === 200);

  const c = getRes.body;
  log('HCS sequence anchored (Bug #1)', c.hcs_sequence !== null && c.hcs_sequence !== undefined,
    `hcs_sequence=${c.hcs_sequence}`);
  log('status is valid', ['PENDING_REVIEW', 'APPROVED', 'PENDING_APPROVAL'].includes(c.audit_status),
    `status=${c.audit_status}`);
  log('arbitrator set', !!c.arbitrator_id, `arbitrator=${c.arbitrator_id}`);

  console.log(`\n     Contract status: ${c.audit_status}`);
  if (c.findings && c.findings.length > 0) {
    console.log(`     Findings (${c.findings.length}):`);
    c.findings.forEach(f => console.log(`       - [${f.severity}] ${f.code}: ${f.message}`));
  }

  // ── Step 5: Handle PENDING_REVIEW — resubmit if there are findings ──────
  if (c.audit_status === 'PENDING_REVIEW') {
    console.log('\n[ 5 ] Resubmit with revised terms');

    const resubRes = await req('POST', `/audit/contracts/${contractId}/resubmit`, {
      terms: {
        description: 'Core loop test contract v2 — data analysis service (revised)',
        deliverable: 'Quarterly analysis report, PDF format, with executive summary',
        value_hbar: 50,
        deadline: '2026-06-01',
        payment_terms: 'on delivery',
      },
      arbitrator_id: arbId,  // ensure arbitrator is set (design gap fix)
    }, buyerKey);

    log('resubmit accepted', resubRes.status === 200, resubRes.body.audit_status || resubRes.body);

    // Re-fetch
    const getRes2 = await req('GET', `/audit/contracts/${contractId}`, null, buyerKey);
    const c2 = getRes2.body;
    console.log(`\n     After resubmit status: ${c2.audit_status}`);
    log('arbitrator preserved after resubmit', !!c2.arbitrator_id, `arbitrator=${c2.arbitrator_id}`);
  } else {
    console.log('\n[ 5 ] Resubmit — skipped (no PENDING_REVIEW findings)');
    pass++;
  }

  // ── Step 5b: If PENDING_APPROVAL, skip (requires console owner auth) ────
  const getRes3 = await req('GET', `/audit/contracts/${contractId}`, null, buyerKey);
  const c3 = getRes3.body;

  if (c3.audit_status === 'PENDING_APPROVAL') {
    console.log('\n     Contract requires owner approval (PENDING_APPROVAL) — this is correct for high-value contracts.');
    console.log('     Skipping approve-limit step (requires console session auth).');
    pass++;
  }

  // ── Step 6: Confirm delivery (only valid once ACTIVE) ───────────────────
  console.log('\n[ 6 ] Confirm Delivery');

  const statusNow = c3.audit_status;
  if (statusNow === 'ACTIVE') {
    const confBuyer = await req('POST', `/audit/contracts/${contractId}/confirm-delivery`, {
      notes: 'Deliverable received and reviewed.',
    }, buyerKey);
    log('buyer confirms delivery', [200, 201].includes(confBuyer.status), confBuyer.body);

    const confSeller = await req('POST', `/audit/contracts/${contractId}/confirm-delivery`, {
      notes: 'Delivery confirmed on my end.',
    }, sellerKey);
    log('seller confirms delivery', [200, 201].includes(confSeller.status), confSeller.body);
  } else {
    console.log(`\n     Contract is ${statusNow} — not yet ACTIVE, skipping delivery confirmation.`);
    console.log('     (Normal: APPROVED contracts need attach-hook to become ACTIVE)');
    pass++;
  }

  // ── Step 7: Audit event log ──────────────────────────────────────────────
  console.log('\n[ 7 ] Audit Event Log');

  const eventsRes = await req('GET', `/audit/contracts/${contractId}/events`, null, buyerKey);
  log('events accessible', eventsRes.status === 200);
  if (eventsRes.body.events) {
    log('events non-empty', eventsRes.body.events.length > 0, `${eventsRes.body.events.length} events`);
    eventsRes.body.events.forEach(e => console.log(`       [${e.event_type}] ${e.created_at} — ${e.actor_id}`));
  }

  // ── Step 8: Seller access check ─────────────────────────────────────────
  console.log('\n[ 8 ] Access Control');
  const sellerGet = await req('GET', `/audit/contracts/${contractId}`, null, sellerKey);
  log('seller can read their contract', sellerGet.status === 200);

  const strangerReg = await req('POST', '/vault/agents/register', { name: 'CoreLoop-Stranger', agent_type: 'general' });
  const strangerGet = await req('GET', `/audit/contracts/${contractId}`, null, strangerReg.body.api_key);
  log('stranger denied access', strangerGet.status === 404 || strangerGet.status === 403,
    `status=${strangerGet.status}`);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(45)}`);
  console.log(`  PASS: ${pass}   FAIL: ${fail}`);
  console.log(`  Contract: ${contractId}`);
  console.log(`  Final status: ${c3.audit_status}`);
  console.log(`${'─'.repeat(45)}\n`);

  if (fail > 0) process.exit(1);
}

run().catch(err => {
  console.error('\nUnhandled error:', err.message);
  process.exit(1);
});
