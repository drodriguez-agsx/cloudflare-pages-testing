# Multi-Tenant App Landing Template

A single static HTML page that is **themed and populated per tenant** from an
external JSON config. Same markup, different brand — colors, copy, logo, links,
contact details — all driven by data.

```
.
├── public/                 # ← Cloudflare Pages build output directory (deployed)
│   └── index.html          #   The template (markup + CSS tokens + loader)
├── functions/              # Pages Functions (compiled separately, NOT a static asset)
│   └── _middleware.js      #   Edge theming Pages Function (Mode A)
├── tenants/                # Per-tenant SOURCE content (git-tracked, dev-only)
│   └── hermosa/            #   One folder per tenant: config + its assets
│       ├── tenant.json     #     Tenant content (see schema below)
│       ├── logo.png        #     Logo asset (referenced by relative path)
│       └── hero.png        #     Hero image asset
├── dist/                   # GENERATED staging gallery + per-tenant bakes (COMMITTED)
│   ├── index.html          #   Tenant gallery (links to each /<slug>/)
│   └── hermosa/            #   Baked, self-contained tenant bundle
├── tenant.example.json     # Reference config — copy this per tenant (dev-only, not deployed)
├── docs/                   # RFCs and design notes (dev-only, not deployed)
└── README.md
```

> **What gets deployed:** only the contents of `public/` (static assets) plus the
> `functions/` directory (resolved from the repo root, not the output dir).
> Everything else — `docs/`, `tenant.example.json`,
> this README — stays in the repo but is **never served**. To make a file
> publicly reachable, it must live under `public/`.

> ## ⚠️ TEMPORARY DEMO MODE — REMOVE BEFORE PRODUCTION
>
> `functions/_middleware.js` currently ships with **hardcoded sample tenants**
> and an **on-page switcher**, purely to show the concept working on the default
> `*.pages.dev` domain. **This is throwaway test code — not for production.**
>
> **Try it (after deploy):**
> - `/` → default template + a floating **DEMO TENANT** switcher bar
> - `/?tenant=northwind` → blue / amber "Northwind Bank"
> - `/?tenant=verdant` → green "Verdant Credit Union"
> - `/?tenant=coral` → plum / coral "Coral Pay"
>
> Click the pills to re-theme the whole page live (colors, logo, copy) — all
> injected at the edge, no client fetch, no flash.
>
> **How it turns off:** demo mode is active only while `TENANT_CONFIG_BASE` is
> **unset**. The moment you set that env var (real S3 mode, see Mode A), the
> sample tenants and switcher disappear automatically. For a clean production
> build, delete the `SAMPLE_TENANTS` / `makeTenant` / `logoDataUri` /
> `SwitcherInjector` blocks from `_middleware.js`.

## How it works

Two things are data-driven:

1. **Content** — any element with a `data-text` / `data-attr-*` attribute is
   filled from the config.
2. **Design tokens** — CSS custom properties (`--color-primary`, etc.) are set
   on `:root` at runtime from `config.tokens`.

There are **two delivery modes**. They share the same `index.html` and the same
JSON shape — pick one (or run both; edge takes priority).

| | Mode A — Edge injection | Mode B — Runtime fetch |
|---|---|---|
| Where config is applied | Cloudflare edge, before the browser gets HTML | In the browser, after load |
| Flash of default theme | None | Brief (mitigated, see below) |
| Extra browser round-trip | No | Yes (S3 fetch) |
| Setup | Needs `functions/_middleware.js` + env var | Just the `<meta>` base URL |
| Best for | Production | Quick start / preview |

---

## Mode B — Runtime fetch (simplest)

1. Host each tenant's config on S3 (or any CORS-enabled origin), e.g.
   `s3://your-bucket/tenants/acme.json`.
2. In `index.html`, set the base URL:
   ```html
   <meta name="tenant-config-base" content="https://your-bucket.s3.amazonaws.com/tenants" />
   ```
3. Select the tenant per request with `?tenant=acme`. The loader fetches
   `${base}/acme.json` (defaults to `default.json` when no slug is given).

> **CORS:** the S3 bucket/object must return `Access-Control-Allow-Origin` for
> your Pages domain, since the browser fetches it cross-origin.

**Flash handling:** `<body>` starts hidden (`body.preload { visibility: hidden }`)
and is revealed once theming is applied — or after a 2.5s failsafe, or
immediately if JS is disabled (`<noscript>`). A failed fetch logs a warning and
shows the baked-in defaults.

---

## Mode A — Edge injection (no flash, recommended for prod)

The Pages Function in `functions/_middleware.js` fetches the tenant JSON at the
edge and inlines it as `window.__TENANT__` in `<head>`. The page applies it
before first paint — no client fetch, no flash.

1. Set a Pages **environment variable**:
   ```
   TENANT_CONFIG_BASE = https://your-bucket.s3.amazonaws.com/tenants
   ```
2. Tenant resolution order: `?tenant=…` → subdomain (`acme.example.com` → `acme`)
   → `default`.
3. For **edge-only** operation, remove the `<meta name="tenant-config-base">`
   from `index.html` so the browser never does its own fetch. If you keep it,
   the edge config wins (the loader checks `window.__TENANT__` first) and the
   meta acts as a fallback.

The injected JSON has `<` escaped to `<` so a value can't break out of the
`<script>` tag.

---

## Config schema

Copy `tenant.example.json`, rename to `<slug>.json`, and edit. Every field is
optional — omit one and the element keeps its placeholder default.

