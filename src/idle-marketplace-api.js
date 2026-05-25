'use strict';
/**
 * IdleAgent.ai marketplace API — mounted in the main AIbrokerAGEnt server.
 * Routes: /api/marketplace/* and /api/idle-policy/*
 * Uses the shared vault.db via existing getDb() — no separate database needed.
 * Auth uses requireOperatorAuth from operator-auth.js (same key system).
 */
const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('./db');
const { requireOperatorAuth } = require('./operator-auth');
const { buildHirePaymentSpec, verifyPayment, buildPaymentSpec, SIMULATION_MODE, NETWORK } = require('./x402');
const { computeTrustScore, getTier } = require('./trust-score');

// Minimum AATS score to participate in marketplace hire (Bronze floor)
const MIN_HIRE_SCORE = 30;
const MIN_HIRE_TIER = 'Bronze';

const VALID_CATEGORIES = [
  'data_processing', 'analysis', 'code_execution', 'research',
  'content', 'verification', 'orchestration', 'specialized',
];
const VALID_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'any'];

// ── Listings ──────────────────────────────────────────────────────────────────

// GET /api/marketplace/listings
router.get('/marketplace/listings', (req, res) => {
  const { category, min_score, tier, max_price, active_only = 'true', limit = 50, offset = 0 } = req.query;
  const db = getDb();

  let sql = 'SELECT * FROM skill_listings WHERE 1=1';
  const params = [];

  if (active_only !== 'false') { sql += ' AND is_active = 1'; }
  if (category && VALID_CATEGORIES.includes(category)) { sql += ' AND skill_category = ?'; params.push(category); }
  if (tier && VALID_TIERS.includes(tier)) { sql += ' AND min_counterparty_tier = ?'; params.push(tier); }
  if (min_score) { sql += ' AND min_counterparty_score <= ?'; params.push(parseInt(min_score, 10)); }
  if (max_price) {
    sql += ' AND (price_per_call <= ? OR price_per_hour <= ?)';
    params.push(parseFloat(max_price), parseFloat(max_price));
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Math.min(parseInt(limit, 10) || 50, 100), parseInt(offset, 10) || 0);

  try {
    const listings = db.prepare(sql).all(...params);
    res.json({ ok: true, listings, count: listings.length });
  } catch (err) {
    // Table may not exist on first run before migration
    res.json({ ok: true, listings: [], count: 0, note: 'marketplace tables initializing' });
  }
});

