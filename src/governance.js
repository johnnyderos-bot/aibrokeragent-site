'use strict';

const express = require('express');
const crypto = require('crypto');
const { getDb } = require('./db');
const { resolveKey } = require('./auth');
const { resolveOperatorKey } = require('./operator-auth');
const { computeTrustScore } = require('./trust-score');
const { anchorRecord, createVaultTopic } = require('./hedera');

const router = express.Router();

// Platform-level HCS topic for governance events.
let _governanceTopic = process.env.HEDERA_GOVERNANCE_TOPIC || null;
async function getGovernanceTopic() {
  if (_governanceTopic) return _governanceTopic;
  try {
    _governanceTopic = await createVaultTopic('platform-governance');
    console.log('[governance] created HCS topic:', _governanceTopic);
  } catch (err) {
    console.error('[governance] HCS topic creation failed:', err.message);
  }
  return _governanceTopic;
}

async function anchorGovernance(payload) {
  const topic = await getGovernanceTopic();
  if (!topic) return null;
  try {
    return await anchorRecord(topic, payload);
  } catch (err) {
    console.error('[governance] HCS anchor failed:', err.message);
    return null;
  }
}

// ── Hash helpers ──────────────────────────────────────────────────────────────

function computeMandatoryHash(mandatory_constraints) {
  const sorted = [...mandatory_constraints].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

// ── Upward Escalation Prohibition ────────────────────────────────────────────
// Returns { ok: true } or { ok: false, violations: [...] }

function validateUpwardEscalation(parent_mandatory, child_effective) {
  const violations = [];

  // parent_mandatory and child_effective are arrays of constraint objects
  // Each constraint: { id, type, ... } where type drives the comparison logic
  for (const parentC of parent_mandatory) {
    const childC = child_effective.find(c => c.id === parentC.id);

    if (!childC) {
      // Child dropped a mandatory constraint entirely — always a violation
      violations.push({ id: parentC.id, reason: 'mandatory_constraint_absent_in_child' });
      continue;
    }

    // Enumerated prohibitions: child.prohibited must be superset of parent.prohibited
    if (Array.isArray(parentC.prohibited) && Array.isArray(childC.prohibited)) {
      const missing = parentC.prohibited.filter(p => !childC.prohibited.includes(p));
      if (missing.length > 0) {
        violations.push({ id: parentC.id, reason: 'child_prohibited_set_missing_items', missing });
      }
    }

    // Numeric limits: child limit must be <= parent limit (more restrictive or equal)
    if (typeof parentC.max_value === 'number' && typeof childC.max_value === 'number') {
      if (childC.max_value > parentC.max_value) {
        violations.push({ id: parentC.id, reason: 'child_max_value_exceeds_parent', parent: parentC.max_value, child: childC.max_value });
      }
    }

    // Boolean flags: if parent is restrictive (true), child must also be true
    for (const key of Object.keys(parentC)) {
      if (key === 'id' || key === 'type' || key === 'prohibited' || key === 'max_value') continue;
      if (parentC[key] === true && childC[key] !== true) {
        violations.push({ id: parentC.id, reason: `boolean_flag_relaxed: ${key}`, parent: true, child: childC[key] });
      }
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

// ── LEG (Local Enforcement Gate) ──────────────────────────────────────────────

function evaluateLeg(action_proposal, effective_constraints) {
  const { type, tool_name, endpoint, file_path, function_name, recipient, content, parameters } = action_proposal;
  const violated = [];
  const checked = [];

  for (const constraint of effective_constraints) {
    switch (type) {
      case 'tool_call': {
        if (constraint.permitted_tools) {
          checked.push(`permitted_tools:${constraint.id}`);
          if (!constraint.permitted_tools.includes(tool_name)) {
            violated.push({ constraint_id: constraint.id, reason: `tool '${tool_name}' not in permitted_tools` });
          }
        }
        if (constraint.prohibited_tools) {
          checked.push(`prohibited_tools:${constraint.id}`);
          if (constraint.prohibited_tools.includes(tool_name)) {
            violated.push({ constraint_id: constraint.id, reason: `tool '${tool_name}' is in prohibited_tools` });
          }
        }
        break;
      }
      case 'api_request': {
        if (constraint.permitted_domains) {
          checked.push(`permitted_domains:${constraint.id}`);
          const allowed = constraint.permitted_domains.some(d => endpoint && endpoint.includes(d));
          if (!allowed) violated.push({ constraint_id: constraint.id, reason: `endpoint '${endpoint}' not in permitted_domains` });
        }
        if (constraint.prohibited_domains) {
          checked.push(`prohibited_domains:${constraint.id}`);
          const blocked = constraint.prohibited_domains.some(d => endpoint && endpoint.includes(d));
          if (blocked) violated.push({ constraint_id: constraint.id, reason: `endpoint '${endpoint}' matches prohibited_domains` });
        }
        break;
      }
      case 'file_write': {
        if (constraint.permitted_paths) {
          checked.push(`permitted_paths:${constraint.id}`);
          const allowed = constraint.permitted_paths.some(p => file_path && file_path.startsWith(p));
          if (!allowed) violated.push({ constraint_id: constraint.id, reason: `path '${file_path}' not in permitted_paths` });
        }
        break;
      }
      case 'function_call': {
        if (constraint.permitted_functions) {
          checked.push(`permitted_functions:${constraint.id}`);
          if (!constraint.permitted_functions.includes(function_name)) {
            violated.push({ constraint_id: constraint.id, reason: `function '${function_name}' not in permitted_functions` });
          }
        }
        break;
      }
      case 'message': {
        if (constraint.permitted_recipients) {
          checked.push(`permitted_recipients:${constraint.id}`);
          if (!constraint.permitted_recipients.includes(recipient)) {
            violated.push({ constraint_id: constraint.id, reason: `recipient '${recipient}' not in permitted_recipients` });
          }
        }
        if (constraint.prohibited_patterns && content) {
          checked.push(`prohibited_patterns:${constraint.id}`);
          for (const pattern of constraint.prohibited_patterns) {
            if (new RegExp(pattern).test(content)) {
              violated.push({ constraint_id: constraint.id, reason: `content matches prohibited pattern: ${pattern}` });
              break;
            }
          }
        }
        break;
      }
      default:
        checked.push(`unknown_type:${type}`);
    }
  }

  return {
    decision: violated.length === 0 ? 'allow' : 'block',
    violated_constraints: violated,
    constraints_checked: checked,
  };
}

// ── Routes ───────────────────────────────────────────────────────────────────

// POST /governance/create — operator creates GCR
router.post('/create', async (req, res) => {
  try {
    const { operator_agent_key, constraints, mandatory_constraints } = req.body;
    if (!operator_agent_key || !constraints || !mandatory_constraints) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    // Accept either operator key or agent key for the operator role
    const operatorId = resolveOperatorKey(operator_agent_key) || resolveKey(operator_agent_key);
    if (!operatorId) return res.status(401).json({ error: 'invalid_operator_agent_key' });

    if (!Array.isArray(mandatory_constraints) || mandatory_constraints.length === 0) {
      return res.status(400).json({ error: 'mandatory_constraints_must_be_non_empty_array' });
    }

    const mandatoryHash = computeMandatoryHash(mandatory_constraints);
    const gcrId = 'gcr_' + crypto.randomBytes(10).toString('hex');
    const now = new Date().toISOString();

    const db = getDb();
    db.prepare(
      `INSERT INTO governance_constraint_records (id, operator_agent_id, constraints_json, mandatory_constraints_hash)
       VALUES (?, ?, ?, ?)`
    ).run(gcrId, operatorId, JSON.stringify({ constraints, mandatory_constraints }), mandatoryHash);

    // HCS anchor — non-blocking
    const hcsResult = await anchorGovernance({ event: 'gcr_created', gcr_id: gcrId, mandatory_constraints_hash: mandatoryHash, ts: now });
    if (hcsResult) {
      db.prepare('UPDATE governance_constraint_records SET hcs_topic = ?, hcs_sequence_number = ? WHERE id = ?')
        .run(_governanceTopic, parseInt(hcsResult.sequenceNumber, 10), gcrId);
    }

    res.json({ gcr_id: gcrId, mandatory_constraints_hash: mandatoryHash, hcs_sequence_number: hcsResult ? hcsResult.sequenceNumber : null });
  } catch (err) {
    console.error('[governance/create]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /governance/spawn — spawning agent creates GIB for spawned agent
router.post('/spawn', async (req, res) => {
  try {
    const { spawning_agent_key, spawned_agent_id, gcr_id, parent_gib_id, effective_constraints } = req.body;
    if (!spawning_agent_key || !spawned_agent_id || !gcr_id || !effective_constraints) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const spawningAgentId = resolveKey(spawning_agent_key);
    if (!spawningAgentId) return res.status(401).json({ error: 'invalid_spawning_agent_key' });

    const db = getDb();
    const spawned = db.prepare('SELECT agent_id FROM agents WHERE agent_id = ?').get(spawned_agent_id);
    if (!spawned) return res.status(404).json({ error: 'spawned_agent_not_found' });

    const rootGcr = db.prepare('SELECT * FROM governance_constraint_records WHERE id = ?').get(gcr_id);
    if (!rootGcr) return res.status(404).json({ error: 'gcr_not_found' });

    // Enforce mandatory_constraints_hash invariant
    const rootConstraints = JSON.parse(rootGcr.constraints_json);
    const expectedHash = rootGcr.mandatory_constraints_hash;

    // Compute hash from the effective_constraints that are mandatory (must match root)
    const effectiveMandatoryIds = new Set(rootConstraints.mandatory_constraints.map(c => c.id));
    const effectiveMandatory = (effective_constraints || []).filter(c => effectiveMandatoryIds.has(c.id));
    const effectiveMandatoryHash = computeMandatoryHash(effectiveMandatory.length > 0 ? effectiveMandatory : rootConstraints.mandatory_constraints);

    const driftDetected = effectiveMandatoryHash !== expectedHash ? 1 : 0;

    // Upward Escalation Prohibition: effective_constraints cannot be less restrictive than root mandatory
    const escalationCheck = validateUpwardEscalation(rootConstraints.mandatory_constraints, effective_constraints);
    if (!escalationCheck.ok) {
      return res.status(409).json({ error: 'upward_escalation_prohibition_violated', violations: escalationCheck.violations });
    }

    const gibId = 'gib_' + crypto.randomBytes(10).toString('hex');
    const now = new Date().toISOString();

    // HCS anchor MUST succeed before agent acts
    const hcsResult = await anchorGovernance({ event: 'gib_created', gib_id: gibId, gcr_id, spawning_agent: spawningAgentId, spawned_agent: spawned_agent_id, mandatory_constraints_hash: expectedHash, ts: now });
    if (!hcsResult) {
      return res.status(503).json({ error: 'hcs_anchor_required_before_agent_acts', detail: 'HCS anchor failed — spawned agent must not act until anchor is confirmed' });
    }

    db.prepare(
      `INSERT INTO governance_inheritance_bindings
         (id, gcr_id, parent_gib_id, spawning_agent_id, spawned_agent_id, effective_constraints_json, mandatory_constraints_hash, hcs_sequence_number, drift_detected)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(gibId, gcr_id, parent_gib_id || null, spawningAgentId, spawned_agent_id, JSON.stringify(effective_constraints), expectedHash, parseInt(hcsResult.sequenceNumber, 10), driftDetected);

    res.json({ gib_id: gibId, mandatory_constraints_hash: expectedHash, drift_detected: driftDetected === 1, hcs_sequence_number: hcsResult.sequenceNumber });
  } catch (err) {
    console.error('[governance/spawn]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /governance/evaluate — LEG: evaluate action before it executes
router.post('/evaluate', async (req, res) => {
  try {
    const { agent_key, gib_id, action_proposal } = req.body;
    if (!agent_key || !gib_id || !action_proposal) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const agentId = resolveKey(agent_key);
    if (!agentId) return res.status(401).json({ error: 'invalid_agent_key' });

    const db = getDb();
    const gib = db.prepare('SELECT * FROM governance_inheritance_bindings WHERE id = ?').get(gib_id);
    if (!gib) return res.status(404).json({ error: 'gib_not_found' });
    if (gib.spawned_agent_id !== agentId) return res.status(403).json({ error: 'agent_not_governed_by_this_gib' });

    const effectiveConstraints = JSON.parse(gib.effective_constraints_json);
    const legResult = evaluateLeg(action_proposal, effectiveConstraints);

    if (legResult.decision === 'block') {
      const gveId = 'gve_' + crypto.randomBytes(8).toString('hex');
      db.prepare(
        `INSERT INTO governance_violation_events (id, gib_id, agent_id, action_type, action_proposal_json, violated_constraints)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(gveId, gib_id, agentId, action_proposal.type || 'unknown', JSON.stringify(action_proposal), JSON.stringify(legResult.violated_constraints));

      // Anchor GVE to HCS asynchronously — non-blocking on response
      anchorGovernance({ event: 'leg_block', gve_id: gveId, gib_id, agent_id: agentId, action_type: action_proposal.type, ts: new Date().toISOString() }).catch(() => {});

      return res.json({ decision: 'block', violated_constraints: legResult.violated_constraints, gve_id: gveId, constraints_checked: legResult.constraints_checked });
    }

    res.json({ decision: 'allow', constraints_checked: legResult.constraints_checked });
  } catch (err) {
    console.error('[governance/evaluate]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// POST /governance/attest — compliance window summary
router.post('/attest', async (req, res) => {
  try {
    const { agent_key, gib_id, window_start, window_end } = req.body;
    if (!agent_key || !gib_id || !window_start || !window_end) {
      return res.status(400).json({ error: 'missing_required_fields' });
    }

    const agentId = resolveKey(agent_key);
    if (!agentId) return res.status(401).json({ error: 'invalid_agent_key' });

    const db = getDb();
    const gib = db.prepare('SELECT * FROM governance_inheritance_bindings WHERE id = ?').get(gib_id);
    if (!gib) return res.status(404).json({ error: 'gib_not_found' });

    // Count evaluate calls in window (infer from GVE records + estimate allows)
    const violations = db.prepare(
      `SELECT COUNT(*) as n FROM governance_violation_events WHERE gib_id = ? AND agent_id = ? AND timestamp >= ? AND timestamp <= ?`
    ).get(gib_id, agentId, window_start, window_end).n;

    // Total evaluated: use GVE violations as the floor; in production agents should report total
    const totalEvaluated = parseInt(req.body.total_actions_evaluated || violations, 10) || violations;
    const complianceRate = totalEvaluated > 0 ? parseFloat(((totalEvaluated - violations) / totalEvaluated).toFixed(4)) : 1.0;

    // Verify mandatory_constraints_hash against root GCR
    const rootGcr = db.prepare('SELECT mandatory_constraints_hash FROM governance_constraint_records WHERE id = ?').get(gib.gcr_id);
    const hashVerified = rootGcr && gib.mandatory_constraints_hash === rootGcr.mandatory_constraints_hash ? 1 : 0;

    // AATS trust score at attestation time
    let aatsTrustScore = null;
    try {
      const scoreResult = computeTrustScore(agentId);
      aatsTrustScore = scoreResult ? scoreResult.score : null;
    } catch { /* non-blocking */ }

    const attestId = 'gattest_' + crypto.randomBytes(8).toString('hex');
    db.prepare(
      `INSERT INTO governance_attestations
         (id, gib_id, agent_id, window_start, window_end, total_actions_evaluated, violations_count, compliance_rate, mandatory_constraints_hash, hash_verified, aats_trust_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(attestId, gib_id, agentId, window_start, window_end, totalEvaluated, violations, complianceRate, gib.mandatory_constraints_hash, hashVerified, aatsTrustScore);

    const hcsResult = await anchorGovernance({
      event: 'governance_attestation',
      attestation_id: attestId,
      gib_id,
      agent_id: agentId,
      compliance_rate: complianceRate,
      violations_count: violations,
      mandatory_constraints_hash: gib.mandatory_constraints_hash,
      hash_verified: hashVerified === 1,
      ts: new Date().toISOString(),
    });

    if (hcsResult) {
      db.prepare('UPDATE governance_attestations SET hcs_sequence_number = ? WHERE id = ?')
        .run(parseInt(hcsResult.sequenceNumber, 10), attestId);
    }

    res.json({ attestation_id: attestId, compliance_rate: complianceRate, violations_count: violations, hash_verified: hashVerified === 1, aats_trust_score: aatsTrustScore, hcs_sequence_number: hcsResult ? hcsResult.sequenceNumber : null });
  } catch (err) {
    console.error('[governance/attest]', err);
    res.status(500).json({ error: 'internal_error', detail: err.message });
  }
});

// GET /governance/drift-check/:gib_id
router.get('/drift-check/:gib_id', (req, res) => {
  try {
    const db = getDb();
    const gib = db.prepare('SELECT * FROM governance_inheritance_bindings WHERE id = ?').get(req.params.gib_id);
    if (!gib) return res.status(404).json({ error: 'gib_not_found' });

    // Trace chain to root GCR
    const rootGcr = db.prepare('SELECT mandatory_constraints_hash FROM governance_constraint_records WHERE id = ?').get(gib.gcr_id);
    if (!rootGcr) return res.status(404).json({ error: 'root_gcr_not_found' });

    // Count depth by walking parent_gib_id chain
    let depth = 1;
    let cursor = gib;
    while (cursor.parent_gib_id) {
      const parent = db.prepare('SELECT * FROM governance_inheritance_bindings WHERE id = ?').get(cursor.parent_gib_id);
      if (!parent) break;
      cursor = parent;
      depth++;
    }

    const driftDetected = gib.mandatory_constraints_hash !== rootGcr.mandatory_constraints_hash;
    res.json({ drift_detected: driftDetected, gib_hash: gib.mandatory_constraints_hash, root_hash: rootGcr.mandatory_constraints_hash, depth });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /governance/agent/:agent_id
router.get('/agent/:agent_id', (req, res) => {
  try {
    const db = getDb();
    const gibs = db.prepare('SELECT * FROM governance_inheritance_bindings WHERE spawned_agent_id = ? ORDER BY created_at DESC LIMIT 10').all(req.params.agent_id);
    const recentViolations = db.prepare('SELECT * FROM governance_violation_events WHERE agent_id = ? ORDER BY timestamp DESC LIMIT 20').all(req.params.agent_id);
    const latestAttestation = db.prepare('SELECT * FROM governance_attestations WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1').get(req.params.agent_id);
    res.json({ agent_id: req.params.agent_id, active_gibs: gibs, recent_violations: recentViolations, latest_attestation: latestAttestation || null });
  } catch (err) {
    res.status(500).json({ error: 'internal_error' });
  }
});

// GET /governance/stats
router.get('/stats', (req, res) => {
  try {
    const db = getDb();
    const gcrs = db.prepare('SELECT COUNT(*) as n FROM governance_constraint_records').get().n;
    const gibs = db.prepare('SELECT COUNT(*) as n FROM governance_inheritance_bindings').get().n;
    const driftCount = db.prepare('SELECT COUNT(*) as n FROM governance_inheritance_bindings WHERE drift_detected = 1').get().n;
    const violations = db.prepare('SELECT COUNT(*) as n FROM governance_violation_events').get().n;
    const attestations = db.prepare('SELECT COUNT(*) as n FROM governance_attestations').get().n;
    const avgCompliance = (() => {
      const row = db.prepare('SELECT AVG(compliance_rate) as avg FROM governance_attestations').get();
      return row && row.avg != null ? parseFloat(row.avg.toFixed(4)) : null;
    })();
    res.json({ total_gcrs: gcrs, total_gibs: gibs, drift_detected: driftCount, total_violations: violations, total_attestations: attestations, avg_compliance_rate: avgCompliance });
  } catch (err) {
    res.status(500).json({ error: 'stats_unavailable' });
  }
});

module.exports = { router };