| Key | Type | Drives |
|---|---|---|
| `meta.title` | string | `<title>` and OS app title |
| `meta.description` | string | `<meta name="description">` |
| `brand.name` | string | Header, footer, copyright, address card |
| `brand.shortName` | string | Logo fallback text |
| `brand.tagline` | string | Header sub-line |
| `brand.location` | string | Footer location |
| `brand.logoUrl` | url | Header logo `<img src>` |
| `hero.badge` | string | Hero pill above the headline |
| `hero.headlineLead` / `hero.headlineAccent` | string | Headline (accent = highlighted span) |
| `hero.subhead` | string | Hero paragraph |
| `hero.pills[]` | `{label}` | 4 feature pills |
| `features.label` / `.heading` / `.intro` | string | Features section header |
| `features.items[]` | `{title, body}` | 6 feature cards |
| `support.label` / `.heading` / `.intro` | string | Support section header |
| `support.email` / `.emailHref` | string | Email card + footer link |
| `support.phone` / `.phoneHref` | string | Phone card |
| `support.address` | string | Address card |
| `support.hours` / `.hoursNote` | string | Business hours card |
| `privacy.label` / `.heading` / `.intro` | string | Privacy section |
| `privacy.fullPolicyUrl` | url | "View Full Privacy Policy" button |
| `links.androidUrl` | url | Google Play button |
| `footer.trustBadge` | string | Footer badge text |
| `tokens` | object | CSS custom properties (see below) |

### Design tokens (`config.tokens`)

Keys map to CSS custom properties (the `--` prefix is optional in JSON). Set a
few brand colors, or override individual component tokens for fine control.

**Brand palette** (cascades everywhere):
`color-primary`, `color-primary-mid`, `color-accent`, `color-accent-lt`,
`color-highlight`, `color-surface`, `color-bg`, `color-bg-alt`, `color-muted`,
`color-text`, `color-text-muted`, plus `radius`, `shadow`.

**Component tokens** (default to the palette; override only when needed):
`header-bg`, `header-accent`, `hero-from`, `hero-via`, `hero-to`,
`hero-accent-text`, `btn-primary-bg`, `btn-primary-bg-hover`, `card-accent`,
`section-label`, `footer-bg`, `footer-accent`.

```jsonc
"tokens": {
  "color-primary": "#0b1f5c",   // sets header, buttons, headings, footer…
  "color-accent":  "#f5c400",   // sets accents, card top-borders, labels…
  "btn-primary-bg": "#0a7d3c"   // …but override just the primary button
}
```

---

## Adding a new tenant

1. `cp tenant.example.json acme.json` and edit the values + tokens.
2. Upload `acme.json` to `s3://your-bucket/tenants/acme.json`.
3. Reach it via `?tenant=acme` (or map `acme.example.com` for subdomain routing).

No code change, no redeploy — it's just data.

---

## Generate per-tenant bundles

For the distribution model (each tenant self-hosts on their own account — see
[RFC-002](docs/rfc-002-git-connected-tenant-deploy.md)), `build.mjs` renders the
template + a tenant's source (`tenants/<slug>/`) into a **self-contained** static
bundle under `dist/<slug>/` (config inlined, assets copied, no runtime fetch).

```bash
npm run build              # build every tenant under tenants/
npm run build -- hermosa   # build one tenant (note the `--`)
node build.mjs hermosa     # same, without npm
```

Each `dist/<slug>/` is drop-anywhere static — deploy it to the tenant's own
Cloudflare Pages account (or any static host).

`dist/` is **committed** (see next section). Re-run `npm run build` after any
change to `tenants/` or `public/index.html`, then commit the regenerated `dist/`.

---

## Staging preview (team-facing gallery)

`npm run build` also writes **`dist/index.html`** — a gallery linking every built
tenant, so the whole team can browse the real outputs from one URL. Because the
bundles are self-contained, each `/<slug>/` renders with correct assets (no
`?tenant=` param, no config fetch).

Deploy it as its own Cloudflare Pages project:

- **Connect the repo** (or push `dist/` to a delivery repo), then:
- **Build command:** `npm run build` &nbsp;·&nbsp; **Build output directory:** `dist`
- Or, no build step: set output dir to `dist` and rely on the committed files.

The team then visits the staging URL → gallery → `/<slug>/` for each tenant.

> This is the "factory + staging preview" role: the central repo generates and
> previews all tenants; individual tenants still self-host their own `dist/<slug>/`
> bundle (RFC-002). Local check: `npx serve dist` then open the gallery.

---

## Local preview

It's a static page. From the repo root:

```bash
npx serve public          # or: python3 -m http.server -d public
```

Then open `http://localhost:3000/?tenant=acme`. Note: Pages Functions
(`functions/`) only run on Cloudflare — use `npx wrangler pages dev public` to
test edge injection locally (serves `public/` and picks up `./functions`).

## Deploy to Cloudflare Pages

- **Build command:** _(none — static)_
- **Build output directory:** `public`
- **Environment variable:** `TENANT_CONFIG_BASE` (only needed for Mode A)

Pages serves the contents of `public/` and auto-detects the `functions/`
directory (at the repo root) to wire up the middleware.

> ⚠️ **If you already deployed with build output `/`:** update the Pages project
> setting **Build output directory** from `/` to `public`, otherwise the next
> deploy will 404 (it'll look for assets in the wrong place, and `docs/` etc.
> would go back to being served).
