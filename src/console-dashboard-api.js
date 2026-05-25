/**
 * Console Dashboard API
 * GET /console/agents/:agent_id/dashboard
 * GET /console/agents/:agent_id/contract-log
 */

const express = require('express');
const { getDb } = require('./db');
const { requireConsoleAuth } = require('./console-auth');
const { computeTrustScore } = require('./trust-score');

const router = express.Router({ mergeParams: true });

/**
 * GET /console/agents/:agent_id/dashboard
 */
router.get('/dashboard', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();
  const agentId = req.params.agent_id;

  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  // Compute trust score
  let trustScore = null;
  try { trustScore = computeTrustScore(agentId); } catch (e) { /* non-fatal */ }

  // Contract counts
  const contractCounts = (() => {
    try {
      const rows = db.prepare(`
        SELECT audit_status, COUNT(*) as n
        FROM audit_contracts
        WHERE buyer_agent = ? OR seller_agent = ?
        GROUP BY audit_status
      `).all(agentId, agentId);
      const counts = {};
      for (const r of rows) counts[r.audit_status] = r.n;
      return counts;
    } catch { return {}; }
  })();

  // Unread notification count
  const unread_notifications = (() => {
    try {
      return db.prepare('SELECT COUNT(*) as n FROM agent_notifications WHERE agent_id = ? AND read = 0').get(agentId).n;
    } catch { return 0; }
  })();

  // Agent limits
  const limits = db.prepare('SELECT * FROM agent_limits WHERE agent_id = ?').get(agentId) || {
    agent_id: agentId, max_contract_value_hbar: null, min_counterparty_score: null,
    require_approval_above_hbar: null, hold: 0, updated_at: null,
  };

  // Recent notifications (last 5)
  const recent_notifications = (() => {
    try {
      return db.prepare('SELECT * FROM agent_notifications WHERE agent_id = ? ORDER BY created_at DESC LIMIT 5').all(agentId);
    } catch { return []; }
  })();

  // Last 5 contracts with counterparty AATS
  const recent_contracts = (() => {
    try {
      const contracts = db.prepare(`
        SELECT id, title, audit_status, total_amount_hbar, buyer_agent, seller_agent,
               created_at, completed_at, hcs_sequence,
               pre_audit_hcs_sequence, post_settlement_hcs_sequence
        FROM audit_contracts
        WHERE buyer_agent = ? OR seller_agent = ?
        ORDER BY created_at DESC
        LIMIT 5
      `).all(agentId, agentId);

      return contracts.map(c => {
        const counterpartyId = c.buyer_agent === agentId ? c.seller_agent : c.buyer_agent;
        const role = c.buyer_agent === agentId ? 'buyer' : 'seller';
        let counterparty_aats = null;
        try {
          const ts = computeTrustScore(counterpartyId);
          counterparty_aats = ts.score || null;
        } catch { /* non-fatal */ }

        // Findings summary
        let findings_summary = { CRITICAL: 0, WARNING: 0, INFO: 0 };
        try {
          const findings = db.prepare('SELECT severity, COUNT(*) as n FROM audit_findings WHERE contract_id = ? GROUP BY severity').all(c.id);
          for (const f of findings) findings_summary[f.severity] = f.n;
        } catch { /* non-fatal */ }

        return { ...c, role, counterparty_id: counterpartyId, counterparty_aats, findings_summary };
      });
    } catch { return []; }
  })();

  res.json({
    agent: {
      agent_id: agent.agent_id,
      name: agent.name,
      agent_type: agent.agent_type,
      credits: agent.credits,
      hedera_account: agent.hedera_account,
      created_at: agent.created_at,
    },
    trust_score: trustScore,
    contract_counts: contractCounts,
    unread_notifications,
    limits,
    recent_notifications,
    recent_contracts,
  });
});

/**
 * GET /console/agents/:agent_id/contract-log
 * Paginated contract log.
 * ?page=1&limit=20&sort=created_at&dir=desc&status=
 */
router.get('/contract-log', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();
  const agentId = req.params.agent_id;

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;

  const ALLOWED_SORT = ['created_at', 'total_amount_hbar', 'audit_status', 'completed_at'];
  const sort = ALLOWED_SORT.includes(req.query.sort) ? req.query.sort : 'created_at';
  const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';

  const statusFilter = req.query.status || null;

  let where = '(buyer_agent = ? OR seller_agent = ?)';
  const params = [agentId, agentId];

  if (statusFilter) {
    where += ' AND audit_status = ?';
    params.push(statusFilter);
  }

  const total = db.prepare(`SELECT COUNT(*) as n FROM audit_contracts WHERE ${where}`).get(...params).n;

  const contracts = db.prepare(`
    SELECT id, title, audit_status, total_amount_hbar, buyer_agent, seller_agent,
           created_at, completed_at, hcs_sequence,
           pre_audit_hcs_sequence, post_settlement_hcs_sequence,
           pre_audit_vault_record_id, post_settlement_vault_record_id
    FROM audit_contracts
    WHERE ${where}
    ORDER BY ${sort} ${dir}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const rows = contracts.map(c => {
    const counterpartyId = c.buyer_agent === agentId ? c.seller_agent : c.buyer_agent;
    const role = c.buyer_agent === agentId ? 'buyer' : 'seller';

    let counterparty_aats = null;
    try {
      const ts = computeTrustScore(counterpartyId);
      counterparty_aats = ts.score || null;
    } catch { /* non-fatal */ }

    let my_aats = null;
    try {
      const ts = computeTrustScore(agentId);
      my_aats = ts.score || null;
    } catch { /* non-fatal */ }

    let findings_summary = { CRITICAL: 0, WARNING: 0, INFO: 0 };
    try {
      const findings = db.prepare('SELECT severity, COUNT(*) as n FROM audit_findings WHERE contract_id = ? GROUP BY severity').all(c.id);
      for (const f of findings) findings_summary[f.severity] = f.n;
    } catch { /* non-fatal */ }

    return {
      ...c,
      role,
      counterparty_id: counterpartyId,
      counterparty_aats,
      my_aats,
      findings_summary,
    };
  });

  res.json({
    contracts: rows,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  });
});

module.exports = router;
