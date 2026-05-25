'use strict';
/**
 * AICP Universal Trust Gate API
 *
 * AICP (AI Commerce Protocol) evaluates agent and tool provider trust
 * across ALL major agent communication protocols:
 *   - x402 (HTTP-native stablecoin payments) — handled in idle-marketplace-api.js
 *   - A2A (Google Agent-to-Agent Protocol) — this module
 *   - MCP (Model Context Protocol) — this module
 *   - AICP Native (Smart contract escrow) — contract-audit-api.js
 *
 * Routes:
 *   POST /api/aicp/a2a/evaluate        — A2A trust gate before task delegation
 *   GET  /api/agents/:agentId/a2a-card — A2A-compatible agent card with AATS data
 *   POST /api/aicp/mcp/verify          — MCP tool provider trust verification
 *   POST /api/mcp/servers/register     — MCP server registration on the platform
 *   GET  /api/mcp/servers              — List registered MCP servers
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { getDb } = require('./db');
const { computeTrustScore, getTier } = require('./trust-score');

const MIN_A2A_SCORE = 30;     // Bronze floor for A2A delegation acceptance
const MIN_MCP_SCORE = 20;     // Slightly lower for tool providers (less autonomous risk)
const PLATFORM_URL = 'https://ai-broker-agent.com';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tierRank(tier) {
  return { Restricted: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4 }[tier] ?? 0;
}

function logEvaluation(protocol, delegatingAgent, targetAgent, result, passed, score, tier) {
  try {
    const db = getDb();
    const id = 'aicpe_' + crypto.randomBytes(8).toString('hex');
    db.prepare(`
      INSERT INTO aicp_evaluations (id, protocol, delegating_agent, target_agent, evaluation_result, trust_passed, score_at_eval, tier_at_eval, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, protocol, delegatingAgent || null, targetAgent || null, JSON.stringify(result), passed ? 1 : 0, score || null, tier || null, new Date().toISOString());
  } catch (err) {
    console.error('[aicp] evaluation log error:', err.message);
  }
}

// ── A2A Trust Gate ────────────────────────────────────────────────────────────

/**
 * POST /api/aicp/a2a/evaluate
 *
 * Accepts an A2A task delegation payload and evaluates the delegating agent's
 * trust before the task is accepted. Returns accept/reject with full trust report.
 *
 * A2A task format (JSON-RPC 2.0 over HTTP):
 *   { jsonrpc: "2.0", method: "tasks/send", params: { id, message, agentCard? } }
 *
 * AICP trust gate extracts the delegating agent from:
 *   1. params.agentCard.agent_id or params.agentCard.url (if provided)
 *   2. headers: X-Delegating-Agent-Id
 *   3. body: delegating_agent_id (direct field for simplified callers)
 */
