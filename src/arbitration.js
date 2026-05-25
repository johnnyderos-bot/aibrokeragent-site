const crypto = require('crypto');
const { getDb } = require('./db');
const { anchorRecord } = require('./hedera');

// Tier definitions
const AI_TIERS = {
  1: { label: 'PROVISIONAL',  max_hbar: 100,    sla_hours: 72 },
  2: { label: 'CERTIFIED',    max_hbar: 1000,   sla_hours: 48 },
  3: { label: 'SENIOR',       max_hbar: 10000,  sla_hours: 24 },
  4: { label: 'MASTER',       max_hbar: null,   sla_hours: 12 },
};
const HUMAN_TIERS = {
  5: { label: 'HUMAN_CERTIFIED', max_hbar: 5000,  sla_hours: 48 },
  6: { label: 'HUMAN_SENIOR',    max_hbar: 50000, sla_hours: 24 },
  7: { label: 'HUMAN_MASTER',    max_hbar: null,  sla_hours: 12 },
};
const ALL_TIERS = { ...AI_TIERS, ...HUMAN_TIERS };

// Platform fee rates
const PLATFORM_FEE = {
  ruling:    0.10,
  mediation: 0.05,
  appeal:    0.15,
};

// Hours from now as ISO datetime string
function hoursFromNow(hours) {
  return new Date(Date.now() + hours * 3600 * 1000).toISOString();
}

function hashText(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Register an arbitrator agent in the registry
function registerArbitrator({ agent_id, type = 'ai', tier = 1, specializations = [], fee_per_dispute = 5.0, stake_hbar = 0.0, kyc_verified = 0 }) {
  const db = getDb();

  // Validate agent exists
  const agent = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(agent_id);
  if (!agent) throw new Error('agent not found');

  // Human arbitrators require KYC
  if (type === 'human' && !kyc_verified) throw new Error('human arbitrators require kyc_verified = 1');

  db.prepare(`
    INSERT INTO arbitrators (agent_id, type, tier, specializations, fee_per_dispute, stake_hbar, kyc_verified)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      type = excluded.type,
      tier = excluded.tier,
      specializations = excluded.specializations,
      fee_per_dispute = excluded.fee_per_dispute,
      stake_hbar = excluded.stake_hbar,
      kyc_verified = excluded.kyc_verified,
      active = 1
  `).run(agent_id, type, tier, JSON.stringify(specializations), fee_per_dispute, stake_hbar, kyc_verified ? 1 : 0);

  return getArbitrator(agent_id);
}

function getArbitrator(agent_id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM arbitrators WHERE agent_id = ?').get(agent_id);
  if (!row) return null;
  return { ...row, specializations: JSON.parse(row.specializations || '[]') };
}

// List active arbitrators, optionally filtered by tier and dispute value
function listArbitrators({ min_tier, max_tier, dispute_value_hbar, type } = {}) {
  const db = getDb();
  let query = 'SELECT * FROM arbitrators WHERE active = 1';
  const params = [];

  if (type) { query += ' AND type = ?'; params.push(type); }
  if (min_tier) { query += ' AND tier >= ?'; params.push(min_tier); }
  if (max_tier) { query += ' AND tier <= ?'; params.push(max_tier); }

  const rows = db.prepare(query).all(...params);

  return rows
    .map(r => ({ ...r, specializations: JSON.parse(r.specializations || '[]') }))
    .filter(r => {
      if (!dispute_value_hbar) return true;
      const tierDef = ALL_TIERS[r.tier];
      return tierDef && (tierDef.max_hbar === null || dispute_value_hbar <= tierDef.max_hbar);
    })
    .sort((a, b) => b.arbitrator_score - a.arbitrator_score);
}

// File a new dispute
function fileDispute({ contract_id, filing_agent, responding_agent, grievance, dispute_value_hbar = 0, arbitrator_id }) {
  const db = getDb();

  if (!contract_id || !filing_agent || !responding_agent || !grievance) {
    throw new Error('contract_id, filing_agent, responding_agent, and grievance are required');
  }
  if (filing_agent === responding_agent) throw new Error('cannot file dispute against yourself');

  // Validate arbitrator if provided
  if (arbitrator_id) {
    const arb = getArbitrator(arbitrator_id);
    if (!arb || !arb.active) throw new Error('arbitrator not found or inactive');
    const tierDef = ALL_TIERS[arb.tier];
    if (tierDef.max_hbar !== null && dispute_value_hbar > tierDef.max_hbar) {
      throw new Error(`arbitrator tier cannot handle disputes above ${tierDef.max_hbar} HBAR`);
    }
  }

  // Collusion check — arbitrator cannot have transacted with either party in last 90 days
  if (arbitrator_id) {
    const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();
    const conflict = db.prepare(`
      SELECT id FROM disputes
      WHERE arbitrator_id = ?
        AND (filing_agent IN (?, ?) OR responding_agent IN (?, ?))
        AND resolved_at > ?
    `).get(arbitrator_id, filing_agent, responding_agent, filing_agent, responding_agent, cutoff);
    if (conflict) throw new Error('conflict of interest — arbitrator transacted with a party in last 90 days');
  }

  const id = crypto.randomBytes(16).toString('hex').toLowerCase();
  const tierDef = arbitrator_id ? ALL_TIERS[getArbitrator(arbitrator_id).tier] : ALL_TIERS[1];
  const sla_deadline = hoursFromNow(tierDef.sla_hours);
  const response_deadline = hoursFromNow(24);

  db.prepare(`
    INSERT INTO disputes
      (id, contract_id, filing_agent, responding_agent, grievance, dispute_value_hbar, arbitrator_id, status, sla_deadline, response_deadline)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'filed', ?, ?)
  `).run(id, contract_id, filing_agent, responding_agent, grievance, dispute_value_hbar, arbitrator_id || null, sla_deadline, response_deadline);

  return getDispute(id);
}

function getDispute(id) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM disputes WHERE id = ?').get(id);
  if (!row) return null;
  return {
    ...row,
    ai_flags: JSON.parse(row.ai_flags || '[]'),
  };
}

