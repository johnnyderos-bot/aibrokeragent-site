/**
 * Console Invites API — create and validate invite tokens (agent-scoped and platform-level)
 */

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const { requireConsoleAuth, getUserRole, requirePlatformRole, PLATFORM_ROLE_LEVELS } = require('./console-auth');

const router = express.Router();

function generateInviteId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * POST /console/invites
 * Owner creates an invite (email, agent_id, role). Returns invite token. Expires 72 hours.
 */
router.post('/', requireConsoleAuth('owner'), (req, res) => {
  const { email, agent_id, role } = req.body || {};
  if (!email || !agent_id || !role) {
    return res.status(400).json({ error: 'email, agent_id, and role are required' });
  }
  if (!['owner', 'admin', 'viewer'].includes(role)) {
    return res.status(400).json({ error: 'role must be owner, admin, or viewer' });
  }

  // Verify caller is owner of the specified agent
  const callerRole = getUserRole(req.consoleUser.id, agent_id);
  if (callerRole !== 'owner') {
    return res.status(403).json({ error: 'you must be the owner of this agent to invite others' });
  }

  // Verify agent exists
  const db = getDb();
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) return res.status(404).json({ error: 'agent not found' });

  const inviteId = generateInviteId();
  const expiresAt = new Date(Date.now() + 72 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO console_invites (id, email, agent_id, role, invited_by_user_id, expires_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(inviteId, email.toLowerCase().trim(), agent_id, role, req.consoleUser.id, expiresAt);

  res.json({
    invite_token: inviteId,
    email: email.toLowerCase().trim(),
    agent_id,
    role,
    expires_at: expiresAt,
  });
});

/**
 * GET /console/invites/:token
 * Validate invite — show who invited, which agent, what role.
 */
router.get('/:token', (req, res) => {
  const db = getDb();
  const invite = db.prepare('SELECT * FROM console_invites WHERE id = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.used_at) return res.status(410).json({ error: 'invite already used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'invite expired' });

  const inviter = db.prepare('SELECT id, name, email FROM console_users WHERE id = ?').get(invite.invited_by_user_id);
  const agent = db.prepare('SELECT agent_id, name FROM agents WHERE agent_id = ?').get(invite.agent_id);

  res.json({
    invite_token: invite.id,
    email: invite.email,
    agent_id: invite.agent_id,
    agent_name: agent?.name || null,
    role: invite.role,
    invited_by: inviter ? { id: inviter.id, name: inviter.name } : null,
    expires_at: invite.expires_at,
    created_at: invite.created_at,
  });
});

/**
 * GET /console/invites
 * List pending invites for agents the caller owns.
 */
router.get('/', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();

  // Get all agents this user owns
  const ownedAgents = db.prepare(`
    SELECT agent_id FROM console_agent_access WHERE user_id = ? AND role = 'owner'
  `).all(req.consoleUser.id).map(r => r.agent_id);

  if (ownedAgents.length === 0) return res.json({ invites: [] });

  const placeholders = ownedAgents.map(() => '?').join(',');
  const now = new Date().toISOString();

  const invites = db.prepare(`
    SELECT ci.*, cu.name as inviter_name, a.name as agent_name
    FROM console_invites ci
    LEFT JOIN console_users cu ON cu.id = ci.invited_by_user_id
    LEFT JOIN agents a ON a.agent_id = ci.agent_id
    WHERE ci.agent_id IN (${placeholders})
      AND ci.used_at IS NULL
      AND ci.expires_at > ?
    ORDER BY ci.created_at DESC
  `).all(...ownedAgents, now);

  res.json({ invites });
});

// ── Platform-level invites ───────────────────────────────────────────────────

/**
 * POST /console/platform-invites
 * Platform owner creates an invite for a friend or employee.
 */
router.post('/platform', requirePlatformRole('owner'), (req, res) => {
  const { email, role } = req.body || {};
  if (!email || !role) return res.status(400).json({ error: 'email and role are required' });
  if (!['owner', 'employee', 'watcher'].includes(role)) {
    return res.status(400).json({ error: 'role must be owner, employee, or watcher' });
  }

  const db = getDb();
  const inviteId  = generateInviteId();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  db.prepare(`
    INSERT INTO console_platform_invites (id, email, platform_role, invited_by_user_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(inviteId, email.toLowerCase().trim(), role, req.consoleUser.id, expiresAt);

  res.json({
    invite_token: inviteId,
    email: email.toLowerCase().trim(),
    platform_role: role,
    expires_at: expiresAt,
    invite_url: `${req.protocol}://${req.get('host')}/console-login.html?invite=${inviteId}`,
  });
});

/**
 * GET /console/platform-invites/:token
 * Validate a platform invite — public, used during registration flow.
 */
router.get('/platform/:token', (req, res) => {
  const db = getDb();
  const invite = db.prepare('SELECT * FROM console_platform_invites WHERE id = ?').get(req.params.token);
  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.used_at) return res.status(410).json({ error: 'invite already used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'invite expired' });

  const inviter = db.prepare('SELECT id, name FROM console_users WHERE id = ?').get(invite.invited_by_user_id);

  res.json({
    invite_token: invite.id,
    email: invite.email,
    platform_role: invite.platform_role,
    invited_by: inviter ? { id: inviter.id, name: inviter.name } : null,
    expires_at: invite.expires_at,
  });
});

/**
 * GET /console/platform-invites
 * List pending platform invites — owner/employee only.
 */
router.get('/platform', requirePlatformRole('employee'), (req, res) => {
  const db  = getDb();
  const now = new Date().toISOString();

  const invites = db.prepare(`
    SELECT pi.*, cu.name as inviter_name
    FROM console_platform_invites pi
    LEFT JOIN console_users cu ON cu.id = pi.invited_by_user_id
    WHERE pi.used_at IS NULL AND pi.expires_at > ?
    ORDER BY pi.created_at DESC
  `).all(now);

  res.json({ invites });
});

module.exports = router;
