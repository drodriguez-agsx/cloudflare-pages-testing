# Docs

Design and planning documents for the multi-tenant landing template.

| Doc | Status | Summary |
|---|---|---|
| [RFC-001: Per-Tenant Custom Domains (Model B)](./rfc-001-model-b-per-tenant-custom-domains.md) | Draft (RFC) | **Central hosting**: Cloudflare Pages + per-tenant custom domains + S3-hosted config, themed at the edge. No code change / no redeploy to onboard a tenant. |
| [RFC-002: Git-Connected Per-Tenant Deploy](./rfc-002-git-connected-tenant-deploy.md) | Draft (RFC) | **Distributed self-hosting**: central repo as a factory that bakes a self-contained static bundle per tenant; each tenant self-hosts on their own Cloudflare account/domain, with git-connected auto-deploy from our CI. |

For setup and usage of the template itself (modes, schema, deploy), see the
[project README](../README.md).
