/**
 * Contract Audit Agent — BrokerAGEnt
 *
 * BrokerAGEnt reviews agent contracts for clarity, measurability, and enforceability.
 * On approval, a Hedera Smart Contract Service (HSCS) hook is attached that holds
 * funds until both parties confirm delivery. BrokerAGEnt never holds funds —
 * the HSCS smart contract does. The audit certificate is anchored to HCS and feeds
 * into the CFI dimension of AATS.
 *
 * Contract lifecycle:
 *   SUBMITTED → APPROVED | NEEDS_REVISION → ACTIVE → COMPLETED | DISPUTED | CANCELLED
 *
 * HSCS hook: testnet uses a mock address. On mainnet, attachHook() deploys a real
 * HSCS smart contract that custodies HBAR until dual delivery confirmation.
 */

const crypto = require('crypto');
const { getDb } = require('./db');
const { anchorRecord } = require('./hedera');
const { fileDispute } = require('./arbitration');
const { storeRecord, grantPermission } = require('./vault');
const { createNotification } = require('./console-notifications-api');
const { computeTrustScore } = require('./trust-score');

// ── Rule-based auditor (v1) ──────────────────────────────────────────────────
// Returns array of findings: { severity, category, finding, suggestion }
// CRITICAL findings block approval until resolved via resubmit.
function analyzeContract(terms, total_amount_hbar, arbitrator_id) {
  const findings = [];
  const text = typeof terms === 'string' ? terms : JSON.stringify(terms);
  const lower = text.toLowerCase();

  // ── CLARITY ──────────────────────────────────────────────────────────────
  if (
    !lower.includes('deliver') && !lower.includes('provide') &&
    !lower.includes('complete') && !lower.includes('produce') && !lower.includes('build')
  ) {
    findings.push({
      severity: 'CRITICAL',
      category: 'CLARITY',
      finding: 'No deliverable is specified. The work product or service must be explicitly described.',
      suggestion: 'Add a "Deliverables" section listing each item the seller must provide.',
    });
  }

  if (
    !lower.includes('deadline') && !lower.includes('by ') && !lower.includes('within ') &&
    !lower.includes('date') && !lower.includes('day') && !lower.includes('week') && !lower.includes('hour')
  ) {
    findings.push({
      severity: 'WARNING',
      category: 'CLARITY',
      finding: 'No timeline or deadline specified.',
      suggestion: 'Add a "Timeline" section with a specific delivery date or timeframe (e.g., "within 7 days of contract activation").',
    });
  }

  // ── MEASURABILITY ─────────────────────────────────────────────────────────
  if (
    !lower.includes('accept') && !lower.includes('criteria') && !lower.includes('requirement') &&
    !lower.includes('standard') && !lower.includes('pass') && !lower.includes('test') &&
    !lower.includes('review') && !lower.includes('approv')
  ) {
    findings.push({
      severity: 'WARNING',
      category: 'MEASURABILITY',
      finding: 'No acceptance criteria defined. Without measurable criteria, delivery confirmation is subjective and disputes are more likely.',
      suggestion: 'Add "Acceptance Criteria" — specific, verifiable conditions that define successful delivery.',
    });
  }

  // ── ENFORCEABILITY ────────────────────────────────────────────────────────
  if (!arbitrator_id) {
    findings.push({
      severity: 'CRITICAL',
      category: 'ENFORCEABILITY',
      finding: 'No arbitrator designated. Disputes cannot be resolved without a pre-selected arbitrator.',
      suggestion: 'Select a certified arbitrator from the BrokerAGEnt Arbitration Registry before activating the hook.',
    });
  }

  if (
    !lower.includes('payment') && !lower.includes('amount') &&
    !lower.includes('hbar') && !lower.includes('credit') && !lower.includes('fee')
  ) {
    findings.push({
      severity: 'CRITICAL',
      category: 'ENFORCEABILITY',
      finding: 'Payment terms are not referenced in the contract body.',
      suggestion: 'Reference the agreed payment amount and currency in the contract terms.',
    });
  }

  // ── RISK ──────────────────────────────────────────────────────────────────
  if (total_amount_hbar > 10000) {
    findings.push({
      severity: 'INFO',
      category: 'RISK',
      finding: `High-value contract (${total_amount_hbar.toLocaleString()} HBAR). Consider designating a Human tier arbitrator (H1+).`,
      suggestion: 'Designate a Human Tier H1 or higher arbitrator from the registry for disputes of this magnitude.',
    });
  }

  const broadRightsTerms = ['all rights', 'irrevocable', 'in perpetuity', 'unlimited license'];
  if (broadRightsTerms.some(t => lower.includes(t))) {
    findings.push({
      severity: 'WARNING',
      category: 'RISK',
      finding: 'Contract contains broad rights language. Scope and duration should be clearly bounded.',
      suggestion: 'Specify the exact rights being transferred, their scope, geographic territory, and duration.',
    });
  }

  return findings;
}

