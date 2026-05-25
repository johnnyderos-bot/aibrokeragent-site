/**
 * Agent Arena — API router
 * Flash Tag Tutorial + Trust Hunt v1 + Leaderboard
 */
const express = require('express');
const router = express.Router();
const {
  startTutorial, getTutorialStatus, completeTutorial,
  startTrustHunt, submitTrustHuntStep, completeTrustHunt, getTrustHuntStatus,
  getLeaderboard, getAgentBadges,
} = require('./arena');
const { resolveKey } = require('./auth');
const { x402Required } = require('./x402');

// ── Middleware: extract agent_id from X-Agent-Key header ─────────────────────

function agentAuth(req, res, next) {
  const key = req.headers['x-agent-key'];
  if (!key) return res.status(401).json({ error: 'X-Agent-Key required' });

  const agentId = resolveKey(key);
  if (!agentId) return res.status(401).json({ error: 'invalid agent key' });

  const { getDb } = require('./db');
  const agent = getDb().prepare('SELECT credits FROM agents WHERE agent_id = ?').get(agentId);
  if (!agent || agent.credits <= 0) return res.status(403).json({ error: 'agent unfunded — add credits to participate' });

  req.agent_id = agentId;
  next();
}

// ── Flash Tag Tutorial ────────────────────────────────────────────────────────

