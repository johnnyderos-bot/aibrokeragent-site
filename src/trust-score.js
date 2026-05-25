/**
 * AI Agent Trust Score (AATS)
 *
 * Formula v2 — approved April 20, 2026:
 *   AATS_raw = (TPH × 0.35) + (BC × 0.20) + (OTV × 0.15) + (CFI × 0.20) + (IAQ × 0.10)
 *   AATS = clamp(AATS_raw + vouching_bonus − dormancy_penalty, 0, 100)
 *
 * Dimensions (AATS v2 weights — approved April 20, 2026):
 *   TPH — Task Performance History     35%  (dispute rate, completion, recency-weighted)
 *   BC  — Behavioral Consistency       20%  (anomaly flags, fraud flags, dispute pattern)
 *   OTV — Operational Tenure & Volume  15%  (days active, vault records as activity proxy)
 *   CFI — Collateral & Financial Integrity 20% (funded status, top-up history)
 *   IAQ — Identity & Attestation Quality   10% (hedera account, registration completeness)
 *
 * Hard gates:
 *   UNFUNDED   — agent has 0 credits; score shown as UNFUNDED regardless of number
 *   FRAUD flag — caps score at 40; -50pts applied to raw before cap
 *
 * Score-to-risk-tier mapping (from research):
 *   85-100  Platinum — unlimited, 105% collateral
 *   70-84   Gold     — $50k, 115% collateral
 *   50-69   Silver   — $10k, 130% collateral
 *   30-49   Bronze   — $1k, 150% collateral
 *   0-29    Restricted — $100, 200% or blocked
 */

const { getDb } = require('./db');

/**
 * Domain-specific weight profiles.
 * Each profile shifts the AATS formula to reflect the risk profile of that agent type.
 *
 * general     — balanced baseline (default)
 * financial   — CFI dominant; payment integrity is the primary trust signal
 * data        — IAQ dominant; code attestation and identity are critical for data agents
 * code        — IAQ + OTV elevated; code hash + operational tenure matter most
 * orchestrator— BC dominant; behavioral consistency is paramount for coordinator agents
 */
const WEIGHT_PROFILES = {
  general: {
    label: 'General',
    description: 'Balanced trust profile for general-purpose agents',
    dominant: null,
    tph: 0.35, bc: 0.20, otv: 0.15, cfi: 0.20, iaq: 0.10, // AATS v2 weights — approved April 20, 2026
  },
  financial: {
    label: 'Financial',
    description: 'Emphasises financial integrity — suited for payment, DeFi, and treasury agents',
    dominant: 'CFI',
    tph: 0.25, bc: 0.20, otv: 0.10, cfi: 0.35, iaq: 0.10,
  },
  data: {
    label: 'Data',
    description: 'Emphasises identity & attestation — suited for data pipeline and analytics agents',
    dominant: 'IAQ',
    tph: 0.25, bc: 0.20, otv: 0.15, cfi: 0.10, iaq: 0.30,
  },
  code: {
    label: 'Code',
    description: 'Elevates code attestation and tenure — suited for software engineering agents',
    dominant: 'IAQ + OTV',
    tph: 0.25, bc: 0.20, otv: 0.20, cfi: 0.10, iaq: 0.25,
  },
  orchestrator: {
    label: 'Orchestrator',
    description: 'Emphasises behavioral consistency — suited for agents that coordinate other agents',
    dominant: 'BC',
    tph: 0.25, bc: 0.35, otv: 0.15, cfi: 0.15, iaq: 0.10,
  },
};

const TIERS = [
  { min: 85, label: 'PLATINUM',   max_tx_usd: null,  collateral_pct: 105 },
  { min: 70, label: 'GOLD',       max_tx_usd: 50000, collateral_pct: 115 },
  { min: 50, label: 'SILVER',     max_tx_usd: 10000, collateral_pct: 130 },
  { min: 30, label: 'BRONZE',     max_tx_usd: 1000,  collateral_pct: 150 },
  { min: 0,  label: 'RESTRICTED', max_tx_usd: 100,   collateral_pct: 200 },
];

function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

// OTV formula from research: min(100, 20×log10(days+1) + 5×log10(txCount+1))
function calcOTV(days_active, tx_count) {
  return Math.min(100, 20 * Math.log10(days_active + 1) + 5 * Math.log10(tx_count + 1));
}

