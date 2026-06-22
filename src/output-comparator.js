'use strict';

// output-comparator.js — semantic comparison of two agent outputs
// Uses Claude Haiku to extract key claims, then scores word-level overlap.
// match threshold: 0.85

const Anthropic = require('@anthropic-ai/sdk');

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic();
  return _client;
}

async function extractClaims(text) {
  const msg = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    messages: [{
      role: 'user',
      content: `Extract the key factual claims from this text as a concise bullet list. One claim per line, starting with "-". Only include specific, verifiable claims.\n\n${text}`,
    }],
  });
  return msg.content[0].text
    .split('\n')
    .filter(l => l.trim().startsWith('-'))
    .map(l => l.replace(/^-\s*/, '').trim())
    .filter(Boolean);
}

function claimsOverlap(a, b) {
  const wordsA = new Set(a.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const wordsB = new Set(b.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  if (wordsA.size === 0) return false;
  const shared = [...wordsA].filter(w => wordsB.has(w));
  return shared.length >= Math.min(2, Math.ceil(wordsA.size * 0.4));
}

function scoreOverlap(claimsA, claimsB) {
  if (claimsA.length === 0 && claimsB.length === 0) return 1.0;
  if (claimsA.length === 0 || claimsB.length === 0) return 0.0;
  let matched = 0;
  for (const a of claimsA) {
    if (claimsB.some(b => claimsOverlap(a, b))) matched++;
  }
  return matched / Math.max(claimsA.length, claimsB.length);
}

async function compareOutputs(outputA, outputB) {
  const [claimsA, claimsB] = await Promise.all([
    extractClaims(outputA),
    extractClaims(outputB),
  ]);

  const score = scoreOverlap(claimsA, claimsB);
  const match = score >= 0.85;

  const onlyA = claimsA.filter(a => !claimsB.some(b => claimsOverlap(a, b)));
  const onlyB = claimsB.filter(b => !claimsA.some(a => claimsOverlap(a, b)));

  return {
    match,
    score: Math.round(score * 1000) / 1000,
    claims_a: claimsA,
    claims_b: claimsB,
    only_in_a: onlyA,
    only_in_b: onlyB,
    diff_summary: match
      ? 'Outputs agree.'
      : `Divergence detected. Agent A has ${onlyA.length} unique claim(s); Agent B has ${onlyB.length} unique claim(s).`,
  };
}

module.exports = { compareOutputs };
