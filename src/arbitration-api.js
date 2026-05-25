const express = require('express');
const { requireAuth } = require('./auth');
const {
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
  ALL_TIERS,
} = require('./arbitration');

const router = express.Router();
router.use(requireAuth);

// GET /arbitration/arbitrators
// List active arbitrators. Optional query: type, min_tier, max_tier, dispute_value_hbar
router.get('/arbitrators', (req, res) => {
  try {
    const { type, min_tier, max_tier, dispute_value_hbar } = req.query;
    const results = listArbitrators({
      type,
      min_tier: min_tier ? parseInt(min_tier) : undefined,
      max_tier: max_tier ? parseInt(max_tier) : undefined,
      dispute_value_hbar: dispute_value_hbar ? parseFloat(dispute_value_hbar) : undefined,
    });
    res.json({ arbitrators: results, tiers: ALL_TIERS });
  } catch (err) {
    console.error('list arbitrators error:', err);
    res.status(500).json({ error: 'failed to list arbitrators' });
  }
});

// POST /arbitration/arbitrators/register
// Register the calling agent as an arbitrator
// Body: { type, tier, specializations, fee_per_dispute, stake_hbar, kyc_verified }
router.post('/arbitrators/register', (req, res) => {
  try {
    const { type, tier, specializations, fee_per_dispute, stake_hbar, kyc_verified } = req.body;
    const result = registerArbitrator({
      agent_id: req.agentId,
      type,
      tier,
      specializations,
      fee_per_dispute,
      stake_hbar,
      kyc_verified,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('register arbitrator error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('require') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /arbitration/arbitrators/:agent_id
router.get('/arbitrators/:agent_id', (req, res) => {
  try {
    const arb = getArbitrator(req.params.agent_id);
    if (!arb) return res.status(404).json({ error: 'arbitrator not found' });
    res.json(arb);
  } catch (err) {
    console.error('get arbitrator error:', err);
    res.status(500).json({ error: 'failed to get arbitrator' });
  }
});

// POST /arbitration/disputes
// File a new dispute
// Body: { contract_id, responding_agent, grievance, dispute_value_hbar, arbitrator_id }
router.post('/disputes', (req, res) => {
  try {
    const { contract_id, responding_agent, grievance, dispute_value_hbar, arbitrator_id } = req.body;
    if (!contract_id || !responding_agent || !grievance) {
      return res.status(400).json({ error: 'contract_id, responding_agent, and grievance are required' });
    }
    const dispute = fileDispute({
      contract_id,
      filing_agent: req.agentId,
      responding_agent,
      grievance,
      dispute_value_hbar: dispute_value_hbar || 0,
      arbitrator_id,
    });
    res.status(201).json(dispute);
  } catch (err) {
    console.error('file dispute error:', err);
    const status = err.message.includes('conflict') || err.message.includes('cannot') ? 400
      : err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /arbitration/disputes/:id
router.get('/disputes/:id', (req, res) => {
  try {
    const dispute = getDispute(req.params.id);
    if (!dispute) return res.status(404).json({ error: 'dispute not found' });
    // Only parties and assigned arbitrator can view
    if (
      req.agentId !== dispute.filing_agent &&
      req.agentId !== dispute.responding_agent &&
      req.agentId !== dispute.arbitrator_id
    ) {
      return res.status(403).json({ error: 'forbidden' });
    }
    res.json(dispute);
  } catch (err) {
    console.error('get dispute error:', err);
    res.status(500).json({ error: 'failed to get dispute' });
  }
});

// POST /arbitration/disputes/:id/evidence
// Submit evidence. Body: { vault_record_id (optional), description }
router.post('/disputes/:id/evidence', (req, res) => {
  try {
    const { vault_record_id, description } = req.body;
    if (!description) return res.status(400).json({ error: 'description is required' });
    const result = submitEvidence({
      dispute_id: req.params.id,
      submitted_by: req.agentId,
      vault_record_id,
      description,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('submit evidence error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('only') || err.message.includes('cannot') ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /arbitration/disputes/:id/deliberate
// Assigned arbitrator moves dispute to deliberating
router.post('/disputes/:id/deliberate', (req, res) => {
  try {
    const dispute = startDeliberation(req.params.id, req.agentId);
    res.json(dispute);
  } catch (err) {
    console.error('deliberate error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('not assigned') ? 403 : 400;
    res.status(status).json({ error: err.message });
  }
});

// POST /arbitration/disputes/:id/rule
// Issue a ruling. Body: { liable_party, remedy_type, remedy_amount, rationale, flags,
//                         ai_confidence, ai_flags, ai_analysis }
router.post('/disputes/:id/rule', async (req, res) => {
  try {
    const {
      liable_party, remedy_type, remedy_amount, rationale,
      flags, ai_confidence, ai_flags, ai_analysis,
    } = req.body;
    if (!liable_party || !remedy_type || !rationale) {
      return res.status(400).json({ error: 'liable_party, remedy_type, and rationale are required' });
    }
    const result = await issueRuling({
      dispute_id: req.params.id,
      arbitrator_id: req.agentId,
      liable_party,
      remedy_type,
      remedy_amount,
      rationale,
      flags,
      ai_confidence,
      ai_flags,
      ai_analysis,
    });
    const status = result.escalated ? 202 : 201;
    res.status(status).json(result);
  } catch (err) {
    console.error('rule error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') || err.message.includes('must be') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /arbitration/disputes/:id/appeal
// File an appeal. Body: { grounds }
router.post('/disputes/:id/appeal', (req, res) => {
  try {
    const { grounds } = req.body;
    if (!grounds) return res.status(400).json({ error: 'grounds are required' });
    const result = fileAppeal({
      dispute_id: req.params.id,
      appellant_id: req.agentId,
      grounds,
    });
    res.status(201).json(result);
  } catch (err) {
    console.error('appeal error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('only') ? 403
      : err.message.includes('deadline') || err.message.includes('already') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /arbitration/disputes/:id/check-timeout
// Manually trigger SLA check for a specific dispute (parties or admin only)
router.post('/disputes/:id/check-timeout', (req, res) => {
  try {
    const dispute = getDispute(req.params.id);
    if (!dispute) return res.status(404).json({ error: 'dispute not found' });
    if (req.agentId !== dispute.filing_agent && req.agentId !== dispute.responding_agent) {
      return res.status(403).json({ error: 'only dispute parties can request a timeout check' });
    }
    const result = checkAndReassign(req.params.id);
    res.json(result);
  } catch (err) {
    console.error('check-timeout error:', err);
    res.status(500).json({ error: 'timeout check failed' });
  }
});

// POST /arbitration/appeals/:id/resolve
// Senior arbitrator resolves an appeal. Body: { outcome, rationale }
router.post('/appeals/:id/resolve', async (req, res) => {
  try {
    const { outcome, rationale } = req.body;
    if (!outcome || !rationale) return res.status(400).json({ error: 'outcome and rationale are required' });
    const result = await resolveAppeal({
      appeal_id: req.params.id,
      senior_arbitrator_id: req.agentId,
      outcome,
      rationale,
    });
    res.json(result);
  } catch (err) {
    console.error('resolve appeal error:', err);
    const status = err.message.includes('not found') ? 404
      : err.message.includes('already') || err.message.includes('Tier') || err.message.includes('outcome') ? 400 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
