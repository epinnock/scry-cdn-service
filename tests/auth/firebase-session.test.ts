import { describe, it, expect, vi, beforeEach } from 'vitest';
import { captureConsole } from '../helpers/capture-console';

// Only the signature/claims check is stubbed so the success path (which used
// to log the whole JWT payload) can run without a Google-signed token.
vi.mock('jose', async (orig) => {
  const actual = await orig<typeof import('jose')>();
  return {
    ...actual,
    importX509: vi.fn(async () => ({}) as any),
    jwtVerify: vi.fn(),
  };
});
import * as jose from 'jose';
import {
  parseCookies,
  validateFirebaseSessionCookie,
} from '@/auth/firebase-session';

describe('parseCookies', () => {
  it('parses single cookie', () => {
    const result = parseCookies('__session=abc123');
    expect(result).toEqual({ __session: 'abc123' });
  });

  it('parses multiple cookies', () => {
    const result = parseCookies('__session=abc123; other=value');
    expect(result).toEqual({ __session: 'abc123', other: 'value' });
  });

  it('handles null', () => {
    const result = parseCookies(null);
    expect(result).toEqual({});
  });

  it('handles empty string', () => {
    const result = parseCookies('');
    expect(result).toEqual({});
  });

  it('handles cookies with = in value', () => {
    const result = parseCookies('token=abc=def=ghi');
    expect(result).toEqual({ token: 'abc=def=ghi' });
  });

  it('trims whitespace around cookie names and values', () => {
    const result = parseCookies('  __session = abc123 ; other = value  ');
    expect(result.__session).toBeDefined();
  });
});

describe('validateFirebaseSessionCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid for malformed JWT', async () => {
    const result = await validateFirebaseSessionCookie('not-a-jwt', 'test-project');
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('returns invalid for JWT without kid header', async () => {
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({ sub: 'user-123' }));
    const fakeJwt = `${header}.${payload}.signature`;

    const result = await validateFirebaseSessionCookie(fakeJwt, 'test-project');
    expect(result.valid).toBe(false);
    expect(result.error).toContain('key ID');
  });
});

describe('validateFirebaseSessionCookie log privacy (audit 2026-09-26 gap 6)', () => {
  it('logs neither email nor uid on a valid session', async () => {
    const UID = 'uid-SECRET-9f3a';
    (jose.jwtVerify as any).mockResolvedValue({
      payload: { sub: UID, email: 'alice@example.com', iss: 'x', aud: 'test-project' },
    });
    const header = btoa(JSON.stringify({ alg: 'RS256', kid: 'k1' }));
    const cache = { get: vi.fn(async () => ({ keys: { k1: 'PEM' } })), put: vi.fn() };

    const cap = captureConsole();
    try {
      const result = await validateFirebaseSessionCookie(`${header}.e30.sig`, 'test-project', cache as any);
      expect(result).toMatchObject({ valid: true, uid: UID });
      const logged = cap.text();
      expect(logged).not.toContain('@');
      expect(logged).not.toContain(UID);
    } finally {
      cap.restore();
    }
  });
});
