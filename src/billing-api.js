const express = require('express');
const router = express.Router();
const { getDb } = require('./db');
const { requireOperatorAuth } = require('./operator-auth');
const {
  PAYMENTS_ENABLED, PLANS, getPlan, getSubscription, requirePlan,
  getUsageSummary, createCheckoutSession, createPortalSession,
  handleStripeWebhook, periodKey,
} = require('./subscriptions');

// POST /billing/waitlist
// Pre-launch waitlist signup — no auth required
router.post('/waitlist', (req, res) => {
  const { email, name, tier_interest, use_case } = req.body;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ error: 'valid email is required' });
  }
  try {
    const db = getDb();
    db.prepare('INSERT INTO waitlist (email, name, tier_interest, use_case) VALUES (?, ?, ?, ?)')
      .run(email.toLowerCase().trim(), name || null, tier_interest || 'free', use_case || null);
    console.log('[waitlist] signup:', email, tier_interest);
    res.json({ ok: true, message: "You're on the list. We'll notify you when commercial services launch." });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE')) {
      return res.json({ ok: true, message: "You're already on the list." });
    }
    res.status(500).json({ error: 'failed to add to waitlist' });
  }
});

// GET /billing/waitlist (admin only)
router.get('/waitlist', (req, res) => {
  if (req.headers['x-admin-key'] !== process.env.ADMIN_KEY) return res.status(401).json({ error: 'admin key required' });
  const rows = getDb().prepare('SELECT * FROM waitlist ORDER BY created_at DESC').all();
  res.json({ count: rows.length, waitlist: rows });
});

// All routes below require operator auth
router.use(requireOperatorAuth);

// GET /billing/subscription — current plan + status
router.get('/subscription', (req, res) => {
  const sub = getSubscription(req.operatorId);
  const plan = getPlan(sub.plan);
  res.json({ ...sub, plan_details: plan, payments_enabled: PAYMENTS_ENABLED });
});

// GET /billing/usage — usage for current billing period
router.get('/usage', (req, res) => {
  const pk = req.query.period || periodKey();
  const rows = getUsageSummary(req.operatorId, pk);
  const sub = getSubscription(req.operatorId);
  const plan = getPlan(sub.plan);
  res.json({ period: pk, plan: sub.plan, plan_details: plan, usage: rows, payments_enabled: PAYMENTS_ENABLED });
});

// POST /billing/checkout — create Stripe checkout session
router.post('/checkout', async (req, res) => {
  if (!PAYMENTS_ENABLED) {
    return res.json({ url: '/waitlist.html', message: 'Payments not yet enabled — added to waitlist flow' });
  }
  const { plan, annual } = req.body;
  if (!['developer', 'professional'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be developer or professional (enterprise: contact us)' });
  }
  try {
    const host = req.headers.origin || 'https://ai-broker-agent.com';
    const result = await createCheckoutSession({
      operatorId: req.operatorId, plan,
      annual: !!annual,
      successUrl: host + '/operator-console.html?checkout=success',
      cancelUrl: host + '/pricing.html',
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /billing/portal — Stripe customer portal link (manage subscription)
router.post('/portal', async (req, res) => {
  if (!PAYMENTS_ENABLED) return res.json({ url: '/pricing.html', message: 'Payments not yet enabled' });
  try {
    const host = req.headers.origin || 'https://ai-broker-agent.com';
    const result = await createPortalSession(req.operatorId, host + '/operator-console.html');
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
