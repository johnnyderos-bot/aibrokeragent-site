'use strict';

// dual-attest.js — dual attestation orchestrator
//
// Two different LLM providers run the same task independently.
// If they agree → both sign (ACC records anchored on same chain).
// If they diverge → one round of self-resolution.
// If still diverged → HITL package returned with plain-English summary
// and exact CRP context records for each agent.

const crypto   = require('crypto');
const express  = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const { getDb }                          = require('./db');
const { hashRecord, getLastRecordHash, anchorAcc } = require('./acc');
const { runTask: runSecondSigner }       = require('./second-signer');
const { compareOutputs }                 = require('./output-comparator');
const { buildHitlPackage }               = require('./hitl-package');

const router = express.Router();

// Primary LLM — Claude Sonnet (configurable via PRIMARY_MODEL env var)
const PRIMARY_MODEL = process.env.PRIMARY_MODEL || 'claude-sonnet-4-6';

let _anthropic = null;
function getAnthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

async function runPrimaryAgent(task, context) {
  const msg = await getAnthropicClient().messages.create({
    model: PRIMARY_MODEL,
    max_tokens: 1024,
    system: 'You are an AI agent completing a task. Be accurate, specific, and concise.',
    messages: [{ role: 'user', content: context ? `${task}\n\nContext: ${context}` : task }],
  });
  return {
    output:   msg.content[0].text,
    model_id: PRIMARY_MODEL,
    provider: 'anthropic',
  };
}