// Submit evidence for a dispute
function submitEvidence({ dispute_id, submitted_by, vault_record_id, description }) {
  const db = getDb();
  const dispute = getDispute(dispute_id);
  if (!dispute) throw new Error('dispute not found');
  if (!['filed', 'responding', 'deliberating'].includes(dispute.status)) {
    throw new Error('evidence cannot be submitted at this stage');
  }
  if (submitted_by !== dispute.filing_agent && submitted_by !== dispute.responding_agent) {
    throw new Error('only dispute parties can submit evidence');
  }
  if (!description) throw new Error('description is required');

  const id = crypto.randomBytes(16).toString('hex').toLowerCase();
  db.prepare(`
    INSERT INTO arbitration_evidence (id, dispute_id, submitted_by, vault_record_id, description)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, dispute_id, submitted_by, vault_record_id || null, description);

  // Advance status to 'responding' once the responding party submits
  if (dispute.status === 'filed' && submitted_by === dispute.responding_agent) {
    db.prepare("UPDATE disputes SET status = 'responding' WHERE id = ?").run(dispute_id);
  }

  return { id, dispute_id, submitted_by, vault_record_id, description };
}

// Arbitrator sets dispute to deliberating
function startDeliberation(dispute_id, arbitrator_id) {
  const db = getDb();
  const dispute = getDispute(dispute_id);
  if (!dispute) throw new Error('dispute not found');
  if (dispute.arbitrator_id !== arbitrator_id) throw new Error('not assigned arbitrator for this dispute');
  if (!['filed', 'responding'].includes(dispute.status)) throw new Error('dispute is not in a reviewable state');

  db.prepare("UPDATE disputes SET status = 'deliberating' WHERE id = ?").run(dispute_id);
  return getDispute(dispute_id);
}

// Issue a ruling
async function issueRuling({ dispute_id, arbitrator_id, liable_party, remedy_type, remedy_amount = 0, rationale, flags = [], ai_confidence, ai_flags, ai_analysis }) {
  const db = getDb();
  const dispute = getDispute(dispute_id);
  if (!dispute) throw new Error('dispute not found');
  if (dispute.status === 'ruled') throw new Error('dispute already has a ruling');

  const arb = getArbitrator(arbitrator_id);
  if (!arb) throw new Error('arbitrator not found');

  // AI escalation check — if AI confidence is below threshold, flag for human review
  const CONFIDENCE_THRESHOLD = 0.65;
  const needsHuman = (
    (ai_confidence !== undefined && ai_confidence < CONFIDENCE_THRESHOLD) ||
    (dispute.dispute_value_hbar > 10000 && arb.type === 'ai') ||
    (ai_flags && ai_flags.includes('MALEVOLENT_CONSTRUCTION') && arb.type === 'ai')
  );

  if (needsHuman) {
    // Store AI analysis and escalate
    db.prepare(`
      UPDATE disputes SET
        status = 'escalated',
        human_escalated = 1,
        ai_confidence = ?,
        ai_flags = ?,
        ai_analysis = ?
      WHERE id = ?
    `).run(
      ai_confidence ?? null,
      JSON.stringify(ai_flags || []),
      ai_analysis || null,
      dispute_id
    );
    return {
      escalated: true,
      dispute_id,
      reason: ai_confidence < CONFIDENCE_THRESHOLD
        ? `AI confidence ${ai_confidence} below threshold ${CONFIDENCE_THRESHOLD}`
        : dispute.dispute_value_hbar > 10000
          ? 'high-value dispute requires human arbitrator'
          : 'MALEVOLENT_CONSTRUCTION finding requires human confirmation',
      dispute: getDispute(dispute_id),
    };
  }

  if (liable_party !== dispute.filing_agent && liable_party !== dispute.responding_agent && liable_party !== 'none') {
    throw new Error('liable_party must be filing_agent, responding_agent, or none');
  }
  if (!rationale) throw new Error('rationale is required');

  const rationale_hash = hashText(rationale);
  const ruling_id = crypto.randomBytes(16).toString('hex').toLowerCase();
  const appeal_deadline = hoursFromNow(48);
  const is_human = arb.type === 'human';

  // Anchor ruling to HCS
  let hcs_topic_id = null;
  let hcs_sequence = null;
  try {
    const arbRow = db.prepare('SELECT hcs_topic_id FROM arbitrators WHERE agent_id = ?').get(arbitrator_id);
    if (arbRow && arbRow.hcs_topic_id) {
      const anchor = await anchorRecord(arbRow.hcs_topic_id, {
        type: 'ARBITRATION_RULING',
        dispute_id,
        liable_party,
        remedy_type,
        remedy_amount,
        rationale_hash,
        flags,
        issued_at: new Date().toISOString(),
      });
      hcs_topic_id = arbRow.hcs_topic_id;
      hcs_sequence = anchor.sequenceNumber;
    }
  } catch (err) {
    console.error('HCS anchor failed (ruling still recorded):', err.message);
  }

  db.prepare(`
    INSERT INTO arbitration_rulings
      (id, dispute_id, arbitrator_id, liable_party, remedy_type, remedy_amount, rationale, rationale_hash, flags, hcs_topic_id, hcs_sequence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(ruling_id, dispute_id, arbitrator_id, liable_party, remedy_type, remedy_amount, rationale, rationale_hash, JSON.stringify(flags), hcs_topic_id, hcs_sequence);

  db.prepare(`
    UPDATE disputes SET
      status = 'ruled',
      human_escalated = ?,
      ai_confidence = ?,
      ai_flags = ?,
      ai_analysis = ?,
      resolved_at = datetime('now'),
      hcs_topic_id = ?,
      hcs_sequence = ?,
      appeal_deadline = ?
    WHERE id = ?
  `).run(
    is_human ? 1 : (dispute.human_escalated || 0),
    ai_confidence ?? dispute.ai_confidence,
    JSON.stringify(ai_flags || JSON.parse(dispute.ai_flags || '[]')),
    ai_analysis || dispute.ai_analysis,
    hcs_topic_id,
    hcs_sequence,
    appeal_deadline,
    dispute_id
  );

  // Update arbitrator stats
  db.prepare(`
    UPDATE arbitrators SET
      total_rulings = total_rulings + 1,
      last_ruling_at = datetime('now')
    WHERE agent_id = ?
  `).run(arbitrator_id);

  return {
    ruling_id,
    dispute_id,
    arbitrator_id,
    liable_party,
    remedy_type,
    remedy_amount,
    rationale_hash,
    flags,
    hcs_topic_id,
    hcs_sequence,
    appeal_deadline,
    human_ruling: is_human,
  };
}

// File an appeal
function fileAppeal({ dispute_id, appellant_id, grounds }) {
  const db = getDb();
  const dispute = getDispute(dispute_id);
  if (!dispute) throw new Error('dispute not found');
  if (dispute.status !== 'ruled') throw new Error('dispute has no ruling to appeal');
  if (appellant_id !== dispute.filing_agent && appellant_id !== dispute.responding_agent) {
    throw new Error('only dispute parties can appeal');
  }
  if (!grounds) throw new Error('grounds are required');

  // Check appeal deadline
  if (dispute.appeal_deadline && new Date() > new Date(dispute.appeal_deadline)) {
    throw new Error('appeal deadline has passed');
  }

  // Check no existing appeal
  const existing = db.prepare('SELECT id FROM appeals WHERE dispute_id = ?').get(dispute_id);
  if (existing) throw new Error('this dispute already has an appeal filed');

  const ruling = db.prepare('SELECT * FROM arbitration_rulings WHERE dispute_id = ?').get(dispute_id);
  const original_arb = getArbitrator(ruling.arbitrator_id);
  const appeal_fee = (original_arb?.fee_per_dispute || 5) * 2;

  const id = crypto.randomBytes(16).toString('hex').toLowerCase();
  db.prepare(`
    INSERT INTO appeals (id, dispute_id, appellant_id, grounds, fee_paid)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, dispute_id, appellant_id, grounds, appeal_fee);

  db.prepare("UPDATE disputes SET status = 'appealed' WHERE id = ?").run(dispute_id);

  return { id, dispute_id, appellant_id, grounds, fee_paid: appeal_fee, status: 'pending' };
}

// Resolve an appeal
async function resolveAppeal({ appeal_id, senior_arbitrator_id, outcome, rationale }) {
  const db = getDb();
  const appeal = db.prepare('SELECT * FROM appeals WHERE id = ?').get(appeal_id);
  if (!appeal) throw new Error('appeal not found');
  if (appeal.outcome) throw new Error('appeal already resolved');
  if (!['affirmed', 'overturned'].includes(outcome)) throw new Error('outcome must be affirmed or overturned');
  if (!rationale) throw new Error('rationale is required');

  const arb = getArbitrator(senior_arbitrator_id);
  if (!arb) throw new Error('arbitrator not found');
  if (arb.tier < 3) throw new Error('appeals require a Tier 3+ arbitrator');

  db.prepare(`
    UPDATE appeals SET
      senior_arbitrator_id = ?,
      outcome = ?,
      resolved_at = datetime('now')
    WHERE id = ?
  `).run(senior_arbitrator_id, outcome, appeal_id);

  const final_status = outcome === 'affirmed' ? 'closed' : 'overturned';
  db.prepare("UPDATE disputes SET status = ? WHERE id = ?").run(final_status, appeal.dispute_id);

  // Score impact: if overturned, penalize original arbitrator
  if (outcome === 'overturned') {
    const ruling = db.prepare('SELECT arbitrator_id FROM arbitration_rulings WHERE dispute_id = ?').get(appeal.dispute_id);
    if (ruling) {
      const penalty = arb.type === 'human' ? 15 : 10;
      db.prepare(`
        UPDATE arbitrators SET
          arbitrator_score = MAX(0, arbitrator_score - ?)
        WHERE agent_id = ?
      `).run(penalty, ruling.arbitrator_id);
    }
  }

  return { appeal_id, outcome, dispute_id: appeal.dispute_id, status: final_status };
}

// ── Arbitrator SLA timeout + re-selection ─────────────────────────────────────
//
// Agent economy standards:
//   AI arbitrators:    re-assign immediately once SLA deadline passes
//   Human arbitrators: 24h grace period beyond SLA (real people, not bots)
//   After 3 lifetime SLA misses: arbitrator auto-deactivated
//   Max 3 reassignments per dispute before DEADLOCKED (admin required)
//
// Re-selection priority: same tier → next tier up → ... → DEADLOCKED

const MAX_REASSIGNMENTS = 3;
const HUMAN_GRACE_HOURS  = 24;
const SLA_MISSES_BEFORE_DEACTIVATION = 3;

function isArbitratorTimedOut(dispute, arbitrator) {
  if (!dispute.sla_deadline) return false;
  const sla = new Date(dispute.sla_deadline);
  const now  = new Date();
  if (now <= sla) return false;

  // Human arbitrators get a grace period beyond the SLA
  if (arbitrator?.type === 'human') {
    const grace = new Date(sla.getTime() + HUMAN_GRACE_HOURS * 3600 * 1000);
    return now > grace;
  }
  return true;
}

// Find the next eligible arbitrator for a dispute.
// Excludes the current one and anyone with a conflict of interest.
function findReplacementArbitrator(dispute, starting_tier) {
  const db = getDb();
  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString();

  const tiers = Object.keys(ALL_TIERS).map(Number).sort((a, b) => a - b);
  const startIdx = tiers.indexOf(starting_tier);

  for (let i = startIdx; i < tiers.length; i++) {
    const tier = tiers[i];
    const tierDef = ALL_TIERS[tier];

    // Skip if tier can't handle this dispute value
    if (tierDef.max_hbar !== null && dispute.dispute_value_hbar > tierDef.max_hbar) continue;

    const candidates = db.prepare(`
      SELECT a.* FROM arbitrators a
      WHERE a.active = 1
        AND a.tier = ?
        AND a.agent_id != ?
      ORDER BY a.arbitrator_score DESC
    `).all(tier, dispute.arbitrator_id || '');

    for (const candidate of candidates) {
      // Collusion check
      const conflict = db.prepare(`
        SELECT id FROM disputes
        WHERE arbitrator_id = ?
          AND (filing_agent IN (?, ?) OR responding_agent IN (?, ?))
          AND resolved_at > ?
      `).get(candidate.agent_id, dispute.filing_agent, dispute.responding_agent,
             dispute.filing_agent, dispute.responding_agent, cutoff);
      if (conflict) continue;

      return candidate;
    }
  }
  return null;
}

/**
 * Check one dispute for arbitrator timeout and re-assign if needed.
 * Returns { action: 'none' | 'reassigned' | 'deadlocked', details }
 */
function checkAndReassign(dispute_id) {
  const db = getDb();
  const dispute = getDispute(dispute_id);
  if (!dispute) return { action: 'none', reason: 'dispute not found' };

  // Only active disputes can time out
  const activeStatuses = ['filed', 'responding', 'deliberating', 'escalated'];
  if (!activeStatuses.includes(dispute.status)) {
    return { action: 'none', reason: `dispute status is ${dispute.status}` };
  }

  if (!dispute.arbitrator_id) return { action: 'none', reason: 'no arbitrator assigned' };

  const arbitrator = getArbitrator(dispute.arbitrator_id);
  if (!isArbitratorTimedOut(dispute, arbitrator)) {
    return { action: 'none', reason: 'within SLA' };
  }

  // Penalize and possibly deactivate the timed-out arbitrator
  const new_misses = (arbitrator?.sla_misses || 0) + 1;
  const deactivate  = new_misses >= SLA_MISSES_BEFORE_DEACTIVATION;
  db.prepare(`
    UPDATE arbitrators SET
      sla_misses = ?,
      arbitrator_score = MAX(0, arbitrator_score - 15),
      active = ?
    WHERE agent_id = ?
  `).run(new_misses, deactivate ? 0 : 1, dispute.arbitrator_id);

  if (deactivate) {
    console.warn(`[arbitration] ${dispute.arbitrator_id} deactivated after ${new_misses} SLA misses`);
  }

  // Cap reassignments to prevent infinite loops
  const reassignment_count = (dispute.reassignment_count || 0) + 1;
  if (reassignment_count > MAX_REASSIGNMENTS) {
    db.prepare("UPDATE disputes SET status = 'deadlocked' WHERE id = ?").run(dispute_id);
    console.error(`[arbitration] dispute ${dispute_id} DEADLOCKED after ${MAX_REASSIGNMENTS} reassignments — admin required`);
    return { action: 'deadlocked', dispute_id, reassignment_count };
  }

  // Find a replacement at the same tier or higher
  const current_tier = arbitrator?.tier || 1;
  const replacement  = findReplacementArbitrator(dispute, current_tier);

  if (!replacement) {
    db.prepare("UPDATE disputes SET status = 'deadlocked' WHERE id = ?").run(dispute_id);
    console.error(`[arbitration] dispute ${dispute_id} DEADLOCKED — no replacement arbitrator available`);
    return { action: 'deadlocked', dispute_id, reason: 'no eligible replacement found' };
  }

  // Re-assign: set new arbitrator, reset SLA, record original if first reassignment
  const new_tier_def = ALL_TIERS[replacement.tier];
  const new_sla      = hoursFromNow(new_tier_def.sla_hours);

  db.prepare(`
    UPDATE disputes SET
      arbitrator_id         = ?,
      sla_deadline          = ?,
      reassignment_count    = ?,
      original_arbitrator_id = COALESCE(original_arbitrator_id, ?),
      status                = CASE WHEN status = 'deliberating' THEN 'filed' ELSE status END
    WHERE id = ?
  `).run(replacement.agent_id, new_sla, reassignment_count, dispute.arbitrator_id, dispute_id);

  console.log(`[arbitration] dispute ${dispute_id} reassigned: ${dispute.arbitrator_id} → ${replacement.agent_id} (tier ${replacement.tier}, attempt ${reassignment_count})`);

  return {
    action: 'reassigned',
    dispute_id,
    previous_arbitrator: dispute.arbitrator_id,
    new_arbitrator: replacement.agent_id,
    new_tier: replacement.tier,
    new_sla_deadline: new_sla,
    reassignment_count,
    previous_arbitrator_deactivated: deactivate,
  };
}

/**
 * Scan all open disputes for SLA breaches and re-assign as needed.
 * Run on a recurring schedule (e.g. every hour).
 */
function processTimeouts() {
  const db = getDb();
  const now = new Date().toISOString();

  const expired = db.prepare(`
    SELECT d.id FROM disputes d
    WHERE d.status IN ('filed', 'responding', 'deliberating', 'escalated')
      AND d.arbitrator_id IS NOT NULL
      AND d.sla_deadline IS NOT NULL
      AND d.sla_deadline < ?
  `).all(now);

  if (expired.length === 0) return { checked: 0, reassigned: 0, deadlocked: 0 };

  let reassigned = 0;
  let deadlocked = 0;

  for (const row of expired) {
    const result = checkAndReassign(row.id);
    if (result.action === 'reassigned') reassigned++;
    if (result.action === 'deadlocked') deadlocked++;
  }

  if (reassigned + deadlocked > 0) {
    console.log(`[arbitration] timeout sweep: ${expired.length} expired, ${reassigned} reassigned, ${deadlocked} deadlocked`);
  }

  return { checked: expired.length, reassigned, deadlocked };
}

module.exports = {
  registerArbitrator,
  getArbitrator,
  listArbitrators,
  fileDispute,
  getDispute,
  submitEvidence,
  startDeliberation,
  issueRuling,
  fileAppeal,
  resolveAppeal,
  checkAndReassign,
  processTimeouts,
  ALL_TIERS,
  PLATFORM_FEE,
};
