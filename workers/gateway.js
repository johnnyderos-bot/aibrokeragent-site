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

// Accept both legacy bav1_ agent keys and provisioned aib_ harness keys
const AGENT_KEY_PATTERN = /^(bav1_|aib_)[a-zA-Z0-9]+$/;
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

// Only known browser-facing frontends need CORS; agent/API-key callers (curl, SDKs,
// server-to-server) don't send Origin and aren't subject to CORS enforcement anyway.
const ALLOWED_ORIGINS = new Set([
  'https://ai-broker-agent.com',
  'https://console.ai-broker-agent.com',
]);

function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Agent-Key, X-Console-Api-Key',
    'Access-Control-Max-Age': '86400',
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// Applies to every response this Worker returns directly (JSON API + traps).
// Not applied to /arcade — that route serves a real HTML/JS/CSS game page via
// env.ASSETS and needs its own, more permissive policy.
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin), ...securityHeaders() },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...corsHeaders(origin), ...securityHeaders() } });
    }

    // --- Arcade lock route — serve static asset, no security checks ---
    // This path is only reachable via a 302 from the Snickers/brad_pacman pipeline.
    if (url.pathname === '/arcade' || url.pathname === '/arcade.html') {
      if (env.ASSETS) {
        return env.ASSETS.fetch(new Request(new URL('/arcade.html', request.url), request));
      }
      return new Response('Arcade unavailable', { status: 503 });
    }

    // --- -1. Commerce endpoints (public — no API key required) ---
    if (url.pathname === '/v1/agent-gateway/provision' && request.method === 'POST') {
      return handleProvision(request, env, origin);
    }
    if (url.pathname === '/v1/stripe/webhook' && request.method === 'POST') {
      return handleStripeWebhook(request, env);
    }

    // --- -1.5. Flash Tag demo endpoints (public — browser demo pages call these
    // with no X-Agent-Key by design; flash-tag-service has its own auth model.
    // Bypasses Roach Motel too — these are legitimate unauthenticated browser
    // calls, not the kind of unattributed traffic the trap system is meant to catch. ---
    if (url.pathname.startsWith('/flash-tag/')) {
      return proxyToOrigin(request, env, origin);
    }

    // --- 0. Roach Motel pre-flight ---
    const roach = await routeRequest(request, env);
    if (roach.route !== 'PASS') {
      // Attach CORS headers to whatever the trap returned
      const resp = roach.response;
      const headers = new Headers(resp.headers);
      for (const [k, v] of Object.entries({ ...corsHeaders(origin), ...securityHeaders() })) headers.set(k, v);
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
          ...securityHeaders(),
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

    // --- 4.5. Vault write-scope enforcement ---
    // [owner:*] records are operator-controlled truth; agents may only write [agentic] records.
    // Blocks attempts to create or overwrite owner vault records via the agent API.
    if (['POST', 'PUT', 'PATCH'].includes(request.method) && url.pathname.startsWith('/vault/records')) {
      try {
        const body = await request.clone().json();
        if (body.label && /^\[owner:/i.test(body.label)) {
          return jsonResponse(
            { error: 'Forbidden', message: 'Agents may not write [owner:*] vault records' },
            403,
            origin,
          );
        }
      } catch (_) {
        // Non-JSON body falls through; origin handles malformed payloads
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
    return proxyToOrigin(request, env, origin);
  },
};

async function proxyToOrigin(request, env, origin) {
  if (!env.ORIGIN_URL) {
    return jsonResponse({ error: 'Gateway Error', message: 'ORIGIN_URL not configured' }, 503, origin);
  }

  const url = new URL(request.url);
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

  // Attach CORS + security headers to origin response, strip origin's stack fingerprint
  const responseHeaders = new Headers(originResponse.headers);
  responseHeaders.delete('X-Powered-By');
  for (const [k, v] of Object.entries({ ...corsHeaders(origin), ...securityHeaders() })) {
    responseHeaders.set(k, v);
  }

  return new Response(originResponse.body, {
    status: originResponse.status,
    statusText: originResponse.statusText,
    headers: responseHeaders,
  });
}

// ── Commerce helpers ────────────────────────────────────────────────────────

const TIER_QUOTAS = {
  free:       { calls_per_month: 100,   agents_max: 1 },
  pro:        { calls_per_month: 10000, agents_max: 5 },
  enterprise: { calls_per_month: -1,    agents_max: -1 },
};

function hexRandom(bytes) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function handleProvision(request, env, origin) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return jsonResponse({ error: 'Bad Request', message: 'Invalid JSON body' }, 400, origin);
  }

  const { tier, agent_name, contact_email, payment_confirmed } = body;

  if (!tier || !TIER_QUOTAS[tier]) {
    return jsonResponse({ error: 'Bad Request', message: 'tier must be one of: free, pro, enterprise' }, 400, origin);
  }
  if (!agent_name || typeof agent_name !== 'string') {
    return jsonResponse({ error: 'Bad Request', message: 'agent_name is required' }, 400, origin);
  }
  if (!contact_email || !contact_email.includes('@')) {
    return jsonResponse({ error: 'Bad Request', message: 'valid contact_email is required' }, 400, origin);
  }

  // Paid tiers require payment — either Stripe webhook or explicit manual flag
  const isPaid = tier === 'pro' || tier === 'enterprise';
  if (isPaid && !payment_confirmed) {
    // Return a pending status; Stripe webhook will issue the key when payment clears
    const stripeUrl = env.STRIPE_PRO_CHECKOUT_URL || 'https://ai-broker-agent.com/pricing';
    return jsonResponse({
      status: 'pending_payment',
      message: `${tier} tier requires payment. Complete checkout to receive your API key at ${contact_email}.`,
      checkout_url: stripeUrl,
    }, 202, origin);
  }

  // Issue key immediately (free tier, or paid with payment_confirmed)
  const apiKey = 'aib_' + hexRandom(16);
  const quota = TIER_QUOTAS[tier];
  const record = JSON.stringify({
    tier,
    quota,
    agent_name,
    contact_email,
    provisioned_at: new Date().toISOString(),
  });

  if (env.API_KEYS) {
    await env.API_KEYS.put(apiKey, record);
  }

  return jsonResponse({
    api_key: apiKey,
    tier,
    quota,
    install_command: `pip install aib-harness && aib-harness init --api-key ${apiKey}`,
    provisioned_at: new Date().toISOString(),
  }, 200, origin);
}

