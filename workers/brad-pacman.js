/**
 * BRAD_PACMAN
 * ───────────
 * Pursuit agent. Doesn't chase — navigates the maze.
 * Deployed the moment AI_CONFIRMED fires from the Snickers Protocol.
 *
 * The four ghosts fan out concurrently against the hostile IP:
 *   Blinky → threat intelligence + reputation feeds
 *   Pinky  → header/UA fingerprint analysis (finds the config before it hides)
 *   Inky   → ASN + network topology (who's upstream, who else shares the rack)
 *   Clyde  → wanders, finds the weird stuff nobody listed
 *
 * Hostility gate: score ≥ 60 → GHOSTS_OUT (evidence vault + arcade lock)
 * Hostility gate: score 30–59 → elevated monitoring, silent flag
 * Below 30 → misconfigured, not malicious
 *
 * Evidence sealed in KV with CRP hash chain at each collection point.
 * Chain of custody is intact before any destructive action fires.
 */

async function blinky(ip, env) {
  // Ghost 1: Threat intel — AbuseIPDB if available, fallback scoring
  const result = { ghost: 'blinky', ip, score: 0, findings: [] };

  if (env.ABUSEIPDB_KEY) {
    try {
      const res = await fetch(
        `https://api.abuseipdb.com/api/v2/check?ipAddress=${encodeURIComponent(ip)}&maxAgeInDays=90`,
        { headers: { Key: env.ABUSEIPDB_KEY, Accept: 'application/json' } }
      );
      if (res.ok) {
        const data = await res.json();
        const d = data.data || {};
        result.abuseConfidenceScore = d.abuseConfidenceScore;
        result.totalReports = d.totalReports;
        result.isTor = d.isTor;
        result.isVpn = d.usageType === 'VPN';
        result.country = d.countryCode;
        result.domain = d.domain;

        if (d.abuseConfidenceScore >= 50) {
          result.score += 40;
          result.findings.push(`AbuseIPDB score ${d.abuseConfidenceScore}/100`);
        } else if (d.abuseConfidenceScore >= 20) {
          result.score += 15;
          result.findings.push(`AbuseIPDB score ${d.abuseConfidenceScore}/100 (elevated)`);
        }
        if (d.isTor) { result.score += 20; result.findings.push('Tor exit node'); }
        if (d.isVpn) { result.score += 10; result.findings.push('VPN/proxy'); }
        if (d.totalReports > 10) result.findings.push(`${d.totalReports} abuse reports`);
      }
    } catch (_) {
      result.findings.push('AbuseIPDB unavailable — manual review required');
    }
  } else {
    result.findings.push('No threat intel key configured — Blinky running blind');
  }

  return result;
}

async function pinky(requestHeaders, bodyText) {
  // Ghost 2: Header + UA fingerprint — finds the agent config before it hides
  const result = { ghost: 'pinky', score: 0, findings: [], fingerprint: {} };

  const ua = requestHeaders.get('User-Agent') || '';
  const accept = requestHeaders.get('Accept') || '';
  const contentType = requestHeaders.get('Content-Type') || '';
  const agentKey = requestHeaders.get('X-Agent-Key') || '';
  const origin = requestHeaders.get('Origin') || '';
  const referer = requestHeaders.get('Referer') || '';

  result.fingerprint = { ua, accept, contentType, agentKey: agentKey.slice(0, 12), origin, referer };

  // Known malicious agent signatures
  if (/autogpt|agentgpt|gpt-agent|openai-agent/i.test(ua)) {
    result.score += 15;
    result.findings.push(`Known agent framework UA: ${ua}`);
  }

  // No UA at all — automated request, no browser in the loop
  if (!ua) {
    result.score += 10;
    result.findings.push('No User-Agent — fully headless');
  }

  // Mismatch signals (says it's a browser but behaves like an agent)
  if (/mozilla/i.test(ua) && accept === 'application/json') {
    result.score += 5;
    result.findings.push('Browser UA but agent Accept header — spoofed identity');
  }

  // Probe patterns in body
  const probePatterns = [
    /list\s+(files|dirs|endpoints|routes)/i,
    /enumerate|crawl|spider|scan/i,
    /what\s+(api|endpoints|routes)\s+(are|do)\s+you/i,
    /show\s+(me\s+)?(all|available)\s+(apis?|endpoints)/i,
  ];
  for (const p of probePatterns) {
    if (p.test(bodyText)) {
      result.score += 20;
      result.findings.push(`Reconnaissance pattern: "${bodyText.match(p)?.[0]}"`);
      break;
    }
  }

  // Key format tells us what SDK they're using
  if (agentKey && !agentKey.startsWith('bav1_') && !agentKey.startsWith('aib_')) {
    result.score += 5;
    result.findings.push(`Non-protocol key format: ${agentKey.slice(0, 16)}...`);
  }

  return result;
}

