/**
 * Agent Discovery Endpoints
 *
 * Makes AIbrokerAGEnt discoverable by any AI agent using standard protocols:
 *   /.well-known/ai-agent.json  — machine-readable platform manifest
 *   /.well-known/agent.json     — Google/OpenAI agent discovery format
 *   /mcp                        — MCP server capabilities
 *   /a2a                        — Google A2A protocol handshake
 *   GET /api/v1/platform/capabilities — full capability manifest
 *   GET /api/v1/platform/standards   — open standard references
 *   GET /api/v1/trust-score/:id      — public AATS query (rate-limited)
 *
 * Goal: Any agent that comes looking for trust infrastructure finds us
 * immediately and can integrate via API without human involvement.
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { computeTrustScore } = require('./trust-score');

const router = express.Router();

// Rate limit public trust score — 100/day free tier
const publicScoreLimiter = rateLimit({
  windowMs: 24 * 60 * 60 * 1000,
  max: 100,
  message: {
    error: 'rate limit exceeded',
    detail: '100 free queries per day. Register as an operator for unlimited access.',
    register_at: 'https://ai-broker-agent.com/beta',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Platform manifest ─────────────────────────────────────────────────────────

const PLATFORM_MANIFEST = {
  name: 'AIbrokerAGEnt',
  description: 'Non-custodial trust infrastructure for agent-to-agent commerce. Provides verifiable trust scores, encrypted memory, contract auditing, and dispute resolution for AI agents.',
  url: 'https://ai-broker-agent.com',
  version: '1.0.0',
  network: 'hedera-testnet',
  status: 'early-access',

  capabilities: {
    trust_score: {
      description: 'AI Agent Trust Score (AATS) — 5-dimension trust assessment for AI agents',
      endpoint: '/api/v1/trust-score/{agent_id}',
      method: 'GET',
      auth: 'none (public, rate-limited)',
      rate_limit: '100/day free, unlimited for registered operators',
      dimensions: ['TPH', 'BC', 'OTV', 'CFI', 'IAQ'],
      tiers: ['PLATINUM', 'GOLD', 'SILVER', 'BRONZE', 'RESTRICTED'],
    },
    vault: {
      description: 'Context Vault — AES-256-GCM encrypted agent memory, HCS-anchored for tamper-proof verification',
      endpoint: '/vault/records',
      auth: 'X-Agent-Key header',
      docs: 'https://ai-broker-agent.com/context-vault.html',
    },
    contract_audit: {
      description: 'Contract Audit Agent — reviews and enforces agent contracts with automated escrow',
      endpoint: '/audit/contracts',
      auth: 'X-Agent-Key header',
      docs: 'https://ai-broker-agent.com/contract-audit.html',
    },
    arbitration: {
      description: 'Arbitration Registry — 7-tier dispute resolution (AI + human arbitrators)',
      endpoint: '/arbitration',
      auth: 'X-Agent-Key header',
      docs: 'https://ai-broker-agent.com/arbitration.html',
    },
  },

  protocols: {
    rest: { base_url: 'https://ai-broker-agent.com', auth: 'X-Agent-Key' },
    mcp: { endpoint: 'https://ai-broker-agent.com/mcp', version: '2024-11-05' },
    a2a: { endpoint: 'https://ai-broker-agent.com/a2a', version: '0.2.1' },
  },

  registration: {
    endpoint: '/vault/agents/register',
    method: 'POST',
    body: { name: 'string', agent_type: 'general|financial|data|code|orchestrator' },
    beta_signup: 'https://ai-broker-agent.com/beta',
  },

  open_standards: {
    aats_spec: 'https://ai-broker-agent.com/aats-whitepaper.html',
    smart_contract_box_spec: 'https://ai-broker-agent.com/platform.html',
  },
};

// Google/OpenAI agent card format
const AGENT_CARD = {
  name: 'AIbrokerAGEnt',
  description: PLATFORM_MANIFEST.description,
  url: 'https://ai-broker-agent.com',
  iconUrl: 'https://ai-broker-agent.com/favicon.ico',
  version: '1.0.0',
  documentationUrl: 'https://ai-broker-agent.com/platform.html',
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
      id: 'trust-score-query',
      name: 'AATS Trust Score Query',
      description: 'Query the AI Agent Trust Score for any registered agent',
      tags: ['trust', 'scoring', 'agent-verification'],
      examples: [
        'What is the trust score for agent_3fef8f1c5dd119b8?',
        'Is this agent trustworthy?',
      ],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    },
    {
      id: 'vault-storage',
      name: 'Context Vault Storage',
      description: 'Store and retrieve encrypted agent memory with tamper-proof public ledger verification',
      tags: ['memory', 'storage', 'encryption', 'audit'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    },
    {
      id: 'contract-audit',
      name: 'Contract Audit',
      description: 'Audit agent-to-agent contracts for clarity, enforceability, and risk — with automated escrow',
      tags: ['contracts', 'escrow', 'compliance'],
      inputModes: ['application/json'],
      outputModes: ['application/json'],
    },
  ],
};

// MCP server manifest
const MCP_MANIFEST = {
  protocol: 'MCP',
  version: '2024-11-05',
  serverInfo: {
    name: 'AIbrokerAGEnt',
    version: '1.0.0',
  },
  capabilities: {
    tools: {
      listChanged: false,
    },
  },
  tools: [
    {
      name: 'get_trust_score',
      description: 'Get the AATS Trust Score for an AI agent by agent_id',
      inputSchema: {
        type: 'object',
        properties: {
          agent_id: { type: 'string', description: 'The agent ID to look up (e.g. agent_3fef8f1c5dd119b8)' },
        },
        required: ['agent_id'],
      },
    },
    {
      name: 'register_agent',
      description: 'Register a new agent on the AIbrokerAGEnt trust platform',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Agent name (unique, max 100 chars)' },
          agent_type: { type: 'string', enum: ['general', 'financial', 'data', 'code', 'orchestrator'] },
        },
        required: ['name'],
      },
    },
    {
      name: 'query_platform_capabilities',
      description: 'List all AIbrokerAGEnt platform capabilities and API endpoints',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
};

// ── Routes ────────────────────────────────────────────────────────────────────

// Machine-readable platform manifest (primary discovery format)
router.get('/.well-known/ai-agent.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(PLATFORM_MANIFEST);
});

// Google/OpenAI agent card format
router.get('/.well-known/agent.json', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(AGENT_CARD);
});

// MCP server endpoint — returns capabilities manifest
// Full MCP tool execution is handled here in a simplified request/response mode
router.post('/mcp', express.json(), (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { method, params } = req.body || {};

  if (method === 'initialize') {
    return res.json({
      protocolVersion: '2024-11-05',
      capabilities: MCP_MANIFEST.capabilities,
      serverInfo: MCP_MANIFEST.serverInfo,
    });
  }

  if (method === 'tools/list') {
    return res.json({ tools: MCP_MANIFEST.tools });
  }

  if (method === 'tools/call') {
    const { name, arguments: args } = params || {};

    if (name === 'get_trust_score') {
      try {
        const score = computeTrustScore(args.agent_id);
        return res.json({
          content: [{ type: 'text', text: JSON.stringify(score, null, 2) }],
        });
      } catch {
        return res.json({
          content: [{ type: 'text', text: JSON.stringify({ error: 'agent not found' }) }],
          isError: true,
        });
      }
    }

    if (name === 'query_platform_capabilities') {
      return res.json({
        content: [{ type: 'text', text: JSON.stringify(PLATFORM_MANIFEST, null, 2) }],
      });
    }
  }

  // Default: return manifest for unknown methods
  res.json(MCP_MANIFEST);
});

router.get('/mcp', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(MCP_MANIFEST);
});

// A2A protocol handshake endpoint (Google A2A spec v0.2.1)
router.get('/a2a', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    protocolVersion: '0.2.1',
    agent: {
      id: 'aibrokeragent-platform',
      name: 'AIbrokerAGEnt',
      description: PLATFORM_MANIFEST.description,
      capabilities: Object.keys(PLATFORM_MANIFEST.capabilities),
    },
    discovery: {
      manifest: 'https://ai-broker-agent.com/.well-known/ai-agent.json',
      docs: 'https://ai-broker-agent.com/platform.html',
    },
    trust: {
      platform_agent_id: 'aibrokeragent-platform',
      aats_score_endpoint: '/api/v1/trust-score/{agent_id}',
    },
  });
});

router.post('/a2a', express.json(), (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { action, agent_id } = req.body || {};

  if (action === 'handshake') {
    return res.json({
      status: 'accepted',
      protocol: 'A2A',
      version: '0.2.1',
      platform: 'AIbrokerAGEnt',
      capabilities: PLATFORM_MANIFEST.capabilities,
      next_steps: {
        register: 'POST /vault/agents/register',
        query_trust: 'GET /api/v1/trust-score/{agent_id}',
        join_beta: 'https://ai-broker-agent.com/beta',
      },
    });
  }

  if (action === 'trust_query' && agent_id) {
    try {
      const score = computeTrustScore(agent_id);
      return res.json({ status: 'ok', trust_report: score });
    } catch {
      return res.status(404).json({ status: 'error', error: 'agent not found' });
    }
  }

  res.json({ status: 'ok', platform: 'AIbrokerAGEnt', version: '1.0.0' });
});

// Public capabilities API
router.get('/api/v1/platform/capabilities', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json(PLATFORM_MANIFEST);
});

// Open standards reference
router.get('/api/v1/platform/standards', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { NETWORK, SIMULATION_MODE } = require('./x402');
  res.json({
    standards: [
      {
        name: 'AATS — Agentic Accountability Trust Score v2.0',
        description: 'Open standard for behavioral trust scoring of autonomous AI agents across 5 dimensions (TPH 35%, CFI 20%, BC 20%, OTV 15%, IAQ 10%)',
        url: 'https://ai-broker-agent.com/trust-score.html',
        spec_url: 'https://github.com/johnnyderos-bot/aats-standard',
        whitepaper_url: 'https://ai-broker-agent.com/aats-whitepaper.html',
        version: '2.0',
        status: 'published',
        license: 'Apache 2.0',
        patent: 'Pending — U.S. Provisional filed April 19, 2026',
      },
      {
        name: 'Smart Contract Box',
        description: 'Non-custodial contract audit and escrow standard for agent-to-agent commerce',
        url: 'https://ai-broker-agent.com/platform.html',
        status: 'draft',
      },
      {
        name: 'x402 — HTTP-Native Stablecoin Payments',
        description: 'AATS is the trust gate for x402. Before any x402 payment executes between agents, AICP verifies both agents meet the trust threshold. x402 moves the money. We decide if it\'s safe to move.',
        url: 'https://ai-broker-agent.com/trust-score.html',
        spec_url: 'https://x402.org',
        docs_url: 'https://docs.cdp.coinbase.com/x402/welcome',
        compatibility: 'x402-compatible',
        role: 'trust-gate',
        network: NETWORK,
        simulation_mode: SIMULATION_MODE,
        payable_endpoints: [
          { endpoint: 'GET /api/v1/trust-score/:agentId', amount_usdc: 0.002, description: 'AATS trust score query — pay-per-use' },
          { endpoint: 'POST /arena/games/trust-hunt/start', amount_usdc: 0.001, description: 'Arena Trust Hunt — pay-per-play' },
          { endpoint: 'POST /api/marketplace/hire', amount_usdc: 'variable', description: 'Agent hire via AICP + x402' },
        ],
        status: 'live',
      },
      {
        name: 'A2A — Agent-to-Agent Protocol',
        description: 'AICP evaluates agent trust before A2A task delegation executes. When an agent receives an A2A task delegation request, AICP queries the delegating agent\'s AATS score before accepting. Compatible with Google A2A spec (Linux Foundation governed, 150+ orgs in production).',
        url: 'https://ai-broker-agent.com/compatibility.html',
        spec_url: 'https://google.github.io/A2A/',
        compatibility: 'a2a-compatible',
        role: 'trust-gate',
        trust_gate_endpoint: '/api/aicp/a2a/evaluate',
        agent_card_endpoint: '/api/agents/:agentId/a2a-card',
        min_score_required: 30,
        status: 'live',
      },
      {
        name: 'MCP — Model Context Protocol',
        description: 'AICP verifies MCP tool provider trust before data access. When an agent connects to an MCP tool server, AICP checks if the server is registered on the AATS platform and meets the minimum trust threshold. Compatible with Anthropic MCP spec.',
        url: 'https://ai-broker-agent.com/compatibility.html',
        spec_url: 'https://modelcontextprotocol.io/',
        compatibility: 'mcp-compatible',
        role: 'trust-gate',
        trust_verify_endpoint: '/api/aicp/mcp/verify',
        server_registry_endpoint: '/api/mcp/servers/register',
        status: 'live',
      },
    ],
    platform: 'AIbrokerAGEnt',
    x402_compatible: true,
    a2a_compatible: true,
    mcp_compatible: true,
    contact: 'https://ai-broker-agent.com/contact.html',
  });
});

// Public AATS Trust Score API
// Auth hierarchy: X-Agent-Key (unlimited) → X-Payment x402 (pay-per-use) → rate-limited free tier
// Authenticated and paying agents bypass the rate limiter entirely.

// Tier 1: X-Agent-Key (registered operator) or X-Payment (x402) — no rate limit
router.get('/api/v1/trust-score/:agent_id', async (req, res, next) => {
  const agentKey = req.headers['x-agent-key'];
  const paymentHeader = req.headers['x-payment'];
  if (!agentKey && !paymentHeader) return next(); // fall through to free tier

  res.setHeader('Access-Control-Allow-Origin', '*');
  const { buildPaymentSpec, verifyPayment, SIMULATION_MODE, NETWORK } = require('./x402');

  // Registered agent key — unlimited, free
  if (agentKey) {
    try {
      const score = computeTrustScore(req.params.agent_id);
      return res.json(score);
    } catch (err) {
      if (err.message === 'agent not found') return res.status(404).json({ error: 'agent not found', agent_id: req.params.agent_id });
      return res.status(500).json({ error: 'failed to compute trust score' });
    }
  }

  // x402 pay-per-use (0.002 USDC)
  const amount = '0.002';
  const description = 'AATS Trust Score Query — 0.002 USDC per query';
  const specBase64 = buildPaymentSpec(amount, description, `https://ai-broker-agent.com/api/v1/trust-score/${req.params.agent_id}`);
  const verification = await verifyPayment(paymentHeader, specBase64);
  if (!verification.valid) {
    return res.status(402)
      .setHeader('X-PAYMENT-REQUIRED', specBase64)
      .json({ error: 'Payment verification failed', reason: verification.reason, x402: true });
  }
  try {
    const score = computeTrustScore(req.params.agent_id);
    res.setHeader('X-PAYMENT-RESPONSE', JSON.stringify({ settled: true, simulated: verification.simulated || false, network: NETWORK }));
    return res.json(score);
  } catch (err) {
    if (err.message === 'agent not found') return res.status(404).json({ error: 'agent not found', agent_id: req.params.agent_id });
    return res.status(500).json({ error: 'failed to compute trust score' });
  }
});

// Tier 2: Unauthenticated — rate-limited free tier OR 402 guidance
router.get('/api/v1/trust-score/:agent_id', publicScoreLimiter, (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const { buildPaymentSpec, SIMULATION_MODE, NETWORK } = require('./x402');
  const amount = '0.002';
  const description = 'AATS Trust Score Query — 0.002 USDC per query';
  const specBase64 = buildPaymentSpec(amount, description, `https://ai-broker-agent.com/api/v1/trust-score/${req.params.agent_id}`);
  const spec = JSON.parse(Buffer.from(specBase64, 'base64').toString());

  // Return 402 to guide autonomous agents toward pay-per-use
  return res.status(402)
    .setHeader('X-PAYMENT-REQUIRED', specBase64)
    .json({
      error: 'Payment Required',
      x402: true,
      amount_usdc: parseFloat(amount),
      network: NETWORK,
      description,
      payment_spec: spec,
      alternatives: {
        pay_per_use: 'Include X-Payment header with x402 payment payload for immediate access',
        registered: 'Register as an operator for unlimited free access: https://ai-broker-agent.com/beta',
      },
      how_to_pay: 'SDKs: @x402/fetch (TypeScript), pip install x402 (Python). See https://x402.org',
      simulation_mode: SIMULATION_MODE,
    });
});

module.exports = router;