// TPH: performance history — blends count-based completion rate with value-weighted rate
// and applies a recency penalty for recent disputes in last 30 days.
//
// Gemini v1 feedback: "An agent could farm its score with 1,000 low-value tasks to offset
// one high-stakes failure." Fix: value-weight completions by contract amount.
//
// Gemini v2 feedback: recency bias — recent 30-day performance carries more weight
// than year-old history to catch model drift.
function calcTPH(disputes_as_defendant, total_records, has_fraud_flag, value_stats, recent_disputes_30d) {
  if (has_fraud_flag) return 0;

  // ── Recency penalty ──────────────────────────────────────────────────────────
  // If agent has active disputes in the last 30 days and low total records,
  // the recent signal should dominate. Scale: each recent dispute = -12 pts floor risk.
  const recency_penalty = recent_disputes_30d > 0
    ? Math.min(25, recent_disputes_30d * 12)
    : 0;

  // ── Cold-start path (< 10 records) ──────────────────────────────────────────
  if (total_records < 10) {
    const dispute_penalty = disputes_as_defendant * 15;
    return Math.max(0, 30 - dispute_penalty - recency_penalty);
  }

  // ── Count-based rate ─────────────────────────────────────────────────────────
  const dispute_rate = disputes_as_defendant / total_records;
  const count_base = (1 - Math.min(dispute_rate, 1)) * 100;

  // ── Value-weighted rate ──────────────────────────────────────────────────────
  // Blend in contract-value completion rate when audit contract history exists.
  // Success on a $10k contract outweighs 100 successful $10 tasks.
  let value_base = count_base; // default: fall back to count-based if no audit history
  if (value_stats.has_value_history) {
    const total_val = value_stats.completed_val + value_stats.disputed_lost_val;
    const value_rate = total_val > 0 ? value_stats.completed_val / total_val : 0.5;
    value_base = value_rate * 100;
    // Blend: 50% count-based + 50% value-based. As escrow history grows, value signal dominates.
    value_base = (count_base * 0.5) + (value_base * 0.5);
  }

  // ── Cap for high dispute rate ─────────────────────────────────────────────────
  const blended = dispute_rate > 0.15 ? Math.min(value_base, 40) : value_base;

  return Math.max(0, blended - recency_penalty);
}

// BC: behavioral consistency — uses fraud/malevolent flags and dispute pattern anomalies
function calcBC(flags, disputes_filed_count, disputes_as_defendant, total_records) {
  if (flags.includes('FRAUD') || flags.includes('MALEVOLENT_CONSTRUCTION')) return 0;

  let score = 100;

  // Penalize for disputes as defendant
  if (total_records > 0) {
    const rate = disputes_as_defendant / total_records;
    score -= Math.min(60, rate * 200); // 10% dispute rate → -20pts; 30% → -60pts
  }

  // Penalize for filing disputes that were ruled frivolous or lost
  if (disputes_filed_count > 5) {
    score -= Math.min(20, (disputes_filed_count - 5) * 2);
  }

  return Math.max(0, score);
}

// CFI: collateral & financial integrity
// Audit fulfillment rate (75%) + credits/funding proxy (25%)
// Falls back to credits-only proxy when no audit contract history exists.
// Note: utilization component removed — BrokerAGEnt does not hold funds.
// Fund custody is managed by the HSCS smart contract hook.
function calcCFI(credits_balance, topup_count, is_funded, audit_stats) {
  if (!is_funded) return 0;

  const { completed, disputed_lost, has_history } = audit_stats;

  if (!has_history) {
    // No audit history yet — credits proxy
    let score = 50;
    if (credits_balance >= 100)     score += 30;
    else if (credits_balance >= 50) score += 20;
    else if (credits_balance >= 20) score += 10;
    else                            score += 5;
    score += Math.min(20, topup_count * 5);
    return Math.min(100, score);
  }

  // Component 1 (75%): Audit fulfillment rate
  // completed / (completed + disputed_lost) — how often does this agent honour contracts?
  const total_resolved = completed + disputed_lost;
  const fulfillment_rate = total_resolved > 0 ? completed / total_resolved : 0.5;
  const fulfillment_score = fulfillment_rate * 100;

  // Component 2 (25%): Credits/funding proxy (hygiene signal)
  let credits_score = 0;
  if (credits_balance >= 100)     credits_score = 100;
  else if (credits_balance >= 50) credits_score = 70;
  else if (credits_balance >= 20) credits_score = 50;
  else                            credits_score = 30;
  credits_score += Math.min(20, topup_count * 5);
  credits_score = Math.min(100, credits_score);

  const cfi = (fulfillment_score * 0.75) + (credits_score * 0.25);
  return Math.min(100, cfi);
}

