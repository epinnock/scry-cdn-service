# Part 4 design: in-plugin previews of private Storybooks (signed URL → partitioned cookie)

**Status: built (2026-09-08) — CDN side in this repo (deployed to
`scry-cdn-service-dev`; production awaits go-ahead), dashboard endpoint in
scry-developer-dashboard, plugin side in scry-link. See "What was built" at
the end.** Parts 1–3 (project Storybook URLs
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

## What was built (2026-09-08)

**scry-cdn-service** (`feat/private-preview-signed-cookie`)

- `src/auth/preview-token.ts` — `verifyPreviewToken(token, projectId, env)`:
  token is `base64url(JSON payload) "." base64url(HMAC-SHA256(secret, payloadB64))`
  over `{ v: 1, uid, projectId, exp, nonce }` (`exp` in unix seconds), verified
  with WebCrypto against `PREVIEW_TOKEN_SECRET` and, if set,
  `PREVIEW_TOKEN_SECRET_PREVIOUS`. Rejects: bad/missing signature, malformed or
  wrong-shaped payload, another project, expired, or an `exp` more than
  10 min (+60 s skew) away. No secret configured → everything rejected.
  `previewCookie()` builds `__scry_preview=<token>; Path=/<projectId>/; Secure;
  HttpOnly; SameSite=None; Partitioned; Max-Age=<remaining>`.
- `src/middleware/auth.ts` — on a private project, after the PAT bearer and
  before the session cookie: `?scry_preview=<token>` present → verify (401 if
  invalid) → `Set-Cookie` as above + `Cache-Control: no-store` + `302` to the
  same URL minus the parameter. A `__scry_preview` cookie that verifies admits
  the request with no Firestore/Google round-trip; a stale one is ignored and
  the session path still runs. Public projects never look at either.
- `Referrer-Policy` on private-project HTML is **`same-origin`**, not the
  `no-referrer` written above: after the exchange the token is never in a
  document URL, so both values keep it out of every Referer — but
  `no-referrer` would also strip the same-origin Referer that the CDN's
  absolute-asset-path redirect (`app.ts`, PRs #13/#15/#16) relies on, breaking
  `src="/hero.png"`-style assets on private Storybooks. `same-origin` keeps
  that working and still sends nothing to third parties.
- Tests: `tests/auth/preview-token.test.ts` (verifier + reference signer) and
  `tests/middleware/auth.test.ts` "signed preview token" (exchange, 401 cases,
  cookie path scoping, stale-cookie fallback, previous secret, no secret,
  public untouched, Referrer-Policy). Secret lives only in the Worker
  (`wrangler secret put PREVIEW_TOKEN_SECRET --env <env>`) and a gitignored
  `.secrets.<env>.json`.

**scry-developer-dashboard** — `POST /api/projects/[id]/preview-token`
(Bearer Scry PAT or Firebase id token via `verifyToken`, owner/member check,
503 when `PREVIEW_TOKEN_SECRET` is unset) returns
`{ token, expiresAt, storybookUrl }` (10-minute `exp`, random nonce,
`storybookUrl` of the newest active build or null). Added to the plugin CORS
matcher in `middleware.ts`. `lib/api/preview-token.ts` holds the signer.

**scry-link** — `mintPreviewToken(token, projectId)` in `src/lib/scry-api.ts`;
`StoryPreview` takes `previewToken` and, for a private project with a
signed-in user, renders
`<iframe src="<storybookUrl>/iframe.html?id=<story>&viewMode=story&scry_preview=<token>">`.
`App` mints when a preview of a private project opens and re-mints after
`expiresAt`; "Open in browser" stays; signed-out or a failed mint shows the
previous hand-off text (also on the embed-failed path).

**Rollout.** CDN dev Worker deployed from the branch with the secret set;
Vercel Preview + Production carry the same `PREVIEW_TOKEN_SECRET`. Production
CDN: set the secret, then deploy — the plugin's private previews 401 (as
today) until both are done.
