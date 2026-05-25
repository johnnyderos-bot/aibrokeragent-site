/**
 * Subscription + metering layer (Stripe-backed, gated behind PAYMENTS_ENABLED)
 * Gate: PAYMENTS_ENABLED=false => track everything, charge nothing.
 * Flip: set PAYMENTS_ENABLED=true in .env when business licenses confirmed.
 */
const { getDb } = require('./db');

const PAYMENTS_ENABLED = process.env.PAYMENTS_ENABLED === 'true';

// Stripe (mock when keys absent)
let _stripe = null;
function getStripe() {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || key.startsWith('sk_test_REPLACE')) {
    _stripe = makeMock();
  } else {
    try { _stripe = require('stripe')(key); }
    catch { _stripe = makeMock(); }
  }
  return _stripe;
}

function makeMock() {
  const fn = (label) => async (...a) => {
    console.log('[subscriptions:mock]', label, JSON.stringify(a).slice(0, 100));
    return { id: `mock_${Date.now()}`, status: 'active', url: '/waitlist.html' };
  };
  return {
    customers:    { create: fn('customers.create') },
    subscriptions: { create: fn('subscriptions.create'), cancel: fn('subscriptions.cancel') },
    checkout:     { sessions: { create: fn('checkout.sessions.create') } },
    billingPortal: { sessions: { create: fn('billingPortal.sessions.create') } },
    webhooks:     { constructEvent: () => { throw new Error('mock webhook'); } },
  };
}

const PLANS = {
  free:         { name: 'Free',         price_monthly: 0,    price_annual: 0,    aats_queries_day: 100, agents_max: 1   },
  developer:    { name: 'Developer',    price_monthly: 29,   price_annual: 290,  aats_queries_day: null, agents_max: 5  },
  professional: { name: 'Professional', price_monthly: 99,   price_annual: 990,  aats_queries_day: null, agents_max: 25 },
  enterprise:   { name: 'Enterprise',   price_monthly: null, price_annual: null, aats_queries_day: null, agents_max: null },
};
const PLAN_ORDER = ['free', 'developer', 'professional', 'enterprise'];

function getPlan(key) { return PLANS[key] || PLANS.free; }

function getSubscription(operatorId) {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO subscriptions (operator_id, plan, status) VALUES (?, 'free', 'active')").run(operatorId);
  return db.prepare('SELECT * FROM subscriptions WHERE operator_id = ?').get(operatorId);
}

function requirePlan(minPlan) {
  minPlan = minPlan || 'free';
  return function(req, res, next) {
    if (!PAYMENTS_ENABLED) return next();
    if (!req.operatorId) return res.status(401).json({ error: 'operator auth required' });
    var sub = getSubscription(req.operatorId);
    if (PLAN_ORDER.indexOf(sub.plan) < PLAN_ORDER.indexOf(minPlan)) {
      return res.status(402).json({ error: 'Requires ' + getPlan(minPlan).name + ' plan', upgrade_url: '/pricing.html' });
    }
    next();
  };
}

function periodKey() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function dayKey() { return new Date().toISOString().slice(0, 10); }

