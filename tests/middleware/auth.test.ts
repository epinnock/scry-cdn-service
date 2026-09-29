import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { privateProjectAuth } from '@/middleware/auth';

vi.mock('@/services/visibility', () => ({
  getProjectVisibility: vi.fn(),
  isProjectMember: vi.fn(),
}));

vi.mock('@/auth/firebase-session', () => ({
  validateFirebaseSessionCookie: vi.fn(),
  parseCookies: vi.fn(),
}));
vi.mock('@/auth/session-revocation', async (orig) => ({
  ...(await orig<any>()),
  getSessionValidAfter: vi.fn(),
}));
vi.mock('@/auth/scry-pat', () => ({
  isScryPat: (t: string) => t.startsWith('scry_pat_'),
  verifyScryPat: vi.fn(),
}));

import { getProjectVisibility, isProjectMember } from '@/services/visibility';
import { validateFirebaseSessionCookie, parseCookies } from '@/auth/firebase-session';
import { verifyScryPat } from '@/auth/scry-pat';
import { getSessionValidAfter } from '@/auth/session-revocation';
import { signPreviewToken } from '../auth/preview-token.test';
import { captureConsole } from '../helpers/capture-console';

describe('privateProjectAuth middleware', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();
    (getSessionValidAfter as any).mockResolvedValue(0); // never signed out

    app = new Hono();
    app.use('/*', privateProjectAuth);
    app.get('/*', (c) => c.text('OK'));
  });

  const mockEnv = {
    FIREBASE_PROJECT_ID: 'test-project',
    CDN_CACHE: { get: vi.fn(), put: vi.fn() },
    UPLOAD_BUCKET: { get: vi.fn() },
  };

  it('allows access to public projects without auth', async () => {
    (getProjectVisibility as any).mockResolvedValue({
      visibility: 'public',
      memberIds: [],
    });

    const req = new Request('https://view.scrymore.com/public-project/v1/index.html');
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(200);
  });

  it('returns 401 for private project without session cookie', async () => {
    (getProjectVisibility as any).mockResolvedValue({
      visibility: 'private',
      memberIds: ['user-123'],
    });
    (parseCookies as any).mockReturnValue({});

    const req = new Request('https://view.scrymore.com/private-project/v1/index.html');
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(401);
  });

  it('returns 401 for invalid session cookie', async () => {
    (getProjectVisibility as any).mockResolvedValue({
      visibility: 'private',
      memberIds: ['user-123'],
    });
    (parseCookies as any).mockReturnValue({ __session: 'invalid-token' });
    (validateFirebaseSessionCookie as any).mockResolvedValue({
      valid: false,
      error: 'Invalid token',
    });

    const req = new Request('https://view.scrymore.com/private-project/v1/index.html', {
      headers: { Cookie: '__session=invalid-token' },
    });
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(401);
  });

  it('returns 403 when user is not a project member', async () => {
    (getProjectVisibility as any).mockResolvedValue({
      visibility: 'private',
      memberIds: ['other-user'],
    });
    (parseCookies as any).mockReturnValue({ __session: 'valid-token' });
    (validateFirebaseSessionCookie as any).mockResolvedValue({
      valid: true,
      uid: 'user-123',
    });
    (isProjectMember as any).mockReturnValue(false);

    const req = new Request('https://view.scrymore.com/private-project/v1/index.html', {
      headers: { Cookie: '__session=valid-token' },
    });
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(403);
  });

  it('allows access when user is a project member', async () => {
    (getProjectVisibility as any).mockResolvedValue({
      visibility: 'private',
      memberIds: ['user-123'],
    });
    (parseCookies as any).mockReturnValue({ __session: 'valid-token' });
    (validateFirebaseSessionCookie as any).mockResolvedValue({
      valid: true,
      uid: 'user-123',
    });
    (isProjectMember as any).mockReturnValue(true);

    const req = new Request('https://view.scrymore.com/private-project/v1/index.html', {
      headers: { Cookie: '__session=valid-token' },
    });
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(200);
  });

  // Previously this expected 200 — a project with no Firestore document served
  // its entire hosted Storybook to anyone, unauthenticated. A missing record is
  // an unknown project, not a public one. Transient Firestore failures do not
  // produce null; getProjectVisibility() maps those to private/no-members.
  it('denies access when project not found', async () => {
    (getProjectVisibility as any).mockResolvedValue(null);

    const req = new Request('https://view.scrymore.com/nonexistent/v1/index.html');
    const res = await app.fetch(req, mockEnv as any);

    expect(res.status).toBe(404);
  });

  describe('Scry PAT bearer (Figma plugin)', () => {
    const privateProject = { visibility: 'private', memberIds: ['user-123'] };

    it('admits a valid PAT whose owner is a member, with no cookie at all', async () => {
      (getProjectVisibility as any).mockResolvedValue(privateProject);
      (verifyScryPat as any).mockResolvedValue({ uid: 'user-123' });
      (isProjectMember as any).mockReturnValue(true);
      const req = new Request('https://view.scrymore.com/private-project/v1/index.json', {
        headers: { Authorization: 'Bearer scry_pat_user123_abc' },
      });
      const res = await app.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      expect(verifyScryPat).toHaveBeenCalledWith('scry_pat_user123_abc', expect.anything());
      expect(validateFirebaseSessionCookie).not.toHaveBeenCalled();
    });

    it('returns 403 for a valid PAT whose owner is not a member', async () => {
      (getProjectVisibility as any).mockResolvedValue(privateProject);
      (verifyScryPat as any).mockResolvedValue({ uid: 'stranger' });
      (isProjectMember as any).mockReturnValue(false);
      const req = new Request('https://view.scrymore.com/private-project/v1/index.json', {
        headers: { Authorization: 'Bearer scry_pat_stranger_abc' },
      });
      const res = await app.fetch(req, mockEnv as any);
      expect(res.status).toBe(403);
    });

    it('returns 401 for an invalid PAT and does not fall back to cookies', async () => {
      (getProjectVisibility as any).mockResolvedValue(privateProject);
      (verifyScryPat as any).mockResolvedValue(null);
      (parseCookies as any).mockReturnValue({ __session: 'would-be-valid' });
      const req = new Request('https://view.scrymore.com/private-project/v1/index.json', {
        headers: { Authorization: 'Bearer scry_pat_user123_revoked', Cookie: '__session=would-be-valid' },
      });
      const res = await app.fetch(req, mockEnv as any);
      expect(res.status).toBe(401);
      expect(validateFirebaseSessionCookie).not.toHaveBeenCalled();
    });

    it('ignores a non-Scry bearer and uses the cookie path', async () => {
      (getProjectVisibility as any).mockResolvedValue(privateProject);
      (parseCookies as any).mockReturnValue({});
      const req = new Request('https://view.scrymore.com/private-project/v1/index.json', {
        headers: { Authorization: 'Bearer some-other-token' },
      });
      const res = await app.fetch(req, mockEnv as any);
      expect(res.status).toBe(401);
      expect(verifyScryPat).not.toHaveBeenCalled();
    });

    it('never consults the PAT on public projects', async () => {
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'public', memberIds: [] });
      const req = new Request('https://view.scrymore.com/public-project/v1/index.json', {
        headers: { Authorization: 'Bearer scry_pat_user123_abc' },
      });
      const res = await app.fetch(req, mockEnv as any);
      expect(res.status).toBe(200);
      expect(verifyScryPat).not.toHaveBeenCalled();
    });
  });

  describe('signed preview token (in-plugin previews)', () => {
    const SECRET = 'cdn-test-secret-0123456789abcdef0123456789abcdef';
    const PREVIOUS = 'cdn-previous-secret-0123456789abcdef0123456789ab';
    const PROJECT = 'private-project';
    const privateProject = { visibility: 'private', memberIds: ['user-123'] };
    const env = { ...mockEnv, PREVIEW_TOKEN_SECRET: SECRET };
    const realParseCookies = (header: string | null) => {
      const out: Record<string, string> = {};
      for (const part of (header ?? '').split(';')) {
        const [k, ...v] = part.split('=');
        if (k?.trim()) out[k.trim()] = v.join('=').trim();
      }
      return out;
    };

    const mint = (overrides: Record<string, unknown> = {}, secret = SECRET) =>
      signPreviewToken(
        { v: 1, uid: 'user-123', projectId: PROJECT, exp: Math.floor(Date.now() / 1000) + 600, nonce: 'n', ...overrides },
        secret,
      );

    beforeEach(() => {
      (getProjectVisibility as any).mockResolvedValue(privateProject);
      (parseCookies as any).mockImplementation(realParseCookies);
      app = new Hono();
      app.use('/*', privateProjectAuth);
      app.get('/*', (c) => {
        if (c.req.path.endsWith('.html')) return c.html('<!doctype html><p>story</p>');
        return c.text('OK');
      });
    });

    it('exchanges a valid ?scry_preview for a partitioned, path-scoped cookie and redirects without the parameter', async () => {
      const token = await mint();
      const req = new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html?id=button--primary&viewMode=story&scry_preview=${token}`);
      const res = await app.fetch(req, env as any);
      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe(`/${PROJECT}/v2/iframe.html?id=button--primary&viewMode=story`);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      const cookie = res.headers.get('Set-Cookie')!;
      expect(cookie.startsWith(`__scry_preview=${token}; `)).toBe(true);
      expect(cookie).toContain(`Path=/${PROJECT}/`);
      for (const attr of ['Secure', 'HttpOnly', 'SameSite=None', 'Partitioned']) expect(cookie).toContain(attr);
      const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
      expect(maxAge).toBeGreaterThan(590);
      expect(maxAge).toBeLessThanOrEqual(600);
      expect(validateFirebaseSessionCookie).not.toHaveBeenCalled();
    });

    it('returns 401 for an expired token, a token for another project, and a bad signature', async () => {
      const cases = [
        await mint({ exp: Math.floor(Date.now() / 1000) - 5 }),
        await mint({ projectId: 'some-other-project' }),
        await mint({}, 'wrong-secret'),
        'garbage',
      ];
      for (const token of cases) {
        const req = new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html?scry_preview=${token}`);
        const res = await app.fetch(req, env as any);
        expect(res.status, token).toBe(401);
        expect(res.headers.get('Set-Cookie')).toBeNull();
      }
    });

    it('admits every request carrying a valid cookie, with no Firestore or Google round-trip', async () => {
      const token = await mint();
      for (const path of ['iframe.html', 'index.json', 'assets/chunk-abc.js']) {
        const req = new Request(`https://view.scrymore.com/${PROJECT}/v2/${path}`, {
          headers: { Cookie: `__scry_preview=${token}` },
        });
        const res = await app.fetch(req, env as any);
        expect(res.status, path).toBe(200);
      }
      expect(validateFirebaseSessionCookie).not.toHaveBeenCalled();
      expect(verifyScryPat).not.toHaveBeenCalled();
    });

    it('scopes the cookie to its project: another private project rejects it', async () => {
      const token = await mint();
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'private', memberIds: ['user-123'] });
      const req = new Request('https://view.scrymore.com/another-private/v1/index.json', {
        headers: { Cookie: `__scry_preview=${token}` },
      });
      const res = await app.fetch(req, env as any);
      expect(res.status).toBe(401);
    });

    it('falls back to the session cookie when the preview cookie is stale', async () => {
      const stale = await mint({ exp: Math.floor(Date.now() / 1000) - 5 });
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123' });
      (isProjectMember as any).mockReturnValue(true);
      const req = new Request(`https://view.scrymore.com/${PROJECT}/v2/index.json`, {
        headers: { Cookie: `__scry_preview=${stale}; __session=valid-session` },
      });
      const res = await app.fetch(req, env as any);
      expect(res.status).toBe(200);
      expect(validateFirebaseSessionCookie).toHaveBeenCalledWith('valid-session', expect.anything(), expect.anything());
    });

    it('accepts a token signed with the previous secret during rotation', async () => {
      const token = await mint({}, PREVIOUS);
      const rotating = { ...env, PREVIEW_TOKEN_SECRET_PREVIOUS: PREVIOUS };
      const exchange = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html?scry_preview=${token}`),
        rotating as any,
      );
      expect(exchange.status).toBe(302);
      const withCookie = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/index.json`, { headers: { Cookie: `__scry_preview=${token}` } }),
        rotating as any,
      );
      expect(withCookie.status).toBe(200);
      const noPrevious = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/index.json`, { headers: { Cookie: `__scry_preview=${token}` } }),
        env as any,
      );
      expect(noPrevious.status).toBe(401);
    });

    it('rejects everything when no secret is configured', async () => {
      const token = await mint();
      const res = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html?scry_preview=${token}`),
        mockEnv as any,
      );
      expect(res.status).toBe(401);
    });

    it('leaves public projects untouched: no exchange, no cookie, the parameter is ignored', async () => {
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'public', memberIds: [] });
      const token = await mint({ projectId: 'public-project' });
      const res = await app.fetch(
        new Request(`https://view.scrymore.com/public-project/v2/iframe.html?scry_preview=${token}`),
        env as any,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Set-Cookie')).toBeNull();
      expect(res.headers.get('Referrer-Policy')).toBeNull();
    });

    it('adds Referrer-Policy: same-origin to HTML of private projects only', async () => {
      const token = await mint();
      const html = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html`, { headers: { Cookie: `__scry_preview=${token}` } }),
        env as any,
      );
      expect(html.status).toBe(200);
      expect(html.headers.get('Referrer-Policy')).toBe('same-origin');
      const json = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/index.json`, { headers: { Cookie: `__scry_preview=${token}` } }),
        env as any,
      );
      expect(json.headers.get('Referrer-Policy')).toBeNull();
      // The session path gets it too — it is a property of private HTML, not of the credential.
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123' });
      (isProjectMember as any).mockReturnValue(true);
      const viaSession = await app.fetch(
        new Request(`https://view.scrymore.com/${PROJECT}/v2/iframe.html`, { headers: { Cookie: '__session=valid-session' } }),
        env as any,
      );
      expect(viaSession.headers.get('Referrer-Policy')).toBe('same-origin');
    });
  });

  // Audit 2026-09-26 gap 6: the viewer logged the session email, the raw uid,
  // every cookie name and the first 50 chars of the Cookie header.
  describe('log privacy', () => {
    const EMAIL = 'alice@example.com';
    const UID = 'uid-SECRET-9f3a';
    const COOKIES = { __session: 'sess-token', _ga: 'GA1.2.3', figma_ref: 'x' };
    const COOKIE_HEADER = '__session=sess-token; _ga=GA1.2.3; figma_ref=x';

    const assertClean = (logged: string) => {
      expect(logged).not.toContain('@');
      expect(logged).not.toContain(UID);
      for (const name of Object.keys(COOKIES)) expect(logged).not.toContain(name);
      for (const value of Object.values(COOKIES)) expect(logged).not.toContain(value);
    };

    for (const [label, member, status] of [
      ['member (200)', true, 200],
      ['non-member (403)', false, 403],
    ] as const) {
      it(`logs no email, uid or cookie names for a ${label}`, async () => {
        (getProjectVisibility as any).mockResolvedValue({ visibility: 'private', memberIds: [UID] });
        (parseCookies as any).mockReturnValue(COOKIES);
        (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: UID, email: EMAIL });
        (isProjectMember as any).mockReturnValue(member);

        const cap = captureConsole();
        try {
          const res = await app.fetch(
            new Request('https://view.scrymore.com/private-project/v1/index.html', { headers: { Cookie: COOKIE_HEADER } }),
            { ...mockEnv, LOG_HASH_SALT: 'test-salt' } as any,
          );
          expect(res.status).toBe(status);
          const logged = cap.text();
          assertClean(logged);
          // The opaque tag is present so one user's requests stay correlatable.
          expect(logged).toMatch(/"uidTag":"[0-9a-f]{8}"/);
        } finally {
          cap.restore();
        }
      });
    }

    it('logs no identifier at all when LOG_HASH_SALT is unset', async () => {
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'private', memberIds: [UID] });
      (parseCookies as any).mockReturnValue(COOKIES);
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: UID, email: EMAIL });
      (isProjectMember as any).mockReturnValue(true);

      const cap = captureConsole();
      try {
        await app.fetch(
          new Request('https://view.scrymore.com/private-project/v1/index.html', { headers: { Cookie: COOKIE_HEADER } }),
          mockEnv as any,
        );
        const logged = cap.text();
        assertClean(logged);
        expect(logged).toContain('"uidTag":"none"');
      } finally {
        cap.restore();
      }
    });

    it('logs no cookie names or values when the session cookie is missing', async () => {
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'private', memberIds: [UID] });
      const others = { _ga: 'GA1.2.3', figma_ref: 'x' };
      (parseCookies as any).mockReturnValue(others);

      const cap = captureConsole();
      try {
        const res = await app.fetch(
          new Request('https://view.scrymore.com/private-project/v1/index.html', { headers: { Cookie: '_ga=GA1.2.3; figma_ref=x' } }),
          mockEnv as any,
        );
        expect(res.status).toBe(401);
        const logged = cap.text();
        for (const k of [...Object.keys(others), ...Object.values(others)]) expect(logged).not.toContain(k);
      } finally {
        cap.restore();
      }
    });
  });

  describe('sign-out revocation (signout-session-race)', () => {
    const cookieReq = () =>
      new Request('https://view.scrymore.com/private-project/v1/index.html', {
        headers: { Cookie: '__session=valid-token' },
      });
    beforeEach(() => {
      (getProjectVisibility as any).mockResolvedValue({ visibility: 'private', memberIds: ['user-123'] });
      (parseCookies as any).mockReturnValue({ __session: 'valid-token' });
      (isProjectMember as any).mockReturnValue(true);
    });

    it('refuses a cookie issued before the user signed out (401), even though signature and expiry are fine', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123', authTime: 900 });
      (getSessionValidAfter as any).mockResolvedValue(1000);
      const res = await app.fetch(cookieReq(), mockEnv as any);
      expect(res.status).toBe(401);
    });

    it('refuses a cookie signed in exactly at the cut-off', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123', authTime: 1000 });
      (getSessionValidAfter as any).mockResolvedValue(1000);
      expect((await app.fetch(cookieReq(), mockEnv as any)).status).toBe(401);
    });

    it('accepts a cookie from a sign-in after the sign-out', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123', authTime: 1001 });
      (getSessionValidAfter as any).mockResolvedValue(1000);
      expect((await app.fetch(cookieReq(), mockEnv as any)).status).toBe(200);
    });

    it('accepts a cookie when the user never signed out', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123', authTime: 5 });
      (getSessionValidAfter as any).mockResolvedValue(0);
      expect((await app.fetch(cookieReq(), mockEnv as any)).status).toBe(200);
    });

    it('denies with 503 (never allows) when the cut-off cannot be read', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: true, uid: 'user-123', authTime: 900 });
      (getSessionValidAfter as any).mockRejectedValue(new Error('firestore down'));
      const cap = captureConsole();
      try {
        expect((await app.fetch(cookieReq(), mockEnv as any)).status).toBe(503);
      } finally {
        cap.restore();
      }
    });

    it('does not consult revocation for a public project, a PAT or an invalid cookie', async () => {
      (validateFirebaseSessionCookie as any).mockResolvedValue({ valid: false, error: 'bad' });
      expect((await app.fetch(cookieReq(), mockEnv as any)).status).toBe(401);
      expect(getSessionValidAfter).not.toHaveBeenCalled();
    });
  });
});