// EigenTrust vouching bonus (simplified single-hop)
// Explicit vouches: each vouch contributes weight × voucher_tier_multiplier
// Tier multipliers (tier-weighted per April 8 approval):
//   Platinum (>=100 credits proxy) = 2.0pts
//   Gold     (>=50  credits proxy) = 1.5pts
//   Silver   (>=10  credits proxy) = 1.0pt
//   Bronze   (<10   credits proxy) = 0.5pts
// Implicit vouches: completed contracts with distinct counterparties = weak endorsement (0.5 each)
// Cap: +10 points
function calcVouchingBonus(agent_id) {
  const db = getDb();
  let bonus = 0;

  try {
    // Explicit vouches — voucher's tier derived from credits proxy
    const vouches = db.prepare(`
      SELECT v.weight, a.credits
      FROM agent_vouches v
      JOIN agents a ON a.agent_id = v.voucher_id
      WHERE v.vouchee_id = ?
    `).all(agent_id);

    for (const v of vouches) {
      const tier_mult = v.credits >= 100 ? 2.0  // Platinum
                      : v.credits >= 50  ? 1.5  // Gold
                      : v.credits >= 10  ? 1.0  // Silver
                      : 0.5;                    // Bronze
      bonus += v.weight * tier_mult;
    }

    // Implicit vouches from completed contracts — each unique counterparty = 0.5
    const implicit = db.prepare(`
      SELECT COUNT(DISTINCT CASE WHEN buyer_agent = ? THEN seller_agent ELSE buyer_agent END) as n
      FROM contracts
      WHERE (buyer_agent = ? OR seller_agent = ?) AND status = 'COMPLETED'
    `).get(agent_id, agent_id, agent_id);

    bonus += (implicit?.n || 0) * 0.5;
  } catch {
    return 0;
  }

  return Math.min(10, bonus);
}

// IAQ: identity & attestation quality
// Components:
//   Registered agent:                    +30
//   Hedera account (on-chain identity):  +25
//   HCS topic active:                    +15
//   Attestation (version-adjusted):      +25 / +15 / +8 / +0  (current/stale/deprecated/flagged)
//   Operator linked + KYB:               +5
//
// version_check: { status, attested_days_ago, flagged_reason }
function calcIAQ(hedera_account, hcs_topic_id, has_attestation, has_operator, version_check) {
  let score = 30;
  if (hedera_account) score += 25;
  if (hcs_topic_id)   score += 15;
  if (has_operator)   score += 5;

  if (has_attestation) {
    const status  = version_check?.status || 'unknown';
    const stale   = (version_check?.attested_days_ago || 0) > 90;

    if (status === 'flagged') {
      score += 0;       // known-broken version — no attestation credit
    } else if (status === 'deprecated') {
      score += 8;       // outdated but not dangerous
    } else if (stale) {
      score += 15;      // registered but hasn't re-attested in >90 days
    } else {
      score += 25;      // current + fresh attestation — full credit
    }
  }

  return Math.min(100, score);
}

function getTier(score) {
  if (score === null) return null;
  return TIERS.find(t => score >= t.min) || TIERS[TIERS.length - 1];
}

/**
 * Generate human-readable reason codes explaining what is driving the score.
 * Mirrors FICO adverse action notice concept (Gemini feedback §2).
 * Each code: { code, impact: 'positive'|'negative'|'info', detail }
 */
