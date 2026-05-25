/**
 * KYC (Know Your Agent / Know Your Operator) module
 *
 * Stores KYC verification records for operators.
 * Full document verification and liveness checks are delegated to
 * a third-party provider (Sumsub recommended). This module stores
 * the attestation hash + status, not raw identity documents.
 *
 * Levels:
 *   basic     — individual: name, DOB, address, gov ID
 *   enhanced  — EDD for PEPs, high-risk jurisdictions, or large volume
 *   kyb       — corporate: incorporation docs, 25% beneficial owner rule
 *
 * Statuses:
 *   pending   — submitted, awaiting provider review
 *   approved  — verified, may transact
 *   rejected  — failed verification
 *   expired   — verification lapsed (re-verify required)
 *
 * Escrow gate:
 *   On testnet: KYC check is advisory — logs warning, does not block
 *   On mainnet: KYC approved status is required to fund escrow
 */

const { getDb } = require('./db');

const IS_MAINNET = process.env.HEDERA_NETWORK === 'mainnet';

// KYC expiry: approved verifications expire after this many days
const KYC_EXPIRY_DAYS = 365;

// ── Queries ───────────────────────────────────────────────────────────────────

function getKycRecord(operator_id) {
  const db = getDb();
  return db.prepare(
    "SELECT * FROM kyc_verifications WHERE operator_id = ? ORDER BY created_at DESC LIMIT 1"
  ).get(operator_id) || null;
}

function getKycStatus(operator_id) {
  const record = getKycRecord(operator_id);
  if (!record) return 'unverified';
  if (record.status === 'approved' && record.expires_at && new Date() > new Date(record.expires_at)) {
    return 'expired';
  }
  return record.status;
}

// ── Submit ────────────────────────────────────────────────────────────────────

/**
 * Record a KYC submission from a provider webhook or manual admin entry.
 *
 * @param {object} opts
 * @param {string} opts.operator_id
 * @param {string} opts.provider         — 'sumsub' | 'jumio' | 'manual'
 * @param {string} opts.applicant_id     — provider's reference ID
 * @param {string} opts.verification_hash — SHA-256 of the KYC artifact bundle
 * @param {string} opts.level            — 'basic' | 'enhanced' | 'kyb'
 * @param {number} opts.pep_flag         — 1 if PEP detected
 * @param {string} [opts.status]         — override status (default: 'pending')
 */
function submitKyc({ operator_id, provider, applicant_id, verification_hash, level = 'basic', pep_flag = 0, status = 'pending' }) {
  const db = getDb();

  const operator = db.prepare('SELECT operator_id FROM operators WHERE operator_id = ?').get(operator_id);
  if (!operator) throw new Error('operator not found');

  const expires_at = status === 'approved'
    ? new Date(Date.now() + KYC_EXPIRY_DAYS * 86400000).toISOString()
    : null;

  const id = require('crypto').randomBytes(16).toString('hex').toLowerCase();

  db.prepare(`
    INSERT INTO kyc_verifications
      (id, operator_id, provider, status, level, applicant_id, verification_hash, pep_flag, reviewed_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, operator_id, provider, status, level,
    applicant_id || null, verification_hash || null,
    pep_flag,
    status !== 'pending' ? new Date().toISOString() : null,
    expires_at
  );

  // Update kyc_status denorm on operators table
  db.prepare('UPDATE operators SET kyc_status = ?, kyc_level = ? WHERE operator_id = ?')
    .run(status, level, operator_id);

  return { id, operator_id, provider, status, level, pep_flag, expires_at };
}

/**
 * Update an existing KYC record (e.g. provider webhook fires with final decision).
 */
function updateKycStatus({ operator_id, status, rejection_reason = null }) {
  const db = getDb();
  const record = getKycRecord(operator_id);
  if (!record) throw new Error('no KYC submission found for this operator');

  const expires_at = status === 'approved'
    ? new Date(Date.now() + KYC_EXPIRY_DAYS * 86400000).toISOString()
    : null;

  db.prepare(`
    UPDATE kyc_verifications SET
      status = ?,
      rejection_reason = ?,
      reviewed_at = datetime('now'),
      expires_at = ?
    WHERE id = ?
  `).run(status, rejection_reason || null, expires_at, record.id);

  db.prepare('UPDATE operators SET kyc_status = ? WHERE operator_id = ?')
    .run(status, operator_id);

  return getKycRecord(operator_id);
}

// ── Gate ──────────────────────────────────────────────────────────────────────

/**
 * Check whether an operator's agents may participate in escrow.
 * On testnet: advisory only (returns warning, never throws).
 * On mainnet: throws if KYC is not approved.
 *
 * @param {string} agent_id
 * @returns {{ ok: boolean, warning?: string }}
 */
function assertKycCleared(agent_id) {
  const db = getDb();

  // Find operator for this agent
  const link = db.prepare(
    'SELECT operator_id FROM operator_agents WHERE agent_id = ?'
  ).get(agent_id);

  if (!link) {
    const msg = `agent ${agent_id} has no linked operator — KYC unverified`;
    if (IS_MAINNET) throw new Error(`KYC required: ${msg}`);
    return { ok: false, warning: msg };
  }

  const status = getKycStatus(link.operator_id);

  if (status !== 'approved') {
    const msg = `operator ${link.operator_id} KYC status: ${status}`;
    if (IS_MAINNET) throw new Error(`KYC required: ${msg}`);
    return { ok: false, warning: msg };
  }

  // PEP flag → require enhanced KYC
  const record = getKycRecord(link.operator_id);
  if (record?.pep_flag && record.level !== 'enhanced') {
    const msg = `operator ${link.operator_id} is a PEP — enhanced due diligence required`;
    if (IS_MAINNET) throw new Error(`EDD required: ${msg}`);
    return { ok: false, warning: msg };
  }

  return { ok: true };
}

module.exports = { submitKyc, updateKycStatus, getKycStatus, getKycRecord, assertKycCleared };
