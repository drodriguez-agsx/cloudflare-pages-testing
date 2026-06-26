/**
 * Cloudflare Pages Function — edge tenant theming (Mode A).
 * ---------------------------------------------------------------------------
 * Runs on every request to this Pages project. For HTML responses it:
 *   1. Resolves the tenant slug (from ?tenant=… or the subdomain).
 *   2. Fetches that tenant's config JSON from S3 (cached at the edge).
 *   3. Inlines it as `window.__TENANT__` inside <head>.
 *
 * The page's loader sees `window.__TENANT__` and applies tokens + content
 * with NO client-side fetch and NO flash of the default theme.
 *
 * If the config can't be fetched, the request passes through untouched and
 * the page falls back to its baked-in defaults (or its own runtime fetch).
 *
 * Configure the S3 base via a Pages environment variable:
 *   TENANT_CONFIG_BASE = https://YOUR_BUCKET.s3.amazonaws.com/tenants
 *
 * To run edge-only, delete the <meta name="tenant-config-base"> from index.html
 * so the page never attempts its own fetch.
 */

export async function onRequest(context) {
  const { request, next, env } = context;

  // Let Pages produce the static asset response first.
  const response = await next();

  // Only rewrite HTML documents.
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  const base = env.TENANT_CONFIG_BASE;
  if (!base) return response; // not configured — serve defaults

  const url = new URL(request.url);
  const slug = resolveSlug(url);

  let config = null;
  try {
    const configUrl = base.replace(/\/$/, '') + '/' + slug + '.json';
    // Cache the tenant JSON at the edge so we don't hit S3 on every request.
    const res = await fetch(configUrl, {
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (res.ok) config = await res.json();
  } catch (_) {
    // Network/parse failure → fall through to defaults.
  }

  if (!config) return response;

  return new HTMLRewriter()
    .on('head', new ConfigInjector(config))
    .transform(response);
}

/**
 * Pick the tenant slug. Priority:
 *   1. ?tenant=acme   (handy for previews)
 *   2. subdomain      (acme.example.com → "acme")
 *   3. "default"
 */
function resolveSlug(url) {
  const fromQuery = url.searchParams.get('tenant');
  if (fromQuery) return sanitize(fromQuery);

  const host = url.hostname;
  const label = host.split('.')[0];
  if (label && label !== 'www' && host.includes('.')) return sanitize(label);

  return 'default';
}

// Allow only safe slug characters to avoid building odd fetch URLs.
function sanitize(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

class ConfigInjector {
  constructor(config) {
    this.config = config;
  }
  element(head) {
    // Escape "<" so a value containing "</script>" can't break out of the tag.
    const json = JSON.stringify(this.config).replace(/</g, '\\u003c');
    head.append(`<script>window.__TENANT__=${json};</script>`, { html: true });
  }
}