function trackUsage(opts) {
  var operatorId = opts.operatorId, agentId = opts.agentId, protocol = opts.protocol;
  var eventType = opts.eventType, quantity = opts.quantity || 1, valueUsd = opts.valueUsd || null;
  try {
    var db = getDb();
    var pk = protocol === 'aats_daily' ? dayKey() : periodKey();
    db.prepare('INSERT INTO usage_events (operator_id, agent_id, protocol, event_type, quantity, value_usd, period_key) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(operatorId || null, agentId || null, protocol, eventType, quantity, valueUsd, pk);
  } catch (err) { console.error('[subscriptions] trackUsage:', err.message); }
}

function getUsageSummary(operatorId, pk) {
  var db = getDb();
  return db.prepare('SELECT protocol, event_type, SUM(quantity) as total, SUM(value_usd) as value_usd FROM usage_events WHERE operator_id = ? AND period_key = ? GROUP BY protocol, event_type').all(operatorId, pk || periodKey());
}

function getAatsDailyCount(agentId) {
  try {
    var r = getDb().prepare("SELECT COALESCE(SUM(quantity),0) as n FROM usage_events WHERE agent_id = ? AND protocol = 'aats_daily' AND period_key = ?").get(agentId, dayKey());
    return r.n || 0;
  } catch { return 0; }
}

function calcAicpFee(escrowValue) {
  return Math.round(Math.min(25.00, Math.max(0.25, escrowValue * 0.005)) * 100) / 100;
}

function collectAicpFee(opts) {
  var operatorId = opts.operatorId, agentId = opts.agentId, escrowValue = opts.escrowValue, contractId = opts.contractId;
  var fee = calcAicpFee(escrowValue);
  trackUsage({ operatorId: operatorId, agentId: agentId, protocol: 'aicp', eventType: 'transaction', quantity: 1, valueUsd: escrowValue });
  if (!PAYMENTS_ENABLED) {
    console.log('[subscriptions:aicp] $' + fee + ' logged (not collected) contract=' + contractId);
    return { fee_usd: fee, collected: false };
  }
  return { fee_usd: fee, collected: true };
}

async function createCheckoutSession(opts) {
  var operatorId = opts.operatorId, plan = opts.plan, annual = opts.annual, successUrl = opts.successUrl, cancelUrl = opts.cancelUrl;
  if (!PAYMENTS_ENABLED) return { url: '/waitlist.html', mock: true };
  var priceId = annual ? 'price_' + plan + '_annual' : 'price_' + plan + '_monthly';
  var s = getStripe();
  var session = await s.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { operator_id: operatorId, plan: plan, annual: annual ? '1' : '0' },
  });
  return { url: session.url, session_id: session.id };
}

async function createPortalSession(operatorId, returnUrl) {
  if (!PAYMENTS_ENABLED) return { url: '/pricing.html', mock: true };
  var sub = getSubscription(operatorId);
  if (!sub.stripe_customer_id) throw new Error('No Stripe customer for operator');
  var session = await getStripe().billingPortal.sessions.create({ customer: sub.stripe_customer_id, return_url: returnUrl });
  return { url: session.url };
}

function handleStripeWebhook(rawBody, sig) {
  var event = getStripe().webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  var db = getDb();
  var obj = event.data.object;
  if (event.type === 'checkout.session.completed') {
    var meta = obj.metadata || {};
    if (meta.operator_id && meta.plan) {
      db.prepare("INSERT INTO subscriptions (operator_id, plan, stripe_customer_id, stripe_subscription_id, status, annual) VALUES (?, ?, ?, ?, 'active', ?) ON CONFLICT(operator_id) DO UPDATE SET plan=excluded.plan, stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id, status='active', annual=excluded.annual, updated_at=datetime('now')")
        .run(meta.operator_id, meta.plan, obj.customer, obj.subscription, meta.annual === '1' ? 1 : 0);
      db.prepare('UPDATE operators SET plan=? WHERE operator_id=?').run(meta.plan, meta.operator_id);
    }
  }
  if (event.type === 'customer.subscription.deleted') {
    db.prepare("UPDATE subscriptions SET status='cancelled', updated_at=datetime('now') WHERE stripe_subscription_id=?").run(obj.id);
  }
  if (event.type === 'customer.subscription.updated') {
    db.prepare("UPDATE subscriptions SET status=?, updated_at=datetime('now') WHERE stripe_subscription_id=?").run(obj.status, obj.id);
  }
  if (event.type === 'invoice.payment_failed') {
    db.prepare("UPDATE subscriptions SET status='past_due', updated_at=datetime('now') WHERE stripe_customer_id=?").run(obj.customer);
  }
  return { received: true, type: event.type };
}

module.exports = {
  PAYMENTS_ENABLED, PLANS, PLAN_ORDER, getPlan,
  getSubscription, requirePlan,
  trackUsage, getUsageSummary, getAatsDailyCount,
  calcAicpFee, collectAicpFee,
  createCheckoutSession, createPortalSession,
  handleStripeWebhook, periodKey, dayKey,
};
