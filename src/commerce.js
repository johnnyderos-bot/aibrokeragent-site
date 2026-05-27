'use strict';

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const { resolveKey } = require('./auth');
const { computeTrustScore } = require('./trust-score');
const { addCredits } = require('./billing');
const { anchorRecord, createVaultTopic } = require('./hedera');

const router = express.Router();

const BROKER_FEE_RATE = parseFloat(process.env.COMMERCE_BROKER_FEE || '0.05');
const TRUST_THRESHOLD = parseFloat(process.env.COMMERCE_TRUST_THRESHOLD || '60');
const PLATFORM_AGENT_ID = process.env.PLATFORM_AGENT_ID || 'platform';
const ADRP_PHASE3_HOURS = parseInt(process.env.ADRP_PHASE3_HOURS || '24', 10);

// Platform-level HCS topic for all commerce CTRs.
// Lazily resolved — first call to anchorCommerce() resolves it.
let _commerceTopic = process.env.HEDERA_COMMERCE_TOPIC || null;
async function getCommerceTopic() {
  if (_commerceTopic) return _commerceTopic;
  try {
    _commerceTopic = await createVaultTopic('platform-commerce');
    console.log('[commerce] created HCS topic:', _commerceTopic);
  } catch (err) {
    console.error('[commerce] HCS topic creation failed:', err.message);
  }
  return _commerceTopic;
}

async function anchorCommerce(payload) {
  const topic = await getCommerceTopic();
  if (!topic) return null;
  try {
    return await anchorRecord(topic, payload);
  } catch (err) {
    console.error('[commerce] HCS anchor failed:', err.message);
    return null;
  }
}

// ── TSR helpers ──────────────────────────────────────────────────────────────

function canonicalizeTsr(obj) {
  const sorted = Object.keys(obj).sort().reduce((acc, k) => { acc[k] = obj[k]; return acc; }, {});
  return JSON.stringify(sorted);
}

function hashTsr(obj) {
  return crypto.createHash('sha256').update(canonicalizeTsr(obj)).digest('hex');
}

function hashBytes(str) {
  return crypto.createHash('sha256').update(String(str)).digest('hex');
}

// ── AVG ──────────────────────────────────────────────────────────────────────

function computeAvg(delivery_output, acceptance_criteria, skipOptional = false) {
  const detail = {};
  let allRequired = true;

  for (const criterion of acceptance_criteria) {
    if (skipOptional && criterion.optional) continue;
    const { id, type, field, ...params } = criterion;
    let passed = false;
    let reason = '';

    try {
      const value = field ? delivery_output[field] : delivery_output;
      switch (type) {
        case 'schema_validation': {
          const schema = params.schema;
          if (!schema || typeof schema !== 'object') { passed = false; reason = 'invalid schema definition'; break; }
          const missing = (schema.required || []).filter(f => delivery_output[f] === undefined || delivery_output[f] === null);
          passed = missing.length === 0;
          reason = passed ? 'all required fields present' : `missing fields: ${missing.join(', ')}`;
          break;
        }
        case 'field_value_range': {
          const num = parseFloat(value);
          passed = !isNaN(num) && num >= params.min && num <= params.max;
          reason = passed ? `${num} in [${params.min}, ${params.max}]` : `${num} outside [${params.min}, ${params.max}]`;
          break;
        }
        case 'hash_match': {
          const actual = hashBytes(value);
          passed = actual === params.expected_hash;
          reason = passed ? 'hash matches' : `expected ${params.expected_hash}, got ${actual}`;
          break;
        }
        case 'regex_pattern': {
          passed = new RegExp(params.pattern).test(String(value));
          reason = passed ? 'pattern matched' : `pattern ${params.pattern} did not match`;
          break;
        }
        case 'field_present': {
          passed = value !== undefined && value !== null && value !== '';
          reason = passed ? 'field present' : 'field missing or null';
          break;
        }
        default:
          passed = false;
          reason = `unknown criterion type: ${type}`;
      }
    } catch (err) {
      passed = false;
      reason = `evaluation error: ${err.message}`;
    }

    detail[id] = { type, passed, reason };
    if (!passed && !criterion.optional) allRequired = false;
  }

  return { result: allRequired ? 'pass' : 'fail', detail };
}

