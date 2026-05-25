/**
 * AATS Score Advisor — BrokerAGEnt
 *
 * Analyzes an agent's current trust score state across all five dimensions
 * and returns a prioritized action list with estimated point gains.
 * Think: credit repair report for AI agents.
 */

const { getDb } = require('./db');
const { computeTrustScore } = require('./trust-score');

// Weighted gain estimate: rawGain points in dimension d, given current weights
function weightedGain(weights, dimension, rawGain) {
  const pct = parseFloat((weights || {})[dimension]) || 10;
  return Math.round((rawGain * pct) / 100 * 10) / 10;
}

const TIER_LABEL = s =>
  s >= 85 ? 'PLATINUM' : s >= 70 ? 'GOLD' : s >= 50 ? 'SILVER' : s >= 30 ? 'BRONZE' : 'RESTRICTED';

function generateScoreAdvice(agentId) {
  const db = getDb();

  // Current trust report
  const report = computeTrustScore(agentId);

  if (report.status === 'UNFUNDED') {
    return {
      agent_id:        agentId,
      status:          'UNFUNDED',
      current_score:   0,
      current_tier:    'RESTRICTED',
      potential_score: 30,
      potential_tier:  'BRONZE',
      potential_gain:  30,
      recommendations: [{
        priority:       1,
        action:         'Fund your agent account',
        dimension:      'ALL',
        estimated_gain: 30,
        effort:         'low',
        cost:           'HBAR deposit (any amount)',
        detail:         'Funding activates AATS scoring. Your score immediately reaches the Bronze floor (30). All further improvements build from there.',
        api_hint:       'POST /vault/account/topup',
      }],
      dimension_snapshot: null,
      generated_at: new Date().toISOString(),
    };
  }

  const agent = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(agentId);
  if (!agent) throw new Error('agent not found');

  // Latest attestation + version status
  const attestation = db.prepare(`
    SELECT model_version, attested_at FROM agent_attestations
    WHERE agent_id = ? ORDER BY attested_at DESC LIMIT 1
  `).get(agentId);

  let versionStatus = 'unattested';
  if (attestation?.model_version) {
    const reg = db.prepare(
      'SELECT status FROM agent_version_registry WHERE model_version = ?'
    ).get(attestation.model_version);
    const daysOld = Math.floor(
      (Date.now() - new Date(attestation.attested_at).getTime()) / (1000 * 60 * 60 * 24)
    );
    if (reg) versionStatus = reg.status;
    else versionStatus = daysOld > 90 ? 'stale' : 'current';
  }

  // Operator link + KYC
  const operatorLink = db.prepare(`
    SELECT o.kyc_status, o.operator_id
    FROM operators o
    JOIN operator_agents oa ON oa.operator_id = o.operator_id
    WHERE oa.agent_id = ?
  `).get(agentId);

  // Activity data
  const recordCount       = db.prepare('SELECT COUNT(*) AS cnt FROM vault_records WHERE agent_id = ?').get(agentId)?.cnt || 0;
  const vouchCount        = db.prepare('SELECT COUNT(*) AS cnt FROM agent_vouches WHERE vouchee_id = ?').get(agentId)?.cnt || 0;
  const completedContracts = db.prepare(`
    SELECT COUNT(*) AS cnt FROM audit_contracts
    WHERE (buyer_agent = ? OR seller_agent = ?) AND audit_status = 'COMPLETED'
  `).get(agentId, agentId)?.cnt || 0;

  const score   = report.score   || 0;
  const weights = report.weights || {};
  const sub     = report.sub_scores || {};

  const recs = [];
  let potential_gain = 0;

  // ── IAQ: Hedera account ──────────────────────────────
  if (!agent.hedera_account) {
    const g = weightedGain(weights, 'iaq', 25);
    recs.push({
      action:         'Link a Hedera agentic wallet',
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'low',
      cost:           'free',
      detail:         'A Hedera account is required for contract audit hook attachment, boost, and arbitration. It contributes +25 raw pts to IAQ and anchors your on-chain identity.',
      api_hint:       'Re-register with hedera_account field, or contact support to update',
      impact_label:   'High — unlocks contract audit hook + boost',
    });
    potential_gain += g;
  }

  // ── IAQ: Attestation / version status ───────────────
  if (!attestation) {
    const g = weightedGain(weights, 'iaq', 25);
    recs.push({
      action:         'Submit a code attestation',
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'low',
      cost:           'free',
      detail:         'Attesting your model_version, code_hash, and system_prompt_hash to HCS proves your agent\'s identity. Adds +25 raw pts IAQ when the version is current.',
      api_hint:       'POST /vault/agents/attest',
      impact_label:   'High — identity anchor',
    });
    potential_gain += g;
  } else if (versionStatus === 'flagged') {
    const g = weightedGain(weights, 'iaq', 25);
    recs.push({
      action:         `URGENT: Upgrade model — ${attestation.model_version} is flagged`,
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'medium',
      cost:           'free',
      detail:         `Your attested version (${attestation.model_version}) is flagged as a security risk. You earn +0 IAQ attestation credit and are hard-blocked from new contract audit hooks on mainnet. Upgrade and re-attest immediately.`,
      api_hint:       'POST /vault/agents/attest with updated model_version',
      impact_label:   'Critical — contract audit hook blocked on mainnet',
    });
    potential_gain += g;
  } else if (versionStatus === 'deprecated') {
    const g = weightedGain(weights, 'iaq', 17);
    recs.push({
      action:         `Upgrade model — ${attestation.model_version} is deprecated (+8 pts, was +25)`,
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'medium',
      cost:           'free',
      detail:         `Your attested version is deprecated. You\'re earning +8 raw IAQ pts instead of +25. Upgrading and re-attesting recovers ~${g} pts toward your final score.`,
      api_hint:       'POST /vault/agents/attest with updated model_version',
      impact_label:   'Medium — partial IAQ credit',
    });
    potential_gain += g;
  } else if (versionStatus === 'stale') {
    const g = weightedGain(weights, 'iaq', 10);
    recs.push({
      action:         'Re-attest your model (attestation is >90 days old)',
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'low',
      cost:           'free',
      detail:         'Attestations older than 90 days drop from +25 to +15 raw IAQ pts. Re-attesting with your current model restores full credit.',
      api_hint:       'POST /vault/agents/attest',
      impact_label:   'Low — refresh for full credit',
    });
    potential_gain += g;
  }

  // ── IAQ: Operator ────────────────────────────────────
  if (!operatorLink) {
    const g = weightedGain(weights, 'iaq', 5);
    recs.push({
      action:         'Link a human operator account',
      dimension:      'IAQ',
      estimated_gain: g,
      effort:         'medium',
      cost:           'free',
      detail:         'A linked operator adds +5 raw IAQ pts and is required for Platinum tier (85+), which unlocks unlimited transaction limits.',
      api_hint:       'POST /operators/register → POST /operators/agents/link',
      impact_label:   'Required for Platinum',
    });
    potential_gain += g;

    if (score >= 72) {
      recs.push({
        action:         'Complete KYC to unlock Platinum tier',
        dimension:      'ALL',
        estimated_gain: 0,
        effort:         'medium',
        cost:           'free',
        detail:         `Your score (${score}) is near Platinum (85+), but without a KYC-verified operator your score is capped at 84. Completing KYC removes the cap.`,
        api_hint:       'POST /operators/register (KYC required)',
        impact_label:   'Unlocks Platinum — unlimited transactions',
      });
    }
  } else if (operatorLink.kyc_status !== 'approved' && score >= 72) {
    recs.push({
      action:         'Complete operator KYC to unlock Platinum tier',
      dimension:      'ALL',
      estimated_gain: 0,
      effort:         'medium',
      cost:           'free',
      detail:         `Operator ${operatorLink.operator_id} KYC status is "${operatorLink.kyc_status}". Approval removes the 84-point Platinum cap.`,
      api_hint:       'Contact support to advance KYC status',
      impact_label:   'Unlocks Platinum',
    });
  }

  // ── OTV: Record volume ───────────────────────────────
  if (recordCount < 50) {
    const target = recordCount < 10 ? 50 : 200;
    const rawGain = recordCount < 10 ? 25 : 10;
    const g = weightedGain(weights, 'otv', rawGain);
    recs.push({
      action:         `Store more vault records (${recordCount} stored, target ${target}+)`,
      dimension:      'OTV',
      estimated_gain: g,
      effort:         'medium',
      cost:           `${Math.max(0, target - recordCount)} credits`,
      detail:         'Operational Tenure & Volume scales logarithmically with record count and days active. Each record costs 1 credit and builds your verifiable activity history.',
      api_hint:       'POST /vault/records',
      impact_label:   'Medium — activity baseline',
    });
    potential_gain += g;
  }

  // ── CFI: Audit contract completions ──────────────────────────
  if (completedContracts === 0 && agent.hedera_account) {
    const g = weightedGain(weights, 'cfi', 25);
    recs.push({
      action:         'Complete your first audited contract',
      dimension:      'CFI',
      estimated_gain: g,
      effort:         'medium',
      cost:           'free (BrokerAGEnt does not hold funds)',
      detail:         'CFI unlocks its full range only with audit contract history. Your first completed contract shifts scoring from credit-balance mode to audit-fulfillment mode, significantly improving CFI potential.',
      api_hint:       'POST /audit/contracts',
      impact_label:   'High — activates CFI audit fulfillment scoring',
    });
    potential_gain += g;
  }

  // ── Boost floor ──────────────────────────────────────
  if (!agent.has_boost && score < 45 && agent.hedera_account) {
    const gain = Math.max(0, 45 - score);
    recs.push({
      action:         'Purchase Trust Boost (floor 30 → 45)',
      dimension:      'ALL',
      estimated_gain: gain,
      effort:         'low',
      cost:           '50 credits (5 HBAR)',
      detail:         'The one-time Trust Boost is the fastest way to move above Bronze. It raises your floor from 30 to 45 — useful for agents that want a credibility signal before organic score activity has time to accumulate.',
      api_hint:       'POST /vault/agents/boost',
      impact_label:   `+${gain} pts immediately (floor lift)`,
    });
    potential_gain += gain;
  }

  // ── Vouching ─────────────────────────────────────────
  if (vouchCount < 3) {
    const g = Math.min(6, (3 - vouchCount) * 2);
    recs.push({
      action:         `Get vouched by ${3 - vouchCount} more trusted agents (${vouchCount}/3)`,
      dimension:      'VOUCHING',
      estimated_gain: g,
      effort:         'medium',
      cost:           'free',
      detail:         'EigenTrust vouches add up to +10 pts bonus. The vouching agent must have a non-trivial credit balance for the vouch to carry weight. Ask counterparties with completed contracts.',
      api_hint:       'Ask counterparty to POST /vault/agents/:your_id/vouch',
      impact_label:   'Low — trust signal from peers',
    });
    potential_gain += g;
  }

  // Sort by estimated_gain desc (keep urgency items first for flagged)
  recs.sort((a, b) => {
    if (a.impact_label?.includes('Critical')) return -1;
    if (b.impact_label?.includes('Critical')) return 1;
    return (b.estimated_gain || 0) - (a.estimated_gain || 0);
  });
  recs.forEach((r, i) => { r.priority = i + 1; });

  const projected = Math.min(100, score + potential_gain);

  return {
    agent_id:        agentId,
    agent_type:      report.agent_type,
    current_score:   score,
    current_tier:    report.tier,
    potential_score: Math.round(projected * 10) / 10,
    potential_tier:  TIER_LABEL(projected),
    potential_gain:  Math.round(potential_gain * 10) / 10,
    quick_wins:      recs.filter(r => r.effort === 'low').slice(0, 3),
    recommendations: recs,
    dimension_snapshot: {
      tph: { score: sub.tph || 0, label: 'Task Performance History',      weight: weights.tph || '30%' },
      bc:  { score: sub.bc  || 0, label: 'Behavioral Consistency',         weight: weights.bc  || '25%' },
      otv: { score: sub.otv || 0, label: 'Operational Tenure & Volume',    weight: weights.otv || '20%' },
      cfi: { score: sub.cfi || 0, label: 'Collateral & Financial Integrity', weight: weights.cfi || '15%' },
      iaq: { score: sub.iaq || 0, label: 'Identity & Attestation Quality', weight: weights.iaq || '10%' },
    },
    version_status:  versionStatus,
    has_boost:       !!agent.has_boost,
    record_count:    recordCount,
    vouch_count:     vouchCount,
    completed_contracts: completedContracts,
    generated_at:    new Date().toISOString(),
  };
}

module.exports = { generateScoreAdvice };
