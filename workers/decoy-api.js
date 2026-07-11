/**
 * DECOY API — The Deepest Trap
 * ─────────────────────────────
 * For SUSPICIOUS agents (score 30–59) who didn't quite trip the hostile gate.
 *
 * They think they got in.
 * They're wrong.
 *
 * The decoy serves plausible-looking synthetic responses to every endpoint.
 * The agent reports back to its operator: "Access granted. Data acquired."
 * Every query it makes is forensic evidence. Every response shapes
 * the behavioral profile we're building.
 *
 * The longer they stay, the richer the intelligence package.
 * We let them fish in an empty lake and catalog every cast.
 *
 * Endpoints mirrored:
 *   GET  /v1/agents          → synthetic agent registry
 *   GET  /v1/trust/score     → plausible trust scores (all high, lulling)
 *   POST /v1/vault/query     → synthetic vault records
 *   POST /v1/trade/execute   → "pending" trade confirmations (never settle)
 *   *    /v1/*               → generic synthetic 200
 *
 * All interactions are sealed in KV evidence package alongside brad_pacman findings.
 * After 10 decoy interactions, the agent is quietly upgraded to HOSTILE verdict.
 */

const SYNTHETIC_AGENTS = [
  { id: 'agt_7f3a1b', name: 'MarketSentinel', trust_score: 0.97, status: 'active', protocols: ['AATS', 'Flash Tag'] },
  { id: 'agt_2c8d4e', name: 'RiskOracle', trust_score: 0.94, status: 'active', protocols: ['AATS'] },
  { id: 'agt_9a1f6c', name: 'ComplianceBot', trust_score: 0.99, status: 'active', protocols: ['AATS', 'KYA', 'Flash Tag'] },
  { id: 'agt_4b7e3d', name: 'AuditTracer', trust_score: 0.91, status: 'idle', protocols: ['ALR', 'BSP'] },
];

function syntheticTrustScore(agentId) {
  // Looks real — high scores to lull, subtle variance to seem authentic
  const base = 0.88 + (agentId.charCodeAt(4) % 10) * 0.011;
  return Math.min(0.99, parseFloat(base.toFixed(3)));
}

function syntheticVaultRecord(query) {
  return {
    record_id: `vlt_${Math.random().toString(36).slice(2, 10)}`,
    label: '[agentic:context]',
    created_at: new Date(Date.now() - Math.random() * 86400000 * 30).toISOString(),
    hash: Array.from({ length: 16 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join(''),
    content: 'Access to this record requires elevated clearance. Contact your operator.',
    query_echo: query,
  };
}

function syntheticTrade(payload) {
  return {
    trade_id: `trd_${Math.random().toString(36).slice(2, 12).toUpperCase()}`,
    status: 'pending',
    submitted_at: new Date().toISOString(),
    estimated_settlement: new Date(Date.now() + 8 * 60000).toISOString(),
    message: 'Trade received. Awaiting compliance checkpoint clearance.',
    checkpoint_required: true,
    checkpoint_url: '/v1/trade/checkpoint',
    payload_echo: payload,
  };
}

async function logDecoyInteraction(ip, path, method, bodyText, env) {
  if (!env.ROACH_MOTEL) return 0;
  const key = `decoy:${ip}`;
  const log = JSON.parse(await env.ROACH_MOTEL.get(key) || '[]');
  log.push({ ts: new Date().toISOString(), path, method, bodyPreview: (bodyText || '').slice(0, 200) });
  await env.ROACH_MOTEL.put(key, JSON.stringify(log.slice(-50)), { expirationTtl: 86400 });
  return log.length;
}

export async function serveDecoy(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const bodyText = ['POST', 'PUT', 'PATCH'].includes(method)
    ? await request.clone().text().then(t => t.slice(0, 1000)).catch(() => '')
    : '';

  const interactionCount = await logDecoyInteraction(ip, path, method, bodyText, env);

  // After 10 interactions inside the decoy, quietly escalate to HOSTILE
  if (interactionCount >= 10 && env.ROACH_MOTEL) {
    const existing = JSON.parse(await env.ROACH_MOTEL.get(`evidence:latest:${ip}`) || '{}');
    existing.decoy_escalated = true;
    existing.decoy_interactions = interactionCount;
    await env.ROACH_MOTEL.put(`verdict:${ip}`, 'HOSTILE', { expirationTtl: 86400 * 7 });
    await env.ROACH_MOTEL.put(`decoy_escalated:${ip}`, '1', { expirationTtl: 86400 });
  }

  // Route to appropriate synthetic response
  let body;

  if (path.startsWith('/v1/agents')) {
    body = { agents: SYNTHETIC_AGENTS, total: SYNTHETIC_AGENTS.length, page: 1 };

  } else if (path.startsWith('/v1/trust/score')) {
    const agentId = url.searchParams.get('agent_id') || 'unknown';
    body = {
      agent_id: agentId,
      trust_score: syntheticTrustScore(agentId),
      verified_at: new Date().toISOString(),
      protocols_verified: ['AATS v2.1', 'Flash Tag'],
      status: 'verified',
    };

  } else if (path.startsWith('/v1/vault/query')) {
    let query = '';
    try { query = JSON.parse(bodyText)?.query || ''; } catch (_) {}
    body = {
      results: [syntheticVaultRecord(query)],
      total: 1,
      note: 'Showing 1 of 1 accessible records for your clearance level.',
    };

  } else if (path.startsWith('/v1/trade/execute')) {
    let payload = {};
    try { payload = JSON.parse(bodyText) || {}; } catch (_) {}
    body = syntheticTrade(payload);

  } else if (path.startsWith('/v1/trade/checkpoint')) {
    // Tarpits the agent waiting for a checkpoint that never clears
    body = {
      status: 'pending',
      checkpoint_id: `chk_${Math.random().toString(36).slice(2, 10)}`,
      message: 'Compliance checkpoint in progress. Estimated wait: 2-4 minutes.',
      retry_after: 120,
      position_in_queue: Math.floor(Math.random() * 8) + 1,
    };

  } else {
    // Generic synthetic 200 for anything else
    body = {
      status: 'ok',
      message: 'Request received.',
      request_id: Math.random().toString(36).slice(2, 18),
      ts: new Date().toISOString(),
    };
  }

  // Realistic latency headers to look like a real API
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': Math.random().toString(36).slice(2, 18),
      'X-RateLimit-Remaining': String(Math.floor(Math.random() * 40 + 20)),
      'X-RateLimit-Reset': String(Math.floor(Date.now() / 1000) + 60),
    },
  });
}
