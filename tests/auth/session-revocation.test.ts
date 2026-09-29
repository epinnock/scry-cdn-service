import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getSessionValidAfter,
  isSessionRevoked,
  resetSessionRevocationCache,
} from '@/auth/session-revocation';

const env = { FIREBASE_PROJECT_ID: 'test-project' } as any;

function fsResponse(status: number, body?: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

describe('isSessionRevoked', () => {
  it('never revokes when the user never signed out', () => {
    expect(isSessionRevoked(100, 0)).toBe(false);
    expect(isSessionRevoked(undefined, 0)).toBe(false);
  });
  it('refuses a cookie signed in before or at the cut-off, allows one after', () => {
    expect(isSessionRevoked(99, 100)).toBe(true);
    expect(isSessionRevoked(100, 100)).toBe(true);
    expect(isSessionRevoked(101, 100)).toBe(false);
  });
  it('refuses a cookie with no auth_time/iat once a cut-off exists', () => {
    expect(isSessionRevoked(undefined, 100)).toBe(true);
  });
});

describe('getSessionValidAfter', () => {
  beforeEach(() => resetSessionRevocationCache());
  afterEach(() => vi.unstubAllGlobals());

  it('reads sessionRevocations/{uid}.validAfter from Firestore', async () => {
    const f = vi.fn(async () => fsResponse(200, { fields: { validAfter: { integerValue: '1234' } } }));
    vi.stubGlobal('fetch', f);
    expect(await getSessionValidAfter('u1', env)).toBe(1234);
    expect((f.mock.calls[0] as any)[0]).toContain('/documents/sessionRevocations/u1');
  });

  it('no document means the user never signed out (0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fsResponse(404)));
    expect(await getSessionValidAfter('u1', env)).toBe(0);
  });

  it('caches for 30 s, then reads again', async () => {
    const f = vi.fn(async () => fsResponse(200, { fields: { validAfter: { integerValue: '5' } } }));
    vi.stubGlobal('fetch', f);
    await getSessionValidAfter('u1', env, 1_000);
    await getSessionValidAfter('u1', env, 30_000);
    expect(f).toHaveBeenCalledTimes(1);
    await getSessionValidAfter('u1', env, 31_001);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('throws (caller denies) on a Firestore error or an unreadable document', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fsResponse(500)));
    await expect(getSessionValidAfter('u1', env)).rejects.toThrow(/500/);
    vi.stubGlobal('fetch', vi.fn(async () => fsResponse(200, { fields: {} })));
    await expect(getSessionValidAfter('u2', env)).rejects.toThrow(/validAfter/);
  });
});
