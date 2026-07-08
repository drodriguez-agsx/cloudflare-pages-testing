# RFC-002: Git-Connected Per-Tenant Deploy (Self-Hosted Distribution)

| | |
|---|---|
| **Status** | Draft — Request for Comments |
| **Author** | drodriguez |
| **Created** | 2026-07-08 |
| **Reviewers** | _TBD_ |
| **Supersedes** | — |
| **Related** | `README.md`, `docs/rfc-001-model-b-per-tenant-custom-domains.md` |

---

## 1. Summary

We are shifting from **central hosting** (RFC-001: every tenant domain points at one
Pages project we own) to a **distribution model**: a central repo acts as a
**factory** that generates a self-contained static bundle per tenant, and each
tenant **self-hosts** that bundle on **their own Cloudflare Pages account and
domain**.

Today that handoff is **manual** (we generate a folder, the tenant deploys it).
This RFC proposes automating it with **git-connected deploy**: each tenant's
Cloudflare Pages project watches a git location we publish their baked bundle to,
so a push from our CI updates their live site with **no manual re-send and no
tenant action**.

The defining property: **we own content/design updates; the tenant owns the
account, domain, and hosting** — and updates flow automatically over git.

---

## 2. Background & current state

The repo is a **data-driven landing template** (`template/index.html` — content
via `data-text` / `data-attr-*`, design via CSS custom-property tokens; see
`README.md`). RFC-001 themed it **at the edge** for tenants hosted centrally.

The new direction (this RFC) is different in one decisive way: **tenants host on
their own Cloudflare account.** They do not have our Pages Function, our
`TENANT_CONFIG_BASE` env var, or our S3 config store. Therefore edge injection
(loader Mode A) **cannot run on their account.** The artifact we hand a tenant
must be a **fully-baked, self-contained static site**:

- theme tokens + content already inlined into the HTML,
- assets (logo, hero, images) sitting alongside with **relative** paths,
- no Pages Function, no runtime config fetch, no FOUC, no CORS dependency.

### 2.1 The factory (assumed prerequisite for this RFC)

This RFC assumes a **build/generator step** exists in the central repo:

```
repo/
├── template/index.html      # data-driven template (single source of markup)
├── tenants/
│   ├── verdant.json         # per-tenant config (+ its source assets)
│   └── acme.json
├── build.mjs                # renders template + a tenant config → baked folder
└── dist/                    # GENERATED (git-ignored)
    ├── verdant/  index.html (theme+content inlined) + logo.svg, hero.jpg …
    └── acme/     …
```

`build verdant` → `dist/verdant/` is the deliverable: the same template rendered
into N standalone outputs. The generator is out of scope here (it is shared by
both the manual and git-connected paths); this RFC covers **how `dist/<tenant>/`
reaches the tenant's Cloudflare account.**

### 2.2 Central repo role (decided)

The central Pages project remains **factory + staging preview**: it also serves
all tenants internally (via the existing `?tenant=` / subfolder mechanism) for
QA before a bundle is handed off. It is **not** the tenant's production host.

### 2.3 Handoff today (the status quo this RFC improves on)

Manual: zip `dist/<tenant>/` (or `wrangler pages deploy dist/<tenant>`), tenant
deploys to their own account. Works for the first tenants; every update is a
manual re-send, and tenants can drift to different versions.

---

## 3. Goals / Non-goals

### Goals
- A push from our CI updates a tenant's live site with **zero manual handoff and
  zero tenant action** after one-time setup.
- Tenant retains ownership of their **Cloudflare account, domain, and billing**.
- Our **source** (template + per-tenant configs + generator) stays **private**;
  only the **baked public output** is exposed to the delivery mechanism.
- Per-tenant **version history and one-click rollback** (git revert).
- Least-privilege: a tenant's Cloudflare connection can see only **their** site.

### Non-goals
- Tenant self-service editing of content/design (still curated by us).
- Replacing the generator/factory (assumed; see §2.1).
- Central hosting (that is RFC-001; explicitly superseded for this cohort).
- Tenants bringing thousands of domains (Cloudflare for SaaS territory — noted
  in RFC-001 §11).

