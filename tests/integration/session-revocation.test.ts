/**
 * End to end through the private-project middleware with the REAL revocation lookup:
 * only the Firestore REST call and the JWT signature check are stubbed.
 * Bug signout-session-race (ISSUES.md #62): a __session copied before sign-out must
 * stop working on the viewer once the dashboard has recorded the sign-out.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Hono } from 'hono';
import { privateProjectAuth } from '@/middleware/auth';
import { resetSessionRevocationCache } from '@/auth/session-revocation';

vi.mock('@/services/visibility', () => ({
  getProjectVisibility: vi.fn(async () => ({ visibility: 'private', memberIds: ['user-1'] })),
  isProjectMember: (ids: string[], uid: string) => ids.includes(uid),
}));
vi.mock('@/auth/firebase-session', () => ({
  parseCookies: (h: string | null) =>
    Object.fromEntries((h ?? '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0])),
  // The cookie value encodes the claims: "<uid>:<authTime>"
  validateFirebaseSessionCookie: vi.fn(async (cookie: string) => {
    const [uid, authTime] = cookie.split(':');
    return { valid: true, uid, authTime: Number(authTime) };
  }),
}));

const env = { FIREBASE_PROJECT_ID: 'test-project' } as any;
let revocationDoc: { validAfter?: string } | null;
let lookups = 0;

const app = new Hono();
app.use('/*', privateProjectAuth);
app.get('/*', (c) => c.text('OK'));
const get = (cookie: string) =>
  app.fetch(
    new Request('https://view.scrymore.com/proj/v1/index.html', { headers: { Cookie: `__session=${cookie}` } }),
    env,
  );

beforeEach(() => {
  resetSessionRevocationCache();
  revocationDoc = null;
  lookups = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (!String(url).includes('/sessionRevocations/')) throw new Error(`unexpected fetch ${url}`);
      lookups += 1;
      return revocationDoc
        ? ({ ok: true, status: 200, json: async () => ({ fields: { validAfter: { integerValue: revocationDoc!.validAfter } } }) } as Response)
        : ({ ok: false, status: 404, json: async () => ({}) } as Response);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('viewer refuses a revoked / old __session', () => {
  it('a normal session works before any sign-out', async () => {
    expect((await get('user-1:900')).status).toBe(200);
  });

  it('a cookie copied before sign-out is refused once the sign-out is recorded', async () => {
    const copy = 'user-1:900';
    expect((await get(copy)).status).toBe(200);
    revocationDoc = { validAfter: '1000' }; // dashboard logout ran
    resetSessionRevocationCache(); // past the 30 s cache window
    expect((await get(copy)).status).toBe(401);
  });

  it('a cookie re-set by a late sync (auth_time before the cut-off) is refused', async () => {
    revocationDoc = { validAfter: '1000' };
    expect((await get('user-1:999')).status).toBe(401);
  });

  it('signing in again after the sign-out works', async () => {
    revocationDoc = { validAfter: '1000' };
    expect((await get('user-1:1200')).status).toBe(200);
  });

  it('is cached: many asset requests cost one Firestore read', async () => {
    await Promise.all([get('user-1:900'), get('user-1:900'), get('user-1:900')]);
    await get('user-1:900');
    expect(lookups).toBeLessThanOrEqual(3);
    const before = lookups;
    await get('user-1:900');
    expect(lookups).toBe(before);
  });

  it('fails closed: a Firestore outage denies (503), it does not allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect((await get('user-1:900')).status).toBe(503);
  });
});
