/**
 * Compliance module — KYC webhook processing + Travel Rule logging
 *
 * Handles inbound verification results from KYC/KYB providers (Sumsub, Jumio, etc.)
 * and anchors a privacy-preserving attestation hash to Hedera HCS.
 *
 * Privacy design:
 *   Raw KYC data (name, DOB, ID) never enters BrokerAGEnt.
 *   The provider stores PII. We receive and store:
 *     - provider_session_id (their reference)
 *     - data_hash (SHA-256 of the full KYC payload — provider-generated)
 *     - risk_score (0.0 low → 1.0 high)
 *     - sanctions_check (CLEAR | HIT | REVIEW)
 *     - verification_type (KYC_INDIVIDUAL | KYC_CORPORATE | KYB)
 *
 *   On APPROVED: we generate a platform attestation hash and anchor it to HCS.
 *   The HCS record proves verification happened without exposing who was verified.
 */

const crypto = require('crypto');
const { getDb } = require('./db');
const { submitKyc, updateKycStatus } = require('./kyc');
const { anchorRecord } = require('./hedera');

// Platform salt — prevents reverse-engineering of attestation hashes
// Set COMPLIANCE_ATTESTATION_SALT in env, or a random value is used (resets on restart)
const ATTESTATION_SALT = process.env.COMPLIANCE_ATTESTATION_SALT || crypto.randomBytes(32).toString('hex');

// HCS topic for compliance attestations (separate from vault topics)
// Set COMPLIANCE_HCS_TOPIC_ID in env after creating the topic on Hedera
const COMPLIANCE_TOPIC_ID = process.env.COMPLIANCE_HCS_TOPIC_ID || null;

// ── Verification webhook ──────────────────────────────────────────────────────

/**
 * Process a verification result from a KYC/KYB provider.
 *
 * @param {string} operator_id
 * @param {object} payload
 * @param {string} payload.provider_session_id
 * @param {string} payload.verification_type    — KYC_INDIVIDUAL | KYC_CORPORATE | KYB
 * @param {string} payload.status               — APPROVED | REJECTED | PENDING | REVIEW
 * @param {string} payload.data_hash            — SHA-256 of full KYC payload (provider-generated)
 * @param {number} payload.risk_score           — 0.0 (low) to 1.0 (high)
 * @param {string} payload.sanctions_check      — CLEAR | HIT | REVIEW
 * @param {string} payload.timestamp
 */