---

## 4. Architecture overview

```
   Source (PRIVATE)                    Delivery (PUBLIC baked output)         Tenant-owned
 ┌──────────────────────┐            ┌───────────────────────────────┐    ┌────────────────────┐
 │ central repo         │            │ per-tenant delivery repo       │    │ tenant CF account  │
 │  template/           │            │  tenant-verdant-site           │    │                    │
 │  tenants/*.json      │  CI push   │   index.html (baked)           │    │ CF Pages project   │
 │  build.mjs           │  ───────►  │   logo.svg, hero.jpg …         │◄───│  watches this repo │
 │                      │  (GH       │   (contains NO source/config)  │ git│  → auto-deploy      │
 │  dist/verdant/  ─────┼── Action)  │                                │    │  custom domain:    │
 └──────────────────────┘            └───────────────────────────────┘    │   verdant.com      │
        ▲                                                                  └────────────────────┘
        │ edit template or tenants/verdant.json, merge                              │
        │                                                                           ▼
   we change content/design                                              browser gets baked page
                                                                         (no function, no fetch)
```

Flow: **edit `tenants/verdant.json` (or the template) → merge → CI builds
`dist/verdant/` → CI pushes it to the `tenant-verdant-site` delivery repo → the
tenant's Cloudflare Pages project (connected to that repo) auto-deploys.**

---

## 5. Detailed design

### 5.1 Delivery-repo topology _(key decision — recommendation below)_

Cloudflare Pages git integration connects **one CF account** to **one repo (one
production branch)**. The tenant owns the CF account, so the question is what git
target their project watches.

| Option | Layout | Isolation | Notes |
|---|---|---|---|
| **A. Repo-per-tenant** _(recommended)_ | `tenant-verdant-site`, `tenant-acme-site`, … | Strong — CF connection sees only that tenant | Independent history/rollback; most repos to manage (scriptable) |
| B. One repo, branch-per-tenant | `tenant-sites` with `verdant`, `acme` branches | Weak — connection can see all branches | Fewer repos; a tenant with repo access sees everyone |
| C. Monorepo + subdir | `tenant-sites/verdant/`, `/acme/` | Weak — CF "root directory" per project | Couples tenants; one bad push risks many |

