# Cloudflare Hardening Brief
*Generated 2026-07-11. All findings below were verified live against production — this is not a review of code-at-rest, it's what's actually happening on the wire right now.*

**UPDATE 2026-07-11 (later same day): All 5 findings below are fixed and verified live.** Gateway is routed and fetching origin correctly (Error 1003 fixed via grey-DNS `origin-api.ai-broker-agent.com`), all three domains now send HSTS/CSP/X-Frame-Options/X-Content-Type-Options/Referrer-Policy, `X-Powered-By` is stripped, and CORS on the gateway + flash-tag-service is locked to `https://ai-broker-agent.com` and `https://console.ai-broker-agent.com`. See `project-cloudflare-gateway.md` in memory for the full fix writeup. The findings below are kept as-written for the historical record of what was wrong.

---

## Executive Summary

The security gateway (`workers/gateway.js` — API key auth, rate limiting, the Roach Motel/Panic Room/Snickers trap system) is real, fairly mature code, and was uploaded to Cloudflare once on 2026-06-11. **It is not intercepting live traffic.** Requests to `api.ai-broker-agent.com` hit the raw origin server directly — no API key check, no rate limit, no Roach Motel pre-flight. Cloudflare is currently acting as a plain CDN in front of an unprotected origin, not as the security layer it was built to be.

That's the headline finding. Below it: none of the three live domains (`ai-broker-agent.com`, `console.ai-broker-agent.com`, `api.ai-broker-agent.com`) send HSTS or `X-Frame-Options`, the Console (auth + API keys + org data) sends almost no security headers at all, and the API origin leaks `X-Powered-By: Express`.

---

## Findings (ranked by severity)

### 1. CRITICAL — Gateway Worker not routed to live traffic

