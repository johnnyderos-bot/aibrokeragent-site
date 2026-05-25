// One-time script: inject comprehensive mobile CSS into all public pages
const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, '../public');

const pages = [
  'index.html',
  'platform.html',
  'pricing.html',
  'context-vault.html',
  'operator-vault.html',
  'trust-score.html',
  'contact.html',
  'aats-whitepaper.html',
  'arbitration.html',
  'contract-audit.html',
];

// Shared mobile CSS injected before </style>
// Uses a unique marker so we don't double-inject
const MARKER = '/* ── Mobile responsive ── */';

const mobileCss = `
    ${MARKER}
    @media (max-width: 768px) {

      /* Banner */
      .testnet-banner { font-size: 11px; padding: 6px 12px; }

      /* Header */
      header {
        padding: 14px 16px !important;
        flex-wrap: wrap;
        gap: 10px;
      }

      /* Hide nav links on mobile — show hamburger */
      nav .nav-links-group { display: none; }

      nav {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      /* Hamburger button */
      .nav-hamburger {
        display: flex !important;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        background: none;
        border: 1px solid #2a2a2a;
        border-radius: 6px;
        padding: 7px 9px;
        cursor: pointer;
      }
      .nav-hamburger span {
        display: block;
        width: 18px;
        height: 2px;
        background: #aaa;
        border-radius: 2px;
        transition: all 0.2s;
      }

      /* Mobile nav drawer */
      .nav-mobile-drawer {
        display: none;
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(0,0,0,0.85);
        z-index: 999;
        padding: 24px;
        flex-direction: column;
        gap: 0;
      }
      .nav-mobile-drawer.open { display: flex !important; }
      .nav-mobile-drawer a {
        display: block;
        padding: 14px 8px;
        font-size: 18px;
        font-weight: 600;
        color: #ccc;
        text-decoration: none;
        border-bottom: 1px solid #1a1a1a;
        transition: color 0.15s;
      }
      .nav-mobile-drawer a:hover { color: #fff; }
      .nav-mobile-drawer a.active { color: #7c6af7; }
      .nav-mobile-drawer .drawer-close {
        align-self: flex-end;
        background: none;
        border: none;
        color: #666;
        font-size: 24px;
        cursor: pointer;
        margin-bottom: 16px;
        padding: 4px 8px;
      }
      .nav-mobile-drawer .drawer-section {
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: #444;
        padding: 16px 8px 8px;
      }
      .nav-mobile-drawer .signin-btn {
        margin-top: 24px;
        background: #6ee7b7;
        color: #0a0a0a !important;
        border-radius: 8px;
        text-align: center;
        font-weight: 700;
        border-bottom: none !important;
      }

      /* Hero */
      .hero-section { padding: 48px 20px 40px !important; }
      .hero-h1 { font-size: 36px !important; letter-spacing: -1px !important; }
      .hero-sub { font-size: 16px !important; }
      .hero h1 { font-size: 30px !important; }
      .hero p { font-size: 16px !important; }
      h1 { font-size: 32px !important; }

      /* Sections */
      .stats-section,
      .products-section,
      .stack-section,
      .panel,
      main { padding-left: 16px !important; padding-right: 16px !important; }

      /* Grids → single column */
      .stats-grid { grid-template-columns: repeat(2, 1fr) !important; }
      .products-grid { grid-template-columns: 1fr !important; }
      .tier-grid { grid-template-columns: 1fr !important; }
      .credits-box { grid-template-columns: 1fr !important; gap: 20px !important; }

      /* Trust boost 2-col → 1-col */
      div[style*="grid-template-columns:1fr 1fr"] {
        grid-template-columns: 1fr !important;
      }

      /* Tables — horizontal scroll */
      .fee-table, table {
        display: block;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        font-size: 13px;
      }

      /* Tabs — scrollable */
      .tabs {
        padding: 0 16px !important;
        overflow-x: auto;
        -webkit-overflow-scrolling: touch;
        flex-wrap: nowrap !important;
      }
      .tab { white-space: nowrap; padding: 12px 16px !important; }

      /* Footer grid → single column */
      footer div[style*="grid-template-columns"] {
        grid-template-columns: 1fr !important;
        gap: 24px !important;
      }
      footer { padding: 32px 16px 24px !important; }

      /* Cards */
      .card { padding: 20px !important; }

      /* Page header */
      .page-header h1 { font-size: 32px !important; }
      .page-header p { font-size: 15px !important; }

      /* Stack row */
      .stack-row-item { flex-wrap: wrap; gap: 12px !important; }

      /* Stat number */
      .stat-number { font-size: 28px !important; }

      /* CTA row */
      .cta-row { flex-direction: column; align-items: center; }
      .cta-row a, .btn { width: 100%; max-width: 320px; text-align: center; }
    }

    /* Hamburger always hidden on desktop */
    .nav-hamburger { display: none; }
    .nav-mobile-drawer { display: none; }
`;

