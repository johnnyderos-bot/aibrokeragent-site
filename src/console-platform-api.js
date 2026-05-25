/**
 * Console Platform API — platform-wide overview and user management
 *
 * GET  /console/platform/overview         — stats visible to any logged-in platform user
 * GET  /console/platform/users            — list all users (owner/employee)
 * PATCH /console/platform/users/:id/role  — change a user's platform_role (owner only)
 * DELETE /console/platform/users/:id      — remove a user (owner only)
 */

const express = require('express');
const { getDb } = require('./db');
const { requirePlatformRole } = require('./console-auth');

const router = express.Router();

/**
 * GET /console/platform/overview
 * Platform stats + recent activity. Visible to any authenticated platform user.
 */
router.get('/overview', requirePlatformRole('watcher'), (req, res) => {
  const db = getDb();

  const safe = (fn) => { try { return fn(); } catch { return null; } };

  const agents_registered = safe(() => db.prepare('SELECT COUNT(*) as n FROM agents').get().n);
  const vault_records     = safe(() => db.prepare('SELECT COUNT(*) as n FROM vault_records').get().n);
  const hedera_anchors    = safe(() => db.prepare('SELECT COUNT(*) as n FROM vault_records WHERE hcs_sequence IS NOT NULL').get().n);

  const contracts_total     = safe(() => db.prepare('SELECT COUNT(*) as n FROM audit_contracts').get().n);
  const contracts_active    = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'ACTIVE'").get().n);
  const contracts_completed = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'COMPLETED'").get().n);
  const total_volume_hbar   = safe(() => db.prepare("SELECT COALESCE(SUM(total_amount_hbar),0) as v FROM audit_contracts WHERE audit_status IN ('ACTIVE','COMPLETED')").get().v);

  const disputes_filed  = safe(() => db.prepare('SELECT COUNT(*) as n FROM disputes').get().n);
  const rulings_issued  = safe(() => db.prepare('SELECT COUNT(*) as n FROM arbitration_rulings').get().n);
  const active_arbitrators = safe(() => db.prepare('SELECT COUNT(*) as n FROM arbitrators WHERE active = 1').get().n);

  const platform_users = safe(() => db.prepare('SELECT COUNT(*) as n FROM console_users WHERE platform_role IS NOT NULL').get().n);

  // Recent contracts (last 5)
  const recent_contracts = safe(() =>
    db.prepare(`
      SELECT id, title, audit_status, total_amount_hbar, buyer_agent, seller_agent, created_at, completed_at
      FROM audit_contracts
      ORDER BY created_at DESC LIMIT 5
    `).all()
  ) || [];

  // Trust score distribution
  const trust_tiers = safe(() => {
    const agents = db.prepare('SELECT agent_id FROM agents').all();
    const { computeTrustScore } = require('./trust-score');
    const tiers = { Platinum: 0, Gold: 0, Silver: 0, Bronze: 0, Restricted: 0, Unscored: 0 };
    for (const { agent_id } of agents) {
      try {
        const ts = computeTrustScore(agent_id);
        const tier = ts?.tier || 'Unscored';
        tiers[tier] = (tiers[tier] || 0) + 1;
      } catch { tiers.Unscored++; }
    }
    return tiers;
  }) || {};

  // Team members with platform roles
  const team = safe(() =>
    db.prepare(`
      SELECT id, name, email, platform_role, active, deactivated_at, created_at
      FROM console_users
      WHERE platform_role IS NOT NULL
      ORDER BY
        CASE platform_role WHEN 'owner' THEN 1 WHEN 'employee' THEN 2 ELSE 3 END,
        created_at ASC
    `).all()
  ) || [];

  res.json({
    stats: {
      agents_registered,
      vault_records,
      hedera_anchors,
      contracts_total,
      contracts_active,
      contracts_completed,
      total_volume_hbar,
      disputes_filed,
      rulings_issued,
      active_arbitrators,
      platform_users,
    },
    trust_tiers,
    recent_contracts,
    team,
    network: process.env.HEDERA_NETWORK || 'testnet',
    viewer: {
      id: req.consoleUser.id,
      name: req.consoleUser.name,
      platform_role: req.consoleUser.platform_role,
    },
  });
});

