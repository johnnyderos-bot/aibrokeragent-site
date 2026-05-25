/**
 * OFAC SDN Sanctions Screening
 *
 * Downloads and caches the OFAC Consolidated Sanctions List.
 * Screens crypto addresses and entity names before escrow operations.
 *
 * Policy: fail-open on download failure (use stale cache + log warning).
 * Hard-block on confirmed match — strict liability applies regardless of intent.
 *
 * Refresh: every 24 hours automatically.
 */

const https = require('https');

// Sanctions lists — all publicly available
const LISTS = [
  {
    name: 'OFAC',
    url: 'https://ofac.treasury.gov/downloads/consolidated/consolidated.csv',
    format: 'ofac_csv',
    fallback: 'https://www.treasury.gov/ofac/downloads/consolidated/consolidated.csv',
  },
  {
    name: 'UN',
    url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
    format: 'un_xml',
    fallback: 'https://scsanctions.un.org/consolidated.xml',
  },
  {
    name: 'UK_OFSI',
    url: 'https://ofsistorage.blob.core.windows.net/publishlive/2022format/ConList.csv',
    format: 'uk_csv',
  },
  {
    name: 'EU',
    url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
    format: 'eu_xml',
  },
];

// Match digital currency addresses from OFAC remarks fields
// Covers: ETH/EVM (0x...), Bitcoin (1..., 3..., bc1...), XMR (4...)
const ADDR_RE = /(?:Digital Currency Address[^"]*?)(0x[a-fA-F0-9]{40}|[13][a-zA-Z0-9]{25,34}|bc1[a-z0-9]{6,87}|4[0-9AB][1-9A-HJ-NP-Za-km-z]{93})/gi;

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

let _cache = {
  addresses: new Set(), // normalized lowercase
  names: [],            // SDN entity names, lowercase
  loaded_at: null,
  stale: false,
};

// ── CSV helpers ───────────────────────────────────────────────────────────────

// Split one CSV line respecting quoted fields
function splitCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuote = !inQuote;
    } else if (ch === ',' && !inQuote) {
      fields.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur.trim());
  return fields;
}

// ── Download ─────────────────────────────────────────────────────────────────

function downloadText(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

// ── Parsers ───────────────────────────────────────────────────────────────────

function parseOfacCsv(csv) {
  const addresses = new Set();
  const names = [];
  const lines = csv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let m; ADDR_RE.lastIndex = 0;
    while ((m = ADDR_RE.exec(line)) !== null) addresses.add(m[1].toLowerCase());
    const fields = splitCsvLine(line);
    const name = fields[0]?.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (name && name.length > 1) names.push(name);
  }
  return { addresses, names };
}

function parseUnXml(xml) {
  const addresses = new Set();
  const names = [];
  // Extract FIRST_NAME/SECOND_NAME/THIRD_NAME/FOURTH_NAME tags
  const nameParts = [...xml.matchAll(/<(?:FIRST|SECOND|THIRD|FOURTH|WHOLE)_NAME>([^<]+)<\//gi)];
  if (nameParts.length) names.push(...nameParts.map(m => m[1].toLowerCase().trim()).filter(n => n.length > 1));
  // UN list rarely has crypto addresses but check anyway
  let m; ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(xml)) !== null) addresses.add(m[1].toLowerCase());
  return { addresses, names };
}

function parseUkCsv(csv) {
  const addresses = new Set();
  const names = [];
  const lines = csv.split('\n');
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let m; ADDR_RE.lastIndex = 0;
    while ((m = ADDR_RE.exec(line)) !== null) addresses.add(m[1].toLowerCase());
    const fields = splitCsvLine(line);
    // UK format: Name6 is often "Name"
    const name = (fields[5] || fields[0] || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
    if (name && name.length > 1) names.push(name);
  }
  return { addresses, names };
}

