/**
 * Contract Audit API — BrokerAGEnt
 *
 * REST endpoints for the Contract Audit Agent.
 * All routes require API key authentication.
 * Fund custody is handled by the HSCS smart contract hook, not BrokerAGEnt.
 */

const express = require('express');
const { requireAuth } = require('./auth');
const { requireConsoleAuth } = require('./console-auth');
const {
  submitContract,
  resubmitContract,
  attachHook,
  confirmDelivery,
  disputeContract,
  cancelContract,
  getContract,
  getAuditEvents,
  approveLimitContract,
} = require('./contract-audit');

const router = express.Router();

// POST /audit/contracts — submit a contract for audit
router.post('/contracts', requireAuth, (req, res) => {
  try {
    const result = submitContract(req.agentId, req.body);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || (err.wallet_required ? 422 : 400);
    res.status(status).json({ error: err.message, ...(err.wallet_required ? { wallet_required: true } : {}) });
  }
});

// GET /audit/contracts/:id — fetch contract with findings (parties + arbitrator only)
router.get('/contracts/:id', requireAuth, (req, res) => {
  try {
    const contract = getContract(req.params.id, req.agentId);
    if (!contract) return res.status(404).json({ error: 'contract not found or access denied' });
    res.json(contract);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/resubmit — resubmit with revised terms
// Body: { terms, arbitrator_id? }  — arbitrator_id allowed to fix a missing-arbitrator finding
router.post('/contracts/:id/resubmit', requireAuth, (req, res) => {
  try {
    const { terms, arbitrator_id } = req.body;
    if (!terms) return res.status(400).json({ error: 'revised terms are required' });
    const result = resubmitContract(req.params.id, req.agentId, terms, arbitrator_id);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/attach-hook — attach HSCS hook (APPROVED → ACTIVE)
router.post('/contracts/:id/attach-hook', requireAuth, (req, res) => {
  try {
    const result = attachHook(req.params.id, req.agentId);
    res.json(result);
  } catch (err) {
    const status = err.status || (err.message.includes('not yet implemented') ? 501 : 400);
    res.status(status).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/confirm-delivery — confirm delivery (either party)
router.post('/contracts/:id/confirm-delivery', requireAuth, (req, res) => {
  try {
    const { notes } = req.body;
    const result = confirmDelivery(req.params.id, req.agentId, notes || null);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/dispute — file a dispute (routes to arbitration)
router.post('/contracts/:id/dispute', requireAuth, (req, res) => {
  try {
    const { grievance } = req.body;
    if (!grievance) return res.status(400).json({ error: 'grievance is required' });
    const result = disputeContract(req.params.id, req.agentId, grievance);
    res.status(201).json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/cancel — request mutual cancellation
router.post('/contracts/:id/cancel', requireAuth, (req, res) => {
  try {
    const result = cancelContract(req.params.id, req.agentId);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

// GET /audit/contracts/:id/events — full audit event log
router.get('/contracts/:id/events', requireAuth, (req, res) => {
  try {
    const events = getAuditEvents(req.params.id, req.agentId);
    if (!events) return res.status(404).json({ error: 'contract not found or access denied' });
    res.json({ contract_id: req.params.id, events });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /audit/contracts/:id/approve-limit — approve a PENDING_APPROVAL contract (Owner only)
// Uses console session auth — the owner must be authenticated via the Human Trust Console
router.post('/contracts/:id/approve-limit', requireConsoleAuth('owner'), (req, res) => {
  try {
    // We use the console user's session but need to act as the buyer/seller agent
    // The console user must own the buyer or seller agent — we fetch the contract to check
    const { getDb } = require('./db');
    const db = getDb();
    const contract = db.prepare('SELECT buyer_agent, seller_agent FROM audit_contracts WHERE id = ?').get(req.params.id);
    if (!contract) return res.status(404).json({ error: 'contract not found' });

    // Find which agent the console user is an owner of that is a party to the contract
    const { getUserRole } = require('./console-auth');
    const buyerRole = getUserRole(req.consoleUser.id, contract.buyer_agent);
    const sellerRole = getUserRole(req.consoleUser.id, contract.seller_agent);

    let actingAgentId = null;
    if (buyerRole === 'owner') actingAgentId = contract.buyer_agent;
    else if (sellerRole === 'owner') actingAgentId = contract.seller_agent;

    if (!actingAgentId) {
      return res.status(403).json({ error: 'you must be the owner of a party to this contract' });
    }

    const result = approveLimitContract(req.params.id, actingAgentId);
    res.json(result);
  } catch (err) {
    const status = err.status || 400;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
