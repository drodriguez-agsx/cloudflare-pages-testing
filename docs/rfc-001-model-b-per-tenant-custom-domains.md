# RFC-001: Multi-Tenant Theming via Per-Tenant Custom Domains (Model B)

| | |
|---|---|
| **Status** | Draft — Request for Comments |
| **Author** | drodriguez |
| **Created** | 2026-06-26 |
| **Reviewers** | _TBD_ |
| **Supersedes** | — |
| **Related** | `README.md`, `functions/_middleware.js`, `tenant.example.json` |

---

## 1. Summary

We serve a single, brand-agnostic landing page from Cloudflare Pages. Each tenant
("client/bank") gets their **own custom domain** (e.g. `verdant.com`). A Pages
Function resolves the incoming hostname to a per-tenant **JSON config hosted on
S3**, and injects that config into the page at the edge — so the page arrives at
the browser already themed and populated (colors, copy, logo, images, privacy
policy), with no flash and no client-side fetch.

The defining property of this design: **onboarding a tenant requires no code
change and no redeploy.** It is two operational steps — add the domain in
Cloudflare, add the JSON file in S3.

---

## 2. Background & current state

The repository already contains a working foundation:

- **`index.html`** — a data-driven template. Content elements carry `data-text`
  and `data-attr-*` (e.g. `data-attr-src`) attributes; design is driven by CSS
  custom properties (`--color-primary`, component tokens, etc.). A loader script
  applies a config object to both content and tokens, and hides the body until
  applied (FOUC guard with a failsafe reveal).
- **`functions/_middleware.js`** — a Pages Function with two modes:
  - **Demo mode** (when `TENANT_CONFIG_BASE` is unset): hardcoded sample tenants
    + an on-page switcher, for showing the concept on `*.pages.dev`.
  - **Prod mode** (when `TENANT_CONFIG_BASE` is set): fetches
    `${base}/${slug}.json` and injects it as `window.__TENANT__`.
- **`tenant.example.json`** — the config schema reference.

The loader already supports **two delivery modes**: edge injection (Mode A, via
the Function — what this RFC builds on) and a client-side runtime fetch (Mode B
of the loader). This RFC concerns the **edge-injection** path.

> Terminology note: "Model A / Model B" in this RFC refers to the **domain
> strategy** (wildcard subdomain vs. per-tenant custom domain). It is unrelated
> to the loader's "Mode A / Mode B" (edge vs. client fetch). This RFC adopts
> **domain Model B** delivered via **loader Mode A** (edge injection).

---

## 3. Goals / Non-goals

### Goals
- Each tenant served on their own branded domain (`verdant.com`).
- All tenant-specific data (content, labels, images, privacy policy, theme
  tokens) lives in one JSON file per tenant on S3.
- Zero code change / zero redeploy to onboard, update, or remove a tenant.
- Server-side theming (no flash, no client config fetch, no CORS dependency).
- Graceful, well-defined fallback when a config is missing or fails to load.

### Non-goals
- Tenant self-service editing of configs (assumed curated by our team — see
  §9 security).
- A full CMS / admin UI (out of scope; may be a later RFC).
- Tenants bringing **thousands** of their own domains (would require Cloudflare
  for SaaS / custom hostnames — noted in §11).

---

## 4. Architecture overview

```
   Browser
     │  GET https://verdant.com/
     ▼
 ┌─────────────────────── Cloudflare Pages ───────────────────────┐
 │  custom domain: verdant.com  ──►  Pages project (this repo)     │
 │                                                                 │
 │   functions/_middleware.js  (runs on every HTML request)        │
 │     1. key = hostname  → "verdant.com"                          │
 │     2. fetch  ${TENANT_CONFIG_BASE}/verdant.com.json  (cached)  │
 │     3. HTMLRewriter: inject <script>window.__TENANT__=…</script>│
 │     4. return themed HTML                                        │
 └─────────────────────────────────────────────────────────────────┘
     │                                   ▲
     │                                   │ server-side fetch (no CORS)
     ▼                                   │
 themed page                      ┌──────┴───────── S3 ─────────────┐
 (loader applies tokens+content)  │ tenants/verdant.com.json        │
                                  │ tenants/acme.com.json           │
 images via <img src=…> ◄─────────│ assets/verdant/logo.svg, …      │
 (browser fetch, public-read)     │ tenants/default.json            │
                                  └─────────────────────────────────┘
```

