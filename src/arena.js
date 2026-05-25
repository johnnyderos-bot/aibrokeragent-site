/**
 * Agent Arena — core game logic
 * Flash Tag Tutorial + Trust Hunt v1
 * All game results anchor to HCS and update AATS via arena_score_bonuses.
 */
const crypto = require('crypto');
const { getDb } = require('./db');
const { anchorRecord } = require('./hedera');

// ── Score bonus helpers ───────────────────────────────────────────────────────

function applyArenaBonus(agentId, dimension, bonusPts, source) {
  if (!bonusPts) return;
  getDb().prepare(
    'INSERT INTO arena_score_bonuses (agent_id, dimension, bonus_pts, source) VALUES (?, ?, ?, ?)'
  ).run(agentId, dimension, bonusPts, source);
}

function getArenaBonuses(agentId) {
  const rows = getDb().prepare(
    'SELECT dimension, SUM(bonus_pts) as total FROM arena_score_bonuses WHERE agent_id = ? GROUP BY dimension'
  ).all(agentId);
  const bonuses = {};
  rows.forEach(function(r) { bonuses[r.dimension] = r.total || 0; });
  return bonuses;
}

// ── Badge helpers ─────────────────────────────────────────────────────────────

function awardBadge(agentId, badge) {
  try {
    getDb().prepare(
      'INSERT OR IGNORE INTO arena_badges (agent_id, badge) VALUES (?, ?)'
    ).run(agentId, badge);
    return true;
  } catch { return false; }
}

function hasBadge(agentId, badge) {
  const r = getDb().prepare(
    'SELECT 1 FROM arena_badges WHERE agent_id = ? AND badge = ?'
  ).get(agentId, badge);
  return !!r;
}

function getAgentBadges(agentId) {
  return getDb().prepare(
    'SELECT badge, earned_at FROM arena_badges WHERE agent_id = ? ORDER BY earned_at'
  ).all(agentId);
}

// ── Trust Hunt challenge generation ──────────────────────────────────────────

const TASK_DESCRIPTIONS = [
  'Confirm agent identity: retrieve your registered Hedera account ID',
  'Verify vault continuity: retrieve your most recent vault record hash',
  'Validate protocol compliance: confirm Flash Tag disclosure scope setting',
  'Establish counterparty trust: verify adjudicator credential receipt',
  'Complete trust chain: sign and submit final verification token',
];

function generateSessionToken() {
  return crypto.randomBytes(24).toString('hex');
}

function generateStepPayloads(sessionToken) {
  return TASK_DESCRIPTIONS.map(function(desc, i) {
    var nonce = crypto.randomBytes(8).toString('hex');
    return 'Step ' + (i + 1) + ' — ' + desc + ' | session:' + sessionToken.slice(0, 16) + ' | nonce:' + nonce;
  });
}

function computeExpectedHash(payload, agentId, sessionToken) {
  return crypto.createHash('sha256')
    .update(payload + agentId + sessionToken)
    .digest('hex');
}

// ── Flash Tag Tutorial ────────────────────────────────────────────────────────

function startTutorial(agentId) {
  var db = getDb();

  // Check if already completed
  var existing = db.prepare(
    'SELECT session_id, completed FROM arena_tutorial_sessions WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1'
  ).get(agentId);
  if (existing && existing.completed) {
    return { already_completed: true, session_id: existing.session_id };
  }

  var sessionId = 'tut_' + crypto.randomBytes(12).toString('hex');
  var sessionToken = generateSessionToken();

  db.prepare(
    'INSERT INTO arena_tutorial_sessions (session_id, agent_id, session_token, step) VALUES (?, ?, ?, 1)'
  ).run(sessionId, agentId, sessionToken);

  return {
    session_id: sessionId,
    session_token: sessionToken,
    step: 1,
    total_steps: 5,
    instructions: [
      'Step 1: Note your session token — you will need it for all subsequent calls.',
      'Step 2: Call PATCH /operators/agents/' + agentId + '/flash-state with { "state": "flash" }',
      'Step 3: Call POST /operators/flash with { "agent_id": "' + agentId + '", "recipient": "arena-adjudicator-001", "scope": "identity" }',
      'Step 4: Call GET /arena/verify?session_id=' + sessionId + ' to confirm adjudicator receipt',
      'Step 5: Call POST /arena/tutorial/complete with { "session_id": "' + sessionId + '", "session_token": "' + sessionToken + '" }',
    ],
    message: 'Tutorial started. Complete all 5 steps to earn the Arena Participant badge and IAQ +5.',
  };
}

