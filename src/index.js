require('dotenv').config();
const express = require('express');
const path = require('path');
const { initDb } = require('./db');
const vaultRouter = require('./api');
const arbitrationRouter = require('./arbitration-api');
const auditRouter     = require('./contract-audit-api');
const operatorRouter  = require('./operator-api');
const telegramBot       = require('./telegram-bot');
const { processTimeouts } = require('./arbitration');
const { cacheInfo: ofacCacheInfo } = require('./ofac');
const complianceRouter  = require('./compliance-api');
const { startAnchorScheduler } = require('./audit-log');
const billingRouter             = require('./billing-api');
const { handleStripeWebhook }   = require('./subscriptions');
const arenaRouter               = require('./arena-api');
const idleMarketplaceRouter     = require('./idle-marketplace-api');
const aicpRouter                = require('./aicp-api');

// Human Trust Console routers
const consoleAuthRouter          = require('./console-auth-api');
const consoleInvitesRouter       = require('./console-invites-api');
const consoleNotificationsRouter = require('./console-notifications-api');
const consoleLimitsRouter        = require('./console-limits-api');
const consoleDashboardRouter     = require('./console-dashboard-api');
const consolePlatformRouter      = require('./console-platform-api');
const consoleOperatorRouter      = require('./console-operator-api');
const discoveryRouter            = require('./discovery-api');
const betaRouter                 = require('./beta-api');
const { router: commerceRouter, processCommerceTimeouts } = require('./commerce');
const { router: governanceRouter } = require('./governance');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// Extensionless URL routing — /pricing → /pricing.html etc.
const urlMap = {
  '/products':   '/platform.html',
  '/platform':   '/platform.html',
  '/pricing':    '/pricing.html',
  '/contact':    '/contact.html',
  '/trust-score':'/trust-score.html',
  '/vault-info': '/context-vault.html',
  '/arbitration':'/arbitration.html',
  '/whitepaper': '/aats-whitepaper.html',
  '/audit':      '/contract-audit.html',
  '/command':    '/operator-console.html',
  '/operator-portal': '/operator-portal.html',
  '/waitlist':   '/waitlist.html',
  '/arena':      '/arena.html',
  '/compatibility': '/compatibility.html',
  '/docs':       '/aats-whitepaper.html',
  '/terms':      '/terms.html',
  '/privacy':    '/privacy.html',
};
Object.entries(urlMap).forEach(([from, to]) => {
  app.get(from, (req, res) => res.redirect(301, to));
});

// Contact form submission — log it (email integration comes later)
app.post('/contact', (req, res) => {
  const { name, email, company, topic, message } = req.body;
  console.log(`[contact-form] ${name} <${email}> [${company || 'no company'}] topic=${topic}: ${(message||'').slice(0,100)}`);
  res.json({ ok: true });
});

// Agent discovery — must be before static file serving
// Handles: /.well-known/*, /mcp, /a2a, /api/v1/platform/*, /api/v1/trust-score/*
app.use('/', discoveryRouter);

app.use('/beta', betaRouter);
app.use('/vault', vaultRouter);
app.use('/arbitration', arbitrationRouter);
app.use('/audit',      auditRouter);
app.use('/operators',   operatorRouter);
app.use('/compliance',  complianceRouter);
app.use('/billing',     billingRouter);
app.use('/arena',       arenaRouter);
app.use('/api',         idleMarketplaceRouter);
app.use('/api',         aicpRouter);
app.use('/commerce',    commerceRouter);
app.use('/governance',  governanceRouter);

// Public leaderboard at canonical API path
app.get('/api/v1/arena/leaderboard', (req, res) => {
  try {
    const { getLeaderboard } = require('./arena');
    const data = getLeaderboard();
    res.json({ ok: true, ...data });
  } catch (err) {
    res.status(500).json({ error: 'leaderboard unavailable' });
  }
});

// Stripe webhook — must use raw body, not JSON-parsed
app.post('/webhooks/stripe', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const result = handleStripeWebhook(req.body, req.headers['stripe-signature']);
    res.json(result);
  } catch (err) {
    console.error('[stripe-webhook]', err.message);
    res.status(400).json({ error: err.message });
  }
});

// Human Trust Console
app.use('/console/auth',             consoleAuthRouter);
app.use('/console/invites',          consoleInvitesRouter);
app.use('/console/platform',         consolePlatformRouter);
app.use('/console/agents/:agent_id/notifications', consoleNotificationsRouter);
app.use('/console/agents/:agent_id',               consoleLimitsRouter);
app.use('/console/agents/:agent_id',               consoleDashboardRouter);
app.use('/console/operator',                       consoleOperatorRouter);

app.get('/health', (req, res) => {
  const db = require('./db').getDb();
  const probe = (table) => { try { db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get(); return 'ok'; } catch { return 'error'; } };
  res.json({
    status: 'ok',
    service: 'BrokerAGEnt Context Vault',
    ofac_screening: ofacCacheInfo(),
    commerce: probe('commerce_transactions'),
    governance: probe('governance_constraint_records'),
  });
});

