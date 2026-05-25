/**
 * Human Operator Console API
 * GET /console/operator/status
 *
 * Aggregates system health, nanoclaw agent state, platform metrics, and
 * recent activity for the human-facing operator dashboard.
 *
 * Auth: requirePlatformRole('watcher') — any logged-in console user.
 */

const express = require('express');
const fs      = require('fs');
const path    = require('path');
const { getDb }               = require('./db');
const { requirePlatformRole } = require('./console-auth');
const { computeTrustScore }   = require('./trust-score');

const router = express.Router();

const NANOCLAW_ROOT    = path.resolve(__dirname, '..', '..', 'nanoclaw');
const NANOCLAW_PID     = path.join(NANOCLAW_ROOT, 'nanoclaw.pid');
const NANOCLAW_LOG     = path.join(NANOCLAW_ROOT, 'logs', 'nanoclaw.log');
const WATCHDOG_LOG     = path.join(NANOCLAW_ROOT, 'logs', 'watchdog.log');
const WATCHDOG_DISABLED = path.join(NANOCLAW_ROOT, 'watchdog.disabled');

const safe = (fn, fallback = null) => { try { return fn(); } catch { return fallback; } };

// ── Nanoclaw process status ────────────────────────────────────────────────────

function getNanoClawStatus() {
  const pidRaw = safe(() => fs.readFileSync(NANOCLAW_PID, 'utf8').trim());
  const pid    = parseInt(pidRaw) || null;
  let alive    = false;
  if (pid) { try { process.kill(pid, 0); alive = true; } catch {} }

  const logLines = safe(() =>
    fs.readFileSync(NANOCLAW_LOG, 'utf8').split('\n').filter(Boolean).slice(-300)
  , []);

  let lastSeen        = null;
  let lastActivity    = null;
  let containerActive = false;
  let containerName   = null;
  let errorCount      = 0;
  let messagesSent    = 0;

  for (let i = logLines.length - 1; i >= 0; i--) {
    const line = logLines[i];
    const tsMatch = line.match(/\[(\d{2}:\d{2}:\d{2}\.\d+)\]/);
    if (tsMatch && !lastSeen) lastSeen = tsMatch[1];

    if (!lastActivity) {
      if      (line.includes('Spawning container agent'))   lastActivity = 'Spawning container';
      else if (line.includes('Telegram message sent'))      lastActivity = 'Message sent to Telegram';
      else if (line.includes('Processing messages'))        lastActivity = 'Processing inbound messages';
      else if (line.includes('NanoClaw running'))           lastActivity = 'Started up — on post';
      else if (line.includes('Scheduler loop started'))     lastActivity = 'Scheduler running';
      else if (line.includes('Agent output'))               lastActivity = 'Agent completed task';
    }

    if (line.includes('Spawning container agent') && !containerName) {
      const m = line.match(/nanoclaw-[\w-]+/);
      if (m) { containerActive = true; containerName = m[0]; }
    }
    if (line.includes('Container exited') || line.includes('Container timeout')) {
      containerActive = false; containerName = null;
    }
    if (line.includes('"level":50') || line.includes('[31m')) errorCount++;
    if (line.includes('Telegram message sent')) messagesSent++;
  }

  // Last watchdog restart timestamp
  let lastRestart = null;
  let restartCount = 0;
  const wdLines = safe(() =>
    fs.readFileSync(WATCHDOG_LOG, 'utf8').split('\n').filter(Boolean)
  , []);
  for (let i = wdLines.length - 1; i >= 0; i--) {
    if (wdLines[i].includes('Started nanoclaw')) {
      restartCount++;
      if (!lastRestart) {
        const m = wdLines[i].match(/\[([^\]]+)\]/);
        if (m) lastRestart = m[1];
      }
    }
  }

  return {
    pid,
    alive,
    last_seen: lastSeen,
    last_activity: lastActivity,
    container_active: containerActive,
    container_name: containerName,
    last_restart: lastRestart,
    restart_count: restartCount,
    error_count: Math.min(errorCount, 99),
    messages_sent: messagesSent,
  };
}

// ── BrokerAGEnt self-check ─────────────────────────────────────────────────────

function getBrokerAgentStatus() {
  return {
    alive: true,
    uptime_seconds: Math.floor(process.uptime()),
    memory_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
    port: process.env.PORT || 3000,
    network: process.env.HEDERA_NETWORK || 'testnet',
  };
}

// ── Platform metrics ──────────────────────────────────────────────────────────

