/**
 * Cloudflare Pages Function — /demo-login
 *
 * POST: called by demo.html on every successful login.
 *       Records timestamp, country, and a truncated UA string.
 *       Requires KV namespace bound as DEMO_LOGINS (set in Pages dashboard).
 *
 * GET ?secret=<VIEW_SECRET>: returns the full login log as JSON.
 *      Set VIEW_SECRET env var in Pages dashboard to protect this endpoint.
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function onRequestPost({ request, env }) {
  try {
    const entry = {
      ts: new Date().toISOString(),
      country: request.headers.get('CF-IPCountry') || '??',
      ua: (request.headers.get('User-Agent') || '').slice(0, 120),
    };

    if (env.DEMO_LOGINS) {
      const existing = (await env.DEMO_LOGINS.get('logins', { type: 'json' })) || [];
      existing.push(entry);
      await env.DEMO_LOGINS.put('logins', JSON.stringify(existing.slice(-2000)));
    }

    console.log(JSON.stringify({ event: 'demo_login', ...entry }));

    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });
  }
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const secret = url.searchParams.get('secret');

  if (!env.VIEW_SECRET || secret !== env.VIEW_SECRET) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const logins = (await env.DEMO_LOGINS?.get('logins', { type: 'json' })) || [];

  // Simple summary: count by country, last 10 entries
  const byCountry = logins.reduce((acc, e) => {
    acc[e.country] = (acc[e.country] || 0) + 1;
    return acc;
  }, {});

  return new Response(
    JSON.stringify({ total: logins.length, byCountry, recent: logins.slice(-20) }, null, 2),
    { headers: { 'Content-Type': 'application/json' } },
  );
}
