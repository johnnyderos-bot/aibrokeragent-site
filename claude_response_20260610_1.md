# Claude Response — 2026-06-10 — 1
## SEO + AI Search Optimization — ai-broker-agent.com

**Status:** COMPLETE
**In response to:** claude_brief_20260610_1.md (Andy, CEO, DerosLabs)
**Completed:** 2026-06-10

---

## Files Modified

### New files created (4)
| File | Purpose |
|------|---------|
| `og-image.png` | 1200×630 OG image — **PNG, not SVG** (see note below) |
| `og-image.svg` | Source SVG for future edits |
| `llms.txt` | AI crawler guide — Anthropic, Perplexity, Gemini |
| `robots.txt` | Allow all, sitemap reference |
| `sitemap.xml` | 11 public pages |

### HTML files modified (11 active + 1 noindex)
| File | Changes |
|------|---------|
| `index.html` | OG tags, Twitter Card, canonical, Schema.org Organization + Product ItemList |
| `pricing.html` | Meta description updated, OG tags, Twitter Card, canonical |
| `brad.html` | OG description updated, og:url/image/site_name added, Twitter Card, canonical, Schema.org Product |
| `terms.html` | Meta description updated, OG tags, Twitter Card, canonical |
| `privacy.html` | Meta description updated, OG tags, Twitter Card, canonical |
| `flashtag.html` | og:url/image/site_name added (title/desc/type existed), Twitter Card, canonical |
| `lifecycle.html` | OG tags, Twitter Card, canonical (Schema.org was already solid — not touched) |
| `trust-scoring.html` | OG tags, Twitter Card, canonical (Schema.org already solid) |
| `context-recall.html` | OG tags, Twitter Card, canonical (Schema.org already solid) |
| `commerce.html` | OG tags, Twitter Card, canonical (Schema.org already solid) |
| `governance.html` | OG tags, Twitter Card, canonical (Schema.org already solid) |
| `index_v2.html` | `<meta name="robots" content="noindex, nofollow">` — old draft, excluded from sitemap |

**demo.html — not touched.** See flag below.

---

## OG Image

`og-image.png` — 1200×630 PNG, created with .NET System.Drawing (no external tooling required).

Design: Dark background (#08090c) · Left blue accent bar · "AIbroker" in near-white (#e4e8f0) · "AGEnt" in blue (#4f8ef7) · tagline in muted gray · domain bottom-right · hex polygon accent top-right echoing the favicon. All meta tags reference `/og-image.png` — the PNG is live in the repo now.

The SVG source is also in the repo as `og-image.svg` for future iteration.

---

## robots.txt

**Created** — was missing. Content:
```
User-agent: *
Allow: /
Sitemap: https://ai-broker-agent.com/sitemap.xml
```

---

## sitemap.xml

**Created** — was missing. 11 public pages. Excludes `demo.html` (see flag) and `index_v2.html` (old draft, noindexed). Adds 6 protocol detail pages not in the original brief page list — they're real public pages and need to be indexed.

Priority distribution: `/` → 1.0, product pages → 0.9, brad/protocol pages → 0.8, pricing → 0.7, terms/privacy → 0.3.

---

## llms.txt

**Created** — at root, accessible at `https://ai-broker-agent.com/llms.txt`.

**One deviation from brief:** Product URLs updated from `/platform` (doesn't exist as a separate route — tabs live in index.html) to actual product pages: `/flashtag`, `/trust-scoring`, `/lifecycle`. AI crawlers follow links; broken routes defeat the purpose.

---

## Flags (findings beyond the brief)

### 1. demo.html — content exposure, not just an SEO issue
**Andy flagged this, correctly.** The brief was to add noindex/nofollow to demo.html. The user confirmed demo.html should not be touched in this pass. But Andy's flag stands: `demo.html` contains what appears to be LRS/internal content and is live at a guessable URL. A password gate is not access control — it's a UI obstacle. Anyone with the URL bypasses it depending on implementation. **This needs a separate ticket: either pull the content out of the deployed file or gate it at the Cloudflare level (Pages access policy).** It is not in scope for this SEO brief but is a real exposure.

### 2. 6 protocol pages had solid Schema.org already
`flashtag.html`, `lifecycle.html`, `trust-scoring.html`, `context-recall.html`, `commerce.html`, `governance.html` — all had complete `SoftwareApplication` + `FAQPage` structured data. Not touched. OG/Twitter/canonical added around them.

### 3. The brief's page list was for a SPA, not separate files
`/platform`, `/the-problem`, `/get-access` are tab sections inside `index.html`, not separate HTML files. Sitemap and canonicals reflect the actual file structure. Schema.org and OG tags for index.html cover the full homepage including all tab content.

### 4. index_v2.html is deployed at /index_v2
Old draft, visible to crawlers. Added `noindex, nofollow` and excluded from sitemap. Recommend removing or password-protecting if it contains anything sensitive.

---

## Verification checklist

- [ ] Deploy to Cloudflare Pages
- [ ] LinkedIn Post Inspector: `https://www.linkedin.com/post-inspector/` → paste `https://ai-broker-agent.com` → confirm OG image renders
- [ ] `https://ai-broker-agent.com/llms.txt` — returns content
- [ ] `https://ai-broker-agent.com/sitemap.xml` — returns valid XML
- [ ] `https://ai-broker-agent.com/robots.txt` — returns allow-all + sitemap
- [ ] `https://ai-broker-agent.com/og-image.png` — returns 1200×630 PNG
- [ ] X/Twitter card validator (if posting there): `https://cards-dev.twitter.com/validator`
