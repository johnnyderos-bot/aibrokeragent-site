/**
 * Console Auth API — register, login, logout, me
 */

const express = require('express');
const { getDb } = require('./db');
const {
  createUser,
  loginUser,
  logoutUser,
  getUserAgentAccess,
  grantAgentAccess,
  setPlatformRole,
  requireConsoleAuth,
  generateId,
} = require('./console-auth');

const router = express.Router();

/**
 * POST /console/auth/register
 * Accept an invite token, set name + password, create user + grant access.
 */
router.post('/register', (req, res) => {
  const { token, name, password } = req.body || {};
  if (!token || !name || !password) {
    return res.status(400).json({ error: 'token, name, and password are required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'password must be at least 8 characters' });
  }

  const db = getDb();

  // Check platform invite first, then fall back to agent invite
  const platformInvite = db.prepare('SELECT * FROM console_platform_invites WHERE id = ?').get(token);
  const agentInvite    = !platformInvite
    ? db.prepare('SELECT * FROM console_invites WHERE id = ?').get(token)
    : null;
  const invite = platformInvite || agentInvite;

  if (!invite) return res.status(404).json({ error: 'invite not found' });
  if (invite.used_at) return res.status(409).json({ error: 'invite already used' });
  if (new Date(invite.expires_at) < new Date()) return res.status(410).json({ error: 'invite expired' });

  // Check email not already registered
  const existing = db.prepare('SELECT id FROM console_users WHERE email = ?').get(invite.email.toLowerCase().trim());
  if (existing) return res.status(409).json({ error: 'email already registered' });

  try {
    const result = db.transaction(() => {
      const { user_id, session_token, session_expires } = createUser(invite.email, name, password);

      if (platformInvite) {
        // Platform invite — set platform-level role
        setPlatformRole(user_id, platformInvite.platform_role);
        db.prepare("UPDATE console_platform_invites SET used_at = datetime('now') WHERE id = ?").run(token);
      } else {
        // Agent invite — grant per-agent access
        grantAgentAccess(user_id, agentInvite.agent_id, agentInvite.role);
        db.prepare("UPDATE console_invites SET used_at = datetime('now') WHERE id = ?").run(token);
      }

      return { user_id, session_token, session_expires };
    })();

    const agentAccess = getUserAgentAccess(result.user_id);
    const user = db.prepare('SELECT platform_role FROM console_users WHERE id = ?').get(result.user_id);

    res.json({
      user_id: result.user_id,
      session_token: result.session_token,
      session_expires: result.session_expires,
      platform_role: user?.platform_role || null,
      agent_access: agentAccess,
    });
  } catch (err) {
    console.error('[console-auth] register error:', err.message);
    res.status(500).json({ error: 'registration failed' });
  }
});

/**
 * POST /console/auth/login
 * email + password → session token
 */
router.post('/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const result = loginUser(email, password);
  if (!result) return res.status(401).json({ error: 'invalid email or password' });

  const agentAccess = getUserAgentAccess(result.user_id);
  const user = getDb().prepare('SELECT platform_role FROM console_users WHERE id = ?').get(result.user_id);
  res.json({
    session_token: result.session_token,
    session_expires: result.session_expires,
    user_id: result.user_id,
    platform_role: user?.platform_role || null,
    agent_access: agentAccess,
  });
});

/**
 * POST /console/auth/logout
 * Clear session
 */
router.post('/logout', requireConsoleAuth(), (req, res) => {
  logoutUser(req.consoleUser.id);
  res.json({ ok: true });
});

/**
 * GET /console/auth/me
 * Current user info + agent access list
 */
router.get('/me', requireConsoleAuth(), (req, res) => {
  const u = req.consoleUser;
  const agentAccess = getUserAgentAccess(u.id);
  res.json({
    id: u.id,
    email: u.email,
    name: u.name,
    org_id: u.org_id,
    platform_role: u.platform_role || null,
    created_at: u.created_at,
    agent_access: agentAccess,
  });
});

module.exports = router;