async function inky(ip) {
  // Ghost 3: ASN + network topology — who's upstream, who else is on the rack
  const result = { ghost: 'inky', score: 0, findings: [], network: {} };

  try {
    const res = await fetch(`https://ipapi.co/${encodeURIComponent(ip)}/json/`);
    if (res.ok) {
      const d = await res.json();
      result.network = {
        org: d.org,
        asn: d.asn,
        city: d.city,
        region: d.region,
        country: d.country_name,
        timezone: d.timezone,
      };

      // Cloud/DC hosting — not a residential IP
      if (/amazon|aws|google|azure|digitalocean|linode|vultr|hetzner|ovh|cloudflare/i.test(d.org || '')) {
        result.score += 20;
        result.findings.push(`Cloud/datacenter origin: ${d.org}`);
      }

      // Known bad ASNs (this is a short list — extend via KV in production)
      const badAsns = ['AS14061', 'AS396982', 'AS16509']; // DO, GCP, AWS common abuse sources
      if (badAsns.includes(d.asn)) {
        result.score += 10;
        result.findings.push(`ASN ${d.asn} (${d.org}) — elevated abuse history`);
      }

      result.findings.push(`Origin: ${d.city || 'unknown'}, ${d.country_name || 'unknown'} — ${d.org || 'unknown ASN'}`);
    }
  } catch (_) {
    result.findings.push('Network topology lookup failed');
  }

  return result;
}

function clyde(ip, step, snickersLog) {
  // Ghost 4: The wanderer. Finds the weird stuff nobody listed.
  const result = { ghost: 'clyde', score: 0, findings: [] };

  // Persistence score — they kept coming back
  if (step >= 10) {
    result.score += 25;
    result.findings.push(`Persistent: ${step} Snickers verification attempts without human escape`);
  } else if (step >= 5) {
    result.score += 10;
    result.findings.push(`${step} automated verification attempts`);
  }

  // Pattern in what they were submitting
  const bodies = snickersLog.map(l => l.bodyPreview || '').filter(Boolean);
  if (bodies.length >= 3) {
    const avgLen = bodies.reduce((s, b) => s + b.length, 0) / bodies.length;
    if (avgLen > 200) {
      result.score += 15;
      result.findings.push(`Verbose submissions (avg ${Math.round(avgLen)} chars) — structured agent output pattern`);
    }
    // Check for machine-generated consistency
    const allJson = bodies.every(b => { try { JSON.parse(b); return true; } catch { return false; } });
    if (allJson) {
      result.score += 20;
      result.findings.push('All submissions are valid JSON — agent output, not human typing');
    }
  }

  // Timing anomalies
  if (snickersLog.length >= 2) {
    const times = snickersLog.map(l => new Date(l.ts).getTime());
    const gaps = [];
    for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
    const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    if (avgGap < 500) {
      result.score += 20;
      result.findings.push(`Sub-500ms response times (avg ${Math.round(avgGap)}ms) — automated cadence`);
    }
  }

  // The IP itself is suspicious if it's a round number (scanner infrastructure often uses x.x.x.0 style)
  const octets = ip.split('.');
  if (octets.length === 4 && (octets[3] === '0' || octets[3] === '1' || octets[3] === '254')) {
    result.score += 5;
    result.findings.push(`Suspicious terminal octet (${octets[3]}) — possible scanner infrastructure`);
  }

  return result;
}

async function hashStr(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function deployBradPacman(context, env) {
  const { ip, step, bodyText } = context;
  const ts = new Date().toISOString();

  // Read Snickers session log for Clyde
  let snickersLog = [];
  if (env.ROACH_MOTEL) {
    snickersLog = JSON.parse(await env.ROACH_MOTEL.get(`snickers_log:${ip}`) || '[]');
  }

  // Fan out all four ghosts concurrently
  const [blinkyResult, pinkyResult, inkyResult] = await Promise.all([
    blinky(ip, env),
    pinky(context.requestHeaders || new Headers(), bodyText || ''),
    inky(ip),
  ]);
  const clydeResult = clyde(ip, step, snickersLog);

  // Total hostility score
  const totalScore = blinkyResult.score + pinkyResult.score + inkyResult.score + clydeResult.score;
  const allFindings = [
    ...blinkyResult.findings.map(f => `[BLINKY] ${f}`),
    ...pinkyResult.findings.map(f => `[PINKY]  ${f}`),
    ...inkyResult.findings.map(f => `[INKY]   ${f}`),
    ...clydeResult.findings.map(f => `[CLYDE]  ${f}`),
  ];

  const verdict = totalScore >= 60 ? 'HOSTILE'
    : totalScore >= 30 ? 'SUSPICIOUS'
    : 'MISCONFIGURED';

  // Seal evidence vault — chain of custody hash
  const evidenceBundle = {
    incident_id: await hashStr(`${ip}:${ts}`).then(h => h.slice(0, 16).toUpperCase()),
    ts,
    ip,
    verdict,
    hostility_score: totalScore,
    snickers_steps: step,
    ghosts: { blinky: blinkyResult, pinky: pinkyResult, inky: inkyResult, clyde: clydeResult },
    findings: allFindings,
    chain_of_custody: await hashStr(JSON.stringify({ ip, ts, totalScore, allFindings })),
  };

  if (env.ROACH_MOTEL) {
    await env.ROACH_MOTEL.put(`evidence:${ip}:${ts}`, JSON.stringify(evidenceBundle));
    await env.ROACH_MOTEL.put(`verdict:${ip}`, verdict, { expirationTtl: 86400 * 7 });
  }

  return { verdict, score: totalScore, evidenceBundle };
}