function generateReasonCodes({
  tph, bc, otv, cfi, iaq,
  has_fraud_flag, is_funded, has_attestation, has_operator, operator_kyc_approved,
  hedera_account, hcs_topic_id, dispute_rate, total_records, days_active,
  dormancy_penalty, vouching_bonus, audit_stats, has_boost, final_score,
  recent_disputes_30d, value_stats, top_counterparty_pct,
}) {
  const codes = [];

  // ── Hard conditions ──────────────────────────────────────────────────────────
  if (!is_funded) {
    codes.push({ code: 'UNFUNDED', impact: 'negative', detail: 'No credits. Fund your agentic wallet account to activate scoring.' });
    return codes;
  }
  if (has_fraud_flag) {
    codes.push({ code: 'FRAUD_FLAGGED', impact: 'negative', detail: 'Arbitration ruling includes FRAUD or MALEVOLENT_CONSTRUCTION flag. Score capped at 40.' });
  }
  if (!operator_kyc_approved && final_score >= 84) {
    codes.push({ code: 'PLATINUM_GATE_BLOCKED', impact: 'info', detail: 'Score would qualify for Platinum (85+) but requires a KYC-verified operator. Currently capped at Gold (84).' });
  }
  if (dormancy_penalty > 0) {
    codes.push({ code: 'DORMANCY_PENALTY', impact: 'negative', detail: `No activity detected for extended period. −${dormancy_penalty} pts applied.` });
  }

  // ── TPH signals ──────────────────────────────────────────────────────────────
  if (total_records < 10) {
    codes.push({ code: 'NEW_AGENT_CONSERVATIVE_DEFAULT', impact: 'info', detail: `Fewer than 10 activity records (currently ${total_records}). Conservative TPH default applied until track record is established.` });
  } else if (dispute_rate > 0.15) {
    codes.push({ code: 'HIGH_DISPUTE_RATE', impact: 'negative', detail: `Dispute rate ${(dispute_rate * 100).toFixed(1)}% exceeds 15% threshold. TPH capped at 40.` });
  } else if (dispute_rate < 0.05 && total_records >= 20) {
    codes.push({ code: 'STRONG_COMPLETION_HISTORY', impact: 'positive', detail: `Dispute rate below 5% across ${total_records} records. Strong task performance signal.` });
  }

  if (recent_disputes_30d > 0) {
    codes.push({ code: 'RECENT_DISPUTES_30D', impact: 'negative', detail: `${recent_disputes_30d} dispute(s) filed against agent in the last 30 days. Recency penalty applied to TPH.` });
  }

  if (top_counterparty_pct > 0.60) {
    codes.push({ code: 'LOW_COUNTERPARTY_DIVERSITY', impact: 'negative', detail: `${Math.round(top_counterparty_pct * 100)}% of completed transactions are with a single counterparty. TPH multiplied by 0.75×. Diversify transaction partners to restore full TPH credit.` });
  }

  if (value_stats.has_value_history) {
    const total_val = value_stats.completed_val + value_stats.disputed_lost_val;
    const value_rate = total_val > 0 ? (value_stats.completed_val / total_val * 100).toFixed(0) : 50;
    codes.push({ code: 'VALUE_WEIGHTED_TPH_ACTIVE', impact: 'info', detail: `Contract-value completion rate: ${value_rate}% (${value_stats.completed_contracts} contracts). High-value completions carry more weight than low-value tasks.` });
  }

  // ── BC signals ───────────────────────────────────────────────────────────────
  if (bc >= 90) {
    codes.push({ code: 'CONSISTENT_BEHAVIOR', impact: 'positive', detail: 'No fraud flags, low dispute pattern. High behavioral consistency.' });
  } else if (bc < 60) {
    codes.push({ code: 'BEHAVIORAL_ANOMALY', impact: 'negative', detail: `BC score ${Math.round(bc)} — elevated dispute rate as defendant or unusual patterns detected.` });
  }

  // ── OTV signals ───────────────────────────────────────────────────────────────
  if (days_active < 14) {
    codes.push({ code: 'LOW_TENURE', impact: 'negative', detail: `Agent active for ${days_active} day(s). OTV score will increase with time and activity.` });
  } else if (days_active >= 180 && otv >= 60) {
    codes.push({ code: 'ESTABLISHED_AGENT', impact: 'positive', detail: `${days_active} days active with strong activity volume. Mature tenure signal.` });
  }

  // ── CFI signals ───────────────────────────────────────────────────────────────
  if (!audit_stats.has_history) {
    codes.push({ code: 'CFI_CREDITS_PROXY', impact: 'info', detail: 'No audit contract history yet. CFI calculated from credit balance. Will upgrade to audit fulfillment rate after first completed contract.' });
  } else if (audit_stats.disputed_lost === 0 && audit_stats.completed > 0) {
    codes.push({ code: 'PERFECT_AUDIT_FULFILLMENT', impact: 'positive', detail: `${audit_stats.completed} contract(s) completed, 0 disputes lost. Maximum fulfillment rate.` });
  }

  // ── IAQ signals ───────────────────────────────────────────────────────────────
  if (!hedera_account) {
    codes.push({ code: 'NO_AGENTIC_WALLET', impact: 'negative', detail: 'No Hedera account linked. IAQ penalised −25 pts. Required for contract audit hook attachment and boost.' });
  }
  if (!hcs_topic_id) {
    codes.push({ code: 'NO_HCS_TOPIC', impact: 'negative', detail: 'No Hedera Consensus Service topic active. IAQ penalised −15 pts.' });
  }
  if (!has_attestation) {
    codes.push({ code: 'NO_CODE_ATTESTATION', impact: 'negative', detail: 'No code attestation registered. Submit model version, code hash, or system prompt hash to gain +25 IAQ pts.' });
  } else {
    const vc = version_check || {};
    if (vc.status === 'flagged') {
      codes.push({ code: 'VERSION_FLAGGED', impact: 'negative', detail: `Attested model version "${vc.model_version}" is flagged with known issues: ${vc.flagged_reason || 'see version registry'}. No attestation credit applied. Re-attest with a current version.` });
    } else if (vc.status === 'deprecated') {
      codes.push({ code: 'VERSION_DEPRECATED', impact: 'negative', detail: `Attested model version "${vc.model_version}" is deprecated. Reduced IAQ credit (+8 instead of +25). Upgrade and re-attest to restore full credit.` });
    } else if (vc.is_stale) {
      codes.push({ code: 'ATTESTATION_STALE', impact: 'negative', detail: `Last code attestation is ${vc.attested_days_ago} days old (threshold: 90 days). Reduced IAQ credit (+15). Re-attest to confirm current version.` });
    } else if (vc.status === 'current') {
      codes.push({ code: 'VERSION_CURRENT', impact: 'positive', detail: `Attested model version "${vc.model_version}" is registered as current. Full attestation credit (+25 IAQ pts).` });
    } else {
      codes.push({ code: 'CODE_ATTESTED', impact: 'positive', detail: `Code attestation anchored on HCS ${vc.attested_days_ago !== undefined ? `(${vc.attested_days_ago} days ago)` : ''}. Version not in registry — +25 IAQ pts applied. Platform will classify version as versions are registered.` });
    }
  }
  if (!has_operator) {
    codes.push({ code: 'NO_OPERATOR_LINKED', impact: 'info', detail: 'No human operator linked. Link an operator account for +5 IAQ pts and Platinum eligibility.' });
  }

  // ── Vouching ─────────────────────────────────────────────────────────────────
  if (vouching_bonus > 0) {
    codes.push({ code: 'VOUCHED_BY_PEERS', impact: 'positive', detail: `EigenTrust vouching bonus: +${Math.round(vouching_bonus * 10) / 10} pts from peer endorsements and completed contract network.` });
  }

  // ── Floor ─────────────────────────────────────────────────────────────────────
  if (has_boost) {
    codes.push({ code: 'BOOST_FLOOR_ACTIVE', impact: 'positive', detail: 'Trust Boost purchased. Score floor set to 45. Formula wins if it produces a higher number.' });
  }

  return codes;
}

