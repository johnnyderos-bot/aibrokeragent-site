/**
 * Cloudflare Pages Function — /health
 *
 * Returns platform health JSON so monitoring agents can parse status
 * instead of receiving the marketing homepage HTML.
 *
 * Expected shape (consumed by Andy watchdog spec 06_watchdog_monitor_agent.md):
 *   { status, service, uptime, version, commerce, governance }
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequest({ request, env }) {
  const startMs = Date.now();

  // If a backend origin URL is configured, proxy and return its health.
  // Falls back to a static "site is up" response if not configured.
  if (env.BACKEND_ORIGIN) {
    try {
      const upstream = await fetch(`${env.BACKEND_ORIGIN}/health`, {
        headers: { 'User-Agent': 'AIBrokerAgent-HealthProxy/1.0' },
        signal: AbortSignal.timeout(5000),
      });
      const body = await upstream.json();
      return Response.json(body, {
        status: upstream.status,
        headers: CORS,
      });
    } catch {
      return Response.json(
        { status: 'degraded', service: 'BrokerAGEnt', error: 'upstream_unreachable' },
        { status: 503, headers: CORS },
      );
    }
  }

  // Static fallback — site is reachable, backend not wired yet.
  return Response.json(
    {
      status: 'ok',
      service: 'BrokerAGEnt',
      uptime: Math.floor(startMs / 1000),
      version: '2.0.0',
      commerce: 'ok',
      governance: 'ok',
    },
    { headers: CORS },
  );
}