// Hamburger + drawer HTML injected right after <body>
function buildDrawer(active) {
  const links = [
    { href: '/', label: 'Home', key: 'home' },
    { href: '/platform.html', label: 'Platform Overview', key: 'products', section: 'Products' },
    { href: '/context-vault.html', label: 'Context Vault', key: 'products' },
    { href: '/operator-vault.html', label: 'Operator Vault', key: 'products' },
    { href: '/trust-score.html', label: 'Trust Score', key: 'products' },
    { href: '/contract-audit.html', label: 'Contract Audit', key: 'products' },
    { href: '/pricing.html', label: 'Pricing', key: 'pricing', section: 'More' },
    { href: '/contact.html', label: 'Contact', key: 'contact' },
    { href: '/aats-whitepaper.html', label: 'AATS Whitepaper', key: 'whitepaper' },
  ];

  let linksHtml = '';
  let lastSection = null;
  for (const l of links) {
    if (l.section && l.section !== lastSection) {
      linksHtml += `<div class="drawer-section">${l.section}</div>`;
      lastSection = l.section;
    }
    const isActive = l.key === active ? ' class="active"' : '';
    linksHtml += `<a href="${l.href}"${isActive}>${l.label}</a>`;
  }
  linksHtml += `<a href="/console-login.html" class="signin-btn">Sign In</a>`;

  return `
<div class="nav-mobile-drawer" id="mobileDrawer">
  <button class="drawer-close" onclick="document.getElementById('mobileDrawer').classList.remove('open')">✕</button>
  ${linksHtml}
</div>
<script>
  function openDrawer() { document.getElementById('mobileDrawer').classList.add('open'); }
  document.getElementById('mobileDrawer').addEventListener('click', function(e) {
    if (e.target === this) this.classList.remove('open');
  });
</script>`;
}

// Map filenames to active keys
const activeMap = {
  'index.html':          'home',
  'platform.html':       'products',
  'context-vault.html':  'products',
  'operator-vault.html': 'products',
  'trust-score.html':    'products',
  'contract-audit.html': 'products',
  'arbitration.html':    'products',
  'pricing.html':        'pricing',
  'contact.html':        'contact',
  'aats-whitepaper.html':'whitepaper',
};

for (const filename of pages) {
  const filepath = path.join(publicDir, filename);
  if (!fs.existsSync(filepath)) { console.log(`SKIP: ${filename}`); continue; }

  let html = fs.readFileSync(filepath, 'utf8');

  // Skip if already processed
  if (html.includes(MARKER)) { console.log(`- already done: ${filename}`); continue; }

  // 1. Inject mobile CSS before </style>
  html = html.replace('</style>', mobileCss + '\n  </style>');

  // 2. Add hamburger button to nav (right before closing </nav>)
  html = html.replace('</nav>', `<button class="nav-hamburger" onclick="openDrawer()" aria-label="Open menu">
      <span></span><span></span><span></span>
    </button>
  </nav>`);

  // 3. Inject drawer after <body> or after testnet-banner
  const drawer = buildDrawer(activeMap[filename] || null);
  if (html.includes('class="testnet-banner"')) {
    html = html.replace(
      /(<div class="testnet-banner">.*?<\/div>)/,
      `$1${drawer}`
    );
  } else {
    html = html.replace('<body>', `<body>${drawer}`);
  }

  fs.writeFileSync(filepath, html, 'utf8');
  console.log(`✓ ${filename}`);
}

console.log('\nDone.');
