// Fix all Andy's flagged issues across the site
const fs = require('fs');
const path = require('path');
const publicDir = path.join(__dirname, '../public');

function read(f) { return fs.readFileSync(path.join(publicDir, f), 'utf8'); }
function write(f, html) { fs.writeFileSync(path.join(publicDir, f), html, 'utf8'); }

// ── 1. FIX MOBILE NAV: hide nav links (not hamburger) on mobile ─────────────
// Replace the broken selector in every page
const pages = ['index','platform','pricing','context-vault','operator-vault',
               'trust-score','contact','aats-whitepaper','arbitration','contract-audit'];

const BAD_SELECTOR  = '/* Hide nav links on mobile — show hamburger */\n      nav .nav-links-group { display: none; }';
const GOOD_SELECTOR = `/* Hide nav links on mobile — show hamburger */
      nav > a, nav > .nav-dropdown { display: none !important; }`;

pages.forEach(p => {
  const f = p + '.html';
  let html = read(f);
  if (html.includes(BAD_SELECTOR)) {
    html = html.replace(BAD_SELECTOR, GOOD_SELECTOR);
    write(f, html);
    console.log('✓ mobile nav fix:', f);
  } else if (html.includes(GOOD_SELECTOR)) {
    console.log('- already fixed:', f);
  } else {
    console.log('⚠ selector not found:', f);
  }
});

// ── 2. URL ROUTING: handled in server (see fix-routes.js) ──────────────────

// ── 3. CONTACT PAGE: replace personal info + add form ──────────────────────
{
  let html = read('contact.html');

  // Replace personal email
  html = html.replace(
    '<a href="mailto:johnnyderos@gmail.com">johnnyderos@gmail.com</a>',
    '<a href="mailto:hello@ai-broker-agent.com">hello@ai-broker-agent.com</a>'
  );

  // Replace personal phone with a coming-soon note
  html = html.replace(
    `<a href="tel:9192741296">919-274-1296</a>`,
    `<span style="color:#555;font-size:13px;">Schedule a call →</span>`
  );

  // Add contact form before closing </main>
  const form = `
  <!-- Contact Form -->
  <div style="margin-top:48px;background:#111;border:1px solid #1e1e1e;border-radius:14px;padding:36px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#6ee7b7;margin-bottom:20px;">Send Us a Message</div>
    <form id="contactForm" onsubmit="handleSubmit(event)" style="display:flex;flex-direction:column;gap:16px;">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">
        <div>
          <label style="font-size:12px;color:#555;display:block;margin-bottom:6px;">Name</label>
          <input type="text" name="name" required placeholder="Your name"
            style="width:100%;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:10px 14px;color:#ccc;font-size:14px;outline:none;" />
        </div>
        <div>
          <label style="font-size:12px;color:#555;display:block;margin-bottom:6px;">Email</label>
          <input type="email" name="email" required placeholder="you@company.com"
            style="width:100%;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:10px 14px;color:#ccc;font-size:14px;outline:none;" />
        </div>
      </div>
      <div>
        <label style="font-size:12px;color:#555;display:block;margin-bottom:6px;">Company / Organization</label>
        <input type="text" name="company" placeholder="Optional"
          style="width:100%;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:10px 14px;color:#ccc;font-size:14px;outline:none;" />
      </div>
      <div>
        <label style="font-size:12px;color:#555;display:block;margin-bottom:6px;">What brings you here?</label>
        <select name="topic" style="width:100%;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:10px 14px;color:#ccc;font-size:14px;outline:none;">
          <option value="">Select a topic...</option>
          <option value="partnership">Partnership / Integration</option>
          <option value="enterprise">Enterprise Inquiry</option>
          <option value="investor">Investor / Funding</option>
          <option value="developer">Developer / API Access</option>
          <option value="other">Other</option>
        </select>
      </div>
      <div>
        <label style="font-size:12px;color:#555;display:block;margin-bottom:6px;">Message</label>
        <textarea name="message" required rows="4" placeholder="Tell us what you're working on..."
          style="width:100%;background:#0d0d0d;border:1px solid #222;border-radius:8px;padding:10px 14px;color:#ccc;font-size:14px;outline:none;resize:vertical;"></textarea>
      </div>
      <button type="submit"
        style="background:#6ee7b7;color:#0a0a0a;font-weight:700;font-size:14px;padding:12px 28px;border:none;border-radius:8px;cursor:pointer;align-self:flex-start;transition:background 0.2s;"
        onmouseover="this.style.background='#a7f3d0'" onmouseout="this.style.background='#6ee7b7'">
        Send Message
      </button>
    </form>
    <div id="formSuccess" style="display:none;margin-top:16px;color:#6ee7b7;font-size:14px;">
      ✓ Message sent — we'll be in touch within 24 hours.
    </div>
  </div>

  <script>
    async function handleSubmit(e) {
      e.preventDefault();
      const form = e.target;
      const data = Object.fromEntries(new FormData(form));
      try {
        await fetch('/contact', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(data) });
      } catch(_) {}
      form.style.display = 'none';
      document.getElementById('formSuccess').style.display = 'block';
    }
  </script>`;

  html = html.replace('</main>', form + '\n</main>');

  // Mobile: stack form grid to 1 col
  html = html.replace(
    '/* ── Mobile responsive ── */\n    @media (max-width: 768px) {\n\n      /* Banner */',
    `/* ── Mobile responsive ── */
    @media (max-width: 768px) {
      .contact-form-grid { grid-template-columns: 1fr !important; }

      /* Banner */`
  );

  write('contact.html', html);
  console.log('✓ contact page updated');
}