async function handleStripeWebhook(request, env) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get('Stripe-Signature') || '';
  const secret = env.STRIPE_WEBHOOK_SECRET;

  if (secret) {
    const valid = await verifyStripeSignature(rawBody, sigHeader, secret);
    if (!valid) {
      return new Response(JSON.stringify({ error: 'Invalid signature' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (_) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const tier = session.metadata?.tier || 'pro';
    const contact_email = session.customer_details?.email || session.customer_email || '';
    const agent_name = session.metadata?.agent_name || 'provisioned-agent';

    const apiKey = 'aib_' + hexRandom(16);
    const quota = TIER_QUOTAS[tier] || TIER_QUOTAS.pro;
    const record = JSON.stringify({
      tier,
      quota,
      agent_name,
      contact_email,
      stripe_session_id: session.id,
      provisioned_at: new Date().toISOString(),
    });

    if (env.API_KEYS) {
      await env.API_KEYS.put(apiKey, record);
    }

    // TODO: email apiKey to contact_email via env.ALERT_WEBHOOK or a transactional email service
    console.log(JSON.stringify({ event: 'stripe_provision', tier, contact_email, key_prefix: apiKey.slice(0, 12) }));
  }

  return new Response(JSON.stringify({ received: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  // Stripe-Signature: t=timestamp,v1=hash[,v1=hash...]
  const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
  const timestamp = parts.t;
  const v1 = parts.v1;
  if (!timestamp || !v1) return false;

  const payload = `${timestamp}.${rawBody}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const computed = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
  return computed === v1;
}