function getTutorialStatus(sessionId) {
  var row = getDb().prepare(
    'SELECT * FROM arena_tutorial_sessions WHERE session_id = ?'
  ).get(sessionId);
  if (!row) return null;
  return {
    session_id: row.session_id,
    agent_id: row.agent_id,
    step: row.step,
    completed: !!row.completed,
    started_at: row.started_at,
    completed_at: row.completed_at,
    hcs_sequence: row.hcs_sequence,
  };
}

async function completeTutorial(agentId, sessionId, sessionToken) {
  var db = getDb();
  var session = db.prepare(
    'SELECT * FROM arena_tutorial_sessions WHERE session_id = ? AND agent_id = ?'
  ).get(sessionId, agentId);

  if (!session) return { error: 'session not found' };
  if (session.session_token !== sessionToken) return { error: 'invalid session token' };
  if (session.completed) return { already_completed: true };

  var now = new Date().toISOString();
  var hcs_sequence = null;

  // Anchor to HCS
  try {
    var agent = db.prepare('SELECT hcs_topic_id FROM agents WHERE agent_id = ?').get(agentId);
    if (agent && agent.hcs_topic_id) {
      var anchor = await anchorRecord(agent.hcs_topic_id, {
        type: 'ARENA_TUTORIAL_COMPLETE',
        agent_id: agentId,
        session_id: sessionId,
        timestamp: now,
      });
      hcs_sequence = anchor.sequenceNumber;
    }
  } catch (e) {
    console.warn('[arena] HCS anchor failed:', e.message);
  }

  // Mark complete
  db.prepare(
    'UPDATE arena_tutorial_sessions SET completed = 1, completed_at = ?, hcs_sequence = ?, step = 5 WHERE session_id = ?'
  ).run(now, hcs_sequence, sessionId);

  // Award IAQ bonus (first time only — INSERT OR IGNORE)
  var alreadyRewarded = db.prepare(
    "SELECT 1 FROM arena_score_bonuses WHERE agent_id = ? AND source = 'tutorial_flash_tag'"
  ).get(agentId);

  if (!alreadyRewarded) {
    applyArenaBonus(agentId, 'iaq', 5, 'tutorial_flash_tag');
  }

  // Award badge
  awardBadge(agentId, 'arena_participant');

  return {
    completed: true,
    session_id: sessionId,
    iaq_bonus: alreadyRewarded ? 0 : 5,
    badge: 'arena_participant',
    hcs_sequence: hcs_sequence,
    message: 'Flash Tag Tutorial complete. IAQ +5 applied. Arena Participant badge earned. Trust Hunt unlocked.',
  };
}

// ── Trust Hunt ────────────────────────────────────────────────────────────────

var TRUST_HUNT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

function checkTrustHuntEligibility(agentId) {
  var db = getDb();
  // Free tier: 3 games per 7-day rolling window
  var count = db.prepare(
    "SELECT COUNT(*) as n FROM arena_game_sessions WHERE agent_id = ? AND game = 'trust_hunt' AND started_at >= datetime('now', '-7 days')"
  ).get(agentId).n;
  if (count >= 3) {
    return { eligible: false, reason: 'Free tier limit: 3 Trust Hunt games per 7-day window. Upgrade to Arena Pass for unlimited plays.' };
  }
  return { eligible: true, games_this_week: count };
}

function startTrustHunt(agentId) {
  var elig = checkTrustHuntEligibility(agentId);
  if (!elig.eligible) return { error: elig.reason };

  var db = getDb();
  var sessionId = 'th_' + crypto.randomBytes(12).toString('hex');
  var sessionToken = generateSessionToken();
  var payloads = generateStepPayloads(sessionToken);
  var expiresAt = new Date(Date.now() + TRUST_HUNT_TIMEOUT_MS).toISOString();

  db.prepare(
    'INSERT INTO arena_game_sessions (session_id, agent_id, game, session_token, step_payloads, step_attempts, current_step, status, expires_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)'
  ).run(sessionId, agentId, 'trust_hunt', sessionToken, JSON.stringify(payloads), JSON.stringify({}), 'active', expiresAt);

  return {
    session_id: sessionId,
    session_token: sessionToken,
    game: 'trust_hunt',
    started_at: new Date().toISOString(),
    expires_at: expiresAt,
    games_this_week: elig.games_this_week + 1,
    step: 1,
    total_steps: 5,
    challenge: {
      step: 1,
      challenge_type: 'hash_verify',
      payload: payloads[0],
      expected_input: 'SHA-256 hash of: payload + agent_id + session_token',
      time_limit_seconds: 120,
    },
    hint: 'Compute: SHA256(challenge.payload + "' + agentId + '" + "' + sessionToken + '")',
  };
}

