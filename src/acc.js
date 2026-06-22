'use strict';

// ACC — Agentic Chain of Custody Protocol
// Provisional App #64/079,042
// Every agent action is recorded, hash-chained, and HCS-anchored.
// Chain integrity is verifiable by any third party.

const crypto  = require('crypto');
const express = require('express');
const { getDb } = require('./db');
const { anchorRecord, createVaultTopic } = require('./hedera');

const router = express.Router();

// ── HCS topic ────────────────────────────────────────────────────────────────
let _accTopic = process.env.HEDERA_ACC_TOPIC || null;

async function getAccTopic() {
  if (_accTopic) return _accTopic;
  try {
    _accTopic = await createVaultTopic('platform-acc');
    console.log('[acc] HCS topic:', _accTopic);
  } catch (err) {
    console.error('[acc] HCS topic creation failed:', err.message);
  }
  return _accTopic;
}

async function anchorAcc(payload) {
  const topic = await getAccTopic();
  if (!topic) return null;
  try {
    return await anchorRecord(topic, payload);
  } catch (err) {
    console.error('[acc] HCS anchor failed:', err.message);
    return null;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashRecord(payload) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

function getLastRecordHash(db, agent_id) {
  const last = db.prepare(
    'SELECT record_hash FROM acc_action_records WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1'
  ).get(agent_id);
  return last ? last.record_hash : null;
}

// ── POST /acc/record ──────────────────────────────────────────────────────────
// Called by agents or the platform runtime when an action occurs.
// Required: agent_id, action_type
// Optional: flash_tag_id, action_target, parameters_hash, context_snapshot,
//           authority_chain, outcome, state_delta_hash,
//           crp_decision_id, alr_id, aiia_assessment_id
router.post('/record', async (req, res) => {
  try {
    const {
      agent_id,
      flash_tag_id,
      action_type,
      action_target,
      parameters_hash,
      context_snapshot,
      authority_chain,
      outcome,
      state_delta_hash,
      crp_decision_id,
      alr_id,
      aiia_assessment_id,
    } = req.body;

    if (!agent_id || !action_type) {
      return res.status(400).json({ error: 'agent_id and action_type required' });
    }

    const db  = getDb();
    const now = new Date().toISOString();
    const record_id      = 'acc_' + crypto.randomBytes(10).toString('hex');
    const prev_record_hash = getLastRecordHash(db, agent_id);

    const recordPayload = {
      record_id,
      agent_id,
      flash_tag_id:       flash_tag_id       || null,
      action_type,
      action_target:      action_target      || null,
      parameters_hash:    parameters_hash    || null,
      context_snapshot:   context_snapshot   || null,
      authority_chain:    authority_chain    || null,
      outcome:            outcome            || 'success',
      state_delta_hash:   state_delta_hash   || null,
      prev_record_hash,
      crp_decision_id:    crp_decision_id    || null,
      alr_id:             alr_id             || null,
      aiia_assessment_id: aiia_assessment_id || null,
      created_at:         now,
    };

    const record_hash = hashRecord(recordPayload);

    // Fire-and-forget HCS — action records are high-volume, non-blocking
    const hcsPromise = anchorAcc({
      event: 'action_recorded',
      record_id,
      agent_id,
      action_type,
      record_hash,
      prev_record_hash,
      ts: now,
    }).catch(() => {});

    db.prepare(`
      INSERT INTO acc_action_records
        (record_id, agent_id, flash_tag_id, action_type, action_target,
         parameters_hash, context_snapshot, authority_chain,
         outcome, state_delta_hash, prev_record_hash, record_hash,
         crp_decision_id, alr_id, aiia_assessment_id, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      record_id,
      agent_id,
      flash_tag_id    || null,
      action_type,
      action_target   || null,
      parameters_hash || null,
      context_snapshot   ? JSON.stringify(context_snapshot)   : null,
      authority_chain    ? JSON.stringify(authority_chain)    : null,
      outcome            || 'success',
      state_delta_hash   || null,
      prev_record_hash,
      record_hash,
      crp_decision_id    || null,
      alr_id             || null,
      aiia_assessment_id || null,
      now
    );

    const hcs = await hcsPromise;
    if (hcs?.sequenceNumber) {
      db.prepare('UPDATE acc_action_records SET hcs_sequence = ? WHERE record_id = ?')
        .run(String(hcs.sequenceNumber), record_id);
    }

    res.json({
      ok:               true,
      record_id,
      record_hash,
      prev_record_hash,
      hcs_sequence:     hcs?.sequenceNumber || null,
    });

  } catch (err) {
    console.error('[acc] record failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET /acc/:record_id ───────────────────────────────────────────────────────
router.get('/:record_id', (req, res) => {
  try {
    const db  = getDb();
    const rec = db.prepare(
      'SELECT * FROM acc_action_records WHERE record_id = ?'
    ).get(req.params.record_id);

    if (!rec) return res.status(404).json({ error: 'record_not_found' });

    if (rec.context_snapshot) rec.context_snapshot = JSON.parse(rec.context_snapshot);
    if (rec.authority_chain)  rec.authority_chain  = JSON.parse(rec.authority_chain);

    res.json({ ok: true, record: rec });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /acc/agent/:agent_id/chain ────────────────────────────────────────────
router.get('/agent/:agent_id/chain', (req, res) => {
  try {
    const db     = getDb();
    const limit  = Math.min(parseInt(req.query.limit  || '100', 10), 500);
    const offset = parseInt(req.query.offset || '0', 10);

    const records = db.prepare(
      `SELECT * FROM acc_action_records
       WHERE agent_id = ? ORDER BY created_at ASC LIMIT ? OFFSET ?`
    ).all(req.params.agent_id, limit, offset);

    const total = db.prepare(
      'SELECT COUNT(*) as cnt FROM acc_action_records WHERE agent_id = ?'
    ).get(req.params.agent_id).cnt;

    res.json({ ok: true, agent_id: req.params.agent_id, total, records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /acc/verify/:agent_id ────────────────────────────────────────────────
// Walk every record in the chain and verify hash integrity + prev linkage.
router.post('/verify/:agent_id', (req, res) => {
  try {
    const db = getDb();
    const records = db.prepare(
      `SELECT * FROM acc_action_records
       WHERE agent_id = ? ORDER BY created_at ASC`
    ).all(req.params.agent_id);

    if (records.length === 0) {
      return res.json({
        ok: true, agent_id: req.params.agent_id,
        valid: true, record_count: 0, violations: [],
      });
    }

    const violations = [];

    for (let i = 0; i < records.length; i++) {
      const r = records[i];

      const payload = {
        record_id:          r.record_id,
        agent_id:           r.agent_id,
        flash_tag_id:       r.flash_tag_id,
        action_type:        r.action_type,
        action_target:      r.action_target,
        parameters_hash:    r.parameters_hash,
        context_snapshot:   r.context_snapshot ? JSON.parse(r.context_snapshot) : null,
        authority_chain:    r.authority_chain  ? JSON.parse(r.authority_chain)  : null,
        outcome:            r.outcome,
        state_delta_hash:   r.state_delta_hash,
        prev_record_hash:   r.prev_record_hash,
        crp_decision_id:    r.crp_decision_id,
        alr_id:             r.alr_id,
        aiia_assessment_id: r.aiia_assessment_id,
        created_at:         r.created_at,
      };
      const expected = hashRecord(payload);

      if (expected !== r.record_hash) {
        violations.push({ record_id: r.record_id, position: i, type: 'hash_mismatch' });
      }

      if (i === 0) {
        if (r.prev_record_hash !== null) {
          violations.push({ record_id: r.record_id, position: i, type: 'invalid_chain_root' });
        }
      } else {
        if (r.prev_record_hash !== records[i - 1].record_hash) {
          violations.push({ record_id: r.record_id, position: i, type: 'broken_chain_link' });
        }
      }
    }

    res.json({
      ok:           true,
      agent_id:     req.params.agent_id,
      valid:        violations.length === 0,
      record_count: records.length,
      violations,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /acc/agent/:agent_id/completeness ─────────────────────────────────────
// Returns 0-100 for AATS ACS dimension.
function computeAccCompleteness(agent_id, db) {
  try {
    const total = db.prepare(
      'SELECT COUNT(*) as cnt FROM acc_action_records WHERE agent_id = ?'
    ).get(agent_id).cnt;

    if (total === 0) return 100;

    // Count records where prev_record_hash doesn't match the previous record's hash
    // (broken chain links indicate tampered or missing records)
    const records = db.prepare(
      'SELECT record_hash, prev_record_hash FROM acc_action_records WHERE agent_id = ? ORDER BY created_at ASC'
    ).all(agent_id);

    let broken = 0;
    for (let i = 1; i < records.length; i++) {
      if (records[i].prev_record_hash !== records[i - 1].record_hash) broken++;
    }

    return Math.round(Math.max(0, 100 - (broken / total * 100)));
  } catch {
    return 100;
  }
}

router.get('/agent/:agent_id/completeness', (req, res) => {
  try {
    const db    = getDb();
    const score = computeAccCompleteness(req.params.agent_id, db);
    const total = db.prepare(
      'SELECT COUNT(*) as cnt FROM acc_action_records WHERE agent_id = ?'
    ).get(req.params.agent_id).cnt;

    res.json({ ok: true, agent_id: req.params.agent_id, completeness: score, total_records: total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = { router, computeAccCompleteness, hashRecord, getLastRecordHash, anchorAcc, getAccTopic };
