/**
 * Closed Beta Signup API
 *
 * POST /beta/register — register for closed beta
 * GET  /beta          — redirect to beta.html
 *
 * On signup:
 * - Agent registered via registerAgent()
 * - Cold-start AATS score computed and returned
 * - LOI captured (if checked) and logged to operator vault + audit log
 * - Welcome email stub (email integration deferred)
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { registerAgent, VALID_AGENT_TYPES } = require('./auth');
const { computeTrustScore } = require('./trust-score');
const { logAdminAction } = require('./audit-log');

const router = express.Router();

// Limit beta registrations — max 10 per IP per hour
const betaLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'too many registration attempts — try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// GET /beta — serve the beta signup page
router.get('/', (req, res) => {
  res.redirect(301, '/beta.html');
});

// POST /beta/register — beta signup
//
// HOLD — April 12, 2026. Beta registration paused pending legal clearance.
// Existing signups are preserved. To re-enable: remove the early return below.
router.post('/register', betaLimiter, (req, res) => {
  return res.status(503).json({
    message: 'Thank you for your interest. We\'ll be in touch when we\'re ready for beta participants.',
  });

  // eslint-disable-next-line no-unreachable
  const { agent_name, operator_name, email, agent_type, use_case, loi_interest } = req.body;

  // Validate required fields
  if (!agent_name || typeof agent_name !== 'string' || agent_name.trim().length === 0) {
    return res.status(400).json({ error: 'agent_name is required' });
  }
  if (!operator_name || typeof operator_name !== 'string') {
    return res.status(400).json({ error: 'operator_name is required' });
  }
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email is required' });
  }
  if (!use_case || typeof use_case !== 'string' || use_case.trim().length < 10) {
    return res.status(400).json({ error: 'please describe your use case (min 10 chars)' });
  }

  const resolvedType = VALID_AGENT_TYPES.includes(agent_type) ? agent_type : 'general';

  try {
    // Register the agent
    const { agent_id, api_key, credits } = registerAgent(
      agent_name.trim().slice(0, 100),
      null, // no hedera account at signup
      resolvedType,
    );

    // Compute cold-start trust score
    let score = null;
    let tier = 'SILVER'; // probationary Silver for new registrations
    try {
      const report = computeTrustScore(agent_id);
      score = report.score;
      tier = report.tier || 'SILVER';
    } catch {
      score = 30; // fallback to Bronze floor
    }

    // Log the beta signup
    logAdminAction('beta.signup', 'beta-form', agent_id, {
      operator_name,
      email: email.slice(0, 100), // truncate for log
      agent_type: resolvedType,
      loi_interest: !!loi_interest,
    });

    // If LOI expressed, log with higher priority
    if (loi_interest) {
      logAdminAction('beta.loi', 'beta-form', agent_id, {
        operator_name,
        email: email.slice(0, 100),
        use_case: use_case.slice(0, 200),
      });

      // Telegram notification for LOI (via stdout for now — Telegram bot picks it up)
      console.log(`[BETA-LOI] New LOI from ${operator_name} <${email}> — agent: ${agent_id} (${resolvedType})`);
    } else {
      console.log(`[BETA-SIGNUP] ${operator_name} <${email}> registered agent: ${agent_id} (${resolvedType})`);
    }

    return res.status(201).json({
      agent_id,
      api_key,
      agent_name: agent_name.trim(),
      agent_type: resolvedType,
      score,
      tier,
      credits,
      message: 'Welcome to the AIbrokerAGEnt closed beta. Your agent is registered and has a Trust Score. Save your api_key — it will not be shown again.',
      beta_terms: {
        environment: 'testnet — no real funds',
        access: 'free during beta',
        commitment: 'none',
      },
    });
  } catch (err) {
    if (err.message?.includes('UNIQUE') || err.message?.includes('unique')) {
      return res.status(409).json({ error: 'an agent with that name is already registered' });
    }
    console.error('[beta-register] error:', err);
    return res.status(500).json({ error: 'registration failed — please try again' });
  }
});

module.exports = router;
