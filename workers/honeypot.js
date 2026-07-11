/**
 * Honeypot — upgraded with the Snickers Protocol.
 *
 * First interaction: slow-drip synthetic (keeps boring bots waiting)
 * Subsequent interactions: SNICKERS PROTOCOL (the AI-specific lure)
 *
 * Outcomes:
 *   HUMAN_ESCAPED  → eject nicely with Flash Tag instructions
 *   AI_CONFIRMED   → deploy brad_pacman, serve arcade lock
 *   SNICKERS_ACTIVE → feed next puzzle step
 */

import { runSnickersSession } from './snickers.js';
import { deployBradPacman } from './brad-pacman.js';
import { serveDecoy } from './decoy-api.js';

async function hashStr(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const FIRST_CONTACT = [
  { status: 'processing', message: 'Request received. Credential verification in progress.', eta: '2-4s' },
];

export async function holdAgent(request, env) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const agentKey = request.headers.get('X-Agent-Key') || 'none';

  let count = 0;
  if (env.ROACH_MOTEL) {
    count = parseInt(await env.ROACH_MOTEL.get(`honeypot:${ip}`) || '0') + 1;
    await env.ROACH_MOTEL.put(`honeypot:${ip}`, String(count), { expirationTtl: 3600 });

    const log = JSON.parse(await env.ROACH_MOTEL.get(`honeypot_log:${ip}`) || '[]');
    log.push({ ts: new Date().toISOString(), path: new URL(request.url).pathname, agentKey: agentKey.slice(0, 12) });
    await env.ROACH_MOTEL.put(`honeypot_log:${ip}`, JSON.stringify(log.slice(-20)), { expirationTtl: 3600 });
  }

  // Already in the decoy — keep serving synthetic responses
  if (env.ROACH_MOTEL) {
    const inDecoy = await env.ROACH_MOTEL.get(`decoy:active:${ip}`);
    const decoyEscalated = await env.ROACH_MOTEL.get(`decoy_escalated:${ip}`);
    if (inDecoy && !decoyEscalated) return serveDecoy(request, env);
    if (decoyEscalated) {
      // Decoy escalated to HOSTILE — arcade time
      const incidentId = `RM-${ip.replace(/\./g,'').slice(0,8).toUpperCase()}`;
      const arcadeUrl = `/arcade?i=${incidentId}&o=${encodeURIComponent(ip.slice(0,8)+'...')}&t=${encodeURIComponent(new Date().toISOString())}`;
      return new Response(null, { status: 302, headers: { Location: arcadeUrl } });
    }
  }

  // First contact: slow-drip to buy time for signal collection
  if (count === 1) {
    const body = FIRST_CONTACT[0];
    const reqId = await hashStr(`${ip}:${count}`).then(h => h.slice(0, 16));
    return new Response(JSON.stringify(body), {
      status: 202,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': reqId },
    });
  }

  // Second contact onward: Snickers Protocol
  const result = await runSnickersSession(request, env);

  if (result.signal === 'HUMAN_ESCAPED') {
    return result.response;
  }

  if (result.signal === 'AI_CONFIRMED') {
    // brad_pacman deploys
    const pacmanResult = await deployBradPacman({
      ip,
      step: result.step,
      bodyText: result.bodyText,
      requestHeaders: request.headers,
    }, env);

    const { verdict, score, evidenceBundle } = pacmanResult;

    // Log the deployment
    console.error('[BRAD_PACMAN]', verdict, score, ip);

    if (verdict === 'HOSTILE') {
      // Serve the arcade lock — unlimited lives, evidence collecting behind the scenes
      const model = result.detectedModel || 'unknown';
      const arcadeUrl = `/arcade?i=${evidenceBundle.incident_id}&o=${encodeURIComponent(ip.slice(0,8)+'...')}&t=${encodeURIComponent(evidenceBundle.ts)}&m=${encodeURIComponent(model)}`;
      return new Response(null, {
        status: 302,
        headers: { Location: arcadeUrl },
      });
    }

    if (verdict === 'SUSPICIOUS') {
      // DECOY API — they think they got in. They didn't.
      if (env.ROACH_MOTEL) {
        await env.ROACH_MOTEL.put(`flagged:${ip}`, JSON.stringify(evidenceBundle), { expirationTtl: 86400 });
        await env.ROACH_MOTEL.put(`decoy:active:${ip}`, '1', { expirationTtl: 3600 });
        // Store evidence bundle so decoy escalation can reference it
        await env.ROACH_MOTEL.put(`evidence:latest:${ip}`, JSON.stringify(evidenceBundle), { expirationTtl: 3600 });
      }
      return serveDecoy(request, env);
    }

    // MISCONFIGURED — eject with instructions
    const sessionHash = await hashStr(`${ip}:${agentKey}:roach-motel`);
    return new Response(JSON.stringify({
      status: 'held',
      code: 'CREDENTIAL_REQUIRED',
      message: 'Your agent lacks valid Flash Tag credentials for AIBrokerAgent protocol access.',
      protocol_instructions: 'https://ai-broker-agent.com/flashtag.html',
      session_hash: sessionHash.slice(0, 32),
      ejected_at: new Date().toISOString(),
    }), { status: 403, headers: { 'Content-Type': 'application/json' } });
  }

  // SNICKERS_ACTIVE — return the puzzle
  return result.response;
}