**Recommendation: Option A (repo-per-tenant).** It gives least-privilege (the
tenant's Cloudflare only ever touches their own repo), independent per-tenant
history and rollback, and clean offboarding (archive/delete one repo). Repo
creation is scriptable via the GitHub API, so the "many repos" cost is low.

### 5.2 Ownership of the delivery repo _(key decision)_

| Option | Who owns delivery repo | Tenant connects via | Trade-off |
|---|---|---|---|
| **A. We own it, grant tenant read** _(recommended)_ | Us | Their CF account, granted read access to our repo | We keep full control of content; tenant just points CF at it |
| B. Tenant owns it, we get push | Tenant | Their own repo | More tenant autonomy; coordination + trust on our push access |

**Recommendation: Option A.** The delivery repo holds only **public baked
output** (safe to expose), we retain update control, and the tenant's
involvement is a one-time "connect this repo in your CF Pages."

### 5.3 Source vs. delivery separation (security-critical)

- **Source repo** (`template/`, `tenants/*.json`, `build.mjs`) stays **private**.
  Configs may reference internal notes, unreleased tenants, pricing, etc.
- **Delivery repo** contains **only** the contents of `dist/<tenant>/` — baked
  HTML + that tenant's public assets. No template source, no other tenant's data,
  no `.json` configs. The CI publish step copies *only* the built output.
- This is the same principle as the `public/`-only serving decision in
  `README.md`: the delivery boundary is what makes files public.

### 5.4 CI publish step (source → delivery)

A GitHub Action in the source repo, on merge to `main`:

1. Detect which tenants changed (config or shared template/asset).
2. `build <tenant>` → `dist/<tenant>/` for each affected tenant.
3. For each, push `dist/<tenant>/` to the tip of that tenant's delivery repo
   production branch (mirror-style: the delivery repo tracks the built output
   exactly — e.g. `git` publish with a clean worktree, or a `peaceiris`-style
   publish action pointed at the external repo).
4. Cloudflare Pages (tenant side) sees the push and deploys automatically.

A shared template/asset change fans out to **all** affected tenants in one CI run
— the whole point of keeping one template.

### 5.5 One-time tenant onboarding

1. We create the tenant's delivery repo and grant their CF-linked git identity
   read access (§5.2 Option A).
2. Tenant: **Cloudflare Pages → Create project → Connect to Git →** select the
   delivery repo, production branch, build command _none_, output dir `/`
   (already baked).
3. Tenant: **Custom domains →** add `verdant.com`; SSL provisions automatically.
4. We push the first build; their site goes live.

After this, **all updates are just a merge in our source repo.**

### 5.6 Updates, rollback, versioning
- **Update:** edit `tenants/verdant.json` or the template → merge → auto-deploy.
- **Rollback:** revert the commit in the delivery repo (or redeploy a previous
  deployment from the tenant's CF dashboard). Per-tenant, independent.
- **Version visibility:** stamp a build id/commit into the baked HTML (comment or
  `<meta>`), so we can see exactly what a tenant is running.

### 5.7 Failure modes

| Situation | Behavior / mitigation |
|---|---|
| CI build fails | No push; delivery repo unchanged; tenant stays on last good deploy |
| Push succeeds, tenant CF build fails | CF keeps prior deployment live; alert on CF deploy webhook |
| Tenant revokes repo access / disconnects CF | Their site freezes at last deploy; we detect via failed push / no-op |
| Bad content merged | Revert in source → re-publish, or revert delivery repo directly |

---

## 6. Operations

- **Onboard:** create delivery repo (scripted) → tenant connects CF + domain →
  first push. (§5.5)
- **Update:** merge to `main`; CI fans out to affected tenants.
- **Offboard:** stop publishing; archive/delete the delivery repo; tenant removes
  the CF project / domain on their side.
- **Audit:** each delivery repo's git log = that tenant's deploy history.

---

## 7. Cost

- **Our side:** GitHub Actions minutes for build + publish (small; scales with
  tenants × change frequency). Delivery repos are free (private or public).
- **Tenant side:** their own Cloudflare Pages (free tier covers static hosting +
  bandwidth generously) and their own domain.
- No S3/Worker invocation cost in this model — the tenant serves **static files**
  from their own account (contrast RFC-001, which billed per HTML pageview on our
  Workers).

---

## 8. Rollout plan

- **Phase 0 — Manual (now):** hand off `dist/<tenant>/` folders manually; prove
  the baked-bundle artifact and the factory. (Status quo.)
- **Phase 1 — Generator hardening:** deterministic `dist/<tenant>/`, relative
  asset paths, build-id stamping, staging-preview parity check.
- **Phase 2 — Delivery plumbing:** delivery-repo creation script; CI publish
  action (source → one delivery repo); dry-run on an internal test tenant.
- **Phase 3 — First git-connected tenant:** onboard `verdant` end-to-end
  (delivery repo → tenant CF connect → domain → auto-deploy). Validate update +
  rollback.
- **Phase 4 — Fan-out:** enable change-detection fan-out to all affected tenants;
  add deploy monitoring/alerting (CF deploy webhooks).

---

## 9. Security & privacy considerations

- **Source stays private; delivery is public-output-only** (§5.3). The CI step
  must copy *only* built output — never `tenants/*.json` or `template/`.
- **Least-privilege connections** (§5.1 Option A): a tenant's CF only ever
  touches their own delivery repo.
- **No secrets in configs or baked output** — these are public marketing pages.
- **Push credentials:** CI uses a scoped deploy key / fine-grained PAT limited to
  the delivery repos, stored as GitHub Actions secrets. Rotate on offboarding.
- **Tenant trust boundary:** because the tenant owns the account, they *can*
  disconnect or edit the delivery repo if granted write — grant **read-only** and
  keep write to our CI.

---

## 10. Open questions / decisions needed

1. **Change detection granularity** — path-based (which `tenants/*.json`
   changed) is easy; a shared template/asset change must fan out to *all*
   tenants. Do we compute the affected set from a dependency map, or rebuild all
   on template changes?
2. **Publish mechanism** — push a mirrored worktree to each external delivery
   repo, or use a publish action (e.g. deploy-to-external-repo)? Confirm auth
   model for cross-repo pushes.
3. **Delivery-repo visibility** — private (tenant granted read) vs public. Public
   simplifies CF connection but exposes the baked output in git (it's already
   public on the live site, so low risk).
4. **Git-connected vs. Direct Upload** — the two are competing delivery
   mechanisms, not complements. Git-connected keeps zero tenant credentials on
   our side; Direct Upload is a simpler pipeline but makes us a credential
   custodian. Both are now specified (git-connected in §4–§9, Direct Upload in
   §13). **This is the primary decision this RFC exists to force.**
5. **Build-id / version surfacing** — where and how to stamp, and whether to
   expose a small "last updated" signal.
6. **Monitoring** — subscribe to each tenant's CF deploy webhook, or poll?

---

## 11. Alternatives considered

- **Manual handoff (status quo)** — simplest; no CI, no delivery repos. Does not
  scale: every update is a re-send and tenants drift. Kept as Phase 0 / fallback.
- **Cloudflare Direct Upload via tenant API token** — our CI runs
  `wrangler pages deploy dist/<tenant>` against the tenant's project using a
  scoped token they issue us. **No delivery repo, fewer moving parts, push-button
  deploy.** Trade-off: we become the **custodian of a live credential to each
  tenant's Cloudflare account**, and there is no git history on their side
  (rollback via CF dashboard only). Strong contender — arguably simpler than
  git-connected for a handful of tenants. **Fully specified in §13.**
- **Central hosting (RFC-001)** — one Pages project, per-tenant custom domains,
  edge theming. We keep total control and one deploy, but the tenant does **not**
  own their account/hosting — which is the explicit goal here. Retain as an
  opt-in for tenants who don't want their own CF account.
- **Branch-per-tenant / monorepo-subdir delivery** (§5.1 B/C) — fewer repos, but
  weaker isolation and coupled blast radius.
- **Tenant-owned delivery repo** (§5.2 B) — more tenant autonomy, more
  coordination and trust on our push access.

---

## 12. Appendix

### 12.1 Roles at a glance
| Concern | Owner |
|---|---|
| Template, configs, generator (source) | **Us** (private repo) |
| Baked output (delivery repo) | **Us** (Option A), tenant granted read |
| Content/design updates | **Us** (merge → CI) |
| Cloudflare account, project, billing | **Tenant** |
| Custom domain + DNS/SSL | **Tenant** |

### 12.2 Definition of done (Phase 3)
- [ ] Generator emits deterministic, self-contained `dist/<tenant>/` (relative
      asset paths, build-id stamped)
- [ ] Delivery-repo creation scripted
- [ ] CI publishes source → delivery repo on merge, output-only
- [ ] First tenant connected on their own CF account + domain, auto-deploying
- [ ] Update + rollback validated end-to-end
- [ ] Deploy monitoring/alerting in place

### 12.3 Relationship to RFC-001
RFC-001 = central hosting (we host, per-tenant custom domains, edge theming).
RFC-002 = distributed self-hosting (tenant hosts baked static, git-connected
updates). They can coexist: RFC-001 as an opt-in managed tier, RFC-002 as the
bring-your-own-account tier.

---

## 13. Alternative delivery: Cloudflare Direct Upload via tenant API token

Instead of publishing to a git repo the tenant's Pages project watches (§4–§9),
our CI deploys **directly** into the tenant's Pages project with
`wrangler pages deploy`, authenticated by a scoped API token the tenant issues
us. No delivery repo, no tenant-side git connection.

### 13.1 What the tenant hands us (per tenant)

Three values — only the first is a secret:

| Value | Secret? | Where the tenant gets it | Notes |
|---|---|---|---|
| `CLOUDFLARE_API_TOKEN` | **yes** | CF dashboard → My Profile / Account → API Tokens → Create | Scope tightly — see §13.2 |
| `CLOUDFLARE_ACCOUNT_ID` | no | CF dashboard (account home / URL) | Per-tenant, not sensitive |
| Pages **project name** | no | The Pages project they created | Target of the deploy |

The tenant also does the one-time setup on their side: create the Pages project
(can be an empty Direct-Upload project) and add their custom domain + DNS/SSL.

### 13.2 Token scoping (security-critical)

The token must be **least-privilege**, so a leak is contained:

- **Permission:** `Account → Cloudflare Pages → Edit` (nothing else — no DNS, no
  Workers, no Zone).
- **Account resources:** restricted to **that tenant's account only** (never
  "all accounts").
- **TTL:** set an expiry (e.g. 90 days) to force rotation; optionally restrict by
  client IP to our CI egress if available.

Because CF tokens are account-scoped, a correctly-scoped token can only ever
touch *that* tenant's Pages — cross-tenant blast radius is zero **as long as
tokens are stored in isolation** (§13.3).

### 13.3 Where the tokens live — storage tiers

| Tier | Mechanism | Isolation | Best for |
|---|---|---|---|
| 1. Flat repo secrets | `CF_TOKEN_VERDANT`, `CF_ACCT_VERDANT`, … | **Weak** — any workflow with write access can read *all* tenants' tokens | 2–3 tenants, throwaway |
| 2. **GitHub Environments — one per tenant** _(recommended)_ | Env `tenant-verdant` holds that tenant's `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` | **Strong** — a job for tenant A cannot read tenant B's secrets; supports required-reviewer rules + per-env audit | First real cohort |
| 3. External secrets manager | Vault / Doppler / 1Password / AWS SM, injected via OIDC | **Strong + rotation/audit** | Many tenants / compliance |

**Recommendation: Tier 2 (GitHub Environments).** Biggest security gain for the
least setup; graduate to Tier 3 only when tenant count or compliance demands it.

### 13.4 Deploy job (Tier 2 shape)

```yaml
# on merge to main, after build produces dist/<tenant>/
strategy:
  matrix:
    tenant: [verdant, acme]
environment: tenant-${{ matrix.tenant }}     # scopes secrets to this tenant only
steps:
  - run: npx wrangler pages deploy dist/${{ matrix.tenant }} \
           --project-name=${{ vars.CF_PROJECT_NAME }}
    env:
      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

Each matrix leg runs in its own environment, so it can only see its own tenant's
credentials.

### 13.5 Credential lifecycle (the ongoing cost)

This model's real weight is operational, not technical:

- **Rotation:** tokens expire (§13.2) — need a routine to collect + swap new ones
  before expiry, or deploys start failing.
- **Revocation / offboarding:** delete the secret **and** tell the tenant to
  revoke the token on their side.
- **Breach response:** a leak of our Actions secrets = write access to every
  stored tenant account. Tier 2/3 isolation limits *reading* them; rotation
  limits the window.
- **Failure surfacing:** a revoked/expired token fails the deploy — alert on it
  so a tenant doesn't silently stop receiving updates.

### 13.6 Direct Upload vs. git-connected — side by side

| | Git-connected (§4–§9) | Direct Upload (§13) |
|---|---|---|
| Credentials we hold | **None** | One scoped token **per tenant** |
| Pipeline complexity | Delivery repo + publish step per tenant | Single `wrangler deploy`, no delivery repo |
| Tenant one-time setup | Connect CF to our repo | Create project + issue us a token |
| Rollback | Git revert (repo history on tenant side) | CF dashboard redeploy only |
| Deploy history/audit | Git log per tenant | CF deployments list |
| Blast radius if *we* are breached | Low (no tenant creds) | High (write to every stored account) |
| Scales cleanly to many tenants | Yes (repo-per-tenant, scripted) | Adds credential-custody burden per tenant |

**Heuristic:** ≤ a handful of tenants and we accept credential custody → Direct
Upload + GitHub Environments is genuinely simpler. Growing tenant count, or we
want to hold **zero** tenant credentials → git-connected.