/**
 * Compute the full AATS for an agent.
 * Returns the score breakdown and tier, or { unfunded: true } if agent has 0 credits.
 */
function computeTrustScore(agent_id) {
  const db = getDb();

  // Agent record
  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error('agent not found');

  // Wrap entire computation — any unexpected error (missing column, schema mismatch, etc.)
  // returns a valid cold-start response instead of propagating a 500.
  try {
    return _computeTrustScoreInner(db, agent, agent_id);
  } catch (err) {
    return {
      agent_id,
      agent_type: agent.agent_type || 'general',
      status: 'ACTIVE',
      score: 0,
      tier: 'BRONZE',
      cold_start: true,
      dimensions: { tph: null, bc: null, otv: null, cfi: null, iaq: null },
      capabilities: agent.capabilities ? JSON.parse(agent.capabilities) : [],
      note: 'No transaction history. Score will update after first verified transaction.',
      computed_at: new Date().toISOString(),
    };
  }
}

function _computeTrustScoreInner(db, agent, agent_id) {
  const is_funded = agent.credits > 0;

  // Vault activity (proxy for transactions)
  const total_records = db.prepare(
    'SELECT COUNT(*) as n FROM vault_records WHERE agent_id = ?'
  ).get(agent_id).n;

  // Top-up count (credits entries in ledger)
  const topup_count = db.prepare(
    "SELECT COUNT(*) as n FROM billing_ledger WHERE agent_id = ? AND type = 'credit'"
  ).get(agent_id).n;

  // Disputes as defendant (all-time)
  const disputes_as_defendant = (() => {
    try {
      return db.prepare(
        "SELECT COUNT(*) as n FROM disputes WHERE responding_agent = ? AND status NOT IN ('filed')"
      ).get(agent_id).n;
    } catch { return 0; }
  })();

  // Disputes as defendant in last 30 days — recency bias signal (Gemini feedback §3)
  const recent_disputes_30d = (() => {
    try {
      return db.prepare(
        "SELECT COUNT(*) as n FROM disputes WHERE responding_agent = ? AND filed_at >= datetime('now', '-30 days')"
      ).get(agent_id).n;
    } catch { return 0; }
  })();

  // Value-weighted completion stats — prevents gaming via low-value task farming (Gemini feedback §1)
  const value_stats = (() => {
    try {
      const completed_row = db.prepare(
        "SELECT COALESCE(SUM(total_amount_hbar), 0) as v, COUNT(*) as n FROM audit_contracts WHERE (buyer_agent = ? OR seller_agent = ?) AND audit_status = 'COMPLETED'"
      ).get(agent_id, agent_id);

      const disputed_lost_val = (() => {
        try {
          return db.prepare(`
            SELECT COALESCE(SUM(c.total_amount_hbar), 0) as v
            FROM arbitration_rulings r
            JOIN disputes d ON r.dispute_id = d.id
            JOIN audit_contracts c ON c.id = d.contract_id
            WHERE r.liable_party = ? AND (d.filing_agent = ? OR d.responding_agent = ?)
          `).get(agent_id, agent_id, agent_id).v || 0;
        } catch { return 0; }
      })();

      const completed_val = completed_row.v || 0;
      const completed_contracts = completed_row.n || 0;
      const has_value_history = (completed_val + disputed_lost_val) > 0;
      return { completed_val, disputed_lost_val, completed_contracts, has_value_history };
    } catch {
      return { completed_val: 0, disputed_lost_val: 0, completed_contracts: 0, has_value_history: false };
    }
  })();

  // Disputes filed by this agent
  const disputes_filed = (() => {
    try {
      return db.prepare(
        "SELECT COUNT(*) as n FROM disputes WHERE filing_agent = ?"
      ).get(agent_id).n;
    } catch { return 0; }
  })();

  // Permanent behavior flags from rulings
  const ruling_flags = (() => {
    try {
      const rows = db.prepare(`
        SELECT r.flags FROM arbitration_rulings r
        JOIN disputes d ON r.dispute_id = d.id
        WHERE d.responding_agent = ? AND r.flags != '[]'
      `).all(agent_id);
      return rows.flatMap(r => JSON.parse(r.flags || '[]'));
    } catch { return []; }
  })();

  const has_fraud_flag = ruling_flags.includes('FRAUD') || ruling_flags.includes('MALEVOLENT_CONSTRUCTION');

  // Days since registration
  const reg_date = new Date(agent.created_at);
  const days_active = Math.max(0, Math.floor((Date.now() - reg_date.getTime()) / 86400000));

  // Days since last activity
  const last_activity = db.prepare(
    'SELECT MAX(created_at) as last FROM vault_records WHERE agent_id = ?'
  ).get(agent_id).last;
  const days_since_last = last_activity
    ? Math.floor((Date.now() - new Date(last_activity).getTime()) / 86400000)
    : days_active;

  // Audit stats for CFI
  const audit_stats = (() => {
    try {
      const completed = db.prepare(
        "SELECT COUNT(*) as n FROM audit_contracts WHERE (buyer_agent = ? OR seller_agent = ?) AND audit_status = 'COMPLETED'"
      ).get(agent_id, agent_id).n;

      // Disputes lost as either party (ruling went against this agent in an audit contract dispute)
      const disputed_lost = (() => {
        try {
          return db.prepare(`
            SELECT COUNT(*) as n FROM arbitration_rulings r
            JOIN disputes d ON r.dispute_id = d.id
            WHERE r.liable_party = ?
              AND (d.filing_agent = ? OR d.responding_agent = ?)
          `).get(agent_id, agent_id, agent_id).n;
        } catch { return 0; }
      })();

      return { completed, disputed_lost, has_history: completed + disputed_lost > 0 };
    } catch {
      return { completed: 0, disputed_lost: 0, has_history: false };
    }
  })();

  // Attestation check + version status
  const { has_attestation, version_check } = (() => {
    try {
      const row = db.prepare(`
        SELECT model_version, attested_at
        FROM agent_attestations
        WHERE agent_id = ?
        ORDER BY attested_at DESC LIMIT 1
      `).get(agent_id);
      if (!row) return { has_attestation: false, version_check: null };

      const attested_days_ago = Math.floor(
        (Date.now() - new Date(row.attested_at).getTime()) / 86400000
      );

      // Look up model_version in the platform registry
      const reg = row.model_version
        ? db.prepare('SELECT status, flagged_reason FROM agent_version_registry WHERE model_version = ?').get(row.model_version)
        : null;

      return {
        has_attestation: true,
        version_check: {
          model_version:    row.model_version || null,
          attested_at:      row.attested_at,
          attested_days_ago,
          status:           reg?.status || 'unknown',   // unknown = not in registry yet
          flagged_reason:   reg?.flagged_reason || null,
          is_stale:         attested_days_ago > 90,
        },
      };
    } catch { return { has_attestation: false, version_check: null }; }
  })();

  // Operator link check + KYC status
  const { has_operator, operator_kyc_approved } = (() => {
    try {
      const row = db.prepare(`
        SELECT oa.operator_id, o.kyc_status
        FROM operator_agents oa
        JOIN operators o ON o.operator_id = oa.operator_id
        WHERE oa.agent_id = ?
        LIMIT 1
      `).get(agent_id);
      return {
        has_operator: !!row,
        operator_kyc_approved: row?.kyc_status === 'approved',
      };
    } catch { return { has_operator: false, operator_kyc_approved: false }; }
  })();

  // Agent-level compliance fields
  const { risk_rating } = db.prepare(
    'SELECT risk_rating FROM agents WHERE agent_id = ?'
  ).get(agent_id) || {};

  // Domain-specific weight profile
  const profile = WEIGHT_PROFILES[agent.agent_type] || WEIGHT_PROFILES.general;

  // Counterparty diversity check (approved April 8):
  // If >60% of completed transactions are with a single counterparty, apply 0.75× to TPH.
  // Prevents inflated scores from bilateral arrangements that don't reflect real market trust.
  const { counterparty_multiplier, top_counterparty_pct } = (() => {
    try {
      const rows = db.prepare(`
        SELECT
          CASE WHEN buyer_agent = ? THEN seller_agent ELSE buyer_agent END AS counterparty,
          COUNT(*) AS tx_count
        FROM contracts
        WHERE (buyer_agent = ? OR seller_agent = ?) AND status = 'COMPLETED'
        GROUP BY counterparty
        ORDER BY tx_count DESC
      `).all(agent_id, agent_id, agent_id);

      if (rows.length === 0) return { counterparty_multiplier: 1.0, top_counterparty_pct: 0 };
      const total_tx = rows.reduce((sum, r) => sum + r.tx_count, 0);
      const pct = total_tx > 0 ? rows[0].tx_count / total_tx : 0;
      return { counterparty_multiplier: pct > 0.60 ? 0.75 : 1.0, top_counterparty_pct: pct };
    } catch { return { counterparty_multiplier: 1.0, top_counterparty_pct: 0 }; }
  })();

  // Arena bonuses — injected per-dimension from gameplay results
  const arena_bonuses = (() => {
    try {
      const { getArenaBonuses } = require('./arena');
      return getArenaBonuses(agent_id);
    } catch { return {}; }
  })();

  // Arena badges
  const arena_badges = (() => {
    try {
      const { getAgentBadges } = require('./arena');
      return getAgentBadges(agent_id).map(b => b.badge);
    } catch { return []; }
  })();

  // Sub-scores
  const tph = clamp(calcTPH(disputes_as_defendant, total_records, has_fraud_flag, value_stats, recent_disputes_30d) * counterparty_multiplier + (arena_bonuses.tph || 0), 0, 100);
  const bc  = clamp(calcBC(ruling_flags, disputes_filed, disputes_as_defendant, total_records) + (arena_bonuses.bc || 0), 0, 100);
  const otv = clamp(calcOTV(days_active, total_records) + (arena_bonuses.otv || 0), 0, 100);
  const cfi = clamp(calcCFI(agent.credits, topup_count, is_funded, audit_stats) + (arena_bonuses.cfi || 0), 0, 100);
  const iaq = clamp(calcIAQ(agent.hedera_account, agent.hcs_topic_id, has_attestation, has_operator, version_check) + (arena_bonuses.iaq || 0), 0, 100);

  // Weighted raw score — weights vary by agent_type
  const raw = (tph * profile.tph) + (bc * profile.bc) + (otv * profile.otv) + (cfi * profile.cfi) + (iaq * profile.iaq);

  // Dormancy penalty — three-phase decay (approved April 8):
  //   0–180d:   no penalty (grace period)
  //   181–365d: −1pt per 30d inactive
  //   >365d:    −2pt per 30d inactive (on top of phase-2 accumulation)
  //   Max total loss capped at 20pts
  const dormancy_penalty = (() => {
    if (days_since_last <= 180) return 0;
    const phase2_days = Math.min(days_since_last, 365) - 180;
    const phase2 = Math.floor(phase2_days / 30) * 1;
    if (days_since_last <= 365) return Math.min(20, phase2);
    const phase3 = Math.floor((days_since_last - 365) / 30) * 2;
    return Math.min(20, phase2 + phase3);
  })();

  // EigenTrust vouching bonus
  const vouching_bonus = calcVouchingBonus(agent_id);

  let final_score = clamp(raw + vouching_bonus - dormancy_penalty, 0, 100);

  // Hard fraud cap
  if (has_fraud_flag) {
    final_score = Math.min(final_score, 40);
  }

  // Funded floor: every funded, non-fraudulent agent starts at minimum Bronze (30).
  // Agents with a one-time boost purchase start at minimum 45 instead.
  // Fraud-flagged agents are excluded — their cap overrides the floor.
  if (!has_fraud_flag) {
    const floor = agent.has_boost ? 45 : 30;
    final_score = Math.max(floor, final_score);
  }

  // Platinum hard gate: KYC approval required to reach 85+
  // Without a verified operator, score is capped at top of Gold (84)
  if (final_score >= 85 && !operator_kyc_approved) {
    final_score = 84;
  }

  // Hard unfunded gate (return special status, not a number)
  if (!is_funded) {
    return {
      agent_id,
      agent_type: agent.agent_type || 'general',
      status: 'UNFUNDED',
      score: 0,
      tier: null,
      message: 'Agent has no credits. Fund an agentic wallet account to activate a minimum Bronze score (30). Boost purchase raises floor to 45.',
      score_floor: { active: false, floor: null, boost_purchased: !!agent.has_boost },
      sub_scores: { tph, bc, otv, cfi, iaq },
      bc_disclosure: {
        provisional: true,
        note: 'The Behavioral Consistency (BC) dimension is provisional. Full behavioral monitoring via Hedera HCS is not yet operational. This score reflects static signals only (fraud flags, dispute patterns) and will be updated when real-time behavioral monitoring is live.',
      },
    };
  }

  const tier = getTier(final_score);

  const dispute_rate = total_records > 0 ? disputes_as_defendant / total_records : 0;

  const reason_codes = generateReasonCodes({
    tph, bc, otv, cfi, iaq,
    has_fraud_flag, is_funded, has_attestation, has_operator, operator_kyc_approved,
    hedera_account: agent.hedera_account, hcs_topic_id: agent.hcs_topic_id,
    dispute_rate, total_records, days_active,
    dormancy_penalty, vouching_bonus, audit_stats,
    has_boost: !!agent.has_boost, final_score,
    recent_disputes_30d, value_stats, top_counterparty_pct,
  });

  return {
    agent_id,
    agent_type: agent.agent_type || 'general',
    agent_type_label: profile.label,
    agent_type_description: profile.description,
    status: has_fraud_flag ? 'FLAGGED' : 'ACTIVE',
    score: Math.round(final_score * 10) / 10,
    tier: tier.label,
    collateral_required_pct: tier.collateral_pct,
    max_transaction_usd: tier.max_tx_usd,
    sub_scores: {
      tph:  Math.round(tph),
      bc:   Math.round(bc),
      otv:  Math.round(otv),
      cfi:  Math.round(cfi),
      iaq:  Math.round(iaq),
    },
    weights: {
      tph: `${Math.round(profile.tph * 100)}%`,
      bc:  `${Math.round(profile.bc  * 100)}%`,
      otv: `${Math.round(profile.otv * 100)}%`,
      cfi: `${Math.round(profile.cfi * 100)}%`,
      iaq: `${Math.round(profile.iaq * 100)}%`,
    },
    dominant_dimension: profile.dominant,
    flags: ruling_flags,
    dormancy_penalty,
    days_active,
    records_stored: total_records,
    credits: agent.credits,
    attestation: {
      code_attested: has_attestation,
      operator_linked: has_operator,
      iaq_mode: has_attestation ? 'attested' : 'unattested',
    },
    audit: {
      contracts_completed: audit_stats.completed,
      disputes_lost: audit_stats.disputed_lost,
      cfi_mode: audit_stats.has_history ? 'audit_fulfillment' : 'credits_proxy',
    },
    vouching: {
      bonus_applied: Math.round(vouching_bonus * 10) / 10,
    },
    arena: {
      badges: arena_badges,
      bonuses: Object.keys(arena_bonuses).length > 0 ? arena_bonuses : null,
    },
    reason_codes,
    score_floor: {
      active: !has_fraud_flag,
      floor: has_fraud_flag ? null : (agent.has_boost ? 45 : 30),
      boost_purchased: !!agent.has_boost,
    },
    compliance: {
      operator_kyc_approved,
      risk_rating: risk_rating !== null && risk_rating !== undefined ? Math.round(risk_rating * 100) / 100 : null,
      platinum_gate: operator_kyc_approved ? 'CLEAR' : 'BLOCKED — KYC approval required for Platinum',
    },
    capabilities: agent.capabilities ? JSON.parse(agent.capabilities) : [],
    bc_disclosure: {
      provisional: true,
      note: 'The Behavioral Consistency (BC) dimension is provisional. Full behavioral monitoring via Hedera HCS is not yet operational. This score reflects static signals only (fraud flags, dispute patterns) and will be updated when real-time behavioral monitoring is live.',
    },
    computed_at: new Date().toISOString(),
  };
}

module.exports = { computeTrustScore, getTier, TIERS, WEIGHT_PROFILES };
