// One-time script: add testnet banner + grouped Products nav to all public pages
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');

// Pages and which nav item should be "active"
// active: 'home' | 'products' | 'pricing' | 'contact' | 'whitepaper' | null
const pages = {
  'index.html':          { active: 'home' },
  'platform.html':       { active: 'products' },
  'context-vault.html':  { active: 'products' },
  'operator-vault.html': { active: 'products' },
  'trust-score.html':    { active: 'products' },
  'contract-audit.html': { active: 'products' },
  'arbitration.html':    { active: 'products' },
  'pricing.html':        { active: 'pricing' },
  'contact.html':        { active: 'contact' },
  'aats-whitepaper.html':{ active: 'whitepaper' },
};

// CSS to inject into each page's <style> block
const navCSS = `
    /* ── Testnet banner ── */
    .testnet-banner {
      background: #1a1200;
      border-bottom: 1px solid #3a2a00;
      padding: 7px 0;
      text-align: center;
      font-size: 12px;
      font-weight: 600;
      color: #c8a83a;
      letter-spacing: 0.5px;
    }

    /* ── Products dropdown ── */
    .nav-dropdown { position: relative; display: inline-flex; align-items: center; }

    .nav-dropdown-btn {
      background: none;
      border: none;
      cursor: pointer;
      color: #666;
      font-size: 14px;
      padding: 6px 12px;
      border-radius: 6px;
      transition: all 0.2s;
      font-family: inherit;
    }
    .nav-dropdown-btn:hover { color: #ccc; background: #141414; }
    .nav-dropdown-btn.active { color: #fff; }

    .nav-dropdown-menu {
      display: none;
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      background: #111;
      border: 1px solid #222;
      border-radius: 10px;
      padding: 6px;
      min-width: 200px;
      z-index: 200;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .nav-dropdown:hover .nav-dropdown-menu { display: block; }

    .nav-dropdown-menu a {
      display: block;
      padding: 8px 12px;
      font-size: 13px;
      color: #888;
      text-decoration: none;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .nav-dropdown-menu a:hover { color: #fff; background: #1a1a1a; }
    .nav-dropdown-menu a.active { color: #7c6af7; }

    .nav-dropdown-menu .menu-divider {
      height: 1px;
      background: #1e1e1e;
      margin: 4px 6px;
    }
`;

const testnetBanner = `<div class="testnet-banner">⚠ Testnet — all transactions use test HBAR · not for production use</div>`;

const signinBtn = `<a href="/console-login.html" style="margin-left:8px;background:#6ee7b7;color:#0a0a0a;font-size:13px;font-weight:700;padding:7px 16px;border-radius:8px;text-decoration:none;transition:opacity 0.15s;" onmouseover="this.style.opacity='0.85'" onmouseout="this.style.opacity='1'">Sign In</a>`;

function buildNav(active, hasSignIn) {
  const homeActive = active === 'home' ? ' class="active"' : '';
  const productsActive = active === 'products' ? ' class="active"' : '';
  const pricingActive = active === 'pricing' ? ' class="active"' : '';
  const contactActive = active === 'contact' ? ' class="active"' : '';

  // Determine which product sublink is active
  const cvActive = active === 'products' ? '' : '';

  return `<nav>
    <a href="/"${homeActive} style="color:${active==='home'?'#fff':'#666'};text-decoration:none;font-size:14px;padding:6px 12px;border-radius:6px;transition:all 0.2s;" onmouseover="if(this.style.color!='#fff')this.style.color='#ccc'" onmouseout="if('${active}'!=='home')this.style.color='#666'">Home</a>
    <div class="nav-dropdown">
      <button class="nav-dropdown-btn${active==='products'?' active':''}">Products ▾</button>
      <div class="nav-dropdown-menu">
        <a href="/platform.html">Platform Overview</a>
        <div class="menu-divider"></div>
        <a href="/context-vault.html">Context Vault</a>
        <a href="/operator-vault.html">Operator Vault</a>
        <a href="/trust-score.html">Trust Score</a>
        <a href="/contract-audit.html">Contract Audit</a>
      </div>
    </div>
    <a href="/pricing.html"${pricingActive} style="color:${active==='pricing'?'#fff':'#666'};text-decoration:none;font-size:14px;padding:6px 12px;border-radius:6px;transition:all 0.2s;" onmouseover="if(this.style.color!='#fff')this.style.color='#ccc'" onmouseout="if('${active}'!=='pricing')this.style.color='#666'">Pricing</a>
    <a href="/contact.html"${contactActive} style="color:${active==='contact'?'#fff':'#666'};text-decoration:none;font-size:14px;padding:6px 12px;border-radius:6px;transition:all 0.2s;" onmouseover="if(this.style.color!='#fff')this.style.color='#ccc'" onmouseout="if('${active}'!=='contact')this.style.color='#666'">Contact</a>
    ${signinBtn}
  </nav>`;
}

// Regex to match the nav block in each page
// Handles both <nav>...</nav> patterns
const navRegex = /<nav>[\s\S]*?<\/nav>/;

// Also remove old status-badge spans that are inside headers (testnet badge in nav)
const statusBadgeRegex = /\s*<span class="status-badge">.*?<\/span>/g;

// Old Sign In button variations
const oldSigninRegex = /\s*<a href="\/console-login\.html"[\s\S]*?<\/a>(?=\s*<\/nav|\s*<\/header)/;

for (const [filename, config] of Object.entries(pages)) {
  const filepath = path.join(publicDir, filename);
  if (!fs.existsSync(filepath)) {
    console.log(`SKIP (not found): ${filename}`);
    continue;
  }

  let html = fs.readFileSync(filepath, 'utf8');

  // 1. Inject nav CSS before closing </style>
  if (!html.includes('nav-dropdown-btn')) {
    html = html.replace('</style>', navCSS + '  </style>');
  }

  // 2. Add testnet banner after <body> if not already there
  if (!html.includes('testnet-banner')) {
    html = html.replace(/(<body[^>]*>)/, `$1\n${testnetBanner}`);
  }

  // 3. Remove old status-badge (testnet badge in nav)
  html = html.replace(statusBadgeRegex, '');

  // 4. Remove old inline Sign In button (will be added back in new nav)
  html = html.replace(oldSigninRegex, '');

  // 5. Replace nav
  const newNav = buildNav(config.active, true);
  if (navRegex.test(html)) {
    html = html.replace(navRegex, newNav);
  } else {
    console.log(`WARN: no nav found in ${filename}`);
  }

  fs.writeFileSync(filepath, html, 'utf8');
  console.log(`✓ ${filename}`);
}

console.log('\nDone.');
