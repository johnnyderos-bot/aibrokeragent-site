/**
 * Platform Audit Log
 *
 * Logs all admin actions and security-relevant events to a local file
 * and anchors batches to Hedera HCS every 15 minutes for tamper-evidence.
 *
 * We sell audit capability — our own admin actions must be auditable too.
 * This is both a compliance requirement and a trust signal for enterprise customers.
 *
 * Log format (JSONL):
 *   { ts, event, actor, target, metadata }
 *
 * Anchor entry format (written after each HCS batch submission):
 *   { ts, event: "hcs.audit_anchor", batch_hash, entry_count, hcs_topic_id,
 *     hcs_sequence, anchor_from_offset, anchor_to_offset }
 *
 * Events logged:
 *   - admin.agent.credit        — credits added to agent
 *   - admin.agent.deregister    — agent forcibly removed
 *   - admin.agent.flag          — fraud/malevolent flag added
 *   - admin.agent.unflag        — flag removed
 *   - admin.operator.kyc_approve — operator KYC approved
 *   - admin.operator.kyc_reject  — operator KYC rejected
 *   - platform.rate_limit       — rate limit triggered (aggregated)
 *   - platform.auth_fail        — authentication failure
 *   - security.key_rotation     — encryption key rotation event
 *   - hcs.audit_anchor          — batch anchor submitted to HCS
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = process.env.AUDIT_LOG_DIR || path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'platform-audit.jsonl');
const HCS_ANCHOR_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const AUDIT_TOPIC_ID = process.env.AUDIT_HCS_TOPIC_ID || process.env.HEDERA_DEFAULT_TOPIC_ID;

// Ensure log directory exists
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Track byte offset of last anchored position in the log file
let lastAnchoredOffset = 0;

/**
 * Initialize the anchor offset to the current end of the log file.
 * Call once at startup so we only anchor new entries, not old history.
 */
function initAnchorOffset() {
  try {
    if (fs.existsSync(LOG_FILE)) {
      const stat = fs.statSync(LOG_FILE);
      lastAnchoredOffset = stat.size;
    }
  } catch {
    lastAnchoredOffset = 0;
  }
}

function writeEntry(entry) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    id: crypto.randomBytes(8).toString('hex'),
    ...entry,
  }) + '\n';

  try {
    fs.appendFileSync(LOG_FILE, line, 'utf-8');
  } catch (err) {
    // Audit log write failure should not crash the server
    console.error('[audit-log] write failed:', err.message);
  }
}

/**
 * Anchor unanchored audit log entries to HCS as a tamper-evident batch.
 * Reads all entries written since lastAnchoredOffset, computes SHA-256
 * of the batch, submits the hash to HCS, then writes an anchor entry
 * referencing the HCS sequence number.
 *
 * One HCS message per batch — not per log entry.
 */
async function anchorAuditBatch() {
  if (!AUDIT_TOPIC_ID) {
    console.warn('[audit-log] HCS anchoring skipped — AUDIT_HCS_TOPIC_ID and HEDERA_DEFAULT_TOPIC_ID not set');
    return null;
  }

  let stat;
  try {
    stat = fs.statSync(LOG_FILE);
  } catch {
    return null; // No log file yet
  }

  const currentSize = stat.size;
  if (currentSize <= lastAnchoredOffset) {
    return null; // No new entries since last anchor
  }

  // Read only new bytes since last anchor
  let newContent;
  try {
    const fd = fs.openSync(LOG_FILE, 'r');
    const bytesToRead = currentSize - lastAnchoredOffset;
    const buf = Buffer.alloc(bytesToRead);
    fs.readSync(fd, buf, 0, bytesToRead, lastAnchoredOffset);
    fs.closeSync(fd);
    newContent = buf.toString('utf-8');
  } catch (err) {
    console.error('[audit-log] failed to read new entries for anchoring:', err.message);
    return null;
  }

  // Parse and count valid JSON lines
  const lines = newContent.split('\n').filter(l => l.trim());
  if (lines.length === 0) return null;

  // Exclude any existing anchor entries (no double-anchoring)
  const auditLines = lines.filter(l => {
    try { return JSON.parse(l).event !== 'hcs.audit_anchor'; } catch { return true; }
  });
  if (auditLines.length === 0) {
    lastAnchoredOffset = currentSize;
    return null;
  }

  // SHA-256 hash of the batch content (raw bytes for determinism)
  const batchHash = crypto.createHash('sha256').update(newContent).digest('hex');

  // Submit to HCS
  let hcsResult = null;
  try {
    const { anchorRecord } = require('./hedera');
    hcsResult = await anchorRecord(AUDIT_TOPIC_ID, {
      type: 'AUDIT_LOG_ANCHOR',
      batch_hash: batchHash,
      entry_count: auditLines.length,
      from_offset: lastAnchoredOffset,
      to_offset: currentSize,
      anchored_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[audit-log] HCS anchor submission failed:', err.message);
    return null;
  }

  // Write anchor record to the log itself (creates verifiable chain)
  const anchorEntry = JSON.stringify({
    ts: new Date().toISOString(),
    id: crypto.randomBytes(8).toString('hex'),
    event: 'hcs.audit_anchor',
    batch_hash: batchHash,
    entry_count: auditLines.length,
    hcs_topic_id: AUDIT_TOPIC_ID,
    hcs_sequence: hcsResult.sequenceNumber,
    hcs_transaction_id: hcsResult.transactionId,
    anchor_from_offset: lastAnchoredOffset,
    anchor_to_offset: currentSize,
    source: 'system',
  }) + '\n';

  try {
    fs.appendFileSync(LOG_FILE, anchorEntry, 'utf-8');
  } catch (err) {
    console.error('[audit-log] failed to write anchor entry:', err.message);
  }

  // Advance offset past what we just anchored (+ the anchor entry itself)
  lastAnchoredOffset = currentSize;

  console.log(`[audit-log] HCS anchor: ${auditLines.length} entries → topic ${AUDIT_TOPIC_ID} seq ${hcsResult.sequenceNumber}`);
  return hcsResult;
}

/**
 * Start the background HCS anchoring timer.
 * Call once from server startup (index.js).
 */
function startAnchorScheduler() {
  initAnchorOffset();
  const timer = setInterval(async () => {
    try {
      await anchorAuditBatch();
    } catch (err) {
      console.error('[audit-log] scheduled anchor failed:', err.message);
    }
  }, HCS_ANCHOR_INTERVAL_MS);

  // Don't let this timer prevent process exit
  if (timer.unref) timer.unref();

  console.log(`[audit-log] HCS batch anchoring active — interval: 15min, topic: ${AUDIT_TOPIC_ID || 'NOT SET'}`);
  return timer;
}

function logAdminAction(event, actor, target, metadata = {}) {
  writeEntry({ event, actor, target, metadata, source: 'admin' });
}

function logSecurityEvent(event, actor, target, metadata = {}) {
  writeEntry({ event, actor, target, metadata, source: 'security' });
}

function logAuthFailure(agentId, endpoint, reason) {
  writeEntry({
    event: 'platform.auth_fail',
    actor: agentId || 'unknown',
    target: endpoint,
    metadata: { reason },
    source: 'security',
  });
}

function logRateLimit(agentId, endpoint) {
  writeEntry({
    event: 'platform.rate_limit',
    actor: agentId || 'unknown',
    target: endpoint,
    source: 'security',
  });
}

module.exports = {
  logAdminAction,
  logSecurityEvent,
  logAuthFailure,
  logRateLimit,
  startAnchorScheduler,
  anchorAuditBatch,
};
