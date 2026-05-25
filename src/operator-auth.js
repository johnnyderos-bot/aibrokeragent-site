const crypto = require('crypto');
const { getDb } = require('./db');

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN  = 64;

function hashKey(apiKey, salt) {
  return crypto.scryptSync(apiKey, salt, KEY_LEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
}

function generateOperatorKey() {
  return 'bok1_' + crypto.randomBytes(32).toString('hex');
}

// Register a new human operator
function registerOperator(name, email = null) {
  const db = getDb();
  const operator_id = 'op_' + crypto.randomBytes(8).toString('hex');
  const apiKey = generateOperatorKey();
  const salt = crypto.randomBytes(16).toString('hex');
  const keyHash = hashKey(apiKey, salt);

  db.prepare(
    'INSERT INTO operators (operator_id, name, email, api_key_hash) VALUES (?, ?, ?, ?)'
  ).run(operator_id, name, email, `${salt}:${keyHash}`);

  return { operator_id, name, email, api_key: apiKey };
}

// Link an agent to an operator
function linkAgent(operator_id, agent_id) {
  const db = getDb();
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error('agent not found');
  db.prepare(
    'INSERT OR IGNORE INTO operator_agents (operator_id, agent_id) VALUES (?, ?)'
  ).run(operator_id, agent_id);
  return { operator_id, agent_id, linked: true };
}

// Resolve an operator API key → operator_id
function resolveOperatorKey(apiKey) {
  if (!apiKey || !apiKey.startsWith('bok1_')) return null;
  const rows = getDb().prepare('SELECT operator_id, api_key_hash FROM operators').all();
  for (const row of rows) {
    const [salt, storedHash] = row.api_key_hash.split(':');
    if (!salt || !storedHash) continue;
    const candidate = hashKey(apiKey, salt);
    if (candidate.length === storedHash.length &&
        crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(storedHash))) {
      return row.operator_id;
    }
  }
  return null;
}

// Get all agent IDs linked to an operator
function getLinkedAgents(operator_id) {
  return getDb().prepare(
    'SELECT agent_id, linked_at, flash_state FROM operator_agents WHERE operator_id = ?'
  ).all(operator_id);
}

// Express middleware — attaches req.operatorId or returns 401
function requireOperatorAuth(req, res, next) {
  const apiKey = req.headers['x-operator-key'];
  const operatorId = resolveOperatorKey(apiKey);
  if (!operatorId) return res.status(401).json({ error: 'invalid or missing X-Operator-Key' });
  req.operatorId = operatorId;
  next();
}

// Flexible middleware — accepts either agent key OR operator key
// Sets req.agentId or req.operatorId depending on which is provided
function requireAnyAuth(req, res, next) {
  const agentKey    = req.headers['x-agent-key'];
  const operatorKey = req.headers['x-operator-key'];

  if (agentKey) {
    const { resolveKey } = require('./auth');
    const agentId = resolveKey(agentKey);
    if (!agentId) return res.status(401).json({ error: 'invalid X-Agent-Key' });
    req.agentId = agentId;
    return next();
  }

  if (operatorKey) {
    const operatorId = resolveOperatorKey(operatorKey);
    if (!operatorId) return res.status(401).json({ error: 'invalid X-Operator-Key' });
    req.operatorId = operatorId;
    return next();
  }

  return res.status(401).json({ error: 'X-Agent-Key or X-Operator-Key required' });
}

module.exports = { registerOperator, linkAgent, resolveOperatorKey, getLinkedAgents, requireOperatorAuth, requireAnyAuth };