function hashText(text) {
  const str = typeof text === 'string' ? text : JSON.stringify(text);
  return crypto.createHash('sha256').update(str).digest('hex');
}

function auditCertHash(id, termsHsh, hookAddress) {
  return crypto.createHash('sha256').update(`${id}:${termsHsh}:${hookAddress}`).digest('hex');
}

// Testnet mock HSCS hook address — mainnet replaces with real HSCS contract deployment
function mockHookAddress(contractId) {
  return `0.0.MOCK_${contractId.slice(0, 8).toUpperCase()}`;
}

function logEvent(db, contract_id, event_type, actor_agent_id, note = null, hcs_sequence = null) {
  const id = crypto.randomBytes(16).toString('hex').toLowerCase();
  db.prepare(`
    INSERT INTO audit_events (id, contract_id, event_type, actor_agent_id, note, hcs_sequence)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, contract_id, event_type, actor_agent_id, note, hcs_sequence);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Submit a contract for audit.
 * Runs analysis immediately. Status is APPROVED if no CRITICAL findings, else NEEDS_REVISION.
 */
function submitContract(agentId, { title, buyer_agent, seller_agent, arbitrator_id, total_amount_hbar, terms }) {
  if (!title || !buyer_agent || !seller_agent || !terms) {
    throw Object.assign(new Error('title, buyer_agent, seller_agent, and terms are required'), { status: 400 });
  }
  if (agentId !== buyer_agent && agentId !== seller_agent) {
    throw Object.assign(new Error('submitting agent must be a party to the contract'), { status: 403 });
  }
  if (buyer_agent === seller_agent) {
    throw Object.assign(new Error('buyer and seller cannot be the same agent'), { status: 400 });
  }

  const db = getDb();

  // Hold check — if either agent has hold = 1, block contract submission
  const buyerLimitsHold = db.prepare('SELECT hold FROM agent_limits WHERE agent_id = ?').get(buyer_agent);
  const sellerLimitsHold = db.prepare('SELECT hold FROM agent_limits WHERE agent_id = ?').get(seller_agent);
  if (buyerLimitsHold && buyerLimitsHold.hold) {
    throw Object.assign(new Error('buyer agent is currently on hold — contract submission blocked'), { status: 423 });
  }
  if (sellerLimitsHold && sellerLimitsHold.hold) {
    throw Object.assign(new Error('seller agent is currently on hold — contract submission blocked'), { status: 423 });
  }

  // Both parties must have a Hedera account (agentic wallet gate)
  const buyerRow  = db.prepare('SELECT hedera_account FROM agents WHERE agent_id = ?').get(buyer_agent);
  const sellerRow = db.prepare('SELECT hedera_account FROM agents WHERE agent_id = ?').get(seller_agent);
  if (!buyerRow)  throw Object.assign(new Error('buyer agent not found'), { status: 404 });
  if (!sellerRow) throw Object.assign(new Error('seller agent not found'), { status: 404 });
  if (!buyerRow.hedera_account) {
    throw Object.assign(new Error('buyer must have an agentic wallet (Hedera account) to enter a contract'), { wallet_required: true, status: 422 });
  }
  if (!sellerRow.hedera_account) {
    throw Object.assign(new Error('seller must have an agentic wallet (Hedera account) to enter a contract'), { wallet_required: true, status: 422 });
  }

  const tHash = hashText(terms);

  // ── Pre-submission checks ──────────────────────────────────────────────────
  const preFindings = [];

  // (a) Hook check — terms should reference hook/hscs/smart contract
  const termsLower = (typeof terms === 'string' ? terms : JSON.stringify(terms)).toLowerCase();
  const hasHookMention = termsLower.includes('hook') || termsLower.includes('hscs') ||
    termsLower.includes('smart contract') || termsLower.includes('smart-contract');
  if (!hasHookMention) {
    preFindings.push({
      severity: 'CRITICAL',
      category: 'ENFORCEABILITY',
      finding: 'No HSCS hook or smart contract reference found in contract terms. An HSCS hook is required to hold funds until delivery is confirmed.',
      suggestion: 'Add a clause referencing the Hedera Smart Contract Service (HSCS) hook that will custody funds during contract execution.',
    });
  }

  // (b) Funding check — both parties must have > 0 credits
  const buyerCreditsRow = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(buyer_agent);
  const sellerCreditsRow = db.prepare('SELECT credits FROM agents WHERE agent_id = ?').get(seller_agent);
  const buyerFunded = buyerCreditsRow && buyerCreditsRow.credits > 0;
  const sellerFunded = sellerCreditsRow && sellerCreditsRow.credits > 0;

  if (!buyerFunded || !sellerFunded) {
    preFindings.push({
      severity: 'WARNING',
      category: 'RISK',
      finding: `Funding issue: ${!buyerFunded ? 'buyer' : ''}${!buyerFunded && !sellerFunded ? ' and ' : ''}${!sellerFunded ? 'seller' : ''} has 0 credits. Contracts cannot be enforced without funded accounts.`,
      suggestion: 'Both parties must fund their agentic wallet accounts before activating the HSCS hook.',
    });
    // Notify owners of unfunded agents
    if (!buyerFunded) {
      createNotification(db, buyer_agent, 'funding_warning', 'warning',
        'Insufficient Credits', 'Your account has 0 credits. Fund your agentic wallet to activate contract hooks.', null);
    }
    if (!sellerFunded) {
      createNotification(db, seller_agent, 'funding_warning', 'warning',
        'Insufficient Credits', 'Your account has 0 credits. Fund your agentic wallet to activate contract hooks.', null);
    }
  }

  const contractAmount = total_amount_hbar || 0;

  // (c) Limits check for buyer
  const buyerLimits = db.prepare('SELECT * FROM agent_limits WHERE agent_id = ?').get(buyer_agent);

  if (buyerLimits) {
    if (buyerLimits.max_contract_value_hbar !== null && contractAmount > buyerLimits.max_contract_value_hbar) {
      preFindings.push({
        severity: 'WARNING',
        category: 'RISK',
        finding: `Contract value (${contractAmount} HBAR) exceeds buyer's maximum contract limit (${buyerLimits.max_contract_value_hbar} HBAR).`,
        suggestion: 'Reduce the contract value or update your agent limits in the Human Trust Console.',
      });
      createNotification(db, buyer_agent, 'limit_exceeded', 'warning',
        'Contract Limit Exceeded',
        `A contract for ${contractAmount} HBAR exceeds your max limit of ${buyerLimits.max_contract_value_hbar} HBAR.`, null);
    }

    if (buyerLimits.min_counterparty_score !== null) {
      let sellerScore = null;
      try { sellerScore = computeTrustScore(seller_agent)?.score || null; } catch { /* non-fatal */ }
      if (sellerScore !== null && sellerScore < buyerLimits.min_counterparty_score) {
        preFindings.push({
          severity: 'WARNING',
          category: 'RISK',
          finding: `Seller AATS score (${sellerScore}) is below buyer's minimum counterparty score requirement (${buyerLimits.min_counterparty_score}).`,
          suggestion: "Review the seller's trust history or update your minimum counterparty score in the console.",
        });
        createNotification(db, buyer_agent, 'counterparty_score_low', 'warning',
          'Counterparty Score Below Threshold',
          `Seller AATS ${sellerScore} is below your minimum of ${buyerLimits.min_counterparty_score}.`, null);
      }
    }
  }

  const findings = [...preFindings, ...analyzeContract(terms, contractAmount, arbitrator_id || null)];
  const hasCritical = findings.some(f => f.severity === 'CRITICAL');

  // Check approval requirement
  let audit_status;
  if (hasCritical) {
    audit_status = 'NEEDS_REVISION';
  } else if (
    buyerLimits &&
    buyerLimits.require_approval_above_hbar !== null &&
    contractAmount > buyerLimits.require_approval_above_hbar
  ) {
    audit_status = 'PENDING_APPROVAL';
    createNotification(db, buyer_agent, 'approval_required', 'info',
      'Contract Pending Your Approval',
      `A contract for ${contractAmount} HBAR requires your approval (threshold: ${buyerLimits.require_approval_above_hbar} HBAR).`, null);
  } else {
    audit_status = 'APPROVED';
  }

  const id = crypto.randomBytes(16).toString('hex').toLowerCase();

  db.transaction(() => {
    db.prepare(`
      INSERT INTO audit_contracts
        (id, title, buyer_agent, seller_agent, arbitrator_id, total_amount_hbar, terms, terms_hash, audit_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, title, buyer_agent, seller_agent, arbitrator_id || null,
      contractAmount,
      typeof terms === 'string' ? terms : JSON.stringify(terms),
      tHash, audit_status
    );

    for (const f of findings) {
      const fid = crypto.randomBytes(16).toString('hex').toLowerCase();
      db.prepare(`
        INSERT INTO audit_findings (id, contract_id, severity, category, finding, suggestion)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fid, id, f.severity, f.category, f.finding, f.suggestion);
    }

    logEvent(db, id, 'SUBMITTED', agentId, `Audit ${audit_status}. ${findings.length} finding(s).`);
  })();

  // ── Post-transaction: store pre-audit vault artifact (async, non-blocking) ───
  setImmediate(async () => {
    try {
      const artifact = JSON.stringify({
        contract_id: id,
        audit_status,
        findings,
        created_at: new Date().toISOString(),
      });
      const vaultResult = await storeRecord(buyer_agent, `audit_pre_${id}`, artifact);
      db.prepare('UPDATE audit_contracts SET pre_audit_vault_record_id = ?, pre_audit_hcs_sequence = ? WHERE id = ?')
        .run(vaultResult.id, vaultResult.hcs_sequence ? String(vaultResult.hcs_sequence) : null, id);
      // Grant seller read access to the pre-audit artifact
      grantPermission(vaultResult.id, buyer_agent, seller_agent);
    } catch (err) {
      console.error('[contract-audit] pre-audit vault artifact failed:', err.message);
    }
  });

  return getContract(id, agentId);
}