async function processVerification(operator_id, payload) {
  const db = getDb();
  const {
    provider_session_id,
    verification_type = 'KYC_INDIVIDUAL',
    status,
    data_hash,
    risk_score,
    sanctions_check = 'CLEAR',
    timestamp,
    provider = 'provider',
  } = payload;

  if (!status) throw new Error('status is required');

  const normalized_status = status.toLowerCase() === 'approved' ? 'approved'
    : status.toLowerCase() === 'rejected' ? 'rejected'
    : 'pending';

  const pep_flag = risk_score >= 0.7 ? 1 : 0;
  const level = verification_type === 'KYB' || verification_type === 'KYC_CORPORATE' ? 'kyb' : 'basic';

  // Upsert KYC record with full provider data
  const existing = db.prepare(
    "SELECT id FROM kyc_verifications WHERE operator_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(operator_id);

  if (existing) {
    db.prepare(`
      UPDATE kyc_verifications SET
        status = ?, risk_score = ?, sanctions_check = ?, verification_type = ?,
        applicant_id = ?, verification_hash = ?, pep_flag = ?,
        reviewed_at = datetime('now'),
        expires_at = CASE WHEN ? = 'approved' THEN datetime('now', '+365 days') ELSE NULL END
      WHERE id = ?
    `).run(
      normalized_status, risk_score ?? null, sanctions_check, verification_type,
      provider_session_id, data_hash || null, pep_flag,
      normalized_status,
      existing.id
    );
    db.prepare("UPDATE operators SET kyc_status = ?, kyc_level = ? WHERE operator_id = ?")
      .run(normalized_status, level, operator_id);
  } else {
    submitKyc({
      operator_id,
      provider,
      applicant_id: provider_session_id,
      verification_hash: data_hash,
      level,
      pep_flag,
      status: normalized_status,
    });
    // Back-fill provider-specific fields
    db.prepare(`
      UPDATE kyc_verifications SET risk_score = ?, sanctions_check = ?, verification_type = ?
      WHERE operator_id = ? ORDER BY created_at DESC LIMIT 1
    `).run(risk_score ?? null, sanctions_check, verification_type, operator_id);
  }

  // Hard block: OFAC/sanctions HIT must not proceed
  if (sanctions_check === 'HIT') {
    console.error(`[compliance] sanctions HIT for operator ${operator_id} — blocking`);
    return {
      operator_id,
      status: 'BLOCKED',
      reason: 'sanctions_check: HIT',
      hcs_anchored: false,
    };
  }

  // Anchor privacy-preserving attestation hash to HCS on APPROVED
  let hcs_sequence = null;
  if (normalized_status === 'approved') {
    hcs_sequence = await anchorAttestation(operator_id, {
      provider_session_id,
      data_hash,
      verification_type,
      risk_score,
      timestamp: timestamp || new Date().toISOString(),
    });

    // Update all agents linked to this operator with compliance data
    db.prepare(`
      UPDATE agents SET
        risk_rating = ?,
        last_screened_at = datetime('now'),
        attestation_hcs_id = COALESCE(?, attestation_hcs_id)
      WHERE agent_id IN (
        SELECT agent_id FROM operator_agents WHERE operator_id = ?
      )
    `).run(risk_score ?? null, hcs_sequence, operator_id);
  }

  return {
    operator_id,
    status: normalized_status.toUpperCase(),
    verification_type,
    risk_score,
    sanctions_check,
    pep_flag: !!pep_flag,
    hcs_anchored: !!hcs_sequence,
    hcs_sequence,
  };
}

// ── HCS attestation anchor ────────────────────────────────────────────────────

async function anchorAttestation(operator_id, { provider_session_id, data_hash, verification_type, risk_score, timestamp }) {
  if (!COMPLIANCE_TOPIC_ID) {
    console.warn('[compliance] COMPLIANCE_HCS_TOPIC_ID not set — skipping HCS anchor');
    return null;
  }

  // Privacy-preserving hash: HMAC of session+data_hash with platform salt
  // This proves verification happened without revealing operator identity on-chain
  const attestation_hash = crypto
    .createHmac('sha256', ATTESTATION_SALT)
    .update(`${operator_id}:${provider_session_id}:${data_hash}:${verification_type}`)
    .digest('hex');

  try {
    const result = await anchorRecord(COMPLIANCE_TOPIC_ID, {
      type: 'COMPLIANCE_ATTESTATION',
      attestation_hash,
      verification_type,
      risk_band: risk_score < 0.3 ? 'LOW' : risk_score < 0.7 ? 'MEDIUM' : 'HIGH',
      verified_at: timestamp,
    });
    console.log(`[compliance] attestation anchored for operator ${operator_id}: seq ${result.sequenceNumber}`);
    return result.sequenceNumber;
  } catch (err) {
    console.error('[compliance] HCS anchor failed (verification still recorded):', err.message);
    return null;
  }
}

// ── Travel Rule ───────────────────────────────────────────────────────────────

/**
 * Log a qualifying transfer for Travel Rule compliance.
 * Called at escrow funding for transfers above the threshold.
 */
function logTravelRule({ originator_agent_id, beneficiary_agent_id, amount_credits, hedera_transaction_id, contract_id }) {
  const db = getDb();

  // Gather originator operator name
  const origOp = db.prepare(`
    SELECT o.name FROM operators o
    JOIN operator_agents oa ON oa.operator_id = o.operator_id
    WHERE oa.agent_id = ?
  `).get(originator_agent_id);

  // Gather beneficiary operator name
  const beneOp = db.prepare(`
    SELECT o.name FROM operators o
    JOIN operator_agents oa ON oa.operator_id = o.operator_id
    WHERE oa.agent_id = ?
  `).get(beneficiary_agent_id);

  const id = crypto.randomBytes(16).toString('hex').toLowerCase();
  db.prepare(`
    INSERT INTO travel_rule_logs
      (id, originator_agent_id, beneficiary_agent_id, originator_vasp_id,
       amount_credits, hedera_transaction_id, contract_id, originator_name, beneficiary_name)
    VALUES (?, ?, ?, 'brokeragent', ?, ?, ?, ?, ?)
  `).run(
    id,
    originator_agent_id, beneficiary_agent_id,
    amount_credits,
    hedera_transaction_id || null,
    contract_id || null,
    origOp?.name || null,
    beneOp?.name || null
  );

  return {
    id,
    originator_agent_id,
    beneficiary_agent_id,
    originator_vasp_id: 'brokeragent',
    amount_credits,
    originator_name: origOp?.name || null,
    beneficiary_name: beneOp?.name || null,
    hedera_transaction_id: hedera_transaction_id || null,
    logged_at: new Date().toISOString(),
  };
}

module.exports = { processVerification, logTravelRule };