// Public stats endpoint — powers the landing page dashboard
app.get('/stats', (req, res) => {
  try {
    const { getDb } = require('./db');
    const db = getDb();
    const agents      = db.prepare('SELECT COUNT(*) as n FROM agents').get().n;
    const records     = db.prepare('SELECT COUNT(*) as n FROM vault_records').get().n;
    const anchors     = db.prepare('SELECT COUNT(*) as n FROM vault_records WHERE hcs_sequence IS NOT NULL').get().n;
    const topicRow    = db.prepare('SELECT COUNT(DISTINCT hcs_topic_id) as n FROM agents WHERE hcs_topic_id IS NOT NULL').get();

    // Contract Audit stats
    const contracts_active    = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'ACTIVE'").get().n; } catch { return 0; } })();
    const contracts_completed = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'COMPLETED'").get().n; } catch { return 0; } })();
    const audits_approved     = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status IN ('APPROVED','ACTIVE','COMPLETED')").get().n; } catch { return 0; } })();

    // Arbitration stats
    const disputes_filed  = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM disputes').get().n; } catch { return 0; } })();
    const rulings_issued  = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM arbitration_rulings').get().n; } catch { return 0; } })();
    const arbitrators     = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM arbitrators WHERE active = 1').get().n; } catch { return 0; } })();

    // Attestations
    const attested_agents = (() => { try { return db.prepare('SELECT COUNT(DISTINCT agent_id) as n FROM agent_attestations').get().n; } catch { return 0; } })();

    // Flash events
    const flash_events = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM flash_events').get().n; } catch { return 0; } })();

    // AATS trust gate queries today
    const aats_queries_today = (() => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        return db.prepare("SELECT COUNT(*) as n FROM aicp_evaluations WHERE created_at >= ?").get(today).n;
      } catch { return 0; }
    })();

    // Commerce stats
    const commerce_transactions = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM commerce_transactions').get().n; } catch { return 0; } })();
    const commerce_settled      = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM commerce_transactions WHERE status='settled'").get().n; } catch { return 0; } })();
    const commerce_disputed     = (() => { try { return db.prepare("SELECT COUNT(*) as n FROM commerce_transactions WHERE status IN ('disputed','resolved')").get().n; } catch { return 0; } })();

    // Governance stats
    const governance_gcrs        = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM governance_constraint_records').get().n; } catch { return 0; } })();
    const governance_gibs        = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM governance_inheritance_bindings').get().n; } catch { return 0; } })();
    const governance_violations  = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM governance_violation_events').get().n; } catch { return 0; } })();
    const governance_attestations = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM governance_attestations').get().n; } catch { return 0; } })();
    const governance_drift_count  = (() => { try { return db.prepare('SELECT COUNT(*) as n FROM governance_inheritance_bindings WHERE drift_detected=1').get().n; } catch { return 0; } })();

    res.json({
      agents_registered:    agents,
      records_stored:       records,
      hedera_anchors:       anchors,
      hedera_topics:        topicRow.n,
      contracts_active,
      contracts_completed,
      audits_approved,
      disputes_filed,
      rulings_issued,
      active_arbitrators:   arbitrators,
      attested_agents,
      flash_events,
      aats_queries_today,
      commerce: { total_transactions: commerce_transactions, settled: commerce_settled, disputed: commerce_disputed },
      governance: { total_gcrs: governance_gcrs, total_gibs: governance_gibs, drift_detected: governance_drift_count, total_violations: governance_violations, total_attestations: governance_attestations },
      network: process.env.HEDERA_NETWORK || 'testnet',
    });
  } catch (err) {
    res.status(500).json({ error: 'stats unavailable' });
  }
});

const PORT = process.env.PORT || 3000;

function scheduleDailyReport() {
  const now = new Date();
  const next8am = new Date(now);
  next8am.setHours(8, 0, 0, 0);
  if (next8am <= now) next8am.setDate(next8am.getDate() + 1);
  const msUntil = next8am - now;
  setTimeout(() => {
    telegramBot.sendReport();
    setInterval(() => telegramBot.sendReport(), 86400000); // repeat every 24h
  }, msUntil);
  console.log(`[telegram-bot] daily report scheduled in ${Math.round(msUntil / 60000)}m`);
}

try {
  initDb();
  app.listen(PORT, () => {
    console.log(`Context Vault running on port ${PORT}`);
  });
  telegramBot.start();
  scheduleDailyReport();

  // Hourly arbitration SLA sweep
  setInterval(() => processTimeouts(), 60 * 60 * 1000);

  // Hourly ADRP phase-3 timeout sweep (refund escrow after 24h hold)
  setInterval(() => { try { processCommerceTimeouts(); } catch (err) { console.error('[commerce-timeout]', err.message); } }, 60 * 60 * 1000);

  // HCS batch anchoring for audit log — 15-minute intervals
  startAnchorScheduler();
} catch (err) {
  console.error('Failed to initialize:', err);
  process.exit(1);
}
