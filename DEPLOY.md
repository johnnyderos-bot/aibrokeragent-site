# Deployment — ai-broker-agent.com

Static HTML site — no build step, no dependencies. Pages deployed: `index.html`, `demo.html`, `terms.html`, `privacy.html`.

---

## Cloudflare Pages (recommended — domain already on Cloudflare)

### Step 1 — Create the Pages project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com) → **Pages** → **Create a project**
2. Choose **Direct Upload** (no Git repo needed)
3. Name the project: `aibrokeragent` (or any slug)
4. Upload `index.html`
5. Click **Deploy site**
6. You'll get a live URL at `https://aibrokeragent.pages.dev` — confirm it loads correctly

### Step 2 — Connect custom domain

1. In the Pages project → **Custom domains** → **Set up a custom domain**
2. Enter: `ai-broker-agent.com`
3. Since the domain is already on Cloudflare, it will offer to add the DNS record automatically — click **Activate domain**
4. Also add `www.ai-broker-agent.com` if you want the www to redirect

DNS propagates immediately (same Cloudflare account — no TTL wait).

### Step 3 — Verify for Mercury

After Step 2, hit `https://ai-broker-agent.com` in a browser and confirm:
- Page loads over HTTPS (Cloudflare handles SSL automatically)
- Company name, description, and contact email are visible
- No broken elements

That URL is what you give Mercury.

---

## Mercury validation notes

Mercury is checking that:
- The URL is live and resolves
- The business name on the site matches the LLC filing name
- The site looks like a real business (not a parked domain)

The page satisfies all three. The meta description is set to the exact Mercury description:
> "AI trust infrastructure — identity and audit layer for autonomous agent networks"

---

## Automated deploys (GitHub Actions — recommended)

Every `git push` to `main` triggers a deploy automatically via `.github/workflows/deploy.yml`.

**One-time setup** — add two secrets to the GitHub repo (Settings → Secrets and variables → Actions):

| Secret | Where to find it |
|--------|-----------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → use "Edit Cloudflare Workers" template, then add `Cloudflare Pages: Edit` permission |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → any zone → right sidebar |

Once secrets are set, push any commit to `main` and watch it deploy under GitHub → Actions tab.

---

## Manual deploy (fallback)

```bash
npx wrangler pages deploy . --project-name=aibrokeragent
```

Run from the project root. Deploys all HTML files to the existing `aibrokeragent` Pages project.

---

## If you want to update content later

Edit the relevant HTML file directly, commit, and push to `main`. The GitHub Action handles the rest.