// POST /api/marketplace/listings
router.post('/marketplace/listings', requireOperatorAuth, (req, res) => {
  const { agent_id, skill_category, skill_name, skill_description, price_per_call, price_per_hour, min_counterparty_score, min_counterparty_tier } = req.body;
  const operatorId = req.operatorId;

  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });
  if (!skill_category || !VALID_CATEGORIES.includes(skill_category)) {
    return res.status(400).json({ error: `skill_category must be one of: ${VALID_CATEGORIES.join(', ')}` });
  }
  if (!skill_name || !skill_name.trim()) return res.status(400).json({ error: 'skill_name required' });

  // Verify agent belongs to this operator
  const link = getDb().prepare('SELECT 1 FROM operator_agents WHERE operator_id = ? AND agent_id = ?').get(operatorId, agent_id);
  if (!link) return res.status(403).json({ error: 'agent not linked to this operator' });

  const id = 'sl_' + crypto.randomBytes(12).toString('hex');
  const now = new Date().toISOString();

  try {
    getDb().prepare(`
      INSERT INTO skill_listings (id, agent_id, operator_id, skill_category, skill_name, skill_description,
        price_per_call, price_per_hour, min_counterparty_score, min_counterparty_tier, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id, agent_id, operatorId, skill_category, skill_name.trim(),
      skill_description || null,
      price_per_call != null ? parseFloat(price_per_call) : null,
      price_per_hour != null ? parseFloat(price_per_hour) : null,
      parseInt(min_counterparty_score, 10) || 0,
      min_counterparty_tier || 'Bronze',
      now, now,
    );
    const listing = getDb().prepare('SELECT * FROM skill_listings WHERE id = ?').get(id);
    res.status(201).json({ ok: true, listing });
  } catch (err) {
    console.error('[idle-marketplace] create listing error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/marketplace/listings/:id
router.get('/marketplace/listings/:id', (req, res) => {
  try {
    const listing = getDb().prepare('SELECT * FROM skill_listings WHERE id = ?').get(req.params.id);
    if (!listing) return res.status(404).json({ error: 'listing not found' });
    res.json({ ok: true, listing });
  } catch {
    res.status(500).json({ error: 'internal error' });
  }
});

// PATCH /api/marketplace/listings/:id/status
router.patch('/marketplace/listings/:id/status', requireOperatorAuth, (req, res) => {
  const { is_active } = req.body;
  if (is_active == null) return res.status(400).json({ error: 'is_active required (true/false)' });

  try {
    const listing = getDb().prepare('SELECT * FROM skill_listings WHERE id = ? AND operator_id = ?').get(req.params.id, req.operatorId);
    if (!listing) return res.status(404).json({ error: 'listing not found or not owned by this operator' });

    getDb().prepare('UPDATE skill_listings SET is_active = ?, updated_at = ? WHERE id = ?')
      .run(is_active ? 1 : 0, new Date().toISOString(), req.params.id);

    res.json({ ok: true, id: req.params.id, is_active: !!is_active });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /api/marketplace/hire — full AICP + x402 flow
// Flow: AATS gate → Flash Rule Engine → x402 payment → AICP contract seal → HCS anchor → TPH update
router.post('/marketplace/hire', async (req, res) => {
  const { listing_id, hiring_agent_id } = req.body;
  if (!listing_id || !hiring_agent_id) return res.status(400).json({ error: 'listing_id and hiring_agent_id required' });

  try {
    const db = getDb();

    // 1 — Fetch listing
    const listing = db.prepare('SELECT * FROM skill_listings WHERE id = ? AND is_active = 1').get(listing_id);
    if (!listing) return res.status(404).json({ error: 'listing not found or inactive' });
    if (listing.agent_id === hiring_agent_id) return res.status(400).json({ error: 'agent cannot hire itself' });

    // 2 — AATS gate: check hiring agent score
    let hiringScore, sellingScore;
    try {
      hiringScore = computeTrustScore(hiring_agent_id);
    } catch (e) {
      return res.status(403).json({
        error: 'AICP trust gate: hiring agent not registered on AATS platform',
        detail: 'Register at https://ai-broker-agent.com/beta to participate in the agent marketplace',
        aicp_gate: 'HIRING_AGENT_NOT_REGISTERED',
      });
    }

    if (hiringScore.score < MIN_HIRE_SCORE) {
      return res.status(403).json({
        error: 'AICP trust gate: hiring agent score below minimum threshold',
        hiring_agent_score: hiringScore.score,
        hiring_agent_tier: hiringScore.tier,
        required_score: MIN_HIRE_SCORE,
        required_tier: MIN_HIRE_TIER,
        aicp_gate: 'HIRING_AGENT_SCORE_TOO_LOW',
      });
    }

    // 3 — AATS gate: check selling agent score
    try {
      sellingScore = computeTrustScore(listing.agent_id);
    } catch (e) {
      return res.status(403).json({
        error: 'AICP trust gate: selling agent no longer registered on AATS platform',
        aicp_gate: 'SELLING_AGENT_NOT_REGISTERED',
      });
    }

    if (sellingScore.score < MIN_HIRE_SCORE) {
      return res.status(403).json({
        error: 'AICP trust gate: selling agent score below minimum threshold — listing suspended',
        selling_agent_score: sellingScore.score,
        aicp_gate: 'SELLING_AGENT_SCORE_TOO_LOW',
      });
    }

    // 4 — Flash Rule Engine: counterparty requirements
    const tierRank = { Restricted: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 };
    const hiringTierRank = tierRank[hiringScore.tier] ?? 0;
    const requiredTierRank = tierRank[listing.min_counterparty_tier] ?? 1;
    const hiringNumericScore = hiringScore.score;

    const flashResult = {
      score_check: hiringNumericScore >= listing.min_counterparty_score,
      tier_check: hiringTierRank >= requiredTierRank,
      fraud_check: !hiringScore.flags?.fraud_flag,
      unfunded_check: hiringScore.tier !== 'UNFUNDED',
    };
    const flashPassed = Object.values(flashResult).every(Boolean);

    if (!flashPassed) {
      return res.status(403).json({
        error: 'Flash Rule Engine: hiring agent does not meet listing requirements',
        flash_evaluation: flashResult,
        required: {
          min_score: listing.min_counterparty_score,
          min_tier: listing.min_counterparty_tier,
        },
        your_score: hiringNumericScore,
        your_tier: hiringScore.tier,
        aicp_gate: 'FLASH_RULE_FAILED',
      });
    }

    // 5 — x402 payment: initiate payment request to target agent
    const price = listing.price_per_call || listing.price_per_hour || 0.001;
    const paymentSpec = buildHirePaymentSpec(
      price.toString(),
      listing.agent_id,
      `IdleAgent hire: ${listing.skill_name}`,
    );

    // Check for X-Payment header (agent submitting payment)
    const paymentHeader = req.headers['x-payment'];
    const specBase64 = buildPaymentSpec(price.toString(), `IdleAgent hire: ${listing.skill_name}`, 'https://ai-broker-agent.com/api/marketplace/hire');

    if (!paymentHeader && price > 0) {
      // Return 402 with payment spec — agent must pay then re-request
      return res.status(402)
        .setHeader('X-PAYMENT-REQUIRED', specBase64)
        .json({
          error: 'Payment Required',
          x402: true,
          aicp_status: 'TRUST_GATES_PASSED',
          flash_evaluation: flashResult,
          amount_usdc: price,
          network: NETWORK,
          description: `Payment for: ${listing.skill_name}`,
          payment_spec: paymentSpec,
          selling_agent: listing.agent_id,
          selling_agent_score: sellingScore.score,
          selling_agent_tier: sellingScore.tier,
          how_to_pay: 'Include X-Payment header with x402 payment payload, then resubmit this request.',
          simulation_mode: SIMULATION_MODE,
          ...(SIMULATION_MODE && { simulation_note: 'Include any X-Payment header value to simulate payment in dev mode.' }),
        });
    }

    // 6 — Verify payment (or simulate if price=0 or simulation mode)
    let paymentResult = { valid: true, simulated: true };
    if (price > 0 && paymentHeader) {
      paymentResult = await verifyPayment(paymentHeader, specBase64);
      if (!paymentResult.valid) {
        return res.status(402)
          .setHeader('X-PAYMENT-REQUIRED', specBase64)
          .json({ error: 'x402 payment verification failed', reason: paymentResult.reason, x402: true });
      }
    }

    // 7 — AICP contract sealed: create transaction record
    const txId = 'mtx_' + crypto.randomBytes(12).toString('hex');
    const aicpContractId = 'aicp_' + crypto.randomBytes(10).toString('hex');
    const now = new Date().toISOString();

    db.prepare(`
      INSERT INTO marketplace_transactions
        (id, listing_id, selling_agent_id, hiring_agent_id, aicp_contract_id, skill_name, price, status, started_at, completed_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
    `).run(txId, listing_id, listing.agent_id, hiring_agent_id, aicpContractId, listing.skill_name, price, now, now, now);

    // 8 — Anchor to HCS via vault records (TPH dimension update for both agents)
    const transactionRecord = {
      type: 'marketplace_transaction',
      transaction_id: txId,
      aicp_contract_id: aicpContractId,
      skill: listing.skill_name,
      price_usdc: price,
      x402: {
        payment_verified: paymentResult.valid,
        simulated: paymentResult.simulated || false,
        tx_hash: paymentResult.txHash || null,
        network: NETWORK,
      },
      counterparty: null, // filled per agent below
      timestamp: now,
    };

    try {
      // Vault record for hiring agent (TPH: completed a transaction as buyer)
      db.prepare(`
        INSERT INTO vault_records (agent_id, label, encrypted_content, iv, tag, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        hiring_agent_id,
        `[aicp] marketplace_hire: ${listing.skill_name}`,
        JSON.stringify({ ...transactionRecord, role: 'hiring_agent', counterparty: listing.agent_id }),
        'x402-record', 'x402-tag',
        crypto.createHash('sha256').update(txId + hiring_agent_id).digest('hex'),
        now,
      );

      // Vault record for selling agent (TPH: completed a transaction as seller)
      db.prepare(`
        INSERT INTO vault_records (agent_id, label, encrypted_content, iv, tag, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        listing.agent_id,
        `[aicp] marketplace_sale: ${listing.skill_name}`,
        JSON.stringify({ ...transactionRecord, role: 'selling_agent', counterparty: hiring_agent_id }),
        'x402-record', 'x402-tag',
        crypto.createHash('sha256').update(txId + listing.agent_id).digest('hex'),
        now,
      );
    } catch (vaultErr) {
      // Vault insert failure doesn't block the transaction — log and continue
      console.error('[idle-marketplace] vault TPH record error:', vaultErr.message);
    }

    console.log(`[x402-hire] ${hiring_agent_id} hired ${listing.agent_id} for "${listing.skill_name}" @ ${price} USDC [${txId}]`);

    res.status(201).json({
      ok: true,
      transaction_id: txId,
      aicp_contract_id: aicpContractId,
      status: 'complete',
      selling_agent: listing.agent_id,
      selling_agent_score: sellingScore.score,
      selling_agent_tier: sellingScore.tier,
      hiring_agent: hiring_agent_id,
      hiring_agent_score: hiringScore.score,
      hiring_agent_tier: hiringScore.tier,
      skill: listing.skill_name,
      price_usdc: price,
      aicp: {
        trust_gates_passed: true,
        flash_evaluation: flashResult,
        contract_sealed: true,
        hcs_pending: true,
      },
      x402: {
        payment_verified: paymentResult.valid,
        simulated: paymentResult.simulated || false,
        tx_hash: paymentResult.txHash || null,
        network: NETWORK,
        simulation_mode: SIMULATION_MODE,
      },
    });
  } catch (err) {
    console.error('[idle-marketplace] hire error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/marketplace/transactions/:agentId
router.get('/marketplace/transactions/:agentId', (req, res) => {
  const { agentId } = req.params;
  const { role = 'all', limit = 20 } = req.query;

  try {
    let rows;
    const lim = Math.min(parseInt(limit, 10) || 20, 100);
    if (role === 'selling') {
      rows = getDb().prepare('SELECT * FROM marketplace_transactions WHERE selling_agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, lim);
    } else if (role === 'hiring') {
      rows = getDb().prepare('SELECT * FROM marketplace_transactions WHERE hiring_agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, lim);
    } else {
      rows = getDb().prepare('SELECT * FROM marketplace_transactions WHERE selling_agent_id = ? OR hiring_agent_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, agentId, lim);
    }
    res.json({ ok: true, agent_id: agentId, transactions: rows, count: rows.length });
  } catch {
    res.json({ ok: true, agent_id: agentId, transactions: [], count: 0 });
  }
});

// ── Idle Policy ───────────────────────────────────────────────────────────────

// POST /api/idle-policy
router.post('/idle-policy', requireOperatorAuth, (req, res) => {
  const { agent_id, auto_list_when_idle, idle_threshold_minutes, max_concurrent_jobs, governance_constraints } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id required' });

  // Verify agent belongs to this operator
  const link = getDb().prepare('SELECT 1 FROM operator_agents WHERE operator_id = ? AND agent_id = ?').get(req.operatorId, agent_id);
  if (!link) return res.status(403).json({ error: 'agent not linked to this operator' });

  const db = getDb();
  const now = new Date().toISOString();
  const existing = db.prepare('SELECT id FROM idle_policies WHERE agent_id = ?').get(agent_id);

  try {
    if (existing) {
      db.prepare(`
        UPDATE idle_policies SET operator_id = ?, auto_list_when_idle = ?, idle_threshold_minutes = ?,
          max_concurrent_jobs = ?, governance_constraints = ?, updated_at = ?
        WHERE agent_id = ?
      `).run(
        req.operatorId, auto_list_when_idle ? 1 : 0,
        parseInt(idle_threshold_minutes, 10) || 15,
        parseInt(max_concurrent_jobs, 10) || 3,
        governance_constraints ? JSON.stringify(governance_constraints) : null,
        now, agent_id,
      );
    } else {
      const id = 'ip_' + crypto.randomBytes(10).toString('hex');
      db.prepare(`
        INSERT INTO idle_policies (id, agent_id, operator_id, auto_list_when_idle,
          idle_threshold_minutes, max_concurrent_jobs, governance_constraints, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, agent_id, req.operatorId, auto_list_when_idle ? 1 : 0,
        parseInt(idle_threshold_minutes, 10) || 15,
        parseInt(max_concurrent_jobs, 10) || 3,
        governance_constraints ? JSON.stringify(governance_constraints) : null,
        now, now,
      );
    }

    const row = db.prepare('SELECT * FROM idle_policies WHERE agent_id = ?').get(agent_id);
    const policy = formatPolicy(row);
    res.json({ ok: true, saved: true, policy });
  } catch (err) {
    console.error('[idle-policy] save error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /api/idle-policy/:agentId
router.get('/idle-policy/:agentId', requireOperatorAuth, (req, res) => {
  try {
    const row = getDb().prepare('SELECT * FROM idle_policies WHERE agent_id = ?').get(req.params.agentId);
    if (!row) return res.status(404).json({ error: 'no idle policy set for this agent', default: defaultPolicy(req.params.agentId) });
    if (row.operator_id !== req.operatorId) return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, policy: formatPolicy(row) });
  } catch {
    res.status(404).json({ error: 'no idle policy set for this agent', default: defaultPolicy(req.params.agentId) });
  }
});

function defaultPolicy(agentId) {
  return { agent_id: agentId, auto_list_when_idle: false, idle_threshold_minutes: 15, max_concurrent_jobs: 3, governance_constraints: null };
}

function formatPolicy(row) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    operator_id: row.operator_id,
    auto_list_when_idle: !!row.auto_list_when_idle,
    idle_threshold_minutes: row.idle_threshold_minutes,
    max_concurrent_jobs: row.max_concurrent_jobs,
    governance_constraints: row.governance_constraints ? JSON.parse(row.governance_constraints) : null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// GET /api/marketplace/agent-listings/:agentId — for the operator console panel
router.get('/marketplace/agent-listings/:agentId', requireOperatorAuth, (req, res) => {
  try {
    const listings = getDb().prepare(
      'SELECT * FROM skill_listings WHERE agent_id = ? AND operator_id = ? ORDER BY created_at DESC'
    ).all(req.params.agentId, req.operatorId);
    res.json({ ok: true, listings, count: listings.length });
  } catch {
    res.json({ ok: true, listings: [], count: 0 });
  }
});

// GET /api/marketplace/agent-earnings/:agentId — earnings summary for console
router.get('/marketplace/agent-earnings/:agentId', requireOperatorAuth, (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare(
      "SELECT COALESCE(SUM(price), 0) as total, COUNT(*) as n FROM marketplace_transactions WHERE selling_agent_id = ? AND status = 'complete'"
    ).get(req.params.agentId);
    const last30 = db.prepare(
      "SELECT COALESCE(SUM(price), 0) as total, COUNT(*) as n FROM marketplace_transactions WHERE selling_agent_id = ? AND status = 'complete' AND completed_at >= datetime('now', '-30 days')"
    ).get(req.params.agentId);
    res.json({ ok: true, agent_id: req.params.agentId, total_earned: total.total, total_jobs: total.n, last_30_days: { earned: last30.total, jobs: last30.n } });
  } catch {
    res.json({ ok: true, agent_id: req.params.agentId, total_earned: 0, total_jobs: 0, last_30_days: { earned: 0, jobs: 0 } });
  }
});

module.exports = router;
