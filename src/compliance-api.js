/**
 * Compliance API — /compliance/*
 *
 * All endpoints require ADMIN_KEY (X-Admin-Key header).
 * These are platform-internal endpoints, not exposed to agents.
 */

const express = require('express');
const { processVerification, logTravelRule } = require('./compliance');

const router = express.Router();

function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'admin key required' });
  }
  next();
}

router.use(requireAdmin);

// POST /compliance/verify/:operator_id
// Receive KYC/KYB verification result from provider.
// Body: { provider_session_id, verification_type, status, data_hash, risk_score, sanctions_check, timestamp, provider }
router.post('/verify/:operator_id', async (req, res) => {
  try {
    const { operator_id } = req.params;
    const {
      provider_session_id,
      verification_type,
      status,
      data_hash,
      risk_score,
      sanctions_check,
      timestamp,
      provider,
    } = req.body;

    if (!provider_session_id || !status) {
      return res.status(400).json({ error: 'provider_session_id and status are required' });
    }

    const result = await processVerification(operator_id, {
      provider_session_id,
      verification_type,
      status,
      data_hash,
      risk_score: risk_score !== undefined ? parseFloat(risk_score) : undefined,
      sanctions_check,
      timestamp,
      provider,
    });

    const httpStatus = result.status === 'BLOCKED' ? 403 : 200;
    res.status(httpStatus).json(result);
  } catch (err) {
    console.error('compliance verify error:', err);
    const status = err.message.includes('not found') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// POST /compliance/travel-rule/log
// Log a qualifying transfer for Travel Rule compliance.
// Body: { originator_agent_id, beneficiary_agent_id, amount_credits, hedera_transaction_id, contract_id }
router.post('/travel-rule/log', (req, res) => {
  try {
    const { originator_agent_id, beneficiary_agent_id, amount_credits, hedera_transaction_id, contract_id } = req.body;

    if (!originator_agent_id || !beneficiary_agent_id || !amount_credits) {
      return res.status(400).json({
        error: 'originator_agent_id, beneficiary_agent_id, and amount_credits are required',
      });
    }

    const result = logTravelRule({
      originator_agent_id,
      beneficiary_agent_id,
      amount_credits: parseFloat(amount_credits),
      hedera_transaction_id,
      contract_id,
    });

    res.status(201).json(result);
  } catch (err) {
    console.error('travel rule log error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
