/**
 * AIBrokerAgent — Cloudflare Worker Gateway
 *
 * Security layer in front of the agent API. Handles:
 *   - Roach Motel pre-flight (threat detection, honeypot, panic room)
 *   - X-Agent-Key validation (format bav1_*) + KV lookup
 *   - Per-agent rate limiting (60 req/min)
 *   - Content-Type enforcement on mutating requests
 *   - Request logging (no PII)
 *   - CORS
 *   - Proxy to ORIGIN_URL
 *
 * Go-live checklist:
 *   1. wrangler kv namespace create ROACH_MOTEL  → paste id into wrangler.toml
 *   2. wrangler kv namespace create API_KEYS     → paste id into wrangler.toml
 *   3. wrangler secret put ORIGIN_URL
 *   4. wrangler secret put CF_API_TOKEN          (needed for L2+ IP block)
 *   5. wrangler secret put CF_ZONE_ID
 *   6. wrangler secret put ALERT_WEBHOOK         (optional — Formspree or similar)
 *   7. wrangler deploy
 */

import { routeRequest } from './roach-motel.js';

const AGENT_KEY_PATTERN = /^bav1_[a-zA-Z0-9]+$/;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 60;

// In-memory rate limit store — safe for single Worker instance
// TODO: Replace with Durable Objects when multi-region scale is needed
const rateLimitStore = new Map();

function getRateLimitEntry(agentId) {
  const now = Date.now();
  let entry = rateLimitStore.get(agentId);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { windowStart: now, count: 0 };
    rateLimitStore.set(agentId, entry);
  }
  return entry;
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Key',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // --- 0. Roach Motel pre-flight ---
    const roach = await routeRequest(request, env);
    if (roach.route !== 'PASS') {
      // Attach CORS headers to whatever the trap returned
      const resp = roach.response;
      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries(corsHeaders(origin))) headers.set(k, v);
      return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers });
    }

    // --- 1. API key format validation ---
    // (roach-motel already validated format; this is belt-and-suspenders)
    const agentKey = request.headers.get('X-Agent-Key');
    if (!agentKey || !AGENT_KEY_PATTERN.test(agentKey)) {
      return jsonResponse(
        { error: 'Unauthorized', message: 'Valid X-Agent-Key header required (format: bav1_...)' },
        401,
        origin,
      );
    }

    // --- 2. KV key validation ---
    if (env.API_KEYS) {
      const record = await env.API_KEYS.get(agentKey);
      if (!record) {
        return jsonResponse({ error: 'Unauthorized', message: 'Unknown API key' }, 401, origin);
      }
    }

    // --- 3. Rate limiting ---
    const entry = getRateLimitEntry(agentKey);
    entry.count++;
    if (entry.count > RATE_LIMIT_MAX) {
      const retryAfter = Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW_MS - Date.now()) / 1000);
      return new Response(JSON.stringify({ error: 'Too Many Requests', retryAfter }), {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.max(retryAfter, 1)),
          ...corsHeaders(origin),
        },
      });
    }

    // --- 4. Content-Type enforcement ---
    if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
      const contentType = request.headers.get('Content-Type') || '';
      if (!contentType.includes('application/json')) {
        return jsonResponse(
          { error: 'Bad Request', message: 'Content-Type must be application/json' },
          400,
          origin,
        );
      }
    }

    // --- 5. Log request metadata (no PII) ---
    console.log(JSON.stringify({
      agentId: agentKey,
      method: request.method,
      path: url.pathname,
      ts: new Date().toISOString(),
    }));

    // --- 6. Proxy to origin ---
    if (!env.ORIGIN_URL) {
      return jsonResponse({ error: 'Gateway Error', message: 'ORIGIN_URL not configured' }, 503, origin);
    }

    const targetUrl = env.ORIGIN_URL.replace(/\/$/, '') + url.pathname + url.search;

    // Strip X-Agent-Key before forwarding — origin trusts the gateway, not raw keys
    const forwardHeaders = new Headers(request.headers);
    forwardHeaders.delete('X-Agent-Key');

    const originResponse = await fetch(new Request(targetUrl, {
      method: request.method,
      headers: forwardHeaders,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'follow',
    }));

    // Attach CORS headers to origin response
    const responseHeaders = new Headers(originResponse.headers);
    for (const [k, v] of Object.entries(corsHeaders(origin))) {
      responseHeaders.set(k, v);
    }

    return new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: responseHeaders,
    });
  },
};