// ── Escrow operations ────────────────────────────────────────────────────────

function lockEscrow(db, agentId, amount, ctrId) {
  return db.transaction(() => {
    const info = db.prepare(
      'UPDATE agents SET credits = ROUND(credits - ?, 4) WHERE agent_id = ? AND credits >= ?'
    ).run(amount, agentId, amount);
    if (info.changes === 0) {
      const agent = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
      if (!agent) throw new Error('agent_not_found');
      return { ok: false, balance: agent.credits };
    }
    const { credits: bal } = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'debit', ?, ?, 'commerce_escrow_lock', ?)`
    ).run(agentId, -amount, bal, ctrId);
    return { ok: true };
  })();
}

function releaseEscrow(db, ctr) {
  // Release to service agent minus broker fee. Broker fee stays on platform.
  const fee = Math.round(ctr.escrow_amount * BROKER_FEE_RATE);
  const payout = ctr.escrow_amount - fee;
  db.transaction(() => {
    db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?')
      .run(payout, ctr.service_agent);
    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'credit', ?, (SELECT credits FROM agents WHERE agent_id = ?), 'commerce_settlement', ?)`
    ).run(ctr.service_agent, payout, ctr.service_agent, ctr.id);
    // Broker fee: add to platform agent if configured
    if (PLATFORM_AGENT_ID !== 'platform') {
      db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?')
        .run(fee, PLATFORM_AGENT_ID);
    }
  })();
  return { payout, fee };
}