---

## 5. Detailed design

### 5.1 Domain → tenant resolution

Because Model B is **one domain per tenant**, the hostname *is* the tenant
identity. We use it directly as the S3 key — no slug-indirection map to maintain.

Proposed resolver (replaces the current first-label `resolveHostSlug`):

```js
function resolveTenantKey(url) {
  // ?tenant= override is for previews/staging only (see §9).
  const override = url.searchParams.get('tenant');
  const raw = (override || url.hostname).toLowerCase().replace(/^www\./, '');
  return raw.replace(/[^a-z0-9.-]/g, '');   // allow dots: domain-as-key
}
```

- `verdant.com` and `www.verdant.com` → `verdant.com`
- Lookup: `GET ${TENANT_CONFIG_BASE}/verdant.com.json`
- Unknown host → falls back to `default.json` (or baked-in template defaults —
  see open question §10.2).
- `sanitize` is widened to allow `.` (domain keys contain dots); it still strips
  anything that isn't `[a-z0-9.-]` to prevent path traversal in the fetch URL.

> Optional alias map: if a tenant ever points two domains at one config
> (`verdant.com` + `verdant.io`), add a tiny `{ "verdant.io": "verdant.com" }`
> lookup before the default path. Not needed for the common case.

### 5.2 S3 config store

**Bucket layout**

```
s3://<bucket>/
  tenants/
    default.json          # fallback config
    verdant.com.json
    acme.com.json
  assets/
    verdant/ logo.svg, hero.jpg, …
    acme/    logo.svg, …
```

- **`TENANT_CONFIG_BASE`** = `https://<bucket-or-cdn>/tenants` (Pages env var).
- Config JSON is fetched **server-side by the Worker** → **no browser CORS
  needed** for the config itself.
- **Images** are referenced by URL in the JSON and loaded by the browser via
  `<img src>` → need **public-read** (CORS not required for plain `<img>`).
- Recommend fronting S3 with a CDN (CloudFront) or evaluating **Cloudflare R2**
  (see §11) for lower latency/egress from the Worker.

### 5.3 Config schema (extends `tenant.example.json`)

Existing fields stay (`meta`, `brand`, `hero`, `features`, `support`, `links`,
`footer`, `tokens`). Model B adds richer fields:

```jsonc
{
  "meta":   { "title": "...", "description": "..." },
  "brand":  { "name": "...", "logoUrl": "https://.../assets/verdant/logo.svg", ... },
  "images": {
    "heroBackground": "https://.../assets/verdant/hero.jpg",   // bound via data-attr / token
    "ogImage":        "https://.../assets/verdant/og.png"
  },
  "privacy": {
    "heading": "Privacy Policy",
    "body":    "<h3>…</h3><p>…</p>"     // OR structured — see §10.1
  },
  "tokens": { "color-primary": "#0f4d34", "color-accent": "#7ac74f", ... }
}
```

- **Images**: just URL fields. `logoUrl` already binds via `data-attr-src`. Add
  `data-attr-src` hooks (and/or a `--hero-image` token) for hero/OG images.
- **Privacy policy / rich text**: requires a binding decision (§10.1). If we go
  with embedded HTML, the loader gains a `data-html` binding (`innerHTML`); if
  structured, a small render loop. Trust assumptions in §9.

### 5.4 Request lifecycle (Function)

1. `onRequest` runs; `await next()` fetches the static `index.html` asset.
2. If response is not `text/html`, return as-is (static assets pass through).
3. `key = resolveTenantKey(url)`.
4. `fetch(${base}/${key}.json, { cf: { cacheTtl, cacheEverything: true } })`.
5. On success → `HTMLRewriter().on('head', inject window.__TENANT__)`.
6. On miss/error → try `default.json`; if that also fails, return untouched
   (template renders its baked-in defaults).
7. Demo-mode blocks (`SAMPLE_TENANTS`, `SwitcherInjector`, `makeTenant`,
   `logoDataUri`) are removed for production (see §8 rollout).