// Write one ACC record directly to DB (no HTTP round-trip)
async function writeAccRecord({ agent_id, flash_tag_id, action_type, action_target, outcome, context_snapshot }) {
  const db  = getDb();
  const now = new Date().toISOString();
  const record_id       = 'acc_' + crypto.randomBytes(10).toString('hex');
  const prev_record_hash = getLastRecordHash(db, agent_id);

  const payload = {
    record_id,
    agent_id,
    flash_tag_id:     flash_tag_id     || null,
    action_type,
    action_target:    action_target    || null,
    parameters_hash:  null,
    context_snapshot: context_snapshot || null,
    authority_chain:  null,
    outcome:          outcome          || 'success',
    state_delta_hash: null,
    prev_record_hash,
    crp_decision_id:  null,
    alr_id:           null,
    aiia_assessment_id: null,
    created_at:       now,
  };

  const record_hash = hashRecord(payload);

  const hcsPromise = anchorAcc({
    event:             'action_recorded',
    record_id,
    agent_id,
    action_type,
    record_hash,
    prev_record_hash,
    ts:                now,
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
    flash_tag_id     || null,
    action_type,
    action_target    || null,
    null,
    context_snapshot ? JSON.stringify(context_snapshot) : null,
    null,
    outcome          || 'success',
    null,
    prev_record_hash,
    record_hash,
    null, null, null,
    now
  );

  const hcs = await hcsPromise;
  if (hcs?.sequenceNumber) {
    db.prepare('UPDATE acc_action_records SET hcs_sequence = ? WHERE record_id = ?')
      .run(String(hcs.sequenceNumber), record_id);
  }

  return { record_id, record_hash, hcs_sequence: hcs?.sequenceNumber || null };
}

// ── POST /dual-attest ─────────────────────────────────────────────────────────
// Required: task, primary_agent_id, attesting_agent_id
// Optional: task_context, primary_flash_tag_id, attesting_flash_tag_id
router.post('/', async (req, res) => {
  try {
    const {
      task,
      task_context,
      primary_agent_id,
      primary_flash_tag_id,
      attesting_agent_id,
      attesting_flash_tag_id,
    } = req.body;

    if (!task || !primary_agent_id || !attesting_agent_id) {
      return res.status(400).json({ error: 'task, primary_agent_id, and attesting_agent_id are required' });
    }

    // ── Step 1: Run both agents in parallel ──────────────────────────────────
    const [resultA, resultB] = await Promise.all([
      runPrimaryAgent(task, task_context),
      runSecondSigner(task, task_context),
    ]);

    // ── Step 2: Compare ──────────────────────────────────────────────────────
    let comparison = await compareOutputs(resultA.output, resultB.output);

    let finalOutputA = resultA.output;
    let finalOutputB = resultB.output;
    let outcome      = comparison.match ? 'agreed' : null;

    // ── Step 3: Self-resolve if diverged ─────────────────────────────────────
    if (!outcome) {
      const resolvePromptA = `You completed a task, and an independent agent produced a different answer. Review both outputs and provide your best final answer.\n\nTask: ${task}\n\nYour original answer:\n${resultA.output}\n\nThe other agent's answer:\n${resultB.output}\n\nProvide your revised answer, incorporating any corrections. If you believe your original is correct, restate it clearly.`;

      const resolvePromptB = `You completed a task, and an independent agent produced a different answer. Review both outputs and provide your best final answer.\n\nTask: ${task}\n\nYour original answer:\n${resultB.output}\n\nThe other agent's answer:\n${resultA.output}\n\nProvide your revised answer, incorporating any corrections. If you believe your original is correct, restate it clearly.`;

      const [resolvedA, resolvedB] = await Promise.all([
        runPrimaryAgent(resolvePromptA, null),
        runSecondSigner(resolvePromptB, null),
      ]);

      finalOutputA = resolvedA.output;
      finalOutputB = resolvedB.output;
      comparison   = await compareOutputs(finalOutputA, finalOutputB);
      outcome      = comparison.match ? 'self_resolved' : 'hitl_required';
    }

    // ── Step 4: Write ACC records for both agents ─────────────────────────────
    const contextSnapshotA = {
      task,
      output: finalOutputA,
      model:  resultA.model_id,
      comparison_score: comparison.score,
    };

    const recordA = await writeAccRecord({
      agent_id:        primary_agent_id,
      flash_tag_id:    primary_flash_tag_id || null,
      action_type:     'dual_attestation',
      action_target:   null,
      outcome,
      context_snapshot: contextSnapshotA,
    });

    const contextSnapshotB = {
      task,
      output: finalOutputB,
      model:  resultB.model_id,
      comparison_score: comparison.score,
    };

    // Second record links to first via action_target
    const recordB = await writeAccRecord({
      agent_id:        attesting_agent_id,
      flash_tag_id:    attesting_flash_tag_id || null,
      action_type:     'dual_attestation',
      action_target:   recordA.record_id,
      outcome,
      context_snapshot: contextSnapshotB,
    });

    // ── Step 5: Agreed or self-resolved → return success ─────────────────────
    if (outcome !== 'hitl_required') {
      return res.json({
        ok: true,
        outcome,
        agreement_score:     comparison.score,
        primary_record_id:   recordA.record_id,
        attesting_record_id: recordB.record_id,
        primary_hcs:         recordA.hcs_sequence,
        attesting_hcs:       recordB.hcs_sequence,
        output_a:            finalOutputA,
        output_b:            finalOutputB,
        agreed_output:       finalOutputA, // primary agent's output is canonical on agreement
      });
    }

    // ── Step 6: HITL required → build plain-English package ──────────────────
    const hitlPackage = await buildHitlPackage({
      task,
      task_context: task_context || null,
      agentA: {
        output:       finalOutputA,
        model_id:     resultA.model_id,
        provider:     resultA.provider,
        flash_tag_id: primary_flash_tag_id || null,
        acc_record_id: recordA.record_id,
        crp_enrollment_id: null, // populated if CRP was used upstream
      },
      agentB: {
        output:       finalOutputB,
        model_id:     resultB.model_id,
        provider:     resultB.provider,
        flash_tag_id: attesting_flash_tag_id || null,
        acc_record_id: recordB.record_id,
        crp_enrollment_id: null,
      },
      comparison,
    });

    res.json({
      ok: true,
      outcome:             'hitl_required',
      primary_record_id:   recordA.record_id,
      attesting_record_id: recordB.record_id,
      hitl: hitlPackage,
    });

  } catch (err) {
    console.error('[dual-attest]', err.message);
    const status = err.message.includes('required') ? 400 : 500;
    res.status(status).json({ error: 'dual_attest_failed', detail: err.message });
  }
});

module.exports = { router };
