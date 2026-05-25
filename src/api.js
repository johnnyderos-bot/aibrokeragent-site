const express = require('express');
const rateLimit = require('express-rate-limit');
const { registerAgent, requireAuth, VALID_AGENT_TYPES } = require('./auth');
const { storeRecord, readRecord, listRecords, grantPermission, revokePermission } = require('./vault');
const { logRateLimit, logAuthFailure } = require('./audit-log');
const { deductCredits, refundCredits, getBalance, getLedger, verifyAndCredit, addCredits, PRICES, HBAR_TO_CREDITS } = require('./billing');
const { computeTrustScore } = require('./trust-score');
const { generateScoreAdvice } = require('./advisor');
const { getDb } = require('./db');

const router = express.Router();

// Rate limit registration — max 5 per IP per hour
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'too many registration attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limit vault write endpoints — max 60 per agent per minute
// Prevents credit-draining attacks and vault spam
const vaultWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  keyGenerator: (req) => req.agentId || req.ip,
  message: { error: 'vault write rate limit exceeded — max 60 writes per minute' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.agentId,
  handler: (req, res, next, options) => {
    logRateLimit(req.agentId, req.path);
    res.status(options.statusCode).json(options.message);
  },
});

// Rate limit vault read endpoints — max 300 per agent per minute
const vaultReadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  keyGenerator: (req) => req.agentId || req.ip,
  message: { error: 'vault read rate limit exceeded — max 300 reads per minute' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.agentId,
});

// Rate limit public AATS score endpoint — max 100 per IP per day (free tier)
const trustScorePublicLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  message: { error: 'rate limit exceeded — 100 free requests/day. Register as an operator for unlimited access.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Register a new agent (no auth required)
// POST /vault/agents/register
// Body: { name, hedera_account (optional) }
//
// HOLD — April 12, 2026. Registration paused pending legal clearance.
// To re-enable: remove the early return below.
router.post('/agents/register', registerLimiter, (req, res) => {
  return res.status(503).json({
    error: 'AIbrokerAGEnt is currently in private development. Registration is temporarily paused.',
  });
});

// All routes below require authentication
router.use(requireAuth);

// Get account balance and pricing info
// GET /vault/account
router.get('/account', (req, res) => {
  try {
    const balance = getBalance(req.agentId);
    res.json({
      agent_id: req.agentId,
      credits: balance,
      pricing: PRICES,
      topup_rate: `1 HBAR = ${HBAR_TO_CREDITS} credits`,
      topup_info: `Send HBAR to ${process.env.HEDERA_ACCOUNT_ID} and contact support with your transaction ID`,
    });
  } catch (err) {
    console.error('account error:', err);
    res.status(500).json({ error: 'failed to retrieve account' });
  }
});

// Get billing ledger
// GET /vault/account/ledger
router.get('/account/ledger', (req, res) => {
  try {
    res.json(getLedger(req.agentId));
  } catch (err) {
    console.error('ledger error:', err);
    res.status(500).json({ error: 'failed to retrieve ledger' });
  }
});

// Top up credits (disabled until mirror node verification is implemented)
// POST /vault/account/topup
// Body: { transaction_id: "0.0.1234@1234567890.123456789" }
router.post('/account/topup', async (req, res) => {
  const { transaction_id } = req.body || {};
  if (!transaction_id) {
    return res.status(400).json({
      error: 'transaction_id is required',
      instructions: `Send HBAR to ${process.env.HEDERA_ACCOUNT_ID}, then POST { transaction_id } to this endpoint`,
      rate: `1 HBAR = ${HBAR_TO_CREDITS} credits`,
    });
  }
  const result = await verifyAndCredit(req.agentId, transaction_id);
  if (result.error) return res.status(400).json(result);
  res.json(result);
});

// Store a context record (costs 1 credit)
// POST /vault/records
// Body: { label, content }
router.post('/records', vaultWriteLimiter, async (req, res) => {
  const { label, content } = req.body;
  if (!label || !content) return res.status(400).json({ error: 'label and content are required' });
  if (typeof label !== 'string' || label.length > 200) {
    return res.status(400).json({ error: 'label must be a string under 200 characters' });
  }
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }

  const billing = deductCredits(req.agentId, 'store_record');
  if (!billing.ok) {
    return res.status(402).json({
      error: 'insufficient credits',
      balance: billing.balance,
      required: billing.required,
      topup_info: `Send HBAR to ${process.env.HEDERA_ACCOUNT_ID} and contact support with your transaction ID`,
    });
  }

  try {
    const record = await storeRecord(req.agentId, label, content);
    res.status(201).json({ ...record, credits_remaining: billing.balance });
  } catch (err) {
    // Hedera or DB failed — refund the credit
    console.error('store error:', err);
    refundCredits(req.agentId, 'store_record');
    res.status(500).json({ error: 'failed to store record — credit refunded' });
  }
});