**Evidence:** `wrangler deployments list` shows one upload on 2026-06-11, no route configured in `wrangler.toml` (routes are a manual Cloudflare-dashboard step per the file's own go-live checklist, separate from `wrangler deploy`). Live test confirms it:

```
POST https://api.ai-broker-agent.com/v1/agent-gateway/provision  (no body)
→ 404 "Cannot POST /v1/agent-gateway/provision"   ← raw Express error page

GET https://api.ai-broker-agent.com/health  -H "X-Agent-Key: bav1_test123"
→ 200 {"ok":true,...}   ← garbage key was never checked, request reached origin directly
```

If the gateway were live, the first request would return the Worker's structured JSON 400/404, and the second would return `401 Unauthorized — Unknown API key` (the KV lookup in `gateway.js:110-114`). Neither happened. The origin is exposed with no authentication, no rate limiting, and none of the Roach Motel defenses (`roach-motel.js`, `panic-room.js`, `snickers.js`, `honeypot.js`, `decoy-api.js`, `brad-pacman.js`) doing anything in production — that entire subsystem is inert.

**Also note:** `gateway.js` was last edited 2026-06-27, sixteen days *after* the last deployment on record — so even if the route gets added today, it'll activate stale code until redeployed.

**Fix:** `wrangler deploy` to push current code, then confirm in Cloudflare dashboard → Workers Routes that `api.ai-broker-agent.com/*` actually points at `aibrokeragent-gateway`. This is a 5-minute fix but needs dashboard access to verify the route side (can't confirm route bindings from the CLI alone without `CF_API_TOKEN`).

### 2. HIGH — Console has almost no security headers

**Evidence:** `console.ai-broker-agent.com` live response headers: no `Content-Security-Policy`, no `X-Content-Type-Options`, no `X-Frame-Options`, no `Strict-Transport-Security`, no `Referrer-Policy`. Just Cloudflare's own defaults (`Server: cloudflare`, `Nel`, `Report-To`). This is the multi-tenant Console — session auth, API keys, org data, storage-backend credentials — and it's the least-hardened of the three domains.

**Fix:** Add security headers at the FastAPI layer (console-service has no header middleware — checked `main.py`, no `helmet`-equivalent) or via a Cloudflare Transform Rule / Worker, whichever is faster to ship. Minimum set: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Content-Security-Policy` scoped to what the Console UI actually needs, `Referrer-Policy: strict-origin-when-cross-origin`.

### 3. MEDIUM — `X-Powered-By: Express` leaks on the API domain

**Evidence:** `api.ai-broker-agent.com` returns `X-Powered-By: Express` on every response (confirmed on `/`, `/health`, and the provision endpoint's 404). Minor, but it's free stack fingerprinting for an attacker and costs nothing to remove (`app.disable('x-powered-by')` at the Express origin, or strip it in the gateway's response headers once the Worker is actually in the path).

### 4. MEDIUM — No HSTS or X-Frame-Options on any of the three domains

**Evidence:** checked all three live responses — none send `Strict-Transport-Security` or `X-Frame-Options`. The site's `_headers` file (Cloudflare Pages config) only sets `X-Frame-Options` on two specific paths (`/api/docs/*`, `/demo.html`) — there's no blanket policy for `/*`.

**Fix:** add a global block to `_headers` for the Pages-served marketing site, and equivalent headers at origin/Worker for Console and API.

### 5. LOW-MEDIUM — Wildcard CORS in multiple places

**Evidence:**
- `gateway.js:46` defaults `Access-Control-Allow-Origin` to `*` when no `Origin` header is sent (`corsHeaders` function) — the Worker never restricts this to a known set of frontend origins.
- `flash-tag-service/main.py:55` — `allow_origins=["*"]` in FastAPI's `CORSMiddleware`, wide open regardless of what the gateway does.
- Live `ai-broker-agent.com` also sends `Access-Control-Allow-Origin: *`.

For a public marketing site this is low-risk. For the flash-tag-service API (issues demo runs, touches Hedera) and the gateway's commerce endpoints (`/v1/agent-gateway/provision`, Stripe webhook), an open wildcard is worth tightening to the actual known caller set once the gateway is live and you know who's calling it directly vs. through the Worker.

### 6. INFO — Console-service has no explicit CORS policy (this is fine, by design)

`console-service/main.py`'s own docstring says same-origin-only, no CORS middleware, session-cookie auth. This is a deliberate, reasonable choice — not a finding, just confirming it's intentional and not an oversight.

---

## Recommended order of operations

1. **Fix #1 first, alone.** Nothing else matters if the gateway isn't in the request path — rate limiting and Roach Motel are worthless as dead code. Redeploy (`wrangler deploy`), verify the route in the Cloudflare dashboard, then re-run the two curl checks above and confirm you get the Worker's JSON responses, not Express's.
2. **Then #2 (Console headers)** — highest-value remaining gap since it's the auth'd surface with real customer data.
3. **#3 and #4 together** — both are header additions, cheap to batch into one pass once you're touching the header config anyway.
4. **#5 last** — needs you to know the real caller set (which frontends/agents legitimately call these APIs) before tightening, so it's naturally a later step, not urgent.

## Open questions (need dashboard/droplet access, not just repo access)

- Is there a Worker Route currently bound to `api.ai-broker-agent.com/*` at all, and if so, to which Worker/version? (Can't see this from `wrangler deployments list` — needs the CF dashboard or a `CF_API_TOKEN` with Zone:Firewall/Workers Routes read scope.)
- What origin actually serves `api.ai-broker-agent.com` right now? The `X-Powered-By: Express` header doesn't match anything in `flash-tag-service` (Python/FastAPI) or `console-service` (Python/FastAPI) — it's some other Node service, possibly an nginx+Node layer on the droplet itself. Worth confirming what's actually listening there before assuming the gateway's `ORIGIN_URL` secret even points at the right thing.
- Is `CF_API_TOKEN` / `CF_ZONE_ID` (needed for the gateway's L2+ IP block feature in Roach Motel) actually set as a Worker secret, or still a TODO from the original skeleton?

---

*Verification commands used (for re-running after fixes ship):*
```
curl -sD - -o /dev/null https://api.ai-broker-agent.com/
curl -sD - -o /dev/null https://console.ai-broker-agent.com/
curl -sD - -o /dev/null https://ai-broker-agent.com/
curl -sD - -X POST -H "Content-Type: application/json" -d '{}' https://api.ai-broker-agent.com/v1/agent-gateway/provision
curl -sD - -H "X-Agent-Key: bav1_test123" https://api.ai-broker-agent.com/health
npx wrangler deployments list   # from aibrokeragent-site/workers/
```
