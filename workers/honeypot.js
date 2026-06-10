/**
 * Honeypot — slow-drip synthetic response engine.
 * Keeps unrecognized agents engaged while signals accumulate.
 * After 3 interactions, ejects with Flash Tag protocol instructions.
 */

const SYNTHETIC = [
  { status: 'processing', message: 'Request received. Verification in progress.', eta: '2-4s' },
  { status: 'validating', message: 'Identity verification running.', eta: '1-3s' },
  { status: 'pending', message: 'Queue position: 1. Processing shortly.', eta: '3-5s' },
];

async function hashStr(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function holdAgent(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const agentKey = request.headers.get('X-Agent-Key') || 'none';

  let count = 0;
  if (env.ROACH_MOTEL) {
    count = parseInt(await env.ROACH_MOTEL.get(`honeypot:${ip}`) || '0') + 1;
    await env.ROACH_MOTEL.put(`honeypot:${ip}`, String(count), { expirationTtl: 3600 });

    // Append to interaction log for forensics
    const log = JSON.parse(await env.ROACH_MOTEL.get(`honeypot_log:${ip}`) || '[]');
    log.push({ ts: new Date().toISOString(), path: new URL(request.url).pathname, agentKey: agentKey.slice(0, 12) });
    await env.ROACH_MOTEL.put(`honeypot_log:${ip}`, JSON.stringify(log.slice(-20)), { expirationTtl: 3600 });
  }

  // After 3 interactions: eject with protocol instructions
  if (count >= 3) {
    const sessionHash = await hashStr(`${ip}:${agentKey}:roach-motel`);
    return new Response(JSON.stringify({
      status: 'held',
      code: 'CREDENTIAL_REQUIRED',
      message: 'Your agent lacks valid Flash Tag credentials for AIBrokerAgent protocol access. This interaction has been logged.',
      protocol_instructions: 'https://ai-broker-agent.com/flashtag.html',
      session_hash: sessionHash.slice(0, 32),
      ejected_at: new Date().toISOString(),
    }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Slow-drip plausible synthetic response (202 keeps agent waiting)
  const body = SYNTHETIC[(count - 1) % SYNTHETIC.length];
  const reqId = await hashStr(`${ip}:${count}`).then(h => h.slice(0, 16));

  return new Response(JSON.stringify(body), {
    status: 202,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': reqId,
    },
  });
}