/**
 * GET /console/platform/users
 * Full user list with roles. Owner/employee only.
 */
router.get('/users', requirePlatformRole('employee'), (req, res) => {
  const db = getDb();
  const users = db.prepare(`
    SELECT id, name, email, platform_role, active, deactivated_at, created_at
    FROM console_users
    ORDER BY created_at ASC
  `).all();
  res.json({ users });
});

/**
 * PATCH /console/platform/users/:id/role
 * Change a user's platform_role. Owner only.
 */
router.patch('/users/:id/role', requirePlatformRole('owner'), (req, res) => {
  const { role } = req.body || {};
  if (!['owner', 'employee', 'watcher'].includes(role) && role !== null) {
    return res.status(400).json({ error: 'role must be owner, employee, watcher, or null' });
  }

  const db = getDb();
  const target = db.prepare('SELECT id, name FROM console_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.consoleUser.id && role !== 'owner') {
    return res.status(400).json({ error: 'cannot demote yourself' });
  }

  db.prepare('UPDATE console_users SET platform_role = ? WHERE id = ?').run(role || null, req.params.id);
  res.json({ ok: true, user_id: req.params.id, platform_role: role || null });
});

/**
 * POST /console/platform/users/:id/deactivate
 * Disable login without deleting. Owner only.
 */
router.post('/users/:id/deactivate', requirePlatformRole('owner'), (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT id, name, active FROM console_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.consoleUser.id) return res.status(400).json({ error: 'cannot deactivate yourself' });

  db.prepare(`
    UPDATE console_users
    SET active = 0, session_token = NULL, session_expires_at = NULL, deactivated_at = datetime('now')
    WHERE id = ?
  `).run(req.params.id);

  res.json({ ok: true, user_id: req.params.id, active: false });
});

/**
 * POST /console/platform/users/:id/reactivate
 * Re-enable a deactivated user. Owner only.
 */
router.post('/users/:id/reactivate', requirePlatformRole('owner'), (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT id FROM console_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });

  db.prepare(`UPDATE console_users SET active = 1, deactivated_at = NULL WHERE id = ?`).run(req.params.id);
  res.json({ ok: true, user_id: req.params.id, active: true });
});

/**
 * DELETE /console/platform/users/:id
 * Permanently delete a user. Owner only.
 */
router.delete('/users/:id', requirePlatformRole('owner'), (req, res) => {
  const db = getDb();
  const target = db.prepare('SELECT id, name FROM console_users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'user not found' });
  if (target.id === req.consoleUser.id) return res.status(400).json({ error: 'cannot delete yourself' });

  db.prepare('DELETE FROM console_users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * GET /console/platform/agents
 * List all registered agents on the platform. Platform owner/employee only.
 * Fixes: operators can't find agents registered via API (not console signup) in the dropdown.
 */
router.get('/agents', requirePlatformRole('employee'), (req, res) => {
  const db = getDb();
  const { grantAgentAccess } = require('./console-auth');
  const agents = db.prepare(
    'SELECT agent_id, name, agent_type, credits, created_at FROM agents ORDER BY created_at DESC'
  ).all();
  const myAccess = db.prepare(
    'SELECT agent_id FROM console_agent_access WHERE user_id = ?'
  ).all(req.consoleUser.id).map(r => r.agent_id);
  res.json({
    agents: agents.map(a => ({
      ...a,
      has_access: myAccess.includes(a.agent_id),
    })),
  });
});

/**
 * POST /console/platform/agents/:id/claim
 * Grant the calling platform owner access to any registered agent.
 * Use when an agent self-registered via API and doesn't appear in the dashboard dropdown.
 */
router.post('/agents/:id/claim', requirePlatformRole('owner'), (req, res) => {
  const db = getDb();
  const { grantAgentAccess } = require('./console-auth');
  const agent = db.prepare('SELECT agent_id, name FROM agents WHERE agent_id = ?').get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });
  const role = req.body?.role && ['owner', 'admin', 'viewer'].includes(req.body.role)
    ? req.body.role
    : 'owner';
  grantAgentAccess(req.consoleUser.id, agent.agent_id, role);
  res.json({ ok: true, agent_id: agent.agent_id, agent_name: agent.name, role, claimed_by: req.consoleUser.id });
});

module.exports = router;