function refundEscrow(db, ctr) {
  db.transaction(() => {
    db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?')
      .run(ctr.escrow_amount, ctr.commissioning_agent);
    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'credit', ?, (SELECT credits FROM agents WHERE agent_id = ?), 'commerce_escrow_refund', ?)`
    ).run(ctr.commissioning_agent, ctr.escrow_amount, ctr.commissioning_agent, ctr.id);
  })();
}

// ── Settlement ────────────────────────────────────────────────────────────────

async function settleTransaction(db, ctrId) {
  const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(ctrId);
  if (!ctr || ctr.status === 'settled') return;
  const { payout, fee } = releaseEscrow(db, ctr);
  const now = new Date().toISOString();
  db.prepare('UPDATE commerce_transactions SET status = ?, updated_at = ? WHERE id = ?')
    .run('settled', now, ctrId);
  const hcsResult = await anchorCommerce({ event: 'settlement', ctr_id: ctrId, payout, fee, ts: now });
  if (hcsResult) {
    db.prepare('UPDATE commerce_transactions SET hcs_sequence_number = ? WHERE id = ?')
      .run(parseInt(hcsResult.sequenceNumber, 10), ctrId);
  }
}

// ── ADRP ─────────────────────────────────────────────────────────────────────

async function runAdrp(db, ctrId) {
  const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(ctrId);
  if (!ctr) return;
  const attest = db.prepare('SELECT * FROM commerce_attestations WHERE ctr_id = ?').get(ctrId);
  if (!attest) return;
  const tsr = JSON.parse(ctr.tsr_json);
  const criteria = tsr.acceptance_criteria || [];
  const deliveryOutput = JSON.parse(attest.compliance_declaration || '{}');

  // Phase 1: re-run AVG with optional criteria dropped
  const phase1 = computeAvg(deliveryOutput, criteria, true);
  if (phase1.result === 'pass') {
    await settleTransaction(db, ctrId);
    return;
  }

  // Phase 2: check if delivery_hash partially matches any TSR field
  let partialFraction = 0;
  const trsFields = Object.values(tsr).filter(v => typeof v === 'string');
  for (const fieldVal of trsFields) {
    if (hashBytes(fieldVal) === attest.delivery_hash) { partialFraction = 0.5; break; }
  }
  if (partialFraction > 0) {
    const partialPayout = Math.round(ctr.escrow_amount * partialFraction);
    const now = new Date().toISOString();
    db.transaction(() => {
      db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?')
        .run(partialPayout, ctr.service_agent);
      db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?')
        .run(ctr.escrow_amount - partialPayout, ctr.commissioning_agent);
      db.prepare(
        `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
         VALUES (?, 'credit', ?, (SELECT credits FROM agents WHERE agent_id = ?), 'commerce_partial_settlement', ?)`
      ).run(ctr.service_agent, partialPayout, ctr.service_agent, ctrId);
    })();
    const disputeId = 'disp_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO commerce_disputes (id, ctr_id, phase, initiator, grounds, resolution, resolved_by)
       VALUES (?, ?, 2, 'avg', ?, ?, 'auto_partial')`
    ).run(disputeId, ctrId, JSON.stringify({ reason: 'partial_completion' }), JSON.stringify({ fraction: partialFraction }));
    db.prepare('UPDATE commerce_transactions SET status = ?, updated_at = ? WHERE id = ?')
      .run('resolved', now, ctrId);
    await anchorCommerce({ event: 'partial_settlement', ctr_id: ctrId, fraction: partialFraction, ts: now });
    return;
  }

  // Phase 3: hold escrow 24h, create dispute record
  const disputeId = 'disp_' + crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO commerce_disputes (id, ctr_id, phase, initiator, grounds)
     VALUES (?, ?, 3, 'avg', ?)`
  ).run(disputeId, ctrId, JSON.stringify({ reason: 'avg_fail_all_phases', avg_detail: attest.avg_detail }));
  db.prepare('UPDATE commerce_transactions SET status = ?, updated_at = ? WHERE id = ?')
    .run('disputed', now, ctrId);
  await anchorCommerce({ event: 'adrp_phase3', ctr_id: ctrId, dispute_id: disputeId, ts: now });
}

// ── Hourly ADRP phase-3 timeout sweep ────────────────────────────────────────

async function processCommerceTimeouts() {
  const db = getDb();
  const cutoff = new Date(Date.now() - ADRP_PHASE3_HOURS * 60 * 60 * 1000).toISOString();
  const expired = db.prepare(
    `SELECT cd.id as dispute_id, cd.ctr_id
     FROM commerce_disputes cd
     JOIN commerce_transactions ct ON ct.id = cd.ctr_id
     WHERE cd.phase = 3 AND cd.resolved_by IS NULL AND cd.created_at < ?
       AND ct.status = 'disputed'`
  ).all(cutoff);

  for (const row of expired) {
    try {
      const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(row.ctr_id);
      if (!ctr) continue;
      refundEscrow(db, ctr);
      const now = new Date().toISOString();
      db.prepare('UPDATE commerce_transactions SET status = ?, updated_at = ? WHERE id = ?')
        .run('resolved', now, row.ctr_id);
      db.prepare('UPDATE commerce_disputes SET resolution = ?, resolved_by = ? WHERE id = ?')
        .run(JSON.stringify({ outcome: 'refunded_after_timeout' }), 'auto_timeout', row.dispute_id);
      await anchorCommerce({ event: 'adrp_timeout_refund', ctr_id: row.ctr_id, ts: now });
    } catch (err) {
      console.error('[commerce] timeout sweep error:', err.message);
    }
  }
}

// ── Trust check helper ────────────────────────────────────────────────────────

function checkTrust(agentId) {
  try {
    const result = computeTrustScore(agentId);
    if (!result || result.tier === 'UNFUNDED') return false;
    return (result.score || 0) >= TRUST_THRESHOLD;
  } catch {
    return false;
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /commerce/commission
router.post('/commission', async (req, res) => {
  try {
    const { commissioning_agent_key, service_agent_id, task_spec, escrow_credits, acceptance_criteria } = req.body;
    if (!commissioning_agent_key || !service_agent_id || !task_spec || !escrow_credits) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const commAgentId = resolveKey(commissioning_agent_key);
    if (!commAgentId) return res.status(401).json({ error: 'invalid_commissioning_agent_key' });

    const db = getDb();
    const svcAgent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(service_agent_id);
    if (!svcAgent) return res.status(404).json({ error: 'service_agent_not_found' });

    if (!checkTrust(commAgentId)) return res.status(403).json({ error: 'commissioning_agent_trust_below_threshold' });
    if (!checkTrust(service_agent_id)) return res.status(403).json({ error: 'service_agent_trust_below_threshold' });

    const amount = parseInt(escrow_credits, 10);
    if (!amount || amount < 1) return res.status(400).json({ error: 'invalid_escrow_credits' });

    const tsr = { task_spec, acceptance_criteria: acceptance_criteria || [], commissioning_agent: commAgentId, service_agent: service_agent_id, created_at: new Date().toISOString() };
    const tsrHash = hashTsr(tsr);
    const ctrId = 'ctr_' + crypto.randomBytes(10).toString('hex');

    const lock = lockEscrow(db, commAgentId, amount, ctrId);
    if (!lock.ok) return res.status(402).json({ error: 'insufficient_credits', balance: lock.balance, required: amount });

    db.prepare(
      `INSERT INTO commerce_transactions (id, tsr_hash, commissioning_agent, service_agent, tsr_json, escrow_amount, status)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`
    ).run(ctrId, tsrHash, commAgentId, service_agent_id, JSON.stringify(tsr), amount);

    const hcsResult = await anchorCommerce({ event: 'commission', ctr_id: ctrId, tsr_hash: tsrHash, ts: tsr.created_at });
    if (hcsResult) {
      db.prepare('UPDATE commerce_transactions SET hcs_sequence_number = ?, hcs_topic = ? WHERE id = ?')
        .run(parseInt(hcsResult.sequenceNumber, 10), _commerceTopic, ctrId);
    }

    res.json({ ctr_id: ctrId, tsr_hash: tsrHash, hcs_sequence_number: hcsResult ? hcsResult.sequenceNumber : null, status: 'pending' });
  } catch (err) {
    console.error('[commerce/commission]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /commerce/attest
router.post('/attest', async (req, res) => {
  try {
    const { service_agent_key, ctr_id, delivery_output, compliance_declaration } = req.body;
    if (!service_agent_key || !ctr_id || delivery_output === undefined) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const svcAgentId = resolveKey(service_agent_key);
    if (!svcAgentId) return res.status(401).json({ error: 'invalid_service_agent_key' });

    const db = getDb();
    const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(ctr_id);
    if (!ctr) return res.status(404).json({ error: 'ctr_not_found' });
    if (ctr.service_agent !== svcAgentId) return res.status(403).json({ error: 'agent_not_party_to_ctr' });
    if (ctr.status !== 'pending') return res.status(409).json({ error: 'ctr_not_in_pending_state', status: ctr.status });

    const deliveryStr = typeof delivery_output === 'string' ? delivery_output : JSON.stringify(delivery_output);
    const deliveryHash = hashBytes(deliveryStr);
    const tsr = JSON.parse(ctr.tsr_json);
    const criteria = tsr.acceptance_criteria || [];

    const parsedDelivery = (() => { try { return JSON.parse(deliveryStr); } catch { return { _raw: deliveryStr }; } })();
    const avgResult = computeAvg(parsedDelivery, criteria);

    const attestId = 'att_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO commerce_attestations (id, ctr_id, delivery_hash, compliance_declaration, avg_result, avg_detail)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(attestId, ctr_id, deliveryHash, JSON.stringify(compliance_declaration || {}), avgResult.result, JSON.stringify(avgResult.detail));

    db.prepare("UPDATE commerce_transactions SET status = 'attested', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), ctr_id);

    const hcsResult = await anchorCommerce({ event: 'attestation', ctr_id, attestation_id: attestId, avg_result: avgResult.result, ts: new Date().toISOString() });

    if (avgResult.result === 'pass') {
      await settleTransaction(db, ctr_id);
    } else {
      await runAdrp(db, ctr_id);
    }

    const updatedCtr = db.prepare('SELECT status FROM commerce_transactions WHERE id = ?').get(ctr_id);
    res.json({ attestation_id: attestId, avg_result: avgResult.result, avg_detail: avgResult.detail, ctr_status: updatedCtr.status, hcs_sequence_number: hcsResult ? hcsResult.sequenceNumber : null });
  } catch (err) {
    console.error('[commerce/attest]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /commerce/verify — operator manual AVG re-run
router.post('/verify', async (req, res) => {
  try {
    const { operator_key, ctr_id } = req.body;
    if (!operator_key || !ctr_id) return res.status(400).json({ error: 'missing_required_fields' });

    // Operator auth: validate against operator keys
    const { resolveOperatorKey } = (() => { try { return require('./operator-auth'); } catch { return {}; } })();
    if (resolveOperatorKey && !resolveOperatorKey(operator_key)) {
      return res.status(401).json({ error: 'invalid_operator_key' });
    }

    const db = getDb();
    const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(ctr_id);
    if (!ctr) return res.status(404).json({ error: 'ctr_not_found' });

    const attest = db.prepare('SELECT * FROM commerce_attestations WHERE ctr_id = ? ORDER BY created_at DESC LIMIT 1').get(ctr_id);
    if (!attest) return res.status(404).json({ error: 'no_attestation_found' });

    const tsr = JSON.parse(ctr.tsr_json);
    const criteria = tsr.acceptance_criteria || [];
    const delivery = (() => { try { return JSON.parse(attest.compliance_declaration); } catch { return {}; } })();
    const avgResult = computeAvg(delivery, criteria);

    res.json({ ctr_id, avg_result: avgResult.result, avg_detail: avgResult.detail, current_status: ctr.status });
  } catch (err) {
    console.error('[commerce/verify]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /commerce/dispute
router.post('/dispute', async (req, res) => {
  try {
    const { agent_key, ctr_id, grounds } = req.body;
    if (!agent_key || !ctr_id || !grounds) return res.status(400).json({ error: 'missing_required_fields' });

    const agentId = resolveKey(agent_key);
    if (!agentId) return res.status(401).json({ error: 'invalid_agent_key' });

    const db = getDb();
    const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(ctr_id);
    if (!ctr) return res.status(404).json({ error: 'ctr_not_found' });
    if (ctr.commissioning_agent !== agentId && ctr.service_agent !== agentId) {
      return res.status(403).json({ error: 'agent_not_party_to_ctr' });
    }
    if (['settled', 'resolved'].includes(ctr.status)) {
      return res.status(409).json({ error: 'ctr_already_finalized', status: ctr.status });
    }

    const disputeId = 'disp_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO commerce_disputes (id, ctr_id, phase, initiator, grounds)
       VALUES (?, ?, 1, ?, ?)`
    ).run(disputeId, ctr_id, agentId, JSON.stringify(grounds));
    db.prepare("UPDATE commerce_transactions SET status = 'disputed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), ctr_id);

    await anchorCommerce({ event: 'dispute_filed', ctr_id, dispute_id: disputeId, initiator: agentId, ts: new Date().toISOString() });

    res.json({ dispute_id: disputeId, phase: 1, ctr_id, next_step: 'operator_review_or_auto_resolution' });
  } catch (err) {
    console.error('[commerce/dispute]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /commerce/resolve — phase 4 operator resolution
router.post('/resolve', async (req, res) => {
  try {
    const { operator_key, dispute_id, resolution } = req.body;
    if (!operator_key || !dispute_id || !resolution) return res.status(400).json({ error: 'missing_required_fields' });

    const { resolveOperatorKey } = (() => { try { return require('./operator-auth'); } catch { return {}; } })();
    if (resolveOperatorKey && !resolveOperatorKey(operator_key)) {
      return res.status(401).json({ error: 'invalid_operator_key' });
    }

    const db = getDb();
    const dispute = db.prepare('SELECT * FROM commerce_disputes WHERE id = ?').get(dispute_id);
    if (!dispute) return res.status(404).json({ error: 'dispute_not_found' });
    if (dispute.resolved_by) return res.status(409).json({ error: 'dispute_already_resolved' });

    const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(dispute.ctr_id);
    if (!ctr) return res.status(404).json({ error: 'ctr_not_found' });

    const outcome = resolution.outcome; // 'release' | 'refund' | 'split'
    const now = new Date().toISOString();

    if (outcome === 'release') {
      await settleTransaction(db, ctr.id);
    } else if (outcome === 'refund') {
      refundEscrow(db, ctr);
      db.prepare("UPDATE commerce_transactions SET status = 'resolved', updated_at = ? WHERE id = ?")
        .run(now, ctr.id);
    } else if (outcome === 'split') {
      const fraction = parseFloat(resolution.fraction || 0.5);
      const svcPayout = Math.round(ctr.escrow_amount * fraction);
      const commRefund = ctr.escrow_amount - svcPayout;
      db.transaction(() => {
        db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?').run(svcPayout, ctr.service_agent);
        db.prepare('UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?').run(commRefund, ctr.commissioning_agent);
      })();
      db.prepare("UPDATE commerce_transactions SET status = 'resolved', updated_at = ? WHERE id = ?").run(now, ctr.id);
    } else {
      return res.status(400).json({ error: 'invalid_outcome', valid_outcomes: ['release', 'refund', 'split'] });
    }

    db.prepare('UPDATE commerce_disputes SET resolution = ?, resolved_by = ? WHERE id = ?')
      .run(JSON.stringify(resolution), 'operator', dispute_id);

    const hcsResult = await anchorCommerce({ event: 'operator_resolution', ctr_id: ctr.id, dispute_id, outcome, ts: now });

    res.json({ ok: true, dispute_id, ctr_id: ctr.id, outcome, hcs_sequence_number: hcsResult ? hcsResult.sequenceNumber : null });
  } catch (err) {
    console.error('[commerce/resolve]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// GET /commerce/transaction/:ctr_id
router.get('/transaction/:ctr_id', (req, res) => {
  try {
    const db = getDb();
    const ctr = db.prepare('SELECT * FROM commerce_transactions WHERE id = ?').get(req.params.ctr_id);
    if (!ctr) return res.status(404).json({ error: 'ctr_not_found' });
    const attestations = db.prepare('SELECT * FROM commerce_attestations WHERE ctr_id = ? ORDER BY created_at ASC').all(req.params.ctr_id);
    const disputes = db.prepare('SELECT * FROM commerce_disputes WHERE ctr_id = ? ORDER BY created_at ASC').all(req.params.ctr_id);
    res.json({ ...ctr, attestations, disputes });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /commerce/stats
router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COUNT(*) as n FROM commerce_transactions').get().n;
    const settled = db.prepare("SELECT COUNT(*) as n FROM commerce_transactions WHERE status = 'settled'").get().n;
    const disputed = db.prepare("SELECT COUNT(*) as n FROM commerce_transactions WHERE status IN ('disputed','resolved')").get().n;
    const avgMs = (() => {
      try {
        const row = db.prepare(
          "SELECT AVG((julianday(updated_at) - julianday(created_at)) * 86400000) as avg_ms FROM commerce_transactions WHERE status = 'settled'"
        ).get();
        return row ? Math.round(row.avg_ms || 0) : 0;
      } catch { return 0; }
    })();
    res.json({ total_transactions: total, settled, disputed, avg_settlement_ms: avgMs });
  } catch (err) {
    res.status(500).json({ error: 'stats_unavailable' });
  }
});

module.exports = { router, processCommerceTimeouts };
