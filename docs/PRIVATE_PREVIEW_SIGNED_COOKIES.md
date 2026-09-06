# Part 4 design: in-plugin previews of private Storybooks (signed URL → partitioned cookie)

**Status: designed, not built (2026-09-06).** Parts 1–3 (project Storybook URLs
in `/api/projects?include=storybookUrl`, an honest project picker in the plugin,
and Scry PAT bearer auth on this CDN for private projects) let the Figma plugin
list and link stories of private projects. What they do not give is a *preview*
of a private story inside the plugin: the preview is an `<iframe>` and an iframe
navigation cannot carry an `Authorization` header, nor can the dozens of chunk,
CSS, `index.json` and image requests Storybook makes once it boots.

## Why cookies, and why partitioned

Every one of those sub-requests must be authorized, so the credential has to ride
along automatically — i.e. a cookie. But the preview iframe is embedded in
Figma's page, which makes `view.scrymore.com` a third party there, and browsers
now block ordinary third-party cookies. **CHIPS / partitioned cookies** are the
standards-track answer for exactly this case ("an embedded service that needs
per-site state"): a cookie scoped to *view.scrymore.com as embedded under
figma.com*. The plugin UI's `null` origin does not matter — the partition key is
the top-level site.

Precedent: CloudFront *signed cookies* (vs. signed URLs) for multi-file private
content; Cloudflare Access `CF_Authorization`; Vercel's deployment-protection
bypass (token in query → cookie for everything after). This design is those
patterns composed, not something new.

## Flow

```
plugin ──(Bearer PAT)──▶ dashboard  GET /api/projects/:id/preview-token
                                   ├─ membership check (same as today)
                                   └─ returns signed token {uid, projectId, exp ≤ 10 min}

plugin sets <iframe src=".../iframe.html?id=<story>&scry_preview=<token>">

CDN privateProjectAuth (private project, no cookie, ?scry_preview present)
   ├─ verify signature + exp + projectId == path project   (no Firestore call)
   ├─ Set-Cookie: __scry_preview=<token>; Path=/<projectId>/;
   │              Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=<remaining>
   └─ 302 → same URL without scry_preview          (keeps the token out of Referer/address)

every subsequent asset request carries the partitioned cookie
   └─ CDN accepts the cookie exactly like the query token
```

The plugin mints a fresh token each time it opens a preview; nothing long-lived
ever exists. `Referrer-Policy: no-referrer` on HTML responses as belt-and-braces.

## Token

- HMAC-SHA256 (or ES256 if we want the dashboard to hold the only private key)
  over `{ v:1, uid, projectId, exp, nonce }`; base64url; ≤ 10 minutes.
- Shared secret `PREVIEW_TOKEN_SECRET` as a wrangler secret here and a Vercel
  secret on the dashboard. Rotation: accept two secrets during a rollover window.
- Bound to one project (path-scoped cookie) and one user. The CDN trusts the
  dashboard's membership decision at mint time; it re-checks nothing, which keeps
  the hot path free of Firestore.

## Where the code lands

| Repo | Change |
|---|---|
| scry-cdn-service | `auth/preview-token.ts` (verify), `middleware/auth.ts` (accept `?scry_preview` and the cookie on private projects, exchange redirect), HTML `Referrer-Policy`, tests |
| scry-developer-dashboard | `POST /api/projects/:id/preview-token` (Bearer PAT, membership, sign), add to the plugin CORS matcher, tests |
| scry-link | when the connected project is private, mint before opening a preview, refresh on expiry, keep the "open in browser" button unconditionally |

Roughly a day. Deploy the CDN part to `scry-cdn-service-dev` first; production
with explicit go-ahead (this Worker serves every Storybook).

## Browser support and the guaranteed path

- Figma desktop is Chromium → partitioned cookies work → previews work.
- Safari (and Firefox < 131) don't implement CHIPS; the preview would fail and,
  because the iframe is cross-origin, the plugin cannot see why. The standard
  complement there is the Storage Access API (needs a user gesture and a prior
  first-party visit) — more ceremony, later if ever.
- Therefore "Open in browser" (session cookie) stays visible for private
  projects regardless; the in-plugin preview is progressive enhancement.

## Rejected alternatives

- Rewriting every asset URL in Storybook's HTML to carry a token: Storybook
  loads chunks dynamically, so rewriting is unreliable.
- A service worker in the plugin iframe: not available in the sandbox.
- Proxying the preview through the dashboard origin: still cross-origin from
  the plugin, same cookie problem, plus double bandwidth.

## Reuse

The same signed-URL exchange lets *any* embed of a private Storybook work
without a dashboard session — share links, agent screenshots, MCP fetches — so
it is worth building as a CDN primitive rather than a plugin special case.