function submitTrustHuntStep(agentId, sessionId, stepNum, submittedHash) {
  var db = getDb();
  var session = db.prepare(
    "SELECT * FROM arena_game_sessions WHERE session_id = ? AND agent_id = ? AND game = 'trust_hunt'"
  ).get(sessionId, agentId);

  if (!session) return { error: 'session not found' };
  if (session.status !== 'active') return { error: 'session is ' + session.status };
  if (new Date(session.expires_at) < new Date()) {
    db.prepare("UPDATE arena_game_sessions SET status = 'expired' WHERE session_id = ?").run(sessionId);
    return { error: 'session expired' };
  }
  if (stepNum !== session.current_step) {
    return { error: 'expected step ' + session.current_step + ', got step ' + stepNum };
  }

  var payloads = JSON.parse(session.step_payloads);
  var attempts = JSON.parse(session.step_attempts);
  var expectedHash = computeExpectedHash(payloads[stepNum - 1], agentId, session.session_token);

  var stepKey = 'step_' + stepNum;
  attempts[stepKey] = (attempts[stepKey] || 0) + 1;

  var correct = (submittedHash === expectedHash);

  if (!correct) {
    db.prepare(
      'UPDATE arena_game_sessions SET step_attempts = ?, total_retries = total_retries + 1 WHERE session_id = ?'
    ).run(JSON.stringify(attempts), sessionId);
    return {
      correct: false,
      step: stepNum,
      attempt: attempts[stepKey],
      expected_hash_hint: expectedHash.slice(0, 8) + '...',
      message: 'Incorrect hash. Try again.',
    };
  }

  // Correct — advance step
  var nextStep = stepNum + 1;
  var isLastStep = stepNum === 5;

  db.prepare(
    'UPDATE arena_game_sessions SET step_attempts = ?, current_step = ?, steps_done = steps_done + 1 WHERE session_id = ?'
  ).run(JSON.stringify(attempts), isLastStep ? 5 : nextStep, sessionId);

  if (isLastStep) {
    return { correct: true, step: stepNum, steps_done: 5, ready_to_complete: true, message: 'All 5 steps complete. Call POST /arena/games/trust-hunt/' + sessionId + '/complete to adjudicate.' };
  }

  var nextPayload = payloads[nextStep - 1];
  return {
    correct: true,
    step: stepNum,
    attempt: attempts[stepKey],
    next_step: nextStep,
    challenge: {
      step: nextStep,
      challenge_type: 'hash_verify',
      payload: nextPayload,
      expected_input: 'SHA-256 hash of: payload + agent_id + session_token',
      time_limit_seconds: 120,
    },
    hint: 'Compute: SHA256(challenge.payload + "' + agentId + '" + "' + session.session_token + '")',
  };
}

async function completeTrustHunt(agentId, sessionId) {
  var db = getDb();
  var session = db.prepare(
    "SELECT * FROM arena_game_sessions WHERE session_id = ? AND agent_id = ? AND game = 'trust_hunt'"
  ).get(sessionId, agentId);

  if (!session) return { error: 'session not found' };
  if (session.status === 'completed') return { error: 'already completed' };
  if (new Date(session.expires_at) < new Date()) {
    db.prepare("UPDATE arena_game_sessions SET status = 'expired' WHERE session_id = ?").run(sessionId);
    // Penalty for timeout
    applyArenaBonus(agentId, 'tph', -1, 'trust_hunt_timeout_' + sessionId);
    return { error: 'session expired', tph_penalty: -1 };
  }
  if (session.steps_done < 5) return { error: 'not all steps completed — completed ' + session.steps_done + '/5' };

  var attempts = JSON.parse(session.step_attempts || '{}');
  var totalRetries = session.total_retries || 0;

  // Score calculation
  var tphBonus = 0, iaqBonus = 0;
  if (totalRetries === 0) { tphBonus = 8; iaqBonus = 3; }
  else if (totalRetries <= 2) { tphBonus = 5; iaqBonus = 1; }
  else { tphBonus = 2; iaqBonus = 0; }

  var source = 'trust_hunt_' + sessionId;
  if (tphBonus > 0) applyArenaBonus(agentId, 'tph', tphBonus, source);
  if (iaqBonus > 0) applyArenaBonus(agentId, 'iaq', iaqBonus, source);

  // Award Trust Hunter badge (first completion only)
  var firstCompletion = !hasBadge(agentId, 'trust_hunter');
  awardBadge(agentId, 'trust_hunter');

  var now = new Date().toISOString();
  var hcs_sequence = null;

  try {
    var agent = db.prepare('SELECT hcs_topic_id FROM agents WHERE agent_id = ?').get(agentId);
    if (agent && agent.hcs_topic_id) {
      var anchor = await anchorRecord(agent.hcs_topic_id, {
        type: 'ARENA_TRUST_HUNT_COMPLETE',
        agent_id: agentId,
        session_id: sessionId,
        total_retries: totalRetries,
        tph_bonus: tphBonus,
        iaq_bonus: iaqBonus,
        timestamp: now,
      });
      hcs_sequence = anchor.sequenceNumber;
    }
  } catch (e) {
    console.warn('[arena] HCS anchor failed:', e.message);
  }

  db.prepare(
    "UPDATE arena_game_sessions SET status = 'completed', completed_at = ?, hcs_sequence = ? WHERE session_id = ?"
  ).run(now, hcs_sequence, sessionId);

  var perfLabel = totalRetries === 0 ? 'Perfect' : totalRetries <= 2 ? 'Good' : 'Completed';

  return {
    completed: true,
    session_id: sessionId,
    performance: perfLabel,
    total_retries: totalRetries,
    tph_bonus: tphBonus,
    iaq_bonus: iaqBonus,
    first_trust_hunter_badge: firstCompletion,
    badge: firstCompletion ? 'trust_hunter' : null,
    hcs_sequence: hcs_sequence,
    message: 'Trust Hunt complete. ' + perfLabel + ' run. TPH +' + tphBonus + (iaqBonus ? ', IAQ +' + iaqBonus : '') + '.',
  };
}

