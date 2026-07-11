/**
 * Roach Motel — pre-origin security trap for the AIBrokerAgent gateway.
 *
 * Routing outcomes:
 *   PASS    → valid credentials + clean signals → proxy to origin
 *   HOLD    → no/bad credentials → honeypot slow-drip until classified
 *   PANIC   → threat signals above threshold → graduated panic room response
 *   TARPIT  → previously flagged IP → 429 with long Retry-After
 *   LOCKDOWN → L4 active → 503 to all traffic
 */

import { collectSignals, scoreSignals } from './threat-classifier.js';
import { holdAgent } from './honeypot.js';
import { executePanicResponse } from './panic-room.js';

// Accept both legacy bav1_ agent keys and provisioned aib_ harness keys — must stay in sync with gateway.js
const AGENT_KEY_PATTERN = /^(bav1_|aib_)[a-zA-Z0-9]+$/;

export async function routeRequest(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  if (env.ROACH_MOTEL) {
    // Server lockdown — L4 active
    const lockdown = await env.ROACH_MOTEL.get('SERVER_LOCKDOWN');
    if (lockdown === '1') {
      return {
        route: 'LOCKDOWN',
        response: new Response(JSON.stringify({ error: 'Service Unavailable', code: 'SERVER_LOCKDOWN' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        }),
      };
    }

    // Tarpit — IP was previously flagged at L2+
    const tarpit = await env.ROACH_MOTEL.get(`tarpit:${ip}`);
    if (tarpit) {
      return {
        route: 'TARPIT',
        response: new Response(JSON.stringify({ error: 'Too Many Requests', code: 'TARPITTED', retryAfter: 1800 }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1800' },
        }),
      };
    }
  }

  const agentKey = request.headers.get('X-Agent-Key');
  const bodyText = await peekBody(request);
  const url = new URL(request.url);

  // No valid key format → run signals then decide HOLD or early PANIC
  if (!agentKey || !AGENT_KEY_PATTERN.test(agentKey)) {
    const signals = await collectSignals(request, env, { bodyText });
    const { score, level } = scoreSignals(signals);

    if (level >= 2) {
      const response = await executePanicResponse(level, { ip, agentKey, signals, score, url: url.pathname }, env);
      return { route: 'PANIC', response };
    }

    return { route: 'HOLD', response: await holdAgent(request, env) };
  }

  // Key present but not yet KV-verified → check KV if wired
  if (env.API_KEYS) {
    const record = await env.API_KEYS.get(agentKey);
    if (!record) {
      return { route: 'HOLD', response: await holdAgent(request, env) };
    }
  }

  // Valid key — full signal scan
  const signals = await collectSignals(request, env, { bodyText });
  const { score, level } = scoreSignals(signals);

  if (level >= 1) {
    const response = await executePanicResponse(level, { ip, agentKey, signals, score, url: url.pathname }, env);
    return { route: 'PANIC', response };
  }

  return { route: 'PASS' };
}

async function peekBody(request) {
  if (!['POST', 'PUT', 'PATCH'].includes(request.method)) return '';
  try {
    return await request.clone().text().then(t => t.slice(0, 2000));
  } catch (_) {
    return '';
  }
}
