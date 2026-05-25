const fs = require('fs');
const path = require('path');

const dir = path.join('public');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

let updated = 0;
for (const f of files) {
  const fp = path.join(dir, f);
  let content = fs.readFileSync(fp, 'utf8');

  // Only process files with desktop nav (has Arena link in nav)
  if (!content.includes('<a href="/arena.html">Arena</a>')) continue;

  // Skip if already has compatibility in desktop nav (not just mobile drawer)
  // Check for it appearing AFTER the <nav> tag and BEFORE the </nav> tag
  const navStart = content.indexOf('<nav>');
  const navEnd = content.indexOf('</nav>', navStart);
  if (navStart === -1 || navEnd === -1) continue;

  const navContent = content.slice(navStart, navEnd);
  if (navContent.includes('compatibility.html')) {
    console.log('Already has compat in nav:', f);
    continue;
  }

  // Add Compatibility link after Arena in the desktop nav
  content = content.replace(
    '<a href="/arena.html">Arena</a>\n    <a href="/contact.html">Contact</a>',
    '<a href="/arena.html">Arena</a>\n    <a href="/compatibility.html">Compatibility</a>\n    <a href="/contact.html">Contact</a>'
  );

  fs.writeFileSync(fp, content, 'utf8');
  console.log('Updated:', f);
  updated++;
}
console.log('Done. Updated', updated, 'files.');
