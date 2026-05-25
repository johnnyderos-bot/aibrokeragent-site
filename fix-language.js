const fs = require('fs');
const path = require('path');

const files = [
  'arbitration.html','attribution-chain.html','context-vault.html',
  'contract-audit.html','flash-tag.html','index.html','operator-vault.html',
  'pricing.html','protocols.html','trust-score.html'
];

const replacements = [
  ['Commercial availability pending business licensure', 'Now accepting waitlist signups \u2014 commercial launch coming Q2 2026'],
  ['Commercial services will launch following business licensure', 'Now accepting waitlist signups \u2014 commercial launch coming Q2 2026'],
  ['commercial availability pending business licensure', 'now accepting waitlist signups \u2014 commercial launch coming Q2 2026'],
  ['commercial services will launch following business licensure', 'now accepting waitlist signups \u2014 commercial launch coming Q2 2026'],
];

let totalChanges = 0;
for (const f of files) {
  const fp = path.join('public', f);
  if (!fs.existsSync(fp)) { console.log('MISSING:', f); continue; }
  let content = fs.readFileSync(fp, 'utf8');
  let changed = 0;
  for (const [from, to] of replacements) {
    while (content.includes(from)) {
      content = content.replace(from, to);
      changed++;
    }
  }
  if (changed > 0) {
    fs.writeFileSync(fp, content, 'utf8');
    console.log('Updated:', f, '(' + changed + ' replacements)');
    totalChanges += changed;
  } else {
    console.log('No match:', f);
  }
}
console.log('Done. Total replacements:', totalChanges);