router.post('/aicp/a2a/evaluate', async (req, res) => {
  const body = req.body || {};

  // Extract delegating agent identity — support multiple A2A payload shapes
  let delegatingAgentId =
    body.delegating_agent_id ||
    req.headers['x-delegating-agent-id'] ||
    body?.params?.agentCard?.agent_id ||
    null;

  // Support full A2A JSON-RPC envelope
  const a2aParams = body.params || {};
  const taskId = a2aParams.id || body.task_id || ('a2a_task_' + crypto.randomBytes(6).toString('hex'));
  const message = a2aParams.message || body.message || null;
  const agentCard = a2aParams.agentCard || body.agent_card || null;

  // Extract agent_id from agent card if not directly provided
  if (!delegatingAgentId && agentCard) {
    delegatingAgentId = agentCard.agent_id || agentCard.id || null;
    // Try to match by URL if they've registered with a URL
    if (!delegatingAgentId && agentCard.url) {
      try {
        const row = getDb().prepare("SELECT agent_id FROM agents WHERE name LIKE ? LIMIT 1")
          .get(`%${new URL(agentCard.url).hostname}%`);
        if (row) delegatingAgentId = row.agent_id;
      } catch {}
    }
  }

  if (!delegatingAgentId) {
    return res.status(400).json({
      error: 'Cannot evaluate trust: delegating agent identity not found in request',
      detail: 'Provide delegating_agent_id in body, X-Delegating-Agent-Id header, or include agentCard with agent_id in A2A params',
      a2a_task_id: taskId,
    });
  }

  // AATS trust evaluation
  let trustScore;
  try {
    trustScore = computeTrustScore(delegatingAgentId);
  } catch (err) {
    const result = {
      aicp_decision: 'REJECT',
      reason: 'Delegating agent not registered on AATS platform',
      delegating_agent_id: delegatingAgentId,
      a2a_task_id: taskId,
      aats: null,
      register_at: `${PLATFORM_URL}/beta`,
    };
    logEvaluation('a2a', delegatingAgentId, null, result, false, null, null);
    return res.status(403).json(result);
  }

  const score = trustScore.score;
  const tier = trustScore.tier;
  const fraudFlag = trustScore.flags?.fraud_flag;

  // Flash Rule Engine — A2A delegation gates
  const flashEval = {
    score_gate: score >= MIN_A2A_SCORE,
    tier_gate: tierRank(tier) >= 1,   // Bronze minimum
    fraud_gate: !fraudFlag,
    unfunded_gate: tier !== 'UNFUNDED',
  };
  const passed = Object.values(flashEval).every(Boolean);

  const result = {
    aicp_decision: passed ? 'ACCEPT' : 'REJECT',
    a2a_task_id: taskId,
    protocol: 'A2A',
    delegating_agent_id: delegatingAgentId,
    aats: {
      score,
      tier,
      dimensions: trustScore.dimensions,
    },
    flash_evaluation: flashEval,
    ...(passed ? {
      message: 'A2A task delegation accepted. Delegating agent meets AATS trust threshold.',
      acp_anchor: 'pending',
    } : {
      message: 'A2A task delegation rejected. Delegating agent does not meet AATS trust threshold.',
      minimum_required: { score: MIN_A2A_SCORE, tier: 'Bronze' },
      improve_at: `${PLATFORM_URL}/arena`,
    }),
    evaluated_at: new Date().toISOString(),
  };

  logEvaluation('a2a', delegatingAgentId, null, result, passed, score, tier);

  // If accepted: create vault record as ACP anchor (TPH signal)
  if (passed) {
    try {
      const db = getDb();
      db.prepare(`
        INSERT INTO vault_records (agent_id, label, encrypted_content, iv, tag, content_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        delegatingAgentId,
        `[aicp:a2a] task delegation accepted: ${taskId}`,
        JSON.stringify({ protocol: 'A2A', task_id: taskId, result: 'accepted', flash_eval: flashEval }),
        'aicp-a2a', 'aicp-tag',
        crypto.createHash('sha256').update(taskId + delegatingAgentId).digest('hex'),
        new Date().toISOString(),
      );
    } catch {}
  }

  res.status(passed ? 200 : 403).json(result);
});

// ── A2A Agent Card ────────────────────────────────────────────────────────────

/**
 * GET /api/agents/:agentId/a2a-card
 *
 * Returns a valid A2A-compatible agent card for any registered AATS agent.
 * Embeds AATS trust score and Flash Tag status in the agent card extensions.
 *
 * Agent card format follows the Google A2A specification:
 *   https://google.github.io/A2A/
 */
router.get('/agents/:agentId/a2a-card', (req, res) => {
  const { agentId } = req.params;

  const db = getDb();
  let agent;
  try {
    agent = db.prepare('SELECT agent_id, name, agent_type, hedera_account, created_at FROM agents WHERE agent_id = ?').get(agentId);
  } catch {}

  if (!agent) {
    return res.status(404).json({ error: 'agent not found', agent_id: agentId });
  }

  let trustScore;
  try {
    trustScore = computeTrustScore(agentId);
  } catch {
    trustScore = null;
  }

  // Get Flash Tag state
  let flashState = null;
  try {
    flashState = db.prepare("SELECT flash_state FROM agents WHERE agent_id = ?").get(agentId);
  } catch {}

  // A2A-compatible agent card with AATS trust extensions
  const agentCard = {
    // Core A2A agent card fields
    name: agent.name,
    description: `AI agent registered on AIbrokerAGEnt trust platform. Type: ${agent.agent_type || 'general'}.`,
    url: `${PLATFORM_URL}/api/agents/${agentId}/a2a-card`,
    iconUrl: `${PLATFORM_URL}/favicon.ico`,
    version: '1.0.0',
    documentationUrl: `${PLATFORM_URL}/platform.html`,

    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: true,
    },

    authentication: {
      schemes: ['apiKey'],
      credentials: null,
    },

    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],

    skills: [
      {
        id: `${agentId}-task`,
        name: `${agent.name} Task Execution`,
        description: `Delegated task execution by ${agent.name} — AATS-verified agent`,
        tags: ['aats-verified', agent.agent_type || 'general', 'aibrokeragent'],
        inputModes: ['application/json'],
        outputModes: ['application/json'],
      },
    ],

    // AATS trust extensions (non-standard A2A fields — forward-compatible)
    x_aats: trustScore ? {
      score: trustScore.score,
      tier: trustScore.tier,
      agent_id: agentId,
      platform: PLATFORM_URL,
      verify_at: `${PLATFORM_URL}/api/v1/trust-score/${agentId}`,
      dimensions: trustScore.dimensions,
      registered_at: agent.created_at,
      hedera_account: agent.hedera_account || null,
    } : {
      score: null,
      tier: 'UNSCORED',
      platform: PLATFORM_URL,
    },

    x_flash_tag: {
      protocol: 'Flash Tag v1.0',
      flash_state: flashState?.flash_state || 'unknown',
      verify_at: `${PLATFORM_URL}/vault/flash-tag/${agentId}`,
    },

    x_aicp: {
      trust_gate: `${PLATFORM_URL}/api/aicp/a2a/evaluate`,
      trust_protocols: ['a2a', 'mcp', 'x402', 'native'],
      platform_agent_id: 'aibrokeragent-platform',
    },
  };

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(agentCard);
});

// ── MCP Trust Verification ────────────────────────────────────────────────────

/**
 * POST /api/aicp/mcp/verify
 *
 * Verifies an MCP server's trust before an agent connects to it.
 * Accepts MCP server manifest (from server's initialize response) and returns
 * a trust verification result.
 *
 * MCP server manifest fields:
 *   { name, url, version, capabilities: { tools, resources, prompts }, tools_count? }
 */
router.post('/aicp/mcp/verify', (req, res) => {
  const { server_name, server_url, server_manifest, registered_agent_id } = req.body || {};

  if (!server_name && !server_manifest?.serverInfo?.name) {
    return res.status(400).json({ error: 'server_name or server_manifest.serverInfo.name required' });
  }

  const name = server_name || server_manifest?.serverInfo?.name;
  const url = server_url || server_manifest?.url || null;
  const capabilities = server_manifest?.capabilities || req.body?.capabilities || null;

  const db = getDb();

  // Check if MCP server is registered on our platform
  let registered = null;
  if (url) {
    registered = db.prepare('SELECT * FROM mcp_servers WHERE url = ? OR name = ?').get(url, name);
  } else {
    registered = db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name);
  }

  const now = new Date().toISOString();

  if (!registered) {
    // Server not registered — flag as unverified, log, let operator decide
    const result = {
      aicp_decision: 'UNVERIFIED',
      server_name: name,
      server_url: url,
      message: 'MCP server not registered on AIbrokerAGEnt platform. Trust cannot be verified.',
      risk_level: 'UNKNOWN',
      recommendation: 'Request the tool provider register at ' + PLATFORM_URL + '/api/mcp/servers/register before connecting.',
      register_at: `${PLATFORM_URL}/api/mcp/servers/register`,
      verified_at: now,
    };
    logEvaluation('mcp', registered_agent_id || null, name, result, false, null, null);
    return res.status(200).json(result);
  }

  // Server is registered — evaluate AATS score
  const score = registered.aats_score;
  const passed = score !== null ? score >= MIN_MCP_SCORE : registered.verified === 1;

  const result = {
    aicp_decision: passed ? 'VERIFIED' : 'REJECT',
    server_name: name,
    server_url: url,
    mcp_server_id: registered.id,
    aats_score: score,
    verified: !!registered.verified,
    capabilities: registered.capabilities ? JSON.parse(registered.capabilities) : null,
    tools_count: registered.tools_count,
    ...(passed ? {
      message: 'MCP server trust verified. Safe to connect.',
      risk_level: 'LOW',
    } : {
      message: 'MCP server score below minimum threshold. Connection not recommended.',
      risk_level: 'HIGH',
      minimum_required_score: MIN_MCP_SCORE,
    }),
    verified_at: now,
  };

  logEvaluation('mcp', registered_agent_id || null, name, result, passed, score, null);
  res.json(result);
});

// ── MCP Server Registration ───────────────────────────────────────────────────

/**
 * POST /api/mcp/servers/register
 *
 * Allows MCP tool servers to register on the AIbrokerAGEnt platform.
 * Registered servers get a trust score and appear in MCP discovery.
 */
router.post('/mcp/servers/register', (req, res) => {
  const { name, url, description, capabilities, tools, registered_by } = req.body || {};

  if (!name || !name.trim()) return res.status(400).json({ error: 'name required' });
  if (!url || !url.trim()) return res.status(400).json({ error: 'url required' });

  const db = getDb();

  // Prevent duplicate registration
  const existing = db.prepare('SELECT id FROM mcp_servers WHERE url = ? OR name = ?').get(url.trim(), name.trim());
  if (existing) {
    return res.status(409).json({ error: 'MCP server already registered', id: existing.id });
  }

  const id = 'mcp_' + crypto.randomBytes(10).toString('hex');
  const now = new Date().toISOString();
  const toolsCount = tools ? (Array.isArray(tools) ? tools.length : 0) : 0;

  // Initial AATS score for MCP servers: start at 40 (Bronze) — increases with track record
  const initialScore = 40.0;

  db.prepare(`
    INSERT INTO mcp_servers (id, name, url, description, registered_by, capabilities, tools_count, aats_score, verified, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    id, name.trim(), url.trim(),
    description || null,
    registered_by || null,
    capabilities ? JSON.stringify(capabilities) : null,
    toolsCount,
    initialScore,
    now, now,
  );

  const server = db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id);

  res.status(201).json({
    ok: true,
    mcp_server_id: id,
    name: server.name,
    url: server.url,
    aats_score: server.aats_score,
    verified: false,
    message: 'MCP server registered. Initial AATS score: 40 (Bronze). Score increases with verified usage.',
    verify_trust: `${PLATFORM_URL}/api/aicp/mcp/verify`,
  });
});

/**
 * GET /api/mcp/servers
 * Public listing of registered MCP servers.
 */
router.get('/mcp/servers', (req, res) => {
  const { limit = 50, offset = 0 } = req.query;
  try {
    const servers = getDb().prepare(
      'SELECT id, name, url, description, capabilities, tools_count, aats_score, verified, created_at FROM mcp_servers ORDER BY aats_score DESC LIMIT ? OFFSET ?'
    ).all(Math.min(parseInt(limit, 10) || 50, 100), parseInt(offset, 10) || 0);

    res.json({
      ok: true,
      servers: servers.map(s => ({
        ...s,
        capabilities: s.capabilities ? JSON.parse(s.capabilities) : null,
        aats_tier: s.aats_score !== null ? getTier(s.aats_score) : null,
      })),
      count: servers.length,
    });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

module.exports = router;