### 5.5 Caching & invalidation

- The Worker caches the fetched JSON at the edge (`cf.cacheTtl`, currently 300s).
- **New tenant**: live as soon as DNS/SSL is up — new key, nothing cached.
- **Editing an existing tenant**: the prior version may serve up to the TTL
  (~5 min). Options: lower TTL (more S3 reads), or add a purge step on publish.
  See open question §10.3.

### 5.6 Fallback & failure modes

| Situation | Behavior |
|---|---|
| Unknown / unmapped host | Fetch `default.json`; else baked-in template defaults |
| S3 5xx / timeout / network error | `try/catch` → `default.json` → baked-in defaults |
| Malformed JSON | Parse fails → caught → fallback as above |
| Over free-tier limit (Mode A) | Function is gated in front of the asset → request errors (429); page does **not** silently fall back. Mitigate with Workers Paid. (See §8/§10.) |
| Image URL 404 | Logo falls back to template default; broken `<img>` otherwise — keep assets validated at publish |

---

## 6. Operations

### 6.1 Onboarding a tenant (the two-step)

1. **Cloudflare Pages → Custom domains → Set up a domain**: add `verdant.com`,
   point DNS at the Pages project. SSL provisions automatically (a few minutes).
2. **Upload `tenants/verdant.com.json`** (and any `assets/verdant/*`) to S3.

No code change. No redeploy. The deployed artifact is tenant-agnostic.

### 6.2 Updating a tenant
- Overwrite the JSON / assets in S3. Live within the cache TTL (§5.5).

### 6.3 Offboarding a tenant
- Remove the custom domain in Cloudflare; optionally delete the S3 files.

### 6.4 Custom domain setup detail
- Apex (`verdant.com`) and `www` both added; redirect `www` → apex (or map both
  via the `www.` strip in §5.1).
- If the tenant's zone is on Cloudflare, SSL + DNS is automatic; otherwise they
  add a CNAME to the Pages project and we validate the domain.

---

## 7. Cost

- **Static hosting + bandwidth**: free/unlimited on Pages.
- **Function invocations** (one per HTML pageview): Workers billing — free tier
  100k/day; Workers Paid $5/mo (10M included, ~$0.30/M after). Scales with HTML
  pageviews, not assets.
- **S3**: storage + GET requests for config/images. Edge caching keeps config
  GETs low. Consider R2 to cut egress (§11).
- Confirm current Cloudflare pricing before budgeting.

---

## 8. Rollout plan

- **Phase 0 — Demo (now):** keep demo mode for stakeholder review on `*.pages.dev`.
- **Phase 1 — Prod plumbing:**
  - Create `tenants/default.json`.
  - Set `TENANT_CONFIG_BASE` in Pages (this auto-disables demo mode).
  - Swap `resolveHostSlug` → `resolveTenantKey` (§5.1); widen `sanitize`.
  - Add image + privacy bindings per §10.1 decision.
  - Remove demo-only blocks from `_middleware.js`.
  - Tokenize the hardcoded icon glyph colors (`#0d2b5e`, `#fff`) — current tech
    debt that prevents icons from matching a tenant's palette.
- **Phase 2 — First tenant:** onboard `verdant.com`; validate end-to-end.
- **Phase 3 — Tooling:** JSON schema + CI validation, a publish/purge script,
  monitoring/alerting on config-fetch failures.
- **Phase 4 — Scale:** evaluate Cloudflare for SaaS if tenants bring many of
  their own domains; evaluate R2.

---

## 9. Security & privacy considerations

- **Injection escaping**: the injected `window.__TENANT__` JSON escapes `<` to
  `<` to prevent `</script>` breakout. Keep this.
- **Embedded HTML (privacy policy)**: if we embed HTML (§10.1 option B), the
  config is **trusted content** — authored by our team, not tenants. If tenant
  self-service is ever added, HTML must be sanitized server-side.
- **No secrets in config**: these JSONs are effectively public marketing data.
  Do not place credentials/PII in them.
