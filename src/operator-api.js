const express = require('express');
const crypto  = require('crypto');
const { registerOperator, linkAgent, getLinkedAgents, requireOperatorAuth } = require('./operator-auth');
const { getDb } = require('./db');
const { storeRecord, readRecord, listRecords } = require('./vault');
const { anchorRecord } = require('./hedera');
const { checkName } = require('./ofac');
const { submitKyc, updateKycStatus, getKycStatus, getKycRecord } = require('./kyc');
const { listSarQueue, resolveSar } = require('./aml');
const { computeTrustScore } = require('./trust-score');

const router = express.Router();

// POST /operators/register
// Register a human operator. No auth required.
// Body: { name, email (optional), entity (optional), type (optional) }
router.post('/register', (req, res) => {
  const { name, email, entity, type } = req.body;
  if (!name || typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'name is required (max 100 chars)' });
  }
  if (email && (typeof email !== 'string' || email.length > 200)) {
    return res.status(400).json({ error: 'email is invalid' });
  }

  // OFAC name screening runs only after input validation passes
  const nameToScreen = name.trim();
  const nameScreen = checkName(nameToScreen);
  if (nameScreen.blocked) {
    console.warn(`[ofac] operator registration blocked: "${nameToScreen}" matched "${nameScreen.match}"`);
    return res.status(403).json({ error: 'registration denied — identity check failed', code: 'OFAC_MATCH' });
  }

  // Screen entity name if provided
  if (entity) {
    const entityScreen = checkName(entity.trim());
    if (entityScreen.blocked) {
      console.warn(`[ofac] operator registration blocked (entity): "${entity}" matched "${entityScreen.match}"`);
      return res.status(403).json({ error: 'registration denied — entity identity check failed', code: 'OFAC_MATCH' });
    }
  }

  try {
    const db = getDb();
    const result = registerOperator(nameToScreen, email || null);
    // Store entity and operator type
    if (entity || type) {
      db.prepare('UPDATE operators SET entity = ?, operator_type = ? WHERE operator_id = ?')
        .run(entity || null, type || 'founder', result.operator_id);
    }
    res.status(201).json({
      ...result,
      entity: entity || null,
      operator_type: type || 'founder',
      warning: 'Save your api_key now — it will not be shown again',
      note: 'Use X-Operator-Key header to authenticate as operator',
    });
  } catch (err) {
    console.error('operator register error:', err);
    res.status(500).json({ error: 'registration failed' });
  }
});

// All routes below require operator auth
router.use(requireOperatorAuth);

