/**
 * Cloudflare Pages Function — tenant theming (Mode A: edge injection).
 * ---------------------------------------------------------------------------
 * Runs on every request. For HTML responses it resolves a tenant config and
 * inlines it as `window.__TENANT__` in <head>, so the page is themed
 * server-side with zero client fetch and zero flash.
 *
 * TWO MODES, switched automatically by the TENANT_CONFIG_BASE env var:
 *
 *   • DEMO mode  (env var NOT set) — uses the hardcoded SAMPLE_TENANTS below
 *     and injects a small on-page switcher. Great for showing the concept on
 *     the default *.pages.dev domain: visit /?tenant=verdant, /?tenant=coral …
 *
 *   • PROD mode  (env var set, e.g. https://bucket.s3.amazonaws.com/tenants)
 *     — fetches `${base}/${slug}.json` from S3, no switcher. Slug comes from
 *     ?tenant=… or the subdomain (acme.example.com → "acme").
 */

export async function onRequest(context) {
  const { request, next, env } = context;

  const response = await next();
  if (!(response.headers.get('content-type') || '').includes('text/html')) return response;

  const base = env.TENANT_CONFIG_BASE;
  const demo = !base;
  const url = new URL(request.url);
  const param = url.searchParams.get('tenant');
  const slug = param ? sanitize(param) : (demo ? '' : resolveHostSlug(url));

  // Resolve the config for this request.
  let config = null;
  if (slug && SAMPLE_TENANTS[slug]) {
    config = SAMPLE_TENANTS[slug];          // demo or override hit
  } else if (base && slug) {
    try {
      const res = await fetch(base.replace(/\/$/, '') + '/' + slug + '.json', {
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (res.ok) config = await res.json();
    } catch (_) { /* fall back to page defaults */ }
  }

  // Nothing to inject and not in demo mode → serve the page untouched.
  if (!config && !demo) return response;

  let rewriter = new HTMLRewriter();
  if (config) rewriter = rewriter.on('head', new ConfigInjector(config));
  if (demo) rewriter = rewriter.on('body', new SwitcherInjector(slug));
  return rewriter.transform(response);
}

function resolveHostSlug(url) {
  const label = url.hostname.split('.')[0];
  if (label && label !== 'www' && url.hostname.includes('.')) return sanitize(label);
  return 'default';
}

function sanitize(slug) {
  return slug.toLowerCase().replace(/[^a-z0-9-]/g, '');
}

class ConfigInjector {
  constructor(config) { this.config = config; }
  element(head) {
    const json = JSON.stringify(this.config).replace(/</g, '\\u003c');
    head.append(`<script>window.__TENANT__=${json};</script>`, { html: true });
  }
}

class SwitcherInjector {
  constructor(active) { this.active = active; }
  element(body) {
    const link = (slug, label) => {
      const on = slug === this.active;
      return `<a href="${slug ? '?tenant=' + slug : '?'}" style="padding:6px 12px;border-radius:999px;` +
        `text-decoration:none;font:600 12px system-ui,sans-serif;` +
        `background:${on ? '#fff' : 'rgba(255,255,255,.12)'};color:${on ? '#111' : '#fff'};">${label}</a>`;
    };
    const links = [link('', 'Default')]
      .concat(Object.entries(SAMPLE_TENANTS).map(([slug, cfg]) => link(slug, cfg._label || slug)))
      .join('');
    body.append(
      `<div style="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;` +
      `display:flex;gap:8px;align-items:center;padding:8px 12px;border-radius:999px;` +
      `background:rgba(17,19,26,.92);box-shadow:0 6px 24px rgba(0,0,0,.35);backdrop-filter:blur(6px);">` +
      `<span style="font:700 11px system-ui,sans-serif;color:#8a93a6;letter-spacing:.05em;">DEMO TENANT</span>` +
      links + `</div>`,
      { html: true }
    );
  }
}

/* ───────────────────────────────────────────────────────────────────────────
   SAMPLE TENANTS (demo only)
   `makeTenant` fills the full config from a small spec; shared copy is lorem.
   Add/edit entries here, or delete this block once S3 configs are wired up.
─────────────────────────────────────────────────────────────────────────── */
function logoDataUri(bg, fg, initials) {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">` +
    `<rect width="48" height="48" rx="11" fill="${bg}"/>` +
    `<text x="24" y="32" text-anchor="middle" font-family="system-ui,sans-serif" ` +
    `font-size="20" font-weight="800" fill="${fg}">${initials}</text></svg>`;
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
}

function makeTenant(s) {
  const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  const item = (t) => ({ title: t, body: lorem });
  return {
    _label: s.label,
    meta: { title: s.name + ' | Mobile App', description: s.name + ' — secure, convenient mobile banking.' },
    brand: {
      name: s.name, shortName: s.short, tagline: s.tagline, location: s.location,
      logoUrl: logoDataUri(s.primary, s.accent, s.short),
    },
    hero: {
      badge: 'Official Mobile App',
      headlineLead: s.headlineLead, headlineAccent: s.headlineAccent,
      subhead: s.subhead,
      pills: [{ label: 'Secure Login' }, { label: 'Instant Transfers' }, { label: '24/7 Access' }, { label: 'Account Management' }],
    },
    features: {
      label: 'What You Can Do', heading: 'Everything You Need, Right in Your Phone', intro: lorem,
      items: [item('Secure Authentication'), item('Fund Transfers'), item('Account Overview'),
        item('Bills Payment'), item('24/7 Support'), item('Trusted Security')],
    },
    support: {
      label: 'App Support & Contact', heading: "We're Here to Help", intro: lorem,
      email: s.email, emailHref: 'mailto:' + s.email,
      phone: s.phone, phoneHref: 'tel:' + s.phone.replace(/[^0-9+]/g, ''),
      address: s.address, hours: 'Mon – Fri: 8:00 AM – 5:00 PM', hoursNote: 'Saturdays and holidays may vary',
    },
    privacy: { label: 'Legal & Data Privacy', heading: 'Privacy Policy', intro: lorem, fullPolicyUrl: '#' },
    links: { androidUrl: '#' },
    footer: { trustBadge: s.trustBadge },
    tokens: {
      'color-primary': s.primary, 'color-primary-mid': s.primaryMid,
      'color-accent': s.accent, 'color-accent-lt': s.accentLt, 'color-highlight': s.highlight,
      'hero-to': s.heroTo, 'btn-primary-bg': s.primary, 'card-accent': s.accent,
    },
  };
}

const SAMPLE_TENANTS = {
  northwind: makeTenant({
    label: 'Northwind', name: 'Northwind Bank', short: 'NB',
    tagline: 'Banking, due north', location: 'Harbor City, Country',
    headlineLead: 'Bank Smarter with', headlineAccent: 'Northwind',
    subhead: 'Secure, convenient, fully digital banking for the whole coast — anytime, anywhere.',
    email: 'support@northwind.example', phone: '(02) 8123-4567', address: '1 Harbor Plaza, Harbor City',
    trustBadge: 'Member NDIC • Insured',
    primary: '#0b2a6b', primaryMid: '#1746b0', accent: '#f5b301', accentLt: '#ffd95e',
    highlight: '#36c5d6', heroTo: '#2f6bff',
  }),
  verdant: makeTenant({
    label: 'Verdant', name: 'Verdant Credit Union', short: 'VC',
    tagline: 'Grow your money', location: 'Greenvale, Country',
    headlineLead: 'Grow with', headlineAccent: 'Verdant',
    subhead: 'Community-first digital banking that helps your savings flourish, 24/7.',
    email: 'help@verdant.example', phone: '(02) 8222-1100', address: '88 Meadow Road, Greenvale',
    trustBadge: 'Member NDIC • Insured',
    primary: '#0f4d34', primaryMid: '#1c7a52', accent: '#7ac74f', accentLt: '#b6e88f',
    highlight: '#2ec4b6', heroTo: '#1f9d5b',
  }),
  coral: makeTenant({
    label: 'Coral', name: 'Coral Pay', short: 'CP',
    tagline: 'Payments, simplified', location: 'Bayfront, Country',
    headlineLead: 'Move money with', headlineAccent: 'Coral Pay',
    subhead: 'Send, spend, and split instantly with a wallet built for the way you live.',
    email: 'care@coral.example', phone: '(02) 8345-9000', address: '5 Bayfront Ave, Bayfront',
    trustBadge: 'Licensed E-Money Issuer',
    primary: '#4a1535', primaryMid: '#8a2b5e', accent: '#ff5d73', accentLt: '#ff9fb0',
    highlight: '#ffb86b', heroTo: '#c43a73',
  }),
};