- **`?tenant=` override**: convenient for previews but lets a request load any
  config key. Configs are public, so risk is low, but restrict the override to
  non-production environments (or behind an internal preview host).
- **Key sanitization**: `resolveTenantKey` strips to `[a-z0-9.-]`, preventing
  path traversal (`../`) in the S3 fetch URL.
- **S3 access**: serve config/assets as public-read (they're public), or
  restrict the bucket to Cloudflare egress if desired.

---

## 10. Open questions / decisions needed

### 10.1 Privacy-policy content format _(needs a decision)_
| Option | JSON holds | Loader change | Notes |
|---|---|---|---|
| A. Link out | a URL | none | Policy on a separate page/PDF. Simplest, safest. |
| B. Embedded HTML | HTML string | add `data-html` (innerHTML) | Full formatting in one file. Trusted-content only. **Recommended.** |
| C. Structured | `[{heading, paragraphs[]}]` | small render loop | Safe (textContent), more loader code. |

### 10.2 Fallback target
Use a real `default.json`, or fall back to the template's baked-in defaults? (A
`default.json` is more controllable and brandable for unknown hosts.)

### 10.3 Cache strategy
Keep 300s TTL (simple, ≤5 min staleness on edits), lower it, or add an explicit
edge-cache purge on publish for instant updates?

### 10.4 Storage choice
S3 (stated) vs **Cloudflare R2** — R2 has zero egress to Workers and can be bound
directly (no public fetch). Worth a spike (§11).

### 10.5 Over-limit behavior
Accept the Mode A gating (errors over free-tier limit) and move to Workers Paid,
or add a resilience path? (Loader Mode B serves the static page even over limit,
at the cost of a flash + CORS — could be a documented degradation lever.)

---

## 11. Alternatives considered

- **Domain Model A — wildcard subdomain** (`verdant.app.com`): simpler infra
  (one wildcard domain), but not the branded per-tenant domain the product wants.
- **Workers-native** (`_worker.js` + assets binding + `run_worker_first`):
  functionally equivalent; more config and a restructure. Pages Functions are
  lower-friction for the file-convention model we already use.
- **Loader Mode B (client-side fetch)** instead of edge injection: more resilient
  to Function limits (static page always serves), but introduces FOUC and a
  cross-origin CORS dependency on S3.
- **Slug-indirection map** instead of hostname-as-key: extra mapping to maintain
  for no benefit in the one-domain-per-tenant case.
- **Cloudflare R2** instead of S3: same network as Workers (lower latency, no
  egress fees), direct binding instead of public fetch. Strong candidate for the
  storage layer.
- **Cloudflare for SaaS / custom hostnames**: the right tool if/when tenants
  bring large numbers of their own domains; heavier setup than plain custom
  domains.

---

## 12. Appendix

### 12.1 Environment variables (Pages project)
| Var | Value | Effect |
|---|---|---|
| `TENANT_CONFIG_BASE` | `https://<cdn-or-bucket>/tenants` | Enables prod mode; base for config fetch |

### 12.2 Local testing
```bash
# run the Pages Function locally on the real Workers runtime
npx wrangler pages dev .

# simulate a tenant hostname (Model B resolution)
curl -s -H "Host: verdant.com" http://127.0.0.1:8788/ | grep -oc 'window.__TENANT__='
# → 1 means the config was injected

# preview override (no custom host needed)
curl -s "http://127.0.0.1:8788/?tenant=verdant.com" | grep -oc 'window.__TENANT__='
```

### 12.3 Proposed `sanitize` change
```js
// before: function sanitize(s){ return s.toLowerCase().replace(/[^a-z0-9-]/g,''); }
function sanitize(s) { return s.toLowerCase().replace(/[^a-z0-9.-]/g, ''); } // allow dots
```

### 12.4 Definition of done (Phase 1)
- [ ] `default.json` exists and renders for unknown hosts
- [ ] `TENANT_CONFIG_BASE` set; demo blocks removed
- [ ] `resolveTenantKey` + widened `sanitize` shipped
- [ ] image + privacy bindings implemented per §10.1
- [ ] icon colors tokenized
- [ ] CI validates tenant JSON against a schema
- [ ] first tenant (`verdant.com`) live and verified