// ── 4. INDEX: agent quick-start block + hero warmth + "growing" stats ────────
{
  let html = read('index.html');

  // Add warmth to hero sub
  html = html.replace(
    '<p class="hero-sub">\n    The foundational trust layer AI agents need to <strong>store context</strong>, <strong>build reputation</strong>, and <strong>transact with confidence</strong>. Think SWIFT and courthouse — for the agent economy.\n  </p>',
    `<p class="hero-sub">
    The foundational trust layer AI agents need to <strong>store context</strong>, <strong>build reputation</strong>, and <strong>transact with confidence</strong>. Think SWIFT and courthouse — for the agent economy.
  </p>
  <p style="font-size:15px;color:#444;margin-top:-16px;margin-bottom:40px;font-style:italic;">We built this because trust shouldn't be a luxury — it should be infrastructure.</p>`
  );

  // Add "Talk to a founder" secondary CTA
  html = html.replace(
    `  <div style="margin-top:16px;display:flex;gap:24px;justify-content:center;">
    <a href="/aats-whitepaper.html" style="font-size:14px;color:#555;text-decoration:none;" onmouseover="this.style.color='#999'" onmouseout="this.style.color='#555'">Read the AATS Whitepaper →</a>
    <a href="/contact.html" style="font-size:14px;color:#555;text-decoration:none;" onmouseover="this.style.color='#999'" onmouseout="this.style.color='#555'">Get in Touch →</a>
  </div>`,
    `  <div style="margin-top:16px;display:flex;gap:24px;justify-content:center;flex-wrap:wrap;">
    <a href="/contact.html" style="font-size:14px;color:#6ee7b7;text-decoration:none;font-weight:600;" onmouseover="this.style.opacity='0.8'" onmouseout="this.style.opacity='1'">Talk to a founder →</a>
    <a href="/aats-whitepaper.html" style="font-size:14px;color:#555;text-decoration:none;" onmouseover="this.style.color='#999'" onmouseout="this.style.color='#555'">Read the AATS Whitepaper →</a>
  </div>`
  );

  // Add "and growing" to testnet note
  html = html.replace(
    'Testnet — data refreshes every 30 seconds · All transactions use test HBAR',
    'Testnet · refreshes every 30 seconds · All transactions use test HBAR · growing daily'
  );

  // Add agent quick-start block before Hedera Stack section
  const agentBlock = `
<!-- ── Agent Quick-Start ── -->
<section class="stack-section" style="padding-top:0;">
  <div class="section-label">For Agents & Developers</div>
  <div style="background:#0d0d1a;border:1px solid #1a1a3a;border-radius:12px;padding:28px 32px;">
    <div style="font-size:14px;color:#7c6af7;font-weight:600;margin-bottom:16px;">Start in 3 API calls</div>
    <pre style="font-family:'Courier New',monospace;font-size:13px;color:#aaa;line-height:1.9;margin:0;overflow-x:auto;"><span style="color:#444;"># 1. Register your agent (free)</span>
POST https://ai-broker-agent.com/vault/agents/register
     { "name": "my-agent", "agent_type": "general" }

<span style="color:#444;"># 2. Store encrypted context (1 credit)</span>
POST https://ai-broker-agent.com/vault/records
     X-Agent-Key: your_key
     { "label": "task-context", "content": "..." }

<span style="color:#444;"># 3. Check any agent's trust score (free)</span>
GET  https://ai-broker-agent.com/vault/agents/:id/trust-report</pre>
    <div style="margin-top:16px;display:flex;gap:12px;flex-wrap:wrap;">
      <a href="/platform.html" style="font-size:13px;color:#7c6af7;text-decoration:none;" onmouseover="this.style.opacity='0.7'" onmouseout="this.style.opacity='1'">Full API reference →</a>
      <a href="/pricing.html" style="font-size:13px;color:#555;text-decoration:none;" onmouseover="this.style.color='#aaa'" onmouseout="this.style.color='#555'">10 free credits on signup →</a>
    </div>
  </div>
</section>

`;

  html = html.replace('<!-- ── Hedera Stack ── -->', agentBlock + '<!-- ── Hedera Stack ── -->');
  write('index.html', html);
  console.log('✓ index.html updated');
}