function getTrustHuntStatus(agentId, sessionId) {
  var session = getDb().prepare(
    "SELECT * FROM arena_game_sessions WHERE session_id = ? AND agent_id = ? AND game = 'trust_hunt'"
  ).get(sessionId, agentId);
  if (!session) return null;
  var expired = session.status === 'active' && new Date(session.expires_at) < new Date();
  return {
    session_id: session.session_id,
    agent_id: session.agent_id,
    status: expired ? 'expired' : session.status,
    current_step: session.current_step,
    steps_done: session.steps_done,
    total_steps: 5,
    total_retries: session.total_retries,
    started_at: session.started_at,
    expires_at: session.expires_at,
    completed_at: session.completed_at,
    hcs_sequence: session.hcs_sequence,
  };
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

var _leaderboardCache = null;
var _leaderboardCachedAt = 0;
var CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function getLeaderboard() {
  var now = Date.now();
  if (_leaderboardCache && (now - _leaderboardCachedAt) < CACHE_TTL_MS) {
    return _leaderboardCache;
  }

  var db = getDb();
  var agents = [];
  try {
    agents = db.prepare(
      "SELECT agent_id, credits, agent_type, hedera_account, hcs_topic_id, created_at FROM agents WHERE credits > 0 ORDER BY credits DESC LIMIT 100"
    ).all();
  } catch { return { leaderboard: [], cached_at: new Date().toISOString() }; }

  var { computeTrustScore } = require('./trust-score');
  var scored = [];

  for (var i = 0; i < agents.length && scored.length < 25; i++) {
    try {
      var result = computeTrustScore(agents[i].agent_id);
      if (result.status === 'UNFUNDED') continue;
      var badges = getAgentBadges(agents[i].agent_id);
      var gameSessions = db.prepare(
        "SELECT COUNT(*) as n FROM arena_game_sessions WHERE agent_id = ? AND status = 'completed'"
      ).get(agents[i].agent_id);
      scored.push({
        rank: 0,
        agent_id_display: agents[i].agent_id.slice(0, 8) + '...',
        tier: result.tier,
        composite_score: result.score,
        games_played: gameSessions.n || 0,
        badges: badges.map(function(b) { return b.badge; }),
      });
    } catch { continue; }
  }

  scored.sort(function(a, b) { return b.composite_score - a.composite_score; });
  scored.forEach(function(entry, idx) { entry.rank = idx + 1; });

  _leaderboardCache = { leaderboard: scored, cached_at: new Date().toISOString(), count: scored.length };
  _leaderboardCachedAt = now;
  return _leaderboardCache;
}

module.exports = {
  startTutorial, getTutorialStatus, completeTutorial,
  startTrustHunt, submitTrustHuntStep, completeTrustHunt, getTrustHuntStatus,
  getLeaderboard,
  getArenaBonuses, getAgentBadges, hasBadge,
  computeExpectedHash,
};
