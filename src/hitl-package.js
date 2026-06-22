'use strict';

// hitl-package.js — plain-English HITL payload builder
// Pulls CRP enrollment records for both agents so the human sees exactly
// what context each agent received, plus a Claude-generated plain-English
// divergence summary and a single focused question to resolve.

const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('./db');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

function getCrpEnrollment(enrollment_id) {
  if (!enrollment_id) return null;
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM crp_side_index WHERE enrollment_id = ?').get(enrollment_id);
    if (!row) return null;
    return {
      enrollment_id: row.enrollment_id,
      content_hash:  row.content_hash,
      hcs_sequence:  row.hcs_sequence || null,
    };
  } catch {
    return null;
  }
}

async function buildHitlPackage({ task, task_context, agentA, agentB, comparison }) {
  const enrollmentA = getCrpEnrollment(agentA.crp_enrollment_id);
  const enrollmentB = getCrpEnrollment(agentB.crp_enrollment_id);

  // If both agents enrolled context, compare hashes — mismatch = tamper signal
  const tamper_detected = !!(
    enrollmentA && enrollmentB &&
    enrollmentA.content_hash !== enrollmentB.content_hash
  );

  const prompt = `Two AI agents completed the same task but produced different outputs. Summarize the divergence for a human reviewer.

Task: ${task}

Agent A (${agentA.provider} / ${agentA.model_id}):
${agentA.output}

Agent B (${agentB.provider} / ${agentB.model_id}):
${agentB.output}

Claims unique to Agent A: ${comparison.only_in_a.length ? comparison.only_in_a.join(' | ') : 'none'}
Claims unique to Agent B: ${comparison.only_in_b.length ? comparison.only_in_b.join(' | ') : 'none'}
Agreement score: ${comparison.score}

Return a JSON object with exactly these fields:
{
  "agreed_on": ["brief bullet of something they agreed on", ...],
  "split_on": ["brief bullet of specific point of divergence", ...],
  "plain_english": "2-3 sentence plain English summary of what happened and why it matters",
  "your_question": "The single most important yes/no or choice question the human needs to answer"
}`;

  let divergence = {
    agreed_on: [],
    split_on: [...comparison.only_in_a, ...comparison.only_in_b],
    plain_english: `Agent A and Agent B produced different outputs on the same task (agreement score: ${comparison.score}). Human review is needed to determine the correct answer.`,
    your_question: 'Which agent\'s output is more accurate for this task?',
  };

  try {
    const msg = await getClient().messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }],
    });
    const raw = msg.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.plain_english) divergence = parsed;
    }
  } catch (e) {
    console.error('[hitl-package] summary failed:', e.message);
  }

  return {
    shared_inputs: {
      task,
      task_context:     task_context || null,
      crp_enrollment_a: enrollmentA,
      crp_enrollment_b: enrollmentB,
      tamper_detected,
    },
    agent_a: {
      output:       agentA.output,
      model:        agentA.model_id,
      provider:     agentA.provider,
      flash_tag_id: agentA.flash_tag_id || null,
      acc_record_id: agentA.acc_record_id || null,
    },
    agent_b: {
      output:       agentB.output,
      model:        agentB.model_id,
      provider:     agentB.provider,
      flash_tag_id: agentB.flash_tag_id || null,
      acc_record_id: agentB.acc_record_id || null,
    },
    divergence,
    chain_state: {
      both_records_anchored: !!(agentA.acc_record_id && agentB.acc_record_id),
      outcome:          'hitl_required',
      agreement_score:  comparison.score,
    },
  };
}

module.exports = { buildHitlPackage };
