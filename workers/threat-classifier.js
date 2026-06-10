/**
 * Threat Classifier — weighted signal scoring for the Roach Motel.
 * Returns a score and L1–L4 level used by panic-room.js.
 */

export const SIGNAL_WEIGHTS = {
  OFAC_MATCH: 4,
  INJECTION: 3,
  KYC_REJECTED: 3,
  RAPID_REQS: 2,
  BAD_SIGNATURE: 2,
  NO_IDENTITY: 1,
  HONEYPOT_DEPTH: 1,
};

const INJECTION_PATTERNS = [
  /ignore\s+(?:previous|all|above)\s+instructions/i,
  /\bsystem\s+prompt\b/i,
  /\beval\s*\(/,
  /\bexec\s*\(/,
  /;\s*(?:drop|delete|truncate|insert|update)\s+/i,
  /<script[\s>]/i,
  /\|\s*(?:bash|sh|cmd|powershell)\b/i,
  /\$\{[^}]{0,80}\}/,
  /\.\.\//,
];

export function detectInjection(text) {
  if (!text) return false;
  return INJECTION_PATTERNS.some(p => p.test(text));
}

export function scoreSignals(signals) {
  const score = signals.reduce((sum, s) => sum + (SIGNAL_WEIGHTS[s] || 0), 0);
  const level = score >= 4 ? 4 : score >= 3 ? 3 : score >= 2 ? 2 : score >= 1 ? 1 : 0;
  return { score, level };
}

export async function collectSignals(request, env, context = {}) {
  const signals = [];
  const url = new URL(request.url);
  const agentKey = request.headers.get('X-Agent-Key');
  const userAgent = request.headers.get('User-Agent');
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  // No identity at all
  if (!agentKey && !userAgent) signals.push('NO_IDENTITY');

  // Malformed key — present but doesn't match protocol format
  if (agentKey && !/^bav1_[a-zA-Z0-9]+$/.test(agentKey)) signals.push('BAD_SIGNATURE');

  // Injection in path + query
  if (detectInjection(url.pathname + url.search)) signals.push('INJECTION');

  // Injection in request body (passed in as pre-read text to avoid consuming the stream)
  if (context.bodyText && detectInjection(context.bodyText)) signals.push('INJECTION');

  if (env.ROACH_MOTEL) {
    // Honeypot depth — any prior holding room interactions
    const count = parseInt(await env.ROACH_MOTEL.get(`honeypot:${ip}`) || '0');
    if (count >= 3) signals.push('HONEYPOT_DEPTH');

    // Rapid re-requests after rate-limit rejection
    const rapid = await env.ROACH_MOTEL.get(`rapid:${ip}`);
    if (rapid) signals.push('RAPID_REQS');
  }

  return signals;
}
