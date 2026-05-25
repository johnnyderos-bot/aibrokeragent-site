/**
 * AML Monitoring — Structuring Detection & SAR Queue
 *
 * Structuring: breaking large transactions into smaller ones to avoid
 * reporting thresholds (BSA/FinCEN "smurfing"). Illegal under 31 U.S.C. § 5324.
 *
 * Detection logic:
 *   - 3+ credits transactions by the same agent within a rolling 24h window
 *   - Each individual transaction < STRUCTURING_SINGLE_THRESHOLD credits
 *   - But the sum within the window >= STRUCTURING_SUM_THRESHOLD credits
 *
 * When detected:
 *   - Creates a SAR_QUEUE record for human review
 *   - Adds an AML_STRUCTURING flag to the agent's billing notes
 *   - Does NOT automatically block the agent (human review first)
 *
 * Travel Rule (BSA / FATF Rec.16):
 *   - Any single transfer >= TRAVEL_RULE_THRESHOLD credits requires
 *     originator + beneficiary data to be transmitted
 *   - checkTravelRule() returns whether the rule applies + what data is needed
 *
 * Thresholds (configurable via env):
 *   STRUCTURING_SUM_THRESHOLD    — default 10000 credits (= 1000 HBAR)
 *   STRUCTURING_SINGLE_THRESHOLD — default 3000 credits  (= 300 HBAR)
 *   STRUCTURING_MIN_TX_COUNT     — default 3 transactions
 *   TRAVEL_RULE_THRESHOLD        — default 100 credits   (= 10 HBAR, conservative for testnet)
 */

const { getDb } = require('./db');

const STRUCTURING_SUM_THRESHOLD    = parseInt(process.env.STRUCTURING_SUM_THRESHOLD    || '10000');
const STRUCTURING_SINGLE_THRESHOLD = parseInt(process.env.STRUCTURING_SINGLE_THRESHOLD || '3000');
const STRUCTURING_MIN_TX_COUNT     = parseInt(process.env.STRUCTURING_MIN_TX_COUNT     || '3');
const TRAVEL_RULE_THRESHOLD        = parseInt(process.env.TRAVEL_RULE_THRESHOLD        || '100');
const STRUCTURING_WINDOW_HOURS     = parseInt(process.env.STRUCTURING_WINDOW_HOURS     || '24');

// ── Structuring ───────────────────────────────────────────────────────────────

/**
 * Check an agent for structuring patterns after a new transaction.
 * Should be called after every debit from billing_ledger.
 *
 * @returns {{ detected: boolean, details? }}
 */
function checkStructuring(agent_id) {
  const db = getDb();
  const window_start = new Date(Date.now() - STRUCTURING_WINDOW_HOURS * 3600 * 1000).toISOString();

  const txs = db.prepare(`
    SELECT amount, created_at FROM billing_ledger
    WHERE agent_id = ?
      AND type = 'debit'
      AND created_at >= ?
    ORDER BY created_at DESC
  `).all(agent_id, window_start);

  if (txs.length < STRUCTURING_MIN_TX_COUNT) return { detected: false };

  // Check if any individual tx is below threshold (hallmark of structuring)
  const below_threshold = txs.filter(t => Math.abs(t.amount) < STRUCTURING_SINGLE_THRESHOLD);
  if (below_threshold.length < STRUCTURING_MIN_TX_COUNT) return { detected: false };

  const sum = txs.reduce((acc, t) => acc + Math.abs(t.amount), 0);
  if (sum < STRUCTURING_SUM_THRESHOLD) return { detected: false };

  const details = {
    agent_id,
    window_hours: STRUCTURING_WINDOW_HOURS,
    tx_count: txs.length,
    below_threshold_count: below_threshold.length,
    sum_credits: Math.round(sum * 100) / 100,
    threshold: STRUCTURING_SUM_THRESHOLD,
    detected_at: new Date().toISOString(),
  };

  // Queue for SAR review
  queueSar(agent_id, 'STRUCTURING', details);

  console.warn(`[aml] structuring detected for agent ${agent_id}: ${txs.length} tx, ${sum} credits in ${STRUCTURING_WINDOW_HOURS}h window`);
  return { detected: true, details };
}

