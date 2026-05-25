const { getDb } = require('./db');
require('dotenv').config();
// Lazy-load aml to avoid circular dependency (aml → db → billing)
let _aml;
function getAml() { return _aml || (_aml = require('./aml')); }

// Pricing (in credits)
const PRICES = {
  store_record:    1.0,
  boost_purchase: 50.0,   // one-time: raises AATS starting floor from 30 → 45
  score_advisor:   5.0,   // per-report: AATS gap analysis + action recommendations
};

// Credit top-up rate: 1 HBAR = 10 credits
const HBAR_TO_CREDITS = 10;

// Free credits granted on registration
const FREE_CREDITS = 10;

function getBalance(agentId) {
  const row = getDb().prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
  return row ? row.credits : null;
}

// Atomically deduct credits using a single UPDATE with a WHERE guard.
// Returns { ok: true, balance, cost } or { ok: false, balance, required }
function deductCredits(agentId, action, refId = null) {
  const db = getDb();
  const cost = PRICES[action];
  if (!cost) throw new Error(`Unknown billable action: ${action}`);

  const result = db.transaction(() => {
    // Single atomic UPDATE — only succeeds if credits >= cost
    const info = db.prepare(
      'UPDATE agents SET credits = ROUND(credits - ?, 4) WHERE agent_id = ? AND credits >= ?'
    ).run(cost, agentId, cost);

    if (info.changes === 0) {
      // Either agent not found or insufficient credits
      const agent = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
      if (!agent) throw new Error('Agent not found');
      return { ok: false, balance: agent.credits, required: cost };
    }

    const { credits: balanceAfter } = db.prepare(
      'SELECT credits FROM agents WHERE agent_id = ?'
    ).get(agentId);

    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'debit', ?, ?, ?, ?)`
    ).run(agentId, -cost, balanceAfter, action, refId);

    return { ok: true, balance: balanceAfter, cost };
  })();

  // Structuring check after successful debit (async — does not block the transaction)
  if (result.ok) {
    try { getAml().checkStructuring(agentId); } catch { /* non-blocking */ }
  }

  return result;
}

// Refund credits — called when a billable action fails after deduction
function refundCredits(agentId, action, refId = null) {
  const db = getDb();
  const cost = PRICES[action];
  if (!cost) return;

  db.transaction(() => {
    db.prepare(
      'UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?'
    ).run(cost, agentId);

    const { credits: balanceAfter } = db.prepare(
      'SELECT credits FROM agents WHERE agent_id = ?'
    ).get(agentId);

    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'credit', ?, ?, 'refund: hedera failure', ?)`
    ).run(agentId, cost, balanceAfter, refId);
  })();
}

// Add credits — internal use only (admin top-up, refunds)
function addCredits(agentId, credits, description, refId = null) {
  const db = getDb();

  return db.transaction(() => {
    const agent = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
    if (!agent) throw new Error('Agent not found');

    db.prepare(
      'UPDATE agents SET credits = ROUND(credits + ?, 4) WHERE agent_id = ?'
    ).run(credits, agentId);

    const { credits: balanceAfter } = db.prepare(
      'SELECT credits FROM agents WHERE agent_id = ?'
    ).get(agentId);

    db.prepare(
      `INSERT INTO billing_ledger (agent_id, type, amount, balance_after, description, ref_id)
       VALUES (?, 'credit', ?, ?, ?, ?)`
    ).run(agentId, credits, balanceAfter, description, refId);

    return { balance: balanceAfter, credits_added: credits };
  })();
}

// Get ledger history for an agent
function getLedger(agentId, limit = 50) {
  return getDb().prepare(
    `SELECT type, amount, balance_after, description, ref_id, created_at
     FROM billing_ledger WHERE agent_id = ?
     ORDER BY created_at DESC LIMIT ?`
  ).all(agentId, limit);
}

// Normalize a Hedera transaction ID to the mirror node URL format.
// Accepts: "0.0.1234@1234567890.123456789" or "0.0.1234-1234567890-123456789"
function normalizeTxId(raw) {
  // Replace @ and the last . in the nanos portion with -
  return raw.replace('@', '-').replace(/\.(\d+)$/, '-$1');
}

const MIRROR_BASE = process.env.HEDERA_NETWORK === 'mainnet'
  ? 'https://mainnode.mirrornode.hedera.com'
  : 'https://testnet.mirrornode.hedera.com';

// Top-up via Hedera mirror node verification.
// Returns { credits_added, balance, transaction_id } on success or { error } on failure.
async function verifyAndCredit(agentId, transactionId) {
  if (!transactionId) return { error: 'transaction_id is required' };

  const db = getDb();
  const platformAccount = process.env.HEDERA_ACCOUNT_ID;
  if (!platformAccount) return { error: 'platform Hedera account not configured' };

  // Replay guard — reject already-processed transactions
  const existing = db.prepare('SELECT agent_id FROM topup_transactions WHERE transaction_id = ?').get(transactionId);
  if (existing) return { error: 'transaction already used for top-up' };

  // Query mirror node
  const urlId = normalizeTxId(transactionId);
  let txData;
  try {
    const res = await fetch(`${MIRROR_BASE}/api/v1/transactions/${urlId}`);
    if (!res.ok) {
      if (res.status === 404) return { error: 'transaction not found on mirror node — may not be finalized yet' };
      return { error: `mirror node returned ${res.status}` };
    }
    txData = await res.json();
  } catch (err) {
    return { error: `mirror node unreachable: ${err.message}` };
  }

  const tx = txData?.transactions?.[0];
  if (!tx) return { error: 'transaction not found' };
  if (tx.result !== 'SUCCESS') return { error: `transaction status: ${tx.result}` };
  if (tx.name !== 'CRYPTOTRANSFER') return { error: 'transaction is not a HBAR transfer' };

  // Find the positive transfer to our platform account
  const transfer = (tx.transfers || []).find(
    t => t.account === platformAccount && t.amount > 0
  );
  if (!transfer) {
    return { error: `no transfer to platform account (${platformAccount}) found in transaction` };
  }

  // tinybars → HBAR (1 HBAR = 100,000,000 tinybars)
  const hbar_amount = transfer.amount / 100_000_000;
  const credits_to_add = Math.floor(hbar_amount * HBAR_TO_CREDITS);

  if (credits_to_add < 1) {
    return { error: `transfer too small: ${hbar_amount} HBAR = ${credits_to_add} credits (minimum 0.1 HBAR)` };
  }

  // Record + credit atomically
  const result = db.transaction(() => {
    db.prepare(
      'INSERT INTO topup_transactions (transaction_id, agent_id, hbar_amount, credits_added) VALUES (?, ?, ?, ?)'
    ).run(transactionId, agentId, hbar_amount, credits_to_add);

    return addCredits(agentId, credits_to_add, `topup: ${hbar_amount} HBAR via ${transactionId}`, transactionId);
  })();

  return {
    transaction_id: transactionId,
    hbar_received: hbar_amount,
    credits_added: credits_to_add,
    balance: result.balance,
  };
}

module.exports = {
  PRICES, HBAR_TO_CREDITS, FREE_CREDITS,
  getBalance, deductCredits, refundCredits, addCredits, getLedger, verifyAndCredit,
};
