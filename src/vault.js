const crypto = require('crypto');
const { getDb } = require('./db');
const { createVaultTopic, anchorRecord } = require('./hedera');
const { getBackend } = require('./storage-backend');
require('dotenv').config();

const ALGORITHM = 'aes-256-gcm';

// Validate encryption key at startup — fail fast rather than encrypt with a bad key
const rawKey = process.env.VAULT_ENCRYPTION_KEY;
if (!rawKey || rawKey.length !== 64) {
  throw new Error(`VAULT_ENCRYPTION_KEY must be a 64-character hex string (32 bytes). Got: ${rawKey ? rawKey.length + ' chars' : 'undefined'}`);
}
const MASTER_KEY = Buffer.from(rawKey, 'hex');

/**
 * Derive a per-agent encryption key using HKDF-SHA256.
 * Each agent's vault data is encrypted under a key derived from their agent_id.
 * Compromise of one agent's data does not expose any other agent's vault.
 *
 * Security note: The derived key is cryptographically bound to the agent_id via
 * HKDF info parameter. An attacker who obtains one agent's plaintext cannot use
 * it to derive keys for other agents.
 */
function deriveAgentKey(agentId) {
  return crypto.hkdfSync('sha256', MASTER_KEY, Buffer.from('aats-vault-salt-v2'), Buffer.from(`agent:${agentId}`), 32);
}

/**
 * Encrypt plaintext using per-agent derived key.
 * Ciphertext format: "v2:<iv_hex>:<tag_hex>:<enc_hex>"
 * The "v2:" prefix signals per-agent encryption (vs legacy global-key records).
 */
function encrypt(plaintext, agentId) {
  const key = deriveAgentKey(agentId);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v2:' + [iv, tag, encrypted].map(b => b.toString('hex')).join(':');
}

/**
 * Decrypt ciphertext.
 * Handles both:
 *   v2 (per-agent derived key, format: "v2:iv:tag:enc")
 *   legacy (global key, format: "iv:tag:enc") — for records created before per-agent keys
 */
function decrypt(ciphertext, agentId) {
  let key;
  let parts;

  if (ciphertext.startsWith('v2:')) {
    // Per-agent key (new records)
    key = deriveAgentKey(agentId);
    parts = ciphertext.slice(3).split(':');
  } else {
    // Legacy global key (existing testnet records — migrate at mainnet)
    key = MASTER_KEY;
    parts = ciphertext.split(':');
  }

  const [ivHex, tagHex, encHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

function hashContent(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function generateId() {
  return crypto.randomBytes(16).toString('hex');
}

// Get or create HCS topic for an agent — stored in agents table, not vault_records
async function getOrCreateTopic(agentId) {
  const db = getDb();
  const agent = db.prepare('SELECT hcs_topic_id FROM agents WHERE agent_id = ?').get(agentId);
  if (agent?.hcs_topic_id) return agent.hcs_topic_id;

  const topicId = await createVaultTopic(agentId);
  db.prepare('UPDATE agents SET hcs_topic_id = ? WHERE agent_id = ?').run(topicId, agentId);
  return topicId;
}

// Store a context record.
// sqlite backend: encrypted blob stored inline in encrypted_content column.
// storj backend:  encrypted blob uploaded to Storj; storage_ref stored in DB.
async function storeRecord(agentId, label, content) {
  const encrypted = encrypt(content, agentId);
  const hash = hashContent(content);
  const topicId = await getOrCreateTopic(agentId);
  const backend = getBackend();

  // Only anchor the content hash — no labels or agent IDs in the public HCS message
  const anchor = await anchorRecord(topicId, {
    hash,
    timestamp: new Date().toISOString(),
  });

  const id = generateId();
  const now = new Date().toISOString();

  if (backend.name === 'storj') {
    // Upload encrypted blob to Storj; store only the reference in DB
    const { ref } = await backend.put(`${agentId}/${id}`, encrypted);
    getDb().prepare(
      `INSERT INTO vault_records
        (id, agent_id, label, encrypted_content, content_hash, hcs_topic_id, hcs_sequence,
         hcs_timestamp, storage_backend, storage_ref)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`
    ).run(id, agentId, label, hash, topicId, String(anchor.sequenceNumber), now, 'storj', ref);
  } else {
    // SQLite backend: store blob inline (original behaviour)
    getDb().prepare(
      `INSERT INTO vault_records
        (id, agent_id, label, encrypted_content, content_hash, hcs_topic_id, hcs_sequence,
         hcs_timestamp, storage_backend)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sqlite')`
    ).run(id, agentId, label, encrypted, hash, topicId, String(anchor.sequenceNumber), now);
  }

  return { id, label, content_hash: hash, hcs_topic_id: topicId, hcs_sequence: anchor.sequenceNumber, created_at: now };
}

// Read a record (checks permission).
// Transparently handles both sqlite (inline) and storj (remote fetch) records.
async function readRecord(recordId, requestingAgentId) {
  const record = getDb().prepare('SELECT * FROM vault_records WHERE id = ?').get(recordId);
  if (!record) return null;

  const permissions = JSON.parse(record.permissions);
  const isOwner = record.agent_id === requestingAgentId;
  const hasPermission = permissions.includes(requestingAgentId);

  if (!isOwner && !hasPermission) return { error: 'forbidden' };

  let encryptedContent;
  if (record.storage_backend === 'storj' && record.storage_ref) {
    encryptedContent = await getBackend().get(record.storage_ref);
  } else {
    encryptedContent = record.encrypted_content;
  }

  return {
    id:           record.id,
    agent_id:     record.agent_id,
    label:        record.label,
    content:      decrypt(encryptedContent, record.agent_id),
    content_hash: record.content_hash,
    hcs_topic_id: record.hcs_topic_id,
    hcs_sequence: record.hcs_sequence,
    created_at:   record.created_at,
  };
}

// List records for an agent (metadata only — no blob fetch needed)
function listRecords(agentId) {
  return getDb().prepare(
    `SELECT id, label, content_hash, hcs_topic_id, hcs_sequence, created_at, storage_backend
     FROM vault_records WHERE agent_id = ? ORDER BY created_at DESC`
  ).all(agentId);
}

// Grant read permission to another agent
function grantPermission(recordId, ownerAgentId, granteeAgentId) {
  const db = getDb();

  return db.transaction(() => {
    const record = db.prepare(
      'SELECT permissions FROM vault_records WHERE id = ? AND agent_id = ?'
    ).get(recordId, ownerAgentId);
    if (!record) return null;

    const permissions = JSON.parse(record.permissions);
    if (!permissions.includes(granteeAgentId)) permissions.push(granteeAgentId);

    db.prepare('UPDATE vault_records SET permissions = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(permissions), new Date().toISOString(), recordId);

    return { id: recordId, permissions };
  })();
}

// Revoke read permission
function revokePermission(recordId, ownerAgentId, granteeAgentId) {
  const db = getDb();

  return db.transaction(() => {
    const record = db.prepare(
      'SELECT permissions FROM vault_records WHERE id = ? AND agent_id = ?'
    ).get(recordId, ownerAgentId);
    if (!record) return null;

    const permissions = JSON.parse(record.permissions).filter(p => p !== granteeAgentId);

    db.prepare('UPDATE vault_records SET permissions = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(permissions), new Date().toISOString(), recordId);

    return { id: recordId, permissions };
  })();
}

module.exports = { storeRecord, readRecord, listRecords, grantPermission, revokePermission };