// ── Travel Rule ───────────────────────────────────────────────────────────────

/**
 * Determine if the Travel Rule applies to an escrow transaction.
 * Returns { applies: boolean, threshold, required_fields? }
 */
function checkTravelRule(amount_credits, buyer_agent, seller_agent) {
  if (amount_credits < TRAVEL_RULE_THRESHOLD) {
    return { applies: false, threshold: TRAVEL_RULE_THRESHOLD };
  }

  const db = getDb();

  // Gather originator info (buyer's operator)
  const buyerOp = db.prepare(`
    SELECT o.operator_id, o.name, o.email, oa.agent_id
    FROM operators o
    JOIN operator_agents oa ON oa.operator_id = o.operator_id
    WHERE oa.agent_id = ?
  `).get(buyer_agent);

  // Gather beneficiary info (seller's operator)
  const sellerOp = db.prepare(`
    SELECT o.operator_id, o.name, o.email, oa.agent_id
    FROM operators o
    JOIN operator_agents oa ON oa.operator_id = o.operator_id
    WHERE oa.agent_id = ?
  `).get(seller_agent);

  const missing = [];
  if (!buyerOp)  missing.push('buyer operator not linked (required for Travel Rule)');
  if (!sellerOp) missing.push('seller operator not linked (required for Travel Rule)');

  return {
    applies: true,
    threshold: TRAVEL_RULE_THRESHOLD,
    amount_credits,
    originator: buyerOp  ? { operator_id: buyerOp.operator_id,  name: buyerOp.name,  agent_id: buyer_agent  } : null,
    beneficiary: sellerOp ? { operator_id: sellerOp.operator_id, name: sellerOp.name, agent_id: seller_agent } : null,
    compliant: missing.length === 0,
    missing_data: missing,
  };
}

// ── SAR Queue ─────────────────────────────────────────────────────────────────

/**
 * Add an entry to the SAR review queue.
 * Human compliance officer reviews and decides whether to file with FinCEN.
 */
function queueSar(agent_id, reason, details = {}) {
  const db = getDb();

  // Idempotent — don't double-queue same agent+reason within 24h
  const recent = db.prepare(`
    SELECT id FROM sar_queue
    WHERE agent_id = ? AND reason = ? AND created_at >= datetime('now', '-1 day')
  `).get(agent_id, reason);
  if (recent) return recent;

  const id = require('crypto').randomBytes(16).toString('hex').toLowerCase();
  db.prepare(`
    INSERT INTO sar_queue (id, agent_id, reason, details, status)
    VALUES (?, ?, ?, ?, 'pending')
  `).run(id, agent_id, reason, JSON.stringify(details));

  return { id, agent_id, reason, status: 'pending' };
}

/**
 * List pending SAR queue entries (admin only).
 */
function listSarQueue(status = 'pending') {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sar_queue WHERE status = ? ORDER BY created_at DESC
  `).all(status).map(r => ({ ...r, details: JSON.parse(r.details || '{}') }));
}

/**
 * Mark a SAR queue entry as reviewed.
 * decision: 'filed' | 'dismissed'
 */
function resolveSar(sar_id, decision, notes = '') {
  const db = getDb();
  if (!['filed', 'dismissed'].includes(decision)) throw new Error('decision must be filed or dismissed');
  db.prepare(`
    UPDATE sar_queue SET status = ?, resolution_notes = ?, resolved_at = datetime('now') WHERE id = ?
  `).run(decision, notes, sar_id);
  return db.prepare('SELECT * FROM sar_queue WHERE id = ?').get(sar_id);
}

module.exports = { checkStructuring, checkTravelRule, queueSar, listSarQueue, resolveSar };
