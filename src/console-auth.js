/**
 * Console Auth — password hashing + session management for Human Trust Console
 * Follows the same scrypt pattern as src/auth.js
 */

const crypto = require('crypto');
const { getDb } = require('./db');

// scrypt parameters — match auth.js
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Create a new console user (called from invite acceptance).
 * Returns { user_id, session_token }
 */
function createUser(email, name, password, org_id = null) {
  const db = getDb();
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const userId = generateId();
  const sessionToken = generateToken();
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  db.prepare(`
    INSERT INTO console_users (id, org_id, email, name, password_hash, session_token, session_expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, org_id || null, email.toLowerCase().trim(), name, `${salt}:${hash}`, sessionToken, sessionExpires);

  return { user_id: userId, session_token: sessionToken, session_expires: sessionExpires };
}

/**
 * Verify email + password, issue a session token.
 * Returns session_token or null.
 */
function loginUser(email, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM console_users WHERE email = ?').get(email.toLowerCase().trim());
  if (!user) return null;

  const [salt, storedHash] = user.password_hash.split(':');
  if (!salt || !storedHash) return null;

  const candidate = hashPassword(password, salt);
  const match =
    candidate.length === storedHash.length &&
    crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash));
  if (!match) return null;

  // Issue fresh session
  const sessionToken = generateToken();
  const sessionExpires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare('UPDATE console_users SET session_token = ?, session_expires_at = ? WHERE id = ?')
    .run(sessionToken, sessionExpires, user.id);

  return { session_token: sessionToken, session_expires: sessionExpires, user_id: user.id };
}

/**
 * Resolve a session token to a user row. Returns null if invalid or expired.
 */
function resolveSession(token) {
  if (!token) return null;
  const db = getDb();
  const user = db.prepare('SELECT * FROM console_users WHERE session_token = ?').get(token);
  if (!user) return null;
  if (user.active === 0) return null;
  if (user.session_expires_at && new Date(user.session_expires_at) < new Date()) return null;
  return user;
}

/**
 * Clear session token for logout.
 */
function logoutUser(userId) {
  getDb().prepare('UPDATE console_users SET session_token = NULL, session_expires_at = NULL WHERE id = ?').run(userId);
}

/**
 * Get agent access list for a user.
 */
function getUserAgentAccess(userId) {
  return getDb().prepare(`
    SELECT caa.agent_id, caa.role, caa.granted_at, a.name as agent_name
    FROM console_agent_access caa
    LEFT JOIN agents a ON a.agent_id = caa.agent_id
    WHERE caa.user_id = ?
    ORDER BY caa.granted_at DESC
  `).all(userId);
}

/**
 * Check user's role for a specific agent. Returns 'owner'|'admin'|'viewer' or null.
 */
function getUserRole(userId, agentId) {
  const row = getDb().prepare(
    'SELECT role FROM console_agent_access WHERE user_id = ? AND agent_id = ?'
  ).get(userId, agentId);
  return row ? row.role : null;
}

/**
 * Grant access to an agent for a user.
 */
function grantAgentAccess(userId, agentId, role) {
  getDb().prepare(`
    INSERT OR REPLACE INTO console_agent_access (user_id, agent_id, role, granted_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(userId, agentId, role);
}

const ROLE_LEVELS = { owner: 3, admin: 2, viewer: 1 };
const PLATFORM_ROLE_LEVELS = { owner: 3, employee: 2, watcher: 1 };

/**
 * Express middleware factory — requires console session + minimum role on :agent_id param.
 * Attaches req.consoleUser and req.consoleRole.
 */
function requireConsoleAuth(minRole = 'viewer') {
  return (req, res, next) => {
    const token =
      req.headers['x-console-token'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      req.cookies?.console_token;

    const user = resolveSession(token);
    if (!user) return res.status(401).json({ error: 'not authenticated' });

    const agentId = req.params.agent_id;
    if (agentId) {
      const role = getUserRole(user.id, agentId);
      if (!role) return res.status(403).json({ error: 'no access to this agent' });
      if ((ROLE_LEVELS[role] || 0) < (ROLE_LEVELS[minRole] || 0)) {
        return res.status(403).json({ error: `requires ${minRole} role, you have ${role}` });
      }
      req.consoleRole = role;
    }

    req.consoleUser = user;
    next();
  };
}

/**
 * Set platform_role for a user.
 */
function setPlatformRole(userId, role) {
  getDb().prepare('UPDATE console_users SET platform_role = ? WHERE id = ?').run(role, userId);
}

/**
 * Express middleware — requires a valid console session with at least the given platform role.
 * Attaches req.consoleUser. Does not check agent-level access.
 */
function requirePlatformRole(minRole = 'watcher') {
  return (req, res, next) => {
    const token =
      req.headers['x-console-token'] ||
      req.headers['authorization']?.replace('Bearer ', '') ||
      req.cookies?.console_token;

    const user = resolveSession(token);
    if (!user) return res.status(401).json({ error: 'not authenticated' });

    const userLevel = PLATFORM_ROLE_LEVELS[user.platform_role] || 0;
    const required  = PLATFORM_ROLE_LEVELS[minRole] || 0;
    if (userLevel < required) {
      return res.status(403).json({ error: `requires platform role ${minRole}` });
    }

    req.consoleUser = user;
    next();
  };
}

module.exports = {
  createUser,
  loginUser,
  resolveSession,
  logoutUser,
  getUserAgentAccess,
  getUserRole,
  grantAgentAccess,
  requireConsoleAuth,
  setPlatformRole,
  requirePlatformRole,
  PLATFORM_ROLE_LEVELS,
  generateId,
};
