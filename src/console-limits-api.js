/**
 * Console Limits API — agent limits + hold toggle
 */

const express = require('express');
const { getDb } = require('./db');
const { requireConsoleAuth } = require('./console-auth');

const router = express.Router({ mergeParams: true });

/**
 * GET /console/agents/:agent_id/limits
 * Get limits for an agent. Requires Owner or Admin.
 */
router.get('/', requireConsoleAuth('admin'), (req, res) => {
  const db = getDb();
  const limits = db.prepare('SELECT * FROM agent_limits WHERE agent_id = ?').get(req.params.agent_id);

  if (!limits) {
    // Return defaults if no row exists
    return res.json({
      agent_id: req.params.agent_id,
      max_contract_value_hbar: null,
      min_counterparty_score: null,
      require_approval_above_hbar: null,
      hold: 0,
      updated_at: null,
    });
  }

  res.json(limits);
});

/**
 * PUT /console/agents/:agent_id/limits
 * Set limits. Requires Owner or Admin.
 */
router.put('/', requireConsoleAuth('admin'), (req, res) => {
  const { max_contract_value_hbar, min_counterparty_score, require_approval_above_hbar } = req.body || {};

  const db = getDb();
  const agentId = req.params.agent_id;

  // Verify agent exists
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  db.prepare(`
    INSERT INTO agent_limits (agent_id, max_contract_value_hbar, min_counterparty_score, require_approval_above_hbar, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      max_contract_value_hbar = excluded.max_contract_value_hbar,
      min_counterparty_score = excluded.min_counterparty_score,
      require_approval_above_hbar = excluded.require_approval_above_hbar,
      updated_at = datetime('now')
  `).run(
    agentId,
    max_contract_value_hbar != null ? Number(max_contract_value_hbar) : null,
    min_counterparty_score != null ? Number(min_counterparty_score) : null,
    require_approval_above_hbar != null ? Number(require_approval_above_hbar) : null,
  );

  const updated = db.prepare('SELECT * FROM agent_limits WHERE agent_id = ?').get(agentId);
  res.json(updated);
});

/**
 * POST /console/agents/:agent_id/hold
 * Toggle hold on/off. Requires Owner only.
 */
router.post('/hold', requireConsoleAuth('owner'), (req, res) => {
  const db = getDb();
  const agentId = req.params.agent_id;

  // Verify agent exists
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agentId);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  // Get current hold status
  const existing = db.prepare('SELECT hold FROM agent_limits WHERE agent_id = ?').get(agentId);
  const currentHold = existing ? existing.hold : 0;
  const newHold = currentHold ? 0 : 1;

  db.prepare(`
    INSERT INTO agent_limits (agent_id, hold, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(agent_id) DO UPDATE SET
      hold = excluded.hold,
      updated_at = datetime('now')
  `).run(agentId, newHold);

  const updated = db.prepare('SELECT * FROM agent_limits WHERE agent_id = ?').get(agentId);
  res.json({ hold: newHold, limits: updated });
});

module.exports = router;