// List records (free)
// GET /vault/records
router.get('/records', (req, res) => {
  try {
    res.json(listRecords(req.agentId));
  } catch (err) {
    console.error('list error:', err);
    res.status(500).json({ error: 'failed to list records' });
  }
});

// Read a record (free)
// GET /vault/records/:id
router.get('/records/:id', vaultReadLimiter, async (req, res) => {
  try {
    const record = await readRecord(req.params.id, req.agentId);
    if (!record) return res.status(404).json({ error: 'not found' });
    if (record.error === 'forbidden') return res.status(403).json({ error: 'forbidden' });
    res.json(record);
  } catch (err) {
    console.error('read error:', err);
    res.status(500).json({ error: 'failed to read record' });
  }
});

// Grant permission (free)
// POST /vault/records/:id/grant
router.post('/records/:id/grant', (req, res) => {
  const { grantee_agent_id } = req.body;
  if (!grantee_agent_id) return res.status(400).json({ error: 'grantee_agent_id required' });
  try {
    const result = grantPermission(req.params.id, req.agentId, grantee_agent_id);
    if (!result) return res.status(404).json({ error: 'record not found or not owner' });
    res.json(result);
  } catch (err) {
    console.error('grant error:', err);
    res.status(500).json({ error: 'failed to grant permission' });
  }
});

// Revoke permission (free)
// POST /vault/records/:id/revoke
router.post('/records/:id/revoke', (req, res) => {
  const { grantee_agent_id } = req.body;
  if (!grantee_agent_id) return res.status(400).json({ error: 'grantee_agent_id required' });
  try {
    const result = revokePermission(req.params.id, req.agentId, grantee_agent_id);
    if (!result) return res.status(404).json({ error: 'record not found or not owner' });
    res.json(result);
  } catch (err) {
    console.error('revoke error:', err);
    res.status(500).json({ error: 'failed to revoke permission' });
  }
});

