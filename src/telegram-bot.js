/**
 * BrokerAGEnt Telegram Analytics Bot
 *
 * Sends analytics reports to a configured Telegram chat.
 * Supports on-demand commands (/stats, /revenue, /activity, /report)
 * and exports sendReport() for scheduled use.
 *
 * Required env vars:
 *   TELEGRAM_BOT_TOKEN — from @BotFather
 *   TELEGRAM_CHAT_ID   — chat/channel ID to post reports to
 */

require('dotenv').config();
const { getDb } = require('./db');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Queries ──────────────────────────────────────────────────────────────────

function getStats() {
  const db = getDb();
  const now = new Date();
  const yesterday = new Date(now - 86400000).toISOString();

  const safe = (fn) => { try { return fn(); } catch { return 0; } };

  // Agents
  const agents_total  = db.prepare('SELECT COUNT(*) as n FROM agents').get().n;
  const agents_funded = db.prepare('SELECT COUNT(*) as n FROM agents WHERE credits > 0').get().n;
  const agents_24h    = safe(() => db.prepare("SELECT COUNT(*) as n FROM agents WHERE created_at >= ?").get(yesterday).n);

  // Vault
  const records_total  = db.prepare('SELECT COUNT(*) as n FROM vault_records').get().n;
  const anchors_total  = db.prepare('SELECT COUNT(*) as n FROM vault_records WHERE hcs_sequence IS NOT NULL').get().n;
  const records_24h    = safe(() => db.prepare("SELECT COUNT(*) as n FROM vault_records WHERE created_at >= ?").get(yesterday).n);

  // Contract Audit
  const contracts_active    = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'ACTIVE'").get().n);
  const contracts_completed = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status = 'COMPLETED'").get().n);
  const contracts_24h       = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE created_at >= ?").get(yesterday).n);
  const audit_volume        = safe(() => db.prepare('SELECT COALESCE(SUM(total_amount_hbar),0) as n FROM audit_contracts').get().n);
  const audits_approved     = safe(() => db.prepare("SELECT COUNT(*) as n FROM audit_contracts WHERE audit_status IN ('APPROVED','ACTIVE','COMPLETED')").get().n);

  // Credits in system
  const credits_total = db.prepare('SELECT COALESCE(SUM(credits),0) as n FROM agents').get().n;

  // Top-ups
  const topups_24h         = safe(() => db.prepare("SELECT COUNT(*) as n FROM topup_transactions WHERE verified_at >= ?").get(yesterday).n);
  const topup_credits_24h  = safe(() => db.prepare("SELECT COALESCE(SUM(credits_added),0) as n FROM topup_transactions WHERE verified_at >= ?").get(yesterday).n);
  const topup_hbar_total   = safe(() => db.prepare('SELECT COALESCE(SUM(hbar_amount),0) as n FROM topup_transactions').get().n);

  // Arbitration
  const disputes_open   = safe(() => db.prepare("SELECT COUNT(*) as n FROM disputes WHERE status NOT IN ('resolved','closed')").get().n);
  const disputes_total  = safe(() => db.prepare('SELECT COUNT(*) as n FROM disputes').get().n);
  const rulings_total   = safe(() => db.prepare('SELECT COUNT(*) as n FROM arbitration_rulings').get().n);
  const arbitrators     = safe(() => db.prepare('SELECT COUNT(*) as n FROM arbitrators WHERE active = 1').get().n);

  return {
    agents: { total: agents_total, funded: agents_funded, new_24h: agents_24h },
    vault:  { records: records_total, anchors: anchors_total, new_24h: records_24h },
    audit: { active: contracts_active, completed: contracts_completed, new_24h: contracts_24h, volume: audit_volume, approved: audits_approved },
    credits: { in_system: credits_total },
    topups: { count_24h: topups_24h, credits_24h: topup_credits_24h, hbar_total: topup_hbar_total },
    arbitration: { open: disputes_open, total: disputes_total, rulings: rulings_total, arbitrators },
  };
}

