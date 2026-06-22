'use strict';

// demo-dual-attestation.js — end-to-end dual attestation demo
// Requires broker running on BROKER_PORT (default 4000).
// Run: node scripts/demo-dual-attestation.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const http = require('http');

const BASE = `http://localhost:${process.env.BROKER_PORT || 4000}`;

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const opts = {
      hostname: 'localhost',
      port:     process.env.BROKER_PORT || 4000,
      path,
      method:   'POST',
      headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    };
    const req = http.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function get(path) {
  return new Promise((resolve, reject) => {
    http.get(`${BASE}${path}`, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    }).on('error', reject);
  });
}

function log(label, obj) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${label}`);
  console.log('─'.repeat(60));
  console.log(JSON.stringify(obj, null, 2));
}

async function main() {
  console.log('\n=== Dual Attestation Demo ===\n');

  // ── 1. Health check ────────────────────────────────────────────────────────
  try {
    const health = await get('/health');
    if (!health.body.ok) throw new Error('not ok');
    console.log('✓ Broker is running');
  } catch {
    console.error('✗ Broker not running. Start with: node src/server.js');
    process.exit(1);
  }

  // ── 2. Register two Flash Tag identities ──────────────────────────────────
  console.log('\n[1] Registering Flash Tag identities...');
  const ftA = await post('/flash-tag/register', {
    agent_id:   'primary-claude',
    group_name: 'dual-attest-demo',
  });
  const ftB = await post('/flash-tag/register', {
    agent_id:   'attester-grok',
    group_name: 'dual-attest-demo',
  });
  console.log(`  Agent A FT: ${ftA.body.registration_id || ftA.body.error}`);
  console.log(`  Agent B FT: ${ftB.body.registration_id || ftB.body.error}`);

  // ── 3. Run dual attestation ────────────────────────────────────────────────
  console.log('\n[2] Running dual attestation...');
  console.log('    Task: ERISA fiduciary key requirements summary');
  console.log('    (This makes two LLM calls in parallel — may take 10-20s)\n');

  const attest = await post('/dual-attest', {
    task: 'Summarize the three most important fiduciary requirements under ERISA for a plan administrator. Be specific and concise.',
    primary_agent_id:      'primary-claude',
    primary_flash_tag_id:  ftA.body.registration_id,
    attesting_agent_id:    'attester-grok',
    attesting_flash_tag_id: ftB.body.registration_id,
  });

  if (!attest.body.ok) {
    console.error('✗ Dual attest failed:', attest.body);
    process.exit(1);
  }

  const { outcome, agreement_score, primary_record_id, attesting_record_id } = attest.body;
  console.log(`✓ Outcome: ${outcome.toUpperCase()}`);
  console.log(`  Agreement score: ${agreement_score}`);
  console.log(`  Primary ACC record:   ${primary_record_id}`);
  console.log(`  Attesting ACC record: ${attesting_record_id}`);

  if (outcome === 'hitl_required') {
    log('HITL Package — human review required', attest.body.hitl);
  } else {
    console.log('\n  Agreed output (primary):');
    console.log('  ' + (attest.body.agreed_output || attest.body.output_a || '').split('\n').join('\n  '));
  }

  // ── 4. Verify attesting agent's chain ─────────────────────────────────────
  console.log('\n[3] Verifying attesting agent chain...');
  const verify = await post('/acc/verify/attester-grok', {});
  console.log(`  Chain valid: ${verify.body.valid}`);
  console.log(`  Violations:  ${verify.body.violations?.length ?? 'N/A'}`);

  // ── 5. Show attesting agent's chain ───────────────────────────────────────
  const chain = await get('/acc/agent/attester-grok/chain');
  console.log(`\n[4] Attesting agent chain (${chain.body.total} record(s)):`);
  for (const r of (chain.body.records || [])) {
    console.log(`  ${r.record_id}  type=${r.action_type}  outcome=${r.outcome}  target=${r.action_target || 'none'}`);
  }

  console.log('\n=== Demo complete ===\n');
}

main().catch(err => { console.error(err); process.exit(1); });