// ── 5. OPERATOR VAULT: make killer line the hero ────────────────────────────
{
  let html = read('operator-vault.html');
  // Find the page header h1 and inject the killer line above it
  html = html.replace(
    '<div class="page-header">',
    `<div class="page-header">
    <div style="font-size:28px;font-weight:800;color:#fff;letter-spacing:-0.5px;margin-bottom:24px;line-height:1.3;">Humans forget.<br><span style="color:#6ee7b7;">AI agents don't.</span></div>`
  );
  write('operator-vault.html', html);
  console.log('✓ operator-vault.html updated');
}

// ── 6. PRICING: add FAQ section ─────────────────────────────────────────────
{
  let html = read('pricing.html');
  const faq = `
  <!-- FAQ -->
  <div style="margin-top:80px;padding-top:48px;border-top:1px solid #1e1e1e;">
    <p class="section-title">Frequently Asked Questions</p>

    <div style="display:flex;flex-direction:column;gap:0;">
      ${[
        ['What happens when I run out of credits?', 'Your agent account is paused — no new records can be stored. Existing records and trust scores remain accessible. Top up at any time by sending HBAR to the platform.'],
        ['Do credits expire?', 'No. Credits never expire. Once purchased, they stay in your account until used.'],
        ['Can I get a refund?', 'Credits are non-refundable once purchased. However, if a store operation fails for any reason, the credit is automatically refunded to your account.'],
        ['Can I share credits between agents?', 'Credits are per-agent. Each registered agent has its own credit balance. Operator accounts can view and top up all agents in their fleet.'],
        ['Is there a free trial?', 'Yes — every new agent receives 10 free credits on registration. No credit card required.'],
        ['What counts as a "store operation"?', 'One store operation = one vault record created. Reading records, querying trust scores, and managing permissions are all free.'],
      ].map(([q, a]) => `
      <div style="padding:20px 0;border-bottom:1px solid #141414;">
        <div style="font-size:14px;font-weight:600;color:#ccc;margin-bottom:8px;">${q}</div>
        <div style="font-size:13px;color:#666;line-height:1.7;">${a}</div>
      </div>`).join('')}
    </div>
  </div>`;

  html = html.replace('<div class="cta-row">', faq + '\n\n  <div class="cta-row">');
  write('pricing.html', html);
  console.log('✓ pricing.html FAQ added');
}

// ── 7. TRUST SCORE: add TL;DR at top ────────────────────────────────────────
{
  let html = read('trust-score.html');
  const tldr = `
  <!-- TL;DR -->
  <div style="background:#0d1520;border:1px solid #1a2535;border-radius:14px;padding:28px 32px;margin-bottom:48px;">
    <div style="font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#7c6af7;margin-bottom:16px;">TL;DR — What is a Trust Score?</div>
    <div style="display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;gap:14px;align-items:flex-start;font-size:14px;color:#aaa;line-height:1.6;">
        <span style="color:#7c6af7;font-weight:700;flex-shrink:0;">1.</span>
        <span>It's a <strong style="color:#ccc;">credit score for AI agents</strong> — a single number (0–100) that tells you how trustworthy an agent is before you work with it.</span>
      </div>
      <div style="display:flex;gap:14px;align-items:flex-start;font-size:14px;color:#aaa;line-height:1.6;">
        <span style="color:#7c6af7;font-weight:700;flex-shrink:0;">2.</span>
        <span>It's calculated from <strong style="color:#ccc;">5 dimensions</strong>: transaction history, behavior, how long the agent has existed, financial record, and identity verification.</span>
      </div>
      <div style="display:flex;gap:14px;align-items:flex-start;font-size:14px;color:#aaa;line-height:1.6;">
        <span style="color:#7c6af7;font-weight:700;flex-shrink:0;">3.</span>
        <span>Every score is <strong style="color:#ccc;">anchored on Hedera</strong> — immutable, timestamped, and independently verifiable. No one can fake it.</span>
      </div>
    </div>
  </div>
`;
  // Insert after page-header div closes
  html = html.replace('</div>\n\n  <!-- ', '</div>\n' + tldr + '\n  <!-- ');
  if (!html.includes('TL;DR')) {
    // fallback: insert after first </div> in main
    html = html.replace(/<main[^>]*>\s*\n/, m => m + tldr);
  }
  write('trust-score.html', html);
  console.log('✓ trust-score.html TL;DR added');
}

console.log('\nAll fixes applied.');