// POST /operators/agents/link
// Link an agent to this operator account.
// Body: { agent_id }
router.post('/agents/link', (req, res) => {
  const { agent_id } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
  try {
    const result = linkAgent(req.operatorId, agent_id);
    res.json(result);
  } catch (err) {
    const status = err.message === 'agent not found' ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /operators/agents
// List all agents linked to this operator.
router.get('/agents', (req, res) => {
  try {
    const agents = getLinkedAgents(req.operatorId);
    res.json({ operator_id: req.operatorId, agents });
  } catch (err) {
    console.error('list agents error:', err);
    res.status(500).json({ error: 'failed to list agents' });
  }
});

// GET /operators/profile
// Returns the operator's profile and linked agents with AATS scores.
router.get('/profile', (req, res) => {
  try {
    const db = getDb();
    const op = db.prepare('SELECT operator_id, name, email, entity, operator_type, kyc_status, created_at FROM operators WHERE operator_id = ?').get(req.operatorId);
    if (!op) return res.status(404).json({ error: 'operator not found' });
    const agents = getLinkedAgents(req.operatorId);
    const agentsWithScore = agents.map(a => {
      const info = db.prepare('SELECT name, agent_type, credits, hcs_topic_id, created_at FROM agents WHERE agent_id = ?').get(a.agent_id);
      let score = null, tier = null;
      try { const s = computeTrustScore(a.agent_id); score = s.score; tier = s.tier; } catch {}
      return { ...a, ...info, trust_score: score, tier };
    });
    const credits = db.prepare("SELECT COALESCE(SUM(amount), 0) as n FROM billing_ledger WHERE agent_id IN (SELECT agent_id FROM operator_agents WHERE operator_id = ?) AND type = 'credit'").get(req.operatorId);
    res.json({ ...op, agents: agentsWithScore, credits_remaining: Math.max(0, credits?.n || 0) });
  } catch (err) {
    console.error('operator profile error:', err);
    res.status(500).json({ error: 'failed to load profile' });
  }
});

// POST /operators/flash
// Initiate a Flash event — operator discloses agent credentials to a recipient.
// Body: { agent_id, recipient, scope: 'identity'|'trust_score'|'capabilities'|'full' }
router.post('/flash', async (req, res) => {
  const { agent_id, recipient, scope = 'trust_score' } = req.body;
  if (!agent_id) return res.status(400).json({ error: 'agent_id is required' });
  if (!recipient) return res.status(400).json({ error: 'recipient is required' });
  const SCOPES = ['identity', 'trust_score', 'capabilities', 'full'];
  if (!SCOPES.includes(scope)) return res.status(400).json({ error: `scope must be one of: ${SCOPES.join(', ')}` });

  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (!linked.includes(agent_id)) return res.status(403).json({ error: 'agent not linked to this operator' });

    const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
    if (!agent) return res.status(404).json({ error: 'agent not found' });

    // Build credential snapshot based on scope
    const scoreData = computeTrustScore(agent_id);
    const flash_event_id = 'flash_' + crypto.randomBytes(12).toString('hex');
    const timestamp = new Date().toISOString();

    let payload = { agent_id, flash_event_id, scope, timestamp, operator_id: req.operatorId, recipient };
    if (scope === 'identity' || scope === 'full') {
      payload.identity = { name: agent.name, agent_id, agent_type: agent.agent_type, registered_at: agent.created_at, hedera_account: agent.hedera_account, hcs_topic_id: agent.hcs_topic_id };
    }
    if (scope === 'trust_score' || scope === 'full') {
      payload.trust_score = { score: scoreData.score, tier: scoreData.tier, sub_scores: scoreData.sub_scores, weights: scoreData.weights };
    }
    if (scope === 'capabilities' || scope === 'full') {
      payload.capabilities = agent.capabilities ? JSON.parse(agent.capabilities) : [];
    }

    // Anchor to HCS if agent has topic
    let hcs_sequence = null;
    try {
      if (agent.hcs_topic_id) {
        const { anchorRecord } = require('./hedera');
        const anchor = await anchorRecord(agent.hcs_topic_id, { type: 'FLASH_EVENT', flash_event_id, operator_id: req.operatorId, recipient, scope, timestamp });
        hcs_sequence = anchor.sequenceNumber;
      }
    } catch (hcsErr) {
      console.warn('[flash] HCS anchor failed:', hcsErr.message);
    }

    // Store event
    db.prepare(`INSERT INTO flash_events (operator_id, agent_id, recipient, scope, flash_event_id, hcs_sequence, payload) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(req.operatorId, agent_id, recipient, scope, flash_event_id, hcs_sequence, JSON.stringify(payload));

    res.status(201).json({ flash_event_id, hcs_sequence, hcs_topic_id: agent.hcs_topic_id, timestamp, scope, recipient, credential_snapshot: payload });
  } catch (err) {
    console.error('flash error:', err);
    res.status(500).json({ error: 'failed to initiate flash event' });
  }
});

// GET /operators/flashes
// List Flash events initiated by this operator.
router.get('/flashes', (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare('SELECT id, agent_id, recipient, scope, flash_event_id, hcs_sequence, created_at FROM flash_events WHERE operator_id = ? ORDER BY created_at DESC LIMIT 50').all(req.operatorId);
    res.json({ flashes: rows });
  } catch (err) {
    res.status(500).json({ error: 'failed to list flash events' });
  }
});

// GET /operators/alerts
// List governance alerts requiring operator response (OGPP).
router.get('/alerts', (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    const alerts = [];

    // Disputes awaiting response
    if (linked.length > 0) {
      const placeholders = linked.map(() => '?').join(',');
      const disputes = db.prepare(`
        SELECT id, responding_agent, status, response_deadline, filed_at
        FROM disputes
        WHERE responding_agent IN (${placeholders})
          AND status = 'filed'
          AND response_deadline IS NOT NULL
      `).all(...linked);
      for (const d of disputes) {
        const deadline = new Date(d.response_deadline);
        const now = new Date();
        const hours_remaining = Math.max(0, Math.round((deadline - now) / 3600000));
        alerts.push({
          id: d.id,
          agent_id: d.responding_agent,
          type: 'DISPUTE_RESPONSE_REQUIRED',
          severity: hours_remaining < 24 ? 'HIGH' : 'MEDIUM',
          description: `Dispute requires response`,
          response_deadline: d.response_deadline,
          hours_remaining,
          filed_at: d.filed_at,
        });
      }

      // Agents with low credits (< 10) — fund warning
      const lowCredit = db.prepare(`SELECT agent_id, credits FROM agents WHERE agent_id IN (${placeholders}) AND credits < 10`).all(...linked);
      for (const a of lowCredit) {
        alerts.push({ id: `low_credit_${a.agent_id}`, agent_id: a.agent_id, type: 'LOW_CREDITS', severity: a.credits <= 0 ? 'HIGH' : 'MEDIUM', description: `Agent credits low (${Math.round(a.credits * 10) / 10} remaining)`, response_deadline: null, hours_remaining: null });
      }
    }

    res.json({ alerts, total: alerts.length });
  } catch (err) {
    console.error('alerts error:', err);
    res.status(500).json({ error: 'failed to load alerts' });
  }
});

// GET /operators/records
// Read all vault records across all linked agents.
// Optional query: ?type=session_summary&agent_id=agent_xxx
router.get('/records', (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (linked.length === 0) return res.json([]);

    const { type, agent_id } = req.query;
    const targets = agent_id && linked.includes(agent_id) ? [agent_id] : linked;

    const placeholders = targets.map(() => '?').join(',');
    let query = `SELECT * FROM vault_records WHERE agent_id IN (${placeholders})`;
    const params = [...targets];

    if (type) { query += ' AND record_type = ?'; params.push(type); }

    query += ' ORDER BY created_at DESC';

    const rows = db.prepare(query).all(...params);
    res.json(rows.map(r => ({
      ...r,
      permissions: JSON.parse(r.permissions || '[]'),
      encrypted_content: undefined, // never expose encrypted content via operator list
    })));
  } catch (err) {
    console.error('operator records error:', err);
    res.status(500).json({ error: 'failed to list records' });
  }
});

// GET /operators/records/:id
// Read a specific vault record from any linked agent (decrypted).
router.get('/records/:id', (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);

    const row = db.prepare('SELECT agent_id FROM vault_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!linked.includes(row.agent_id)) return res.status(403).json({ error: 'forbidden' });

    const record = readRecord(req.params.id, row.agent_id);
    if (!record) return res.status(404).json({ error: 'not found' });
    res.json(record);
  } catch (err) {
    console.error('operator read record error:', err);
    res.status(500).json({ error: 'failed to read record' });
  }
});

// POST /operators/records/:id/acknowledge
// Operator acknowledges a shared record — confirms they've seen it.
// Anchored to HCS as mutual acknowledgment.
router.post('/records/:id/acknowledge', async (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);

    const row = db.prepare('SELECT * FROM vault_records WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'not found' });
    if (!linked.includes(row.agent_id)) return res.status(403).json({ error: 'forbidden' });
    if (row.operator_acknowledged_at) {
      return res.json({ already_acknowledged: true, acknowledged_at: row.operator_acknowledged_at });
    }

    const acknowledged_at = new Date().toISOString();
    db.prepare(
      'UPDATE vault_records SET shared_with_operator = ?, operator_acknowledged_at = ? WHERE id = ?'
    ).run(req.operatorId, acknowledged_at, req.params.id);

    // Anchor acknowledgment to HCS
    let hcs_sequence = null;
    try {
      if (row.hcs_topic_id) {
        const anchor = await anchorRecord(row.hcs_topic_id, {
          type: 'OPERATOR_ACKNOWLEDGMENT',
          record_id: row.id,
          content_hash: row.content_hash,
          operator_id: req.operatorId,
          acknowledged_at,
        });
        hcs_sequence = anchor.sequenceNumber;
      }
    } catch (err) {
      console.error('HCS anchor failed for acknowledgment:', err.message);
    }

    res.json({
      record_id: req.params.id,
      operator_id: req.operatorId,
      acknowledged_at,
      hcs_sequence,
    });
  } catch (err) {
    console.error('acknowledge error:', err);
    res.status(500).json({ error: 'failed to acknowledge record' });
  }
});

// POST /operators/session-summary
// Operator or agent writes a structured session summary.
// Body: { agent_id, title, decisions: [], commitments: [], context, anchor }
router.post('/session-summary', async (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    const { agent_id, title, decisions, commitments, context, anchor = true } = req.body;

    if (!agent_id || !title) return res.status(400).json({ error: 'agent_id and title are required' });
    if (!linked.includes(agent_id)) return res.status(403).json({ error: 'agent not linked to this operator' });

    const content = JSON.stringify({
      type: 'session_summary',
      title,
      decisions:   decisions   || [],
      commitments: commitments || [],
      context:     context     || '',
      operator_id: req.operatorId,
      recorded_at: new Date().toISOString(),
    });

    // Store via vault (encrypts + anchors to HCS)
    const record = await storeRecord(agent_id, title, content);

    // Tag as session_summary and link to operator
    db.prepare(
      "UPDATE vault_records SET record_type = 'session_summary', shared_with_operator = ? WHERE id = ?"
    ).run(req.operatorId, record.id);

    res.status(201).json({
      ...record,
      record_type: 'session_summary',
      shared_with_operator: req.operatorId,
    });
  } catch (err) {
    console.error('session summary error:', err);
    res.status(500).json({ error: 'failed to store session summary' });
  }
});

// GET /operators/session-summaries
// List all session summaries across linked agents, most recent first.
router.get('/session-summaries', (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (linked.length === 0) return res.json([]);

    const placeholders = linked.map(() => '?').join(',');
    const rows = db.prepare(`
      SELECT id, agent_id, label, content_hash, hcs_topic_id, hcs_sequence,
             operator_acknowledged_at, created_at
      FROM vault_records
      WHERE agent_id IN (${placeholders}) AND record_type = 'session_summary'
      ORDER BY created_at DESC
    `).all(...linked);

    res.json(rows);
  } catch (err) {
    console.error('session summaries error:', err);
    res.status(500).json({ error: 'failed to list session summaries' });
  }
});

// ── KYC endpoints ─────────────────────────────────────────────────────────────

// GET /operators/kyc/status — own KYC status
router.get('/kyc/status', (req, res) => {
  try {
    const status = getKycStatus(req.operatorId);
    const record = getKycRecord(req.operatorId);
    res.json({
      operator_id: req.operatorId,
      kyc_status: status,
      level: record?.level || null,
      pep_flag: record?.pep_flag || 0,
      expires_at: record?.expires_at || null,
      provider: record?.provider || null,
    });
  } catch (err) {
    res.status(500).json({ error: 'failed to get KYC status' });
  }
});

// POST /operators/kyc/submit — submit KYC attestation from provider
// Body: { provider, applicant_id, verification_hash, level }
// Operators submit the hash + provider reference after completing verification
// on the provider's platform. Status starts as 'pending' until webhook confirms.
router.post('/kyc/submit', (req, res) => {
  try {
    const { provider, applicant_id, verification_hash, level } = req.body;
    if (!provider || !applicant_id) {
      return res.status(400).json({ error: 'provider and applicant_id are required' });
    }
    const result = submitKyc({
      operator_id: req.operatorId,
      provider,
      applicant_id,
      verification_hash,
      level: level || 'basic',
    });
    res.status(201).json({
      ...result,
      message: 'KYC submission recorded — pending provider confirmation',
    });
  } catch (err) {
    console.error('kyc submit error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /operators/kyc/webhook — receive KYC decision from provider (ADMIN_KEY protected)
// Body: { operator_id, status, rejection_reason }
router.post('/kyc/webhook', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'admin key required' });
  }
  try {
    const { operator_id, status, rejection_reason } = req.body;
    if (!operator_id || !status) {
      return res.status(400).json({ error: 'operator_id and status are required' });
    }
    if (!['approved', 'rejected', 'expired'].includes(status)) {
      return res.status(400).json({ error: 'status must be approved, rejected, or expired' });
    }
    const result = updateKycStatus({ operator_id, status, rejection_reason });
    res.json(result);
  } catch (err) {
    console.error('kyc webhook error:', err);
    res.status(400).json({ error: err.message });
  }
});

// ── SAR queue (admin only) ────────────────────────────────────────────────────

// GET /operators/admin/sar-queue
router.get('/admin/sar-queue', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'admin key required' });
  }
  const { status } = req.query;
  res.json({ items: listSarQueue(status || 'pending') });
});

// POST /operators/admin/sar-queue/:id/resolve
router.post('/admin/sar-queue/:id/resolve', (req, res) => {
  const adminKey = req.headers['x-admin-key'];
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'admin key required' });
  }
  try {
    const { decision, notes } = req.body;
    const result = resolveSar(req.params.id, decision, notes);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PATCH /operators/agents/:agent_id/flash-state
// Set Flash state (private/flash/public) for an agent. Anchored to HCS.
router.patch('/agents/:agent_id/flash-state', async (req, res) => {
  const { agent_id } = req.params;
  const { state } = req.body;
  const STATES = ['private', 'flash', 'public'];
  if (!STATES.includes(state)) return res.status(400).json({ error: `state must be one of: ${STATES.join(', ')}` });
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (!linked.includes(agent_id)) return res.status(403).json({ error: 'agent not linked to this operator' });

    db.prepare('UPDATE operator_agents SET flash_state = ? WHERE operator_id = ? AND agent_id = ?')
      .run(state, req.operatorId, agent_id);

    let hcs_sequence = null;
    try {
      const agent = db.prepare('SELECT hcs_topic_id FROM agents WHERE agent_id = ?').get(agent_id);
      if (agent?.hcs_topic_id) {
        const anchor = await anchorRecord(agent.hcs_topic_id, {
          type: 'FLASH_STATE_CHANGE', agent_id, operator_id: req.operatorId,
          new_state: state, timestamp: new Date().toISOString(),
        });
        hcs_sequence = anchor.sequenceNumber;
      }
    } catch (err) { console.warn('[flash-state] HCS anchor failed:', err.message); }

    res.json({ agent_id, flash_state: state, hcs_sequence, updated_at: new Date().toISOString() });
  } catch (err) {
    console.error('flash state error:', err);
    res.status(500).json({ error: 'failed to update flash state' });
  }
});

function defaultFlashRules() {
  return {
    min_tx_value_for_flash: 500,
    min_counterparty_score: 0,
    min_counterparty_tier: 'any',
    require_mutual_disclosure: false,
    high_risk_contracts_full_scope: false,
    scope_by_value: { enabled: false, low_threshold: 100, low_scope: 'identity', high_scope: 'full' },
  };
}

// GET /operators/agents/:agent_id/flash-rules
router.get('/agents/:agent_id/flash-rules', (req, res) => {
  const { agent_id } = req.params;
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (!linked.includes(agent_id)) return res.status(403).json({ error: 'agent not linked to this operator' });

    const row = db.prepare('SELECT rules, updated_at FROM flash_rules WHERE agent_id = ? AND operator_id = ?').get(agent_id, req.operatorId);
    res.json({ agent_id, rules: row ? JSON.parse(row.rules) : defaultFlashRules(), updated_at: row?.updated_at || null });
  } catch (err) {
    res.status(500).json({ error: 'failed to load flash rules' });
  }
});

// POST /operators/agents/:agent_id/flash-rules
router.post('/agents/:agent_id/flash-rules', (req, res) => {
  const { agent_id } = req.params;
  const { rules } = req.body;
  if (!rules || typeof rules !== 'object') return res.status(400).json({ error: 'rules object required' });
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (!linked.includes(agent_id)) return res.status(403).json({ error: 'agent not linked to this operator' });

    const updated_at = new Date().toISOString();
    db.prepare(`INSERT INTO flash_rules (agent_id, operator_id, rules, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(agent_id, operator_id) DO UPDATE SET rules = excluded.rules, updated_at = excluded.updated_at`)
      .run(agent_id, req.operatorId, JSON.stringify(rules), updated_at);

    res.json({ agent_id, rules, updated_at, saved: true });
  } catch (err) {
    console.error('flash rules save error:', err);
    res.status(500).json({ error: 'failed to save flash rules' });
  }
});

// GET /operators/contracts
// List all contracts where any linked agent is buyer or seller.
// Optional query: ?status=ACTIVE&agent_id=...
router.get('/contracts', (req, res) => {
  try {
    const db = getDb();
    const linked = getLinkedAgents(req.operatorId).map(a => a.agent_id);
    if (linked.length === 0) return res.json({ contracts: [], counts: {} });

    const { status, agent_id } = req.query;
    const targets = agent_id && linked.includes(agent_id) ? [agent_id] : linked;
    const placeholders = targets.map(() => '?').join(',');

    let query = `
      SELECT c.*,
             buyer.name  AS buyer_name,
             seller.name AS seller_name
      FROM audit_contracts c
      LEFT JOIN agents buyer  ON buyer.agent_id  = c.buyer_agent
      LEFT JOIN agents seller ON seller.agent_id = c.seller_agent
      WHERE (c.buyer_agent IN (${placeholders}) OR c.seller_agent IN (${placeholders}))
    `;
    const params = [...targets, ...targets];

    if (status) { query += ' AND c.audit_status = ?'; params.push(status.toUpperCase()); }
    query += ' ORDER BY c.created_at DESC LIMIT 200';

    const contracts = db.prepare(query).all(...params);

    // Add findings summary to each contract
    const db2 = require('./db').getDb();
    const enriched = contracts.map(c => {
      const findings = db2.prepare(
        'SELECT severity, COUNT(*) AS cnt FROM audit_findings WHERE contract_id = ? GROUP BY severity'
      ).all(c.id);
      const fs = {};
      findings.forEach(f => { fs[f.severity] = f.cnt; });
      return { ...c, findings_summary: fs };
    });

    // Count by status
    const counts = enriched.reduce((acc, c) => {
      acc[c.audit_status] = (acc[c.audit_status] || 0) + 1;
      return acc;
    }, {});

    res.json({ contracts: enriched, counts, linked_agents: linked });
  } catch (err) {
    console.error('operator contracts error:', err);
    res.status(500).json({ error: 'failed to list contracts' });
  }
});

module.exports = router;