function getPlatformMetrics() {
  const db = getDb();
  return {
    agents_registered:   safe(() => db.prepare('SELECT COUNT(*) as n FROM agents').get().n, 0),
    vault_records:       safe(() => db.prepare('SELECT COUNT(*) as n FROM vault_records').get().n, 0),
    hedera_anchors:      safe(() => db.prepare('SELECT COUNT(*) as n FROM vault_records WHERE hcs_sequence IS NOT NULL').get().n, 0),
    contracts_active:    safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status='ACTIVE'").get().n, 0),
    contracts_completed: safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status='COMPLETED'").get().n, 0),
    disputes_open:       safe(() => db.prepare("SELECT COUNT(*) as n FROM disputes WHERE status NOT IN ('CLOSED','RESOLVED')").get().n, 0),
    rulings_issued:      safe(() => db.prepare('SELECT COUNT(*) as n FROM arbitration_rulings').get().n, 0),
    attested_agents:     safe(() => db.prepare('SELECT COUNT(DISTINCT agent_id) as n FROM agent_attestations').get().n, 0),
    platform_users:      safe(() => db.prepare('SELECT COUNT(*) as n FROM console_users').get().n, 0),
  };
}

// ── Activity feed ──────────────────────────────────────────────────────────────

function getActivityFeed() {
  const db = getDb();
  const events = [];

  const records = safe(() => db.prepare(
    'SELECT agent_id, label, created_at, hcs_sequence FROM vault_records ORDER BY created_at DESC LIMIT 8'
  ).all(), []);
  for (const r of records) {
    events.push({
      ts: r.created_at, type: 'vault', icon: '🔒',
      label: r.hcs_sequence ? 'Vault record anchored to Hedera' : 'Vault record stored',
      detail: r.label || r.agent_id,
    });
  }

  const contracts = safe(() => db.prepare(
    'SELECT id, title, audit_status, buyer_agent, created_at FROM audit_contracts ORDER BY created_at DESC LIMIT 5'
  ).all(), []);
  for (const c of contracts) {
    events.push({
      ts: c.created_at, type: 'contract', icon: '📋',
      label: `Contract ${c.audit_status.toLowerCase()}`,
      detail: c.title || c.id,
    });
  }

  const rulings = safe(() => db.prepare(`
    SELECT r.created_at, r.ruling, d.description FROM arbitration_rulings r
    LEFT JOIN disputes d ON d.id = r.dispute_id ORDER BY r.created_at DESC LIMIT 3
  `).all(), []);
  for (const r of rulings) {
    events.push({
      ts: r.created_at, type: 'ruling', icon: '⚖️',
      label: `Ruling: ${r.ruling}`, detail: r.description || '',
    });
  }

  return events
    .filter(e => e.ts)
    .sort((a, b) => new Date(b.ts) - new Date(a.ts))
    .slice(0, 15);
}

// ── Top agents by trust score ──────────────────────────────────────────────────

function getTopAgents() {
  const db = getDb();
  const agents = safe(() => db.prepare(
    'SELECT agent_id, name, agent_type, credits, created_at FROM agents ORDER BY credits DESC LIMIT 10'
  ).all(), []);
  return agents.map(a => {
    let score = null;
    try { score = computeTrustScore(a.agent_id)?.score ?? null; } catch {}
    return { ...a, trust_score: score };
  }).sort((a, b) => (b.trust_score || 0) - (a.trust_score || 0)).slice(0, 6);
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.get('/status', requirePlatformRole('watcher'), (req, res) => {
  res.json({
    generated_at:     new Date().toISOString(),
    nanoclaw:         getNanoClawStatus(),
    brokeragent:      getBrokerAgentStatus(),
    platform:         getPlatformMetrics(),
    activity_feed:    getActivityFeed(),
    top_agents:       getTopAgents(),
    watchdog_enabled: !fs.existsSync(WATCHDOG_DISABLED),
  });
});

// POST /console/operator/watchdog — toggle watchdog on/off
// Body: { enabled: true|false }
router.post('/watchdog', requirePlatformRole('watcher'), (req, res) => {
  const { enabled } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled (boolean) is required' });
  }
  try {
    if (enabled) {
      if (fs.existsSync(WATCHDOG_DISABLED)) fs.unlinkSync(WATCHDOG_DISABLED);
    } else {
      fs.writeFileSync(WATCHDOG_DISABLED, `Disabled by ${req.consoleUser.name || req.consoleUser.email} at ${new Date().toISOString()}\n`);
    }
    const state = !fs.existsSync(WATCHDOG_DISABLED);
    console.log(`[operator-console] watchdog ${state ? 'ENABLED' : 'DISABLED'} by ${req.consoleUser.email}`);
    res.json({ watchdog_enabled: state });
  } catch (err) {
    res.status(500).json({ error: 'failed to toggle watchdog: ' + err.message });
  }
});

module.exports = router;