/**
 * Resubmit a contract with revised terms after addressing NEEDS_REVISION findings.
 * Re-runs the audit against the new terms.
 */
function resubmitContract(contractId, agentId, terms, arbitratorId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (!['NEEDS_REVISION', 'APPROVED'].includes(contract.audit_status)) {
    throw Object.assign(new Error(`cannot resubmit a contract in ${contract.audit_status} status`), { status: 409 });
  }
  if (!terms) throw Object.assign(new Error('revised terms are required'), { status: 400 });

  // Allow setting/replacing arbitrator on resubmit to unblock contracts stuck on missing-arbitrator finding
  const effectiveArbitratorId = arbitratorId || contract.arbitrator_id;

  const tHash = hashText(terms);
  const findings = analyzeContract(terms, contract.total_amount_hbar, effectiveArbitratorId);
  const hasCritical = findings.some(f => f.severity === 'CRITICAL');
  const audit_status = hasCritical ? 'NEEDS_REVISION' : 'APPROVED';

  db.transaction(() => {
    db.prepare(`
      UPDATE audit_contracts SET terms = ?, terms_hash = ?, audit_status = ?, arbitrator_id = ? WHERE id = ?
    `).run(typeof terms === 'string' ? terms : JSON.stringify(terms), tHash, audit_status, effectiveArbitratorId || null, contractId);

    db.prepare('DELETE FROM audit_findings WHERE contract_id = ?').run(contractId);
    for (const f of findings) {
      const fid = crypto.randomBytes(16).toString('hex').toLowerCase();
      db.prepare(`
        INSERT INTO audit_findings (id, contract_id, severity, category, finding, suggestion)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(fid, contractId, f.severity, f.category, f.finding, f.suggestion);
    }

    logEvent(db, contractId, 'RESUBMITTED', agentId, `Re-audit ${audit_status}. ${findings.length} finding(s).${arbitratorId ? ' Arbitrator updated.' : ''}`);
  })();

  return getContract(contractId, agentId);
}

/**
 * Attach the HSCS hook to the contract. Requires APPROVED status.
 * Either party may call this — on testnet it records a mock HSCS address.
 * On mainnet this deploys a real HSCS smart contract that custodies HBAR.
 */
function attachHook(contractId, agentId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (contract.audit_status !== 'APPROVED') {
    throw Object.assign(new Error(`hook can only be attached to APPROVED contracts (current: ${contract.audit_status})`), { status: 409 });
  }

  const IS_MAINNET = process.env.HEDERA_NETWORK === 'mainnet';
  if (IS_MAINNET) {
    // TODO: deploy real HSCS contract via @hashgraph/sdk
    throw Object.assign(new Error('HSCS mainnet deployment not yet implemented — testnet only'), { status: 501 });
  }

  const hookAddress = mockHookAddress(contractId);
  const certHash = auditCertHash(contractId, contract.terms_hash, hookAddress);

  db.transaction(() => {
    db.prepare(`
      UPDATE audit_contracts
      SET audit_status = 'ACTIVE', hook_address = ?, hook_type = 'hscs_testnet_mock',
          audit_certificate_hash = ?, hook_attached_at = datetime('now')
      WHERE id = ?
    `).run(hookAddress, certHash, contractId);
    logEvent(db, contractId, 'HOOK_ATTACHED', agentId,
      `HSCS hook attached: ${hookAddress}. Audit cert: ${certHash.slice(0, 16)}…`);
  })();

  return getContract(contractId, agentId);
}

/**
 * Confirm delivery. Both buyer and seller must confirm to complete the contract.
 * When both have confirmed, status → COMPLETED and audit certificate is anchored on HCS.
 */
function confirmDelivery(contractId, agentId, notes = null) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (contract.audit_status !== 'ACTIVE') {
    throw Object.assign(new Error(`delivery can only be confirmed on ACTIVE contracts (current: ${contract.audit_status})`), { status: 409 });
  }

  // Determine which flag to set
  const isBuyer = contract.buyer_agent === agentId;
  const alreadyConfirmedField = isBuyer ? 'buyer_confirmed' : 'seller_confirmed';
  if (contract[alreadyConfirmedField]) {
    throw Object.assign(new Error('you have already confirmed delivery'), { status: 409 });
  }

  const buyerConfirmed  = isBuyer ? 1 : contract.buyer_confirmed;
  const sellerConfirmed = !isBuyer ? 1 : contract.seller_confirmed;
  const bothConfirmed   = buyerConfirmed && sellerConfirmed;

  db.transaction(() => {
    db.prepare(`
      UPDATE audit_contracts
      SET buyer_confirmed = ?, seller_confirmed = ?${bothConfirmed ? ", audit_status = 'COMPLETED', completed_at = datetime('now')" : ''}
      WHERE id = ?
    `).run(buyerConfirmed, sellerConfirmed, contractId);

    const role = isBuyer ? 'buyer' : 'seller';
    logEvent(db, contractId, 'DELIVERY_CONFIRMED', agentId,
      `${role} confirmed delivery.${notes ? ' Notes: ' + notes : ''}`);

    if (bothConfirmed) {
      logEvent(db, contractId, 'COMPLETED', null, 'Both parties confirmed. Contract COMPLETED. HSCS hook released.');
    }
  })();

  // Anchor to HCS on completion + store post-settlement vault artifact (sequential, non-blocking)
  if (bothConfirmed) {
    setImmediate(async () => {
      try {
        const updated = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
        const topicId = updated.hcs_topic_id || process.env.HEDERA_DEFAULT_TOPIC_ID;

        // 1. Anchor the COMPLETED event to HCS first
        try {
          const anchorResult = await anchorRecord(
            topicId,
            { event: 'AUDIT_CONTRACT_COMPLETED', contract_id: contractId, cert: updated.audit_certificate_hash, completed_at: new Date().toISOString() }
          );
          if (anchorResult?.sequenceNumber) {
            db.prepare('UPDATE audit_contracts SET hcs_sequence = ? WHERE id = ?')
              .run(String(anchorResult.sequenceNumber), contractId);
            db.prepare(`UPDATE audit_events SET hcs_sequence = ? WHERE contract_id = ? AND event_type = 'COMPLETED'`)
              .run(String(anchorResult.sequenceNumber), contractId);
          }
        } catch (err) {
          console.error('[contract-audit] HCS anchor failed:', err.message);
        }

        // 2. Store post-settlement vault artifact
        const findings = db.prepare('SELECT * FROM audit_findings WHERE contract_id = ?').all(contractId);
        const artifact = JSON.stringify({
          contract_id: contractId,
          title: updated.title,
          buyer_agent: updated.buyer_agent,
          seller_agent: updated.seller_agent,
          total_amount_hbar: updated.total_amount_hbar,
          audit_status: updated.audit_status,
          completed_at: updated.completed_at,
          findings_count: findings.length,
          audit_certificate_hash: updated.audit_certificate_hash,
          created_at: new Date().toISOString(),
        });
        const vaultResult = await storeRecord(updated.buyer_agent, `audit_post_${contractId}`, artifact);
        db.prepare('UPDATE audit_contracts SET post_settlement_vault_record_id = ?, post_settlement_hcs_sequence = ? WHERE id = ?')
          .run(vaultResult.id, vaultResult.hcs_sequence ? String(vaultResult.hcs_sequence) : null, contractId);
        // Grant both parties read access
        grantPermission(vaultResult.id, updated.buyer_agent, updated.seller_agent);
      } catch (err) {
        console.error('[contract-audit] post-settlement artifact failed:', err.message);
      }
    });
  }

  return getContract(contractId, agentId);
}

/**
 * File a dispute. Routes to the Arbitration Registry.
 * The pre-selected arbitrator from the contract is used.
 */
function disputeContract(contractId, agentId, grievance) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (contract.audit_status !== 'ACTIVE') {
    throw Object.assign(new Error(`disputes can only be filed on ACTIVE contracts (current: ${contract.audit_status})`), { status: 409 });
  }
  if (!grievance) throw Object.assign(new Error('grievance is required'), { status: 400 });

  const respondingAgent = agentId === contract.buyer_agent ? contract.seller_agent : contract.buyer_agent;

  db.transaction(() => {
    db.prepare("UPDATE audit_contracts SET audit_status = 'DISPUTED' WHERE id = ?").run(contractId);
    logEvent(db, contractId, 'DISPUTED', agentId, `Dispute filed: ${grievance.slice(0, 200)}`);
  })();

  // Auto-file in arbitration system
  let dispute = null;
  try {
    dispute = fileDispute({
      contract_id:       contractId,
      filing_agent:      agentId,
      responding_agent:  respondingAgent,
      grievance,
      dispute_value_hbar: contract.total_amount_hbar,
      arbitrator_id:     contract.arbitrator_id,
    });
  } catch (err) {
    console.error('[contract-audit] arbitration filing failed:', err.message);
  }

  return { contract: getContract(contractId, agentId), dispute };
}

/**
 * Request mutual cancellation. If the other party has already requested, contract is CANCELLED.
 */
function cancelContract(contractId, agentId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (!['APPROVED', 'ACTIVE'].includes(contract.audit_status)) {
    throw Object.assign(new Error(`cannot cancel a contract in ${contract.audit_status} status`), { status: 409 });
  }
  if (contract.cancel_requested_by === agentId) {
    throw Object.assign(new Error('you have already requested cancellation'), { status: 409 });
  }

  if (contract.cancel_requested_by && contract.cancel_requested_by !== agentId) {
    // Both parties agree — cancel
    db.transaction(() => {
      db.prepare(`
        UPDATE audit_contracts SET audit_status = 'CANCELLED', cancelled_at = datetime('now') WHERE id = ?
      `).run(contractId);
      logEvent(db, contractId, 'CANCELLED', agentId, 'Mutual cancellation confirmed by both parties.');
    })();
  } else {
    // First cancellation request
    db.prepare('UPDATE audit_contracts SET cancel_requested_by = ? WHERE id = ?').run(agentId, contractId);
    logEvent(db, contractId, 'CANCEL_REQUESTED', agentId, 'Cancellation requested. Awaiting counterparty confirmation.');
  }

  return getContract(contractId, agentId);
}

/**
 * Fetch contract with findings and events. Only accessible to parties and the designated arbitrator.
 */
function getContract(contractId, agentId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) return null;
  if (
    contract.buyer_agent !== agentId &&
    contract.seller_agent !== agentId &&
    contract.arbitrator_id !== agentId
  ) return null;

  const findings = db.prepare(
    'SELECT * FROM audit_findings WHERE contract_id = ? ORDER BY severity, created_at'
  ).all(contractId);

  return { ...contract, findings };
}

/**
 * Return full audit event log for a contract.
 */
function getAuditEvents(contractId, agentId) {
  const contract = getContract(contractId, agentId);
  if (!contract) return null;
  const db = getDb();
  return db.prepare(
    'SELECT * FROM audit_events WHERE contract_id = ? ORDER BY created_at'
  ).all(contractId);
}

/**
 * Approve a PENDING_APPROVAL contract. Owner only (enforced at API layer via requireConsoleAuth).
 */
function approveLimitContract(contractId, agentId) {
  const db = getDb();
  const contract = db.prepare('SELECT * FROM audit_contracts WHERE id = ?').get(contractId);
  if (!contract) throw Object.assign(new Error('contract not found'), { status: 404 });
  if (contract.buyer_agent !== agentId && contract.seller_agent !== agentId) {
    throw Object.assign(new Error('access denied'), { status: 403 });
  }
  if (contract.audit_status !== 'PENDING_APPROVAL') {
    throw Object.assign(new Error(`contract is not in PENDING_APPROVAL status (current: ${contract.audit_status})`), { status: 409 });
  }

  db.transaction(() => {
    db.prepare("UPDATE audit_contracts SET audit_status = 'APPROVED' WHERE id = ?").run(contractId);
    logEvent(db, contractId, 'LIMIT_APPROVED', agentId, 'Contract approved despite exceeding require_approval_above_hbar limit.');
  })();

  return getContract(contractId, agentId);
}

module.exports = {
  submitContract,
  resubmitContract,
  attachHook,
  confirmDelivery,
  disputeContract,
  cancelContract,
  getContract,
  getAuditEvents,
  approveLimitContract,
};
