/**
 * Console Notifications API — list, read, read-all
 * Also exports createNotification helper for use in contract-audit.js
 */

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const { requireConsoleAuth } = require('./console-auth');

const router = express.Router({ mergeParams: true });

/**
 * Helper: create a notification for an agent.
 * Exported for use in contract-audit.js and other modules.
 */
function createNotification(db, agent_id, type, severity, title, message, contract_id = null) {
  const id = crypto.randomBytes(16).toString('hex');
  db.prepare(`
    INSERT INTO agent_notifications (id, agent_id, type, severity, title, message, contract_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, agent_id, type, severity, title, message, contract_id || null);
  return id;
}

/**
 * Notify all owner users of an agent.
 */
function notifyAgentOwners(db, agent_id, type, severity, title, message, contract_id = null) {
  // Find owner users for this agent
  const owners = db.prepare(`
    SELECT user_id FROM console_agent_access WHERE agent_id = ? AND role = 'owner'
  `).all(agent_id);

  // We create one notification per agent (not per user) — agents have owners
  createNotification(db, agent_id, type, severity, title, message, contract_id);
}

/**
 * GET /console/agents/:agent_id/notifications
 * List notifications. ?unread_only=true filters to unread.
 */
router.get('/', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();
  const unreadOnly = req.query.unread_only === 'true';

  let sql = 'SELECT * FROM agent_notifications WHERE agent_id = ?';
  const params = [req.params.agent_id];

  if (unreadOnly) {
    sql += ' AND read = 0';
  }

  sql += ' ORDER BY created_at DESC LIMIT 100';

  const notifications = db.prepare(sql).all(...params);
  const unread_count = db.prepare('SELECT COUNT(*) as n FROM agent_notifications WHERE agent_id = ? AND read = 0').get(req.params.agent_id).n;

  res.json({ notifications, unread_count });
});

/**
 * POST /console/agents/:agent_id/notifications/:id/read
 * Mark a single notification as read.
 */
router.post('/:id/read', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();
  const notif = db.prepare('SELECT * FROM agent_notifications WHERE id = ? AND agent_id = ?')
    .get(req.params.id, req.params.agent_id);
  if (!notif) return res.status(404).json({ error: 'notification not found' });

  db.prepare('UPDATE agent_notifications SET read = 1 WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

/**
 * POST /console/agents/:agent_id/notifications/read-all
 * Mark all notifications for this agent as read.
 */
router.post('/read-all', requireConsoleAuth('viewer'), (req, res) => {
  const db = getDb();
  const result = db.prepare('UPDATE agent_notifications SET read = 1 WHERE agent_id = ? AND read = 0')
    .run(req.params.agent_id);
  res.json({ ok: true, updated: result.changes });
});

module.exports = router;
module.exports.createNotification = createNotification;
module.exports.notifyAgentOwners = notifyAgentOwners;