// ── Formatters ───────────────────────────────────────────────────────────────

function fmt(n, decimals = 1) {
  return typeof n === 'number' ? (Number.isInteger(n) ? n : n.toFixed(decimals)) : '—';
}

function buildReport(s) {
  const lines = [
    `*BrokerAGEnt Analytics* 📊`,
    `_${new Date().toUTCString()}_`,
    ``,
    `*Agents*`,
    `• Registered: ${fmt(s.agents.total)}  |  Funded: ${fmt(s.agents.funded)}`,
    `• New (24h): ${fmt(s.agents.new_24h)}`,
    ``,
    `*Vault*`,
    `• Records stored: ${fmt(s.vault.records)}  |  HCS anchored: ${fmt(s.vault.anchors)}`,
    `• New records (24h): ${fmt(s.vault.new_24h)}`,
    ``,
    `*Contract Audit*`,
    `• Active: ${fmt(s.audit.active)}  |  Completed: ${fmt(s.audit.completed)}`,
    `• Total HBAR audited: ${fmt(s.audit.volume)} HBAR`,
    `• New audits (24h): ${fmt(s.audit.new_24h)}  |  Approved: ${fmt(s.audit.approved)}`,
    ``,
    `*Revenue*`,
    `• Top-ups (24h): ${fmt(s.topups.count_24h)} tx → ${fmt(s.topups.credits_24h)} credits`,
    `• HBAR received (all-time): ${fmt(s.topups.hbar_total)} HBAR`,
    `• Credits in system: ${fmt(s.credits.in_system)} credits`,
    ``,
    `*Arbitration*`,
    `• Open disputes: ${fmt(s.arbitration.open)}  |  Total: ${fmt(s.arbitration.total)}`,
    `• Rulings issued: ${fmt(s.arbitration.rulings)}  |  Arbitrators: ${fmt(s.arbitration.arbitrators)}`,
  ];
  return lines.join('\n');
}

// ── Telegram API helpers ─────────────────────────────────────────────────────

async function sendMessage(chat_id, text) {
  const res = await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, text, parse_mode: 'Markdown' }),
  });
  return res.json();
}

async function getUpdates(offset) {
  const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30`);
  return res.json();
}

// ── Public API ───────────────────────────────────────────────────────────────

// Send a report to the configured chat
async function sendReport() {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set — skipping report');
    return;
  }
  try {
    const stats = getStats();
    await sendMessage(CHAT_ID, buildReport(stats));
  } catch (err) {
    console.error('[telegram-bot] sendReport error:', err.message);
  }
}

// ── Command polling loop ─────────────────────────────────────────────────────

let _offset = 0;
let _running = false;

async function poll() {
  if (!_running) return;
  try {
    const data = await getUpdates(_offset);
    if (data.ok && data.result?.length) {
      for (const update of data.result) {
        _offset = update.update_id + 1;
        const msg = update.message;
        if (!msg?.text) continue;

        const cmd = msg.text.split(' ')[0].toLowerCase().replace(`@${msg.bot_name}`, '');
        const chat = msg.chat.id;

        if (['/stats', '/report', '/revenue', '/activity'].includes(cmd)) {
          const stats = getStats();
          await sendMessage(chat, buildReport(stats));
        } else if (cmd === '/help') {
          await sendMessage(chat, [
            '*BrokerAGEnt Bot Commands*',
            '/stats — full analytics dashboard',
            '/report — same as /stats',
            '/help — show this message',
          ].join('\n'));
        }
      }
    }
  } catch (err) {
    console.error('[telegram-bot] poll error:', err.message);
  }
  setTimeout(poll, 1000);
}

function start() {
  if (!BOT_TOKEN) {
    console.warn('[telegram-bot] TELEGRAM_BOT_TOKEN not set — bot disabled');
    return;
  }
  _running = true;
  console.log('[telegram-bot] started');
  poll();
}

function stop() {
  _running = false;
}

module.exports = { start, stop, sendReport };
