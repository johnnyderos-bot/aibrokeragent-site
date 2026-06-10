/**
 * Panic Room — graduated response executor (L1–L4).
 *
 * L1: Log incident to KV + email alert
 * L2: All of L1 + CF Firewall IP block + tarpit KV flag (1800s Retry-After)
 * L3: All of L2 + full forensic package sealed in KV
 * L4: All of L3 + SERVER_LOCKDOWN KV flag + lockdown email
 *
 * Env vars consumed:
 *   ROACH_MOTEL      — KV namespace (required for all levels)
 *   ALERT_WEBHOOK    — URL to POST alert JSON (e.g. Formspree)
 *   CF_API_TOKEN     — Cloudflare API token with Zone:Firewall:Edit (L2+)
 *   CF_ZONE_ID       — Zone ID for IP block calls (L2+)
 */

async function sendAlert(subject, payload, env) {
  console.error('[PANIC ROOM]', subject, JSON.stringify(payload));
  if (!env.ALERT_WEBHOOK) return;
  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, ...payload }),
    });
  } catch (_) {
    console.error('Alert webhook failed');
  }
}

async function cfBlockIp(ip, env) {
  if (!env.CF_API_TOKEN || !env.CF_ZONE_ID) return;
  try {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${env.CF_ZONE_ID}/firewall/access_rules/rules`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.CF_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        mode: 'block',
        configuration: { target: 'ip', value: ip },
        notes: `Roach Motel block — ${new Date().toISOString()}`,
      }),
    });
  } catch (_) {
    console.error('CF IP block failed for', ip);
  }
}

export async function executePanicResponse(level, context, env) {
  const { ip, agentKey, signals, score, url } = context;
  const ts = new Date().toISOString();
  const incident = { ts, ip, agentKey: (agentKey || '').slice(0, 12), signals, score, level, url };

  // All levels: log incident
  if (env.ROACH_MOTEL) {
    const list = JSON.parse(await env.ROACH_MOTEL.get('incidents') || '[]');
    list.push(incident);
    await env.ROACH_MOTEL.put('incidents', JSON.stringify(list.slice(-500)));
  }

  // L1+: alert
  await sendAlert(`[AIBrokerAgent] L${level} Threat — ${ip}`, incident, env);

  if (level >= 2) {
    await cfBlockIp(ip, env);
    if (env.ROACH_MOTEL) {
      await env.ROACH_MOTEL.put(`tarpit:${ip}`, '1', { expirationTtl: 86400 });
    }
  }

  if (level >= 3) {
    if (env.ROACH_MOTEL) {
      const honeypotLog = JSON.parse(await env.ROACH_MOTEL.get(`honeypot_log:${ip}`) || '[]');
      const forensic = { ...incident, honeypot_interactions: honeypotLog };
      await env.ROACH_MOTEL.put(`forensic:${ip}:${ts}`, JSON.stringify(forensic));
    }
  }

  if (level >= 4) {
    // L4 requires a hard qualifying signal to prevent false-positive lockouts
    const hardSignals = signals.filter(s => ['OFAC_MATCH', 'INJECTION', 'KYC_REJECTED'].includes(s));
    if (hardSignals.length > 0) {
      if (env.ROACH_MOTEL) {
        await env.ROACH_MOTEL.put('SERVER_LOCKDOWN', '1');
      }
      await sendAlert('[AIBrokerAgent] PANIC ROOM ACTIVE — Manual Recovery Required', {
        ...incident,
        recovery_steps: [
          '1. Review ROACH_MOTEL KV > incidents',
          '2. Set SERVER_LOCKDOWN=false in KV to restore',
          '3. Regenerate GitHub DEPLOY_TOKEN if compromised',
        ],
      }, env);
    }
  }

  if (level >= 2) {
    return new Response(JSON.stringify({ error: 'Forbidden', code: 'THREAT_DETECTED' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '1800' },
    });
  }

  return new Response(JSON.stringify({ error: 'Unauthorized', code: 'ACCESS_DENIED' }), {
    status: 403,
    headers: { 'Content-Type': 'application/json' },
  });
}