function parseEuXml(xml) {
  // EU XML: <nameAlias wholeName="..."> or <lastName>/<firstName>
  const addresses = new Set();
  const names = [];
  const wholeNames = [...xml.matchAll(/wholeName="([^"]+)"/gi)];
  names.push(...wholeNames.map(m => m[1].toLowerCase().trim()).filter(n => n.length > 1));
  const lastNames = [...xml.matchAll(/<lastName>([^<]+)<\//gi)];
  names.push(...lastNames.map(m => m[1].toLowerCase().trim()).filter(n => n.length > 1));
  let m; ADDR_RE.lastIndex = 0;
  while ((m = ADDR_RE.exec(xml)) !== null) addresses.add(m[1].toLowerCase());
  return { addresses, names };
}

function parseList(content, format) {
  switch (format) {
    case 'ofac_csv': return parseOfacCsv(content);
    case 'un_xml':   return parseUnXml(content);
    case 'uk_csv':   return parseUkCsv(content);
    case 'eu_xml':   return parseEuXml(content);
    default:         return { addresses: new Set(), names: [] };
  }
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refreshCache(silent = false) {
  if (!silent) console.log('[ofac] downloading sanctions lists...');

  const allAddresses = new Set();
  const allNames = [];
  let anyLoaded = false;

  await Promise.allSettled(LISTS.map(async (list) => {
    let content = null;
    let source = list.url;
    try {
      content = await downloadText(list.url);
    } catch (err) {
      console.warn(`[ofac] ${list.name} primary URL failed: ${err.message}`);
      if (list.fallback) {
        try {
          content = await downloadText(list.fallback);
          source = list.fallback;
        } catch (err2) {
          console.warn(`[ofac] ${list.name} fallback also failed: ${err2.message}`);
        }
      }
    }
    if (!content) return;
    try {
      const { addresses, names } = parseList(content, list.format);
      addresses.forEach(a => allAddresses.add(a));
      allNames.push(...names);
      anyLoaded = true;
      console.log(`[ofac] ${list.name}: ${addresses.size} addresses, ${names.length} names`);
    } catch (parseErr) {
      console.warn(`[ofac] ${list.name} parse failed: ${parseErr.message}`);
    }
  }));

  if (anyLoaded) {
    _cache = { addresses: allAddresses, names: allNames, loaded_at: Date.now(), stale: false };
    console.log(`[ofac] total: ${allAddresses.size} addresses, ${allNames.length} names across ${LISTS.length} lists`);
  } else if (_cache.loaded_at) {
    _cache.stale = true;
    console.warn(`[ofac] all list downloads failed — using stale cache from ${new Date(_cache.loaded_at).toISOString()}`);
  } else {
    console.error('[ofac] WARN: all sanctions lists unavailable and no cache exists. Screening is INACTIVE.');
  }
}

// Schedule daily refresh
function startAutoRefresh() {
  // First refresh already done at init — schedule subsequent ones
  setInterval(() => refreshCache(), CACHE_TTL_MS);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Check a crypto/Hedera address against the SDN list.
 * Returns { blocked: true, match } or { blocked: false }.
 */
function checkAddress(address) {
  if (!address) return { blocked: false };
  const normalized = address.toLowerCase().replace(/\s/g, '');
  if (_cache.addresses.has(normalized)) {
    return { blocked: true, match: normalized, list: 'SDN', reason: 'address on OFAC SDN list' };
  }
  return { blocked: false };
}

/**
 * Check an entity name against the SDN list.
 * Uses exact match first, then substring match restricted to multi-word SDN entries
 * (entries with a space) to avoid false positives from common first/last name fragments.
 * Returns { blocked: true, match } or { blocked: false }.
 */
function checkName(name) {
  if (!name) return { blocked: false };
  const normalized = name.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  if (normalized.length < 4) return { blocked: false };

  // Exact match first
  if (_cache.names.includes(normalized)) {
    return { blocked: true, match: normalized, list: 'SDN', reason: 'name on OFAC SDN list' };
  }

  // Substring match — only check SDN entries that are full multi-word names (contain a space
  // and are at least 6 chars) to prevent single-word fragments like "john" or "ai" from
  // triggering a block on any name that contains that word.
  const sdnMatch = _cache.names.find(n => {
    if (n.length < 6 || !n.includes(' ')) return false;
    return n.includes(normalized) || normalized.includes(n);
  });
  if (sdnMatch) {
    return { blocked: true, match: sdnMatch, list: 'SDN', reason: 'name matches OFAC SDN entry' };
  }
  return { blocked: false };
}

/**
 * Screen an agent before a financial operation.
 * Checks hedera_account and evm_address (if present).
 * Returns { blocked: false } or { blocked: true, reason, match }.
 */
function screenAgent(agent) {
  if (!agent) return { blocked: false };
  if (agent.hedera_account) {
    const r = checkAddress(agent.hedera_account);
    if (r.blocked) return r;
  }
  if (agent.evm_address) {
    const r = checkAddress(agent.evm_address);
    if (r.blocked) return r;
  }
  return { blocked: false };
}

function isReady() {
  return !!_cache.loaded_at;
}

function isStale() {
  return _cache.stale;
}

function cacheInfo() {
  return {
    loaded_at: _cache.loaded_at ? new Date(_cache.loaded_at).toISOString() : null,
    address_count: _cache.addresses.size,
    name_count: _cache.names.length,
    stale: _cache.stale,
    active: !!_cache.loaded_at,
  };
}

// ── Init ──────────────────────────────────────────────────────────────────────

// Non-blocking startup load
refreshCache(true).then(() => startAutoRefresh());

module.exports = { checkAddress, checkName, screenAgent, refreshCache, isReady, isStale, cacheInfo };
