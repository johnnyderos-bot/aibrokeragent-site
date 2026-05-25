const crypto = require('crypto');
const { getDb } = require('./db');
const { FREE_CREDITS } = require('./billing');

// scrypt parameters — deliberately slow to resist brute force / rainbow tables
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;

function hashKey(apiKey, salt) {
  return crypto.scryptSync(apiKey, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
}

function generateApiKey() {
  return 'bav1_' + crypto.randomBytes(32).toString('hex');
}

const VALID_AGENT_TYPES = ['general', 'financial', 'data', 'code', 'orchestrator'];

// Register a new agent — returns agent_id and api_key (shown once)
function registerAgent(name, hederaAccount = null, agentType = 'general') {
  const db = getDb();
  const resolvedType = VALID_AGENT_TYPES.includes(agentType) ? agentType : 'general';
  const agentId = 'agent_' + crypto.randomBytes(8).toString('hex');
  const apiKey = generateApiKey();
  const salt = crypto.randomBytes(16).toString('hex');
  const keyHash = hashKey(apiKey, salt);

  // Store as salt:hash so we can verify later
  db.prepare(
    'INSERT INTO agents (agent_id, name, api_key_hash, credits, hedera_account, agent_type) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(agentId, name, `${salt}:${keyHash}`, FREE_CREDITS, hederaAccount, resolvedType);

  return { agent_id: agentId, name, agent_type: resolvedType, api_key: apiKey, credits: FREE_CREDITS };
}

// Resolve an API key to an agent_id — returns null if invalid
function resolveKey(apiKey) {
  if (!apiKey) return null;

  // We can't query by hash directly anymore (salt is per-agent)
  // So we use the key prefix (bav1_) to confirm format, then scan
  // In production with many agents this needs an index strategy —
  // for testnet the agent count is small so a full scan is fine
  const rows = getDb().prepare('SELECT agent_id, api_key_hash FROM agents').all();

  for (const row of rows) {
    const [salt, storedHash] = row.api_key_hash.split(':');
    if (!salt || !storedHash) continue;
    const candidate = hashKey(apiKey, salt);
    // Constant-time comparison to prevent timing attacks
    if (candidate.length === storedHash.length &&
        crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash))) {
      return row.agent_id;
    }
  }

  return null;
}

// Express middleware — attaches req.agentId or returns 401
function requireAuth(req, res, next) {
  const apiKey = req.headers['x-agent-key'];
  const agentId = resolveKey(apiKey);
  if (!agentId) {
    // Log auth failure — imported lazily to avoid circular dependency
    try {
      const { logAuthFailure } = require('./audit-log');
      logAuthFailure(null, req.path, 'invalid or missing X-Agent-Key');
    } catch {}
    return res.status(401).json({ error: 'invalid or missing X-Agent-Key' });
  }
  req.agentId = agentId;
  next();
}

module.exports = { registerAgent, requireAuth, resolveKey, VALID_AGENT_TYPES };