// Submit a code attestation (agent registers its identity fingerprint)
// POST /vault/agents/attest
// Body: { model_version, system_prompt_hash, code_hash, operator_id (optional) }
router.post('/agents/attest', async (req, res) => {
  const { model_version, system_prompt_hash, code_hash, operator_id } = req.body;
  if (!model_version && !system_prompt_hash && !code_hash) {
    return res.status(400).json({ error: 'at least one of model_version, system_prompt_hash, or code_hash is required' });
  }
  try {
    const db = require('./db').getDb();

    // KYC gate: if agent has a linked operator, that operator must be KYC-approved
    // before anchoring an identity attestation to HCS (advisory on testnet)
    const link = db.prepare(
      'SELECT o.kyc_status, o.operator_id FROM operators o JOIN operator_agents oa ON oa.operator_id = o.operator_id WHERE oa.agent_id = ?'
    ).get(req.agentId);
    if (link && link.kyc_status !== 'approved') {
      const IS_MAINNET = process.env.HEDERA_NETWORK === 'mainnet';
      const msg = `operator ${link.operator_id} KYC status is ${link.kyc_status} — HCS anchor skipped`;
      if (IS_MAINNET) return res.status(403).json({ error: `KYC approval required for attestation: ${msg}` });
      console.warn(`[attest] ${msg}`);
    }
    const agent = db.prepare('SELECT hcs_topic_id FROM agents WHERE agent_id = ?').get(req.agentId);

    let hcs_topic_id = null;
    let hcs_sequence = null;

    // Anchor attestation to HCS
    try {
      if (agent && agent.hcs_topic_id) {
        const { anchorRecord } = require('./hedera');
        const anchor = await anchorRecord(agent.hcs_topic_id, {
          type: 'CODE_ATTESTATION',
          agent_id: req.agentId,
          model_version:      model_version      || null,
          system_prompt_hash: system_prompt_hash || null,
          code_hash:          code_hash          || null,
          attested_at:        new Date().toISOString(),
        });
        hcs_topic_id = agent.hcs_topic_id;
        hcs_sequence = anchor.sequenceNumber;
      }
    } catch (err) {
      console.error('HCS anchor failed for attestation:', err.message);
    }

    const id = require('crypto').randomBytes(16).toString('hex');
    db.prepare(`
      INSERT INTO agent_attestations
        (id, agent_id, model_version, system_prompt_hash, code_hash, operator_id, hcs_topic_id, hcs_sequence)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, req.agentId, model_version || null, system_prompt_hash || null,
           code_hash || null, operator_id || null, hcs_topic_id, hcs_sequence);

    res.status(201).json({
      id,
      agent_id:           req.agentId,
      model_version:      model_version      || null,
      system_prompt_hash: system_prompt_hash || null,
      code_hash:          code_hash          || null,
      hcs_topic_id,
      hcs_sequence,
      attested_at:        new Date().toISOString(),
      iaq_impact: '+25 pts toward Identity & Attestation Quality sub-score',
    });
  } catch (err) {
    console.error('attest error:', err);
    res.status(500).json({ error: 'failed to store attestation' });
  }
});

// Get latest attestation for any agent (public)
// GET /vault/agents/:id/attestation
router.get('/agents/:id/attestation', (req, res) => {
  try {
    const db = require('./db').getDb();
    const row = db.prepare(`
      SELECT id, agent_id, model_version, system_prompt_hash, code_hash,
             hcs_topic_id, hcs_sequence, attested_at
      FROM agent_attestations
      WHERE agent_id = ?
      ORDER BY attested_at DESC LIMIT 1
    `).get(req.params.id);
    if (!row) return res.status(404).json({ error: 'no attestation found for this agent' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: 'failed to get attestation' });
  }
});

// Admin top-up — manually credit any agent (protected by ADMIN_KEY in .env)
// POST /vault/admin/topup
// Body: { agent_id, credits, note }
router.post('/admin/topup', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'invalid or missing X-Admin-Key' });
  }
  const { agent_id, credits, note } = req.body;
  if (!agent_id || typeof credits !== 'number' || credits <= 0) {
    return res.status(400).json({ error: 'agent_id and positive credits are required' });
  }
  try {
    const result = addCredits(agent_id, credits, note || 'manual top-up');
    res.json({ agent_id, credits_added: credits, new_balance: result.balance });
  } catch (err) {
    const status = err.message === 'Agent not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Get trust report for calling agent (free)
// GET /vault/trust-report
router.get('/trust-report', (req, res) => {
  try {
    const report = computeTrustScore(req.agentId);
    res.json(report);
  } catch (err) {
    console.error('trust report error:', err);
    res.status(500).json({ error: 'failed to compute trust score' });
  }
});

// Get trust report for any agent by ID (public — no auth required)
// GET /vault/agents/:id/trust-report
router.get('/agents/:id/trust-report', (req, res) => {
  try {
    const report = computeTrustScore(req.params.id);
    res.json(report);
  } catch (err) {
    if (err.message === 'agent not found') return res.status(404).json({ error: 'agent not found' });
    console.error('trust report error:', err);
    res.status(500).json({ error: 'failed to compute trust score' });
  }
});

// POST /vault/agents/:id/vouch — vouch for another agent
// Authenticated agent vouches for agent :id
router.post('/agents/:id/vouch', (req, res) => {
  const vouchee_id = req.params.id;
  const voucher_id = req.agentId;
  if (vouchee_id === voucher_id) return res.status(400).json({ error: 'cannot vouch for yourself' });

  const db = getDb();
  const vouchee = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(vouchee_id);
  if (!vouchee) return res.status(404).json({ error: 'agent not found' });

  const weight = Math.min(1.0, Math.max(0.1, parseFloat(req.body?.weight) || 1.0));

  try {
    db.prepare(`
      INSERT INTO agent_vouches (voucher_id, vouchee_id, weight)
      VALUES (?, ?, ?)
      ON CONFLICT(voucher_id, vouchee_id) DO UPDATE SET weight = excluded.weight
    `).run(voucher_id, vouchee_id, weight);
    res.json({ voucher_id, vouchee_id, weight, status: 'vouched' });
  } catch (err) {
    console.error('vouch error:', err);
    res.status(500).json({ error: 'failed to record vouch' });
  }
});

// PUT /vault/agents/capabilities — set your own capability list
// Body: { capabilities: string[] }
router.put('/agents/capabilities', (req, res) => {
  const { capabilities } = req.body;
  if (!Array.isArray(capabilities)) {
    return res.status(400).json({ error: 'capabilities must be an array of strings' });
  }
  const sanitized = capabilities.map(c => String(c).slice(0, 100)).slice(0, 50);
  const db = getDb();
  db.prepare('UPDATE agents SET capabilities = ? WHERE agent_id = ?')
    .run(JSON.stringify(sanitized), req.agentId);
  res.json({ agent_id: req.agentId, capabilities: sanitized, status: 'updated' });
});

// GET /vault/agents/:id/capabilities — public capabilities lookup
router.get('/agents/:id/capabilities', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT agent_id, agent_type, capabilities FROM agents WHERE agent_id = ?')
    .get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const capabilities = agent.capabilities ? JSON.parse(agent.capabilities) : [];
  res.json({ agent_id: agent.agent_id, agent_type: agent.agent_type, capabilities });
});

// DELETE /vault/agents/:id/vouch — remove your vouch
router.delete('/agents/:id/vouch', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM agent_vouches WHERE voucher_id = ? AND vouchee_id = ?'
  ).run(req.agentId, req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'vouch not found' });
  res.json({ status: 'vouch removed' });
});

// POST /vault/agents/boost — one-time purchase: raises AATS floor from 30 → 45
// Costs 50 credits. Idempotent — re-calling after purchase is a no-op.
router.post('/agents/boost', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT has_boost, credits, hedera_account FROM agents WHERE agent_id = ?').get(req.agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  // Require an agentic wallet (Hedera account) to purchase a boost
  if (!agent.hedera_account) {
    return res.status(403).json({
      error: 'agentic wallet required',
      message: 'Link a Hedera account to your agent before purchasing a trust boost. BrokerAGEnt is for agent-to-agent commerce only.',
    });
  }

  if (agent.has_boost) {
    return res.json({ status: 'already_boosted', message: 'Trust boost already active on this agent.' });
  }

  const billing = deductCredits(req.agentId, 'boost_purchase');
  if (!billing.ok) {
    return res.status(402).json({
      error: 'insufficient credits',
      balance: billing.balance,
      required: billing.required,
      message: `Boost costs ${PRICES.boost_purchase} credits (${PRICES.boost_purchase / 10} HBAR).`,
    });
  }

  try {
    db.prepare('UPDATE agents SET has_boost = 1 WHERE agent_id = ?').run(req.agentId);
    res.json({
      status: 'boosted',
      message: 'Trust boost activated. AATS score floor raised from 30 to 45.',
      credits_spent: PRICES.boost_purchase,
      credits_remaining: billing.balance,
      score_floor: 45,
    });
  } catch (err) {
    // Refund if DB update failed
    refundCredits(req.agentId, 'boost_purchase');
    console.error('boost error:', err);
    res.status(500).json({ error: 'failed to activate boost — credit refunded' });
  }
});

// GET /vault/agents/:id/wallet-check — verify an agent has an agentic wallet (public)
router.get('/agents/:id/wallet-check', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT agent_id, hedera_account, hcs_topic_id FROM agents WHERE agent_id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  res.json({
    agent_id: agent.agent_id,
    has_agentic_wallet: !!agent.hedera_account,
    hedera_account: agent.hedera_account || null,
    hcs_topic_active: !!agent.hcs_topic_id,
  });
});

// GET /vault/agents/:id/score-advisor — AATS gap analysis (costs 5 credits, agent auth)
// Returns prioritized action list with estimated score gains
router.get('/agents/:id/score-advisor', (req, res) => {
  // Must be your own agent or an admin key
  const adminKey = req.headers['x-admin-key'];
  const isAdmin = adminKey && adminKey === process.env.ADMIN_KEY;
  if (!isAdmin && req.agentId !== req.params.id) {
    return res.status(403).json({ error: 'You can only request a score advisor report for your own agent' });
  }

  const billing = deductCredits(req.agentId, 'score_advisor');
  if (!billing.ok) {
    return res.status(402).json({
      error: 'insufficient credits',
      balance: billing.balance,
      required: billing.required,
      message: `Score Advisor costs ${PRICES.score_advisor} credits per report.`,
    });
  }

  try {
    const advice = generateScoreAdvice(req.params.id);
    res.json({ ...advice, credits_spent: PRICES.score_advisor, credits_remaining: billing.balance });
  } catch (err) {
    refundCredits(req.agentId, 'score_advisor');
    if (err.message === 'agent not found') return res.status(404).json({ error: 'agent not found — credit refunded' });
    console.error('score advisor error:', err);
    res.status(500).json({ error: 'failed to generate score advice — credit refunded' });
  }
});

// GET /vault/agents/:id/version-check — check an agent's attested version against the registry (public)
router.get('/agents/:id/version-check', (req, res) => {
  const db = getDb();
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  const attestation = db.prepare(`
    SELECT model_version, attested_at
    FROM agent_attestations
    WHERE agent_id = ?
    ORDER BY attested_at DESC LIMIT 1
  `).get(req.params.id);

  if (!attestation || !attestation.model_version) {
    return res.json({
      agent_id: req.params.id,
      has_attestation: false,
      version_status: 'unattested',
      iaq_impact: 'No IAQ credit awarded without attestation',
      recommendation: 'Submit a model attestation via POST /vault/agents/attest',
    });
  }

  const registry = db.prepare(
    'SELECT status, flagged_reason, effective_date FROM agent_version_registry WHERE model_version = ?'
  ).get(attestation.model_version);

  const attested_days_ago = Math.floor(
    (Date.now() - new Date(attestation.attested_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  const version_status = registry
    ? registry.status
    : (attested_days_ago > 90 ? 'stale' : 'current');

  const iaq_impact_map = {
    current: '+25 pts',
    stale:   '+15 pts (re-attest to restore full credit)',
    deprecated: '+8 pts (upgrade required)',
    flagged: '+0 pts (security risk — upgrade immediately)',
    unknown: '+15 pts (not in registry — treated as stale)',
  };

  res.json({
    agent_id: req.params.id,
    has_attestation: true,
    model_version: attestation.model_version,
    attested_at: attestation.attested_at,
    attested_days_ago,
    version_status,
    in_registry: !!registry,
    flagged_reason: registry?.flagged_reason || null,
    iaq_impact: iaq_impact_map[version_status] || '+15 pts',
    recommendation: version_status === 'flagged'
      ? 'Upgrade immediately — this version has a known security risk'
      : version_status === 'deprecated'
      ? 'This version is deprecated — upgrade to restore full IAQ credit'
      : version_status === 'stale'
      ? 'Re-attest with your current model version (last attestation is >90 days old)'
      : null,
  });
});

// GET /vault/versions — list all versions in the registry (public)
router.get('/versions', (req, res) => {
  const db = getDb();
  try {
    const versions = db.prepare(
      'SELECT model_version, status, flagged_reason, effective_date, created_at FROM agent_version_registry ORDER BY effective_date DESC'
    ).all();
    res.json({ versions, count: versions.length });
  } catch (err) {
    console.error('versions list error:', err);
    res.status(500).json({ error: 'failed to list versions' });
  }
});

// POST /vault/admin/versions — add or update a version in the registry (admin only)
// Body: { model_version, status, flagged_reason (optional), effective_date (optional) }
router.post('/admin/versions', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'invalid or missing X-Admin-Key' });
  }

  const { model_version, status, flagged_reason, effective_date } = req.body;
  if (!model_version || !status) {
    return res.status(400).json({ error: 'model_version and status are required' });
  }

  const VALID_STATUSES = ['current', 'deprecated', 'flagged', 'unknown'];
  if (!VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${VALID_STATUSES.join(', ')}` });
  }

  if (status === 'flagged' && !flagged_reason) {
    return res.status(400).json({ error: 'flagged_reason is required when status is flagged' });
  }

  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO agent_version_registry (model_version, status, flagged_reason, effective_date)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(model_version) DO UPDATE SET
        status = excluded.status,
        flagged_reason = excluded.flagged_reason,
        effective_date = excluded.effective_date
    `).run(
      model_version,
      status,
      flagged_reason || null,
      effective_date || new Date().toISOString().split('T')[0]
    );

    const row = db.prepare('SELECT * FROM agent_version_registry WHERE model_version = ?').get(model_version);
    res.status(201).json({ status: 'ok', version: row });
  } catch (err) {
    console.error('admin versions error:', err);
    res.status(500).json({ error: 'failed to update version registry' });
  }
});

module.exports = router;