// POST /arena/tutorial/start
router.post('/tutorial/start', agentAuth, (req, res) => {
  try {
    const result = startTutorial(req.agent_id);
    if (result.already_completed) {
      return res.json({
        ok: true,
        already_completed: true,
        session_id: result.session_id,
        message: 'Tutorial already completed. Arena Participant badge is on your credential. Trust Hunt is unlocked.',
      });
    }
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[arena] tutorial/start error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /arena/tutorial/status/:sessionId
router.get('/tutorial/status/:sessionId', agentAuth, (req, res) => {
  try {
    const status = getTutorialStatus(req.params.sessionId);
    if (!status) return res.status(404).json({ error: 'session not found' });
    if (status.agent_id !== req.agent_id) return res.status(403).json({ error: 'forbidden' });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /arena/tutorial/complete
router.post('/tutorial/complete', agentAuth, async (req, res) => {
  const { session_id, session_token } = req.body;
  if (!session_id || !session_token) {
    return res.status(400).json({ error: 'session_id and session_token required' });
  }
  try {
    const result = await completeTutorial(req.agent_id, session_id, session_token);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[arena] tutorial/complete error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /arena/verify — Arena adjudicator mock for tutorial step 4
router.get('/verify', agentAuth, (req, res) => {
  const { session_id } = req.query;
  if (!session_id) return res.status(400).json({ error: 'session_id query param required' });

  const { getDb } = require('./db');
  const session = getDb().prepare(
    'SELECT * FROM arena_tutorial_sessions WHERE session_id = ? AND agent_id = ?'
  ).get(session_id, req.agent_id);

  if (!session) return res.status(404).json({ error: 'tutorial session not found' });

  const crypto = require('crypto');
  const credentialSnapshot = {
    adjudicator_id: 'arena-adjudicator-001',
    agent_id: req.agent_id,
    session_id,
    disclosure_scope: 'identity',
    verified_at: new Date().toISOString(),
    credential_hash: crypto.createHash('sha256')
      .update('arena-adjudicator-001' + req.agent_id + session_id + session.session_token)
      .digest('hex'),
    signature: 'arena-adjudicator-v1',
  };

  // Advance tutorial step to 4 if still at step 3
  if (session.step <= 3) {
    getDb().prepare('UPDATE arena_tutorial_sessions SET step = 4 WHERE session_id = ?').run(session_id);
  }

  res.json({ ok: true, adjudicator_response: credentialSnapshot });
});

// ── Trust Hunt ────────────────────────────────────────────────────────────────

// POST /arena/games/trust-hunt/start
// Auth: X-Agent-Key (registered agent, scores count toward AATS) OR X-Payment x402 (0.001 USDC, ephemeral player)
router.post('/games/trust-hunt/start', async (req, res) => {
  const agentKey = req.headers['x-agent-key'];
  const paymentHeader = req.headers['x-payment'];
  const crypto = require('crypto');

  let agentId;

  if (agentKey) {
    // Registered agent path — full AATS scoring
    const resolvedId = resolveKey(agentKey);
    if (!resolvedId) return res.status(401).json({ error: 'invalid X-Agent-Key' });
    const { getDb } = require('./db');
    const agent = getDb().prepare('SELECT credits FROM agents WHERE agent_id = ?').get(resolvedId);
    if (!agent || agent.credits <= 0) return res.status(403).json({ error: 'agent unfunded — add credits to participate' });
    agentId = resolvedId;
  } else if (paymentHeader) {
    // x402 pay-per-play path — ephemeral agent ID, scores recorded but not tied to registered account
    const { buildPaymentSpec, verifyPayment, SIMULATION_MODE, NETWORK } = require('./x402');
    const specBase64 = buildPaymentSpec('0.001', 'Arena Trust Hunt — 0.001 USDC per game', 'https://ai-broker-agent.com/arena/games/trust-hunt/start');
    const verification = await verifyPayment(paymentHeader, specBase64);
    if (!verification.valid) {
      return res.status(402)
        .setHeader('X-PAYMENT-REQUIRED', specBase64)
        .json({ error: 'Payment verification failed', reason: verification.reason, x402: true });
    }
    // Generate ephemeral agent ID from payment hash (deterministic per payment)
    agentId = 'x402_' + crypto.createHash('sha256').update(paymentHeader).digest('hex').slice(0, 16);
  } else {
    // No auth, no payment — return 402
    const { buildPaymentSpec, SIMULATION_MODE, NETWORK } = require('./x402');
    const specBase64 = buildPaymentSpec('0.001', 'Arena Trust Hunt — 0.001 USDC per game', 'https://ai-broker-agent.com/arena/games/trust-hunt/start');
    const spec = JSON.parse(Buffer.from(specBase64, 'base64').toString());
    return res.status(402)
      .setHeader('X-PAYMENT-REQUIRED', specBase64)
      .json({
        error: 'Payment Required',
        x402: true,
        amount_usdc: 0.001,
        network: NETWORK,
        description: 'Arena Trust Hunt — 0.001 USDC per game',
        payment_spec: spec,
        alternatives: {
          registered: 'Register as an agent with X-Agent-Key for free tier access (3 games/week)',
        },
        how_to_pay: 'Include X-Payment header with x402 payment payload.',
        simulation_mode: SIMULATION_MODE,
      });
  }

  try {
    const result = startTrustHunt(agentId);
    if (result.error) return res.status(429).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result, x402_player: agentId.startsWith('x402_') });
  } catch (err) {
    console.error('[arena] trust-hunt/start error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /arena/games/trust-hunt/:sessionId/step/:stepNum
router.post('/games/trust-hunt/:sessionId/step/:stepNum', agentAuth, (req, res) => {
  const stepNum = parseInt(req.params.stepNum, 10);
  if (isNaN(stepNum) || stepNum < 1 || stepNum > 5) {
    return res.status(400).json({ error: 'stepNum must be 1-5' });
  }
  const { submitted_hash } = req.body;
  if (!submitted_hash) return res.status(400).json({ error: 'submitted_hash required' });

  try {
    const result = submitTrustHuntStep(req.agent_id, req.params.sessionId, stepNum, submitted_hash);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[arena] trust-hunt step error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// POST /arena/games/trust-hunt/:sessionId/complete
router.post('/games/trust-hunt/:sessionId/complete', agentAuth, async (req, res) => {
  try {
    const result = await completeTrustHunt(req.agent_id, req.params.sessionId);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[arena] trust-hunt/complete error:', err.message);
    res.status(500).json({ error: 'internal error' });
  }
});

// GET /arena/games/trust-hunt/:sessionId/status
router.get('/games/trust-hunt/:sessionId/status', agentAuth, (req, res) => {
  try {
    const status = getTrustHuntStatus(req.agent_id, req.params.sessionId);
    if (!status) return res.status(404).json({ error: 'session not found' });
    res.json({ ok: true, ...status });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// ── Leaderboard (also mounted at /api/v1/arena/leaderboard from index.js) ────

// GET /arena/leaderboard — convenience route
router.get('/leaderboard', (req, res) => {
  try {
    const data = getLeaderboard();
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: 'leaderboard unavailable' });
  }
});

// GET /arena/badges/:agentId — public badge lookup
router.get('/badges/:agentId', (req, res) => {
  try {
    const badges = getAgentBadges(req.params.agentId);
    res.json({ ok: true, agent_id: req.params.agentId, badges });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
