import { describe, it, expect } from 'vitest';
import {
  verifyPreviewToken,
  previewCookie,
  previewTokenSecrets,
  PREVIEW_TOKEN_MAX_AGE_S,
} from '@/auth/preview-token';

const SECRET = 'current-secret-0123456789abcdef0123456789abcdef';
const PREVIOUS = 'previous-secret-0123456789abcdef0123456789abcde';
const PROJECT = 'ZGJ3UPwvmKtR9j3eAqaQ';
const UID = 'p6Bc64ctJTbf7ws1W1cekBRbUs83';
const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);

function b64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Reference signer — what the dashboard does. */
export async function signPreviewToken(payload: Record<string, unknown>, secret: string): Promise<string> {
  const payloadB64 = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payloadB64)));
  return `${payloadB64}.${b64url(sig)}`;
}

function payload(overrides: Record<string, unknown> = {}) {
  return { v: 1, uid: UID, projectId: PROJECT, exp: Math.floor(NOW / 1000) + 600, nonce: 'n0nce', ...overrides };
}

const env = { PREVIEW_TOKEN_SECRET: SECRET } as any;

describe('verifyPreviewToken', () => {
  it('accepts a freshly minted token for its project and reports the remaining lifetime', async () => {
    const token = await signPreviewToken(payload(), SECRET);
    const verified = await verifyPreviewToken(token, PROJECT, env, NOW);
    expect(verified).toEqual({ uid: UID, projectId: PROJECT, exp: Math.floor(NOW / 1000) + 600, remainingSeconds: 600 });
  });

  it('rejects an expired token', async () => {
    const token = await signPreviewToken(payload({ exp: Math.floor(NOW / 1000) - 1 }), SECRET);
    expect(await verifyPreviewToken(token, PROJECT, env, NOW)).toBeNull();
    const atExpiry = await signPreviewToken(payload({ exp: Math.floor(NOW / 1000) }), SECRET);
    expect(await verifyPreviewToken(atExpiry, PROJECT, env, NOW)).toBeNull();
  });

  it('rejects a token that claims more than the maximum lifetime', async () => {
    const token = await signPreviewToken(payload({ exp: Math.floor(NOW / 1000) + PREVIEW_TOKEN_MAX_AGE_S + 120 }), SECRET);
    expect(await verifyPreviewToken(token, PROJECT, env, NOW)).toBeNull();
  });

  it('rejects a token bound to another project', async () => {
    const token = await signPreviewToken(payload({ projectId: 'other-project' }), SECRET);
    expect(await verifyPreviewToken(token, PROJECT, env, NOW)).toBeNull();
  });

  it('rejects a bad signature, a tampered payload and malformed input', async () => {
    const good = await signPreviewToken(payload(), SECRET);
    const [p, s] = good.split('.');
    const forged = await signPreviewToken(payload(), 'not-the-secret');
    expect(await verifyPreviewToken(forged, PROJECT, env, NOW)).toBeNull();
    const tampered = `${b64url(new TextEncoder().encode(JSON.stringify(payload({ projectId: PROJECT, uid: 'someone-else' }))))}.${s}`;
    expect(await verifyPreviewToken(tampered, PROJECT, env, NOW)).toBeNull();
    for (const bad of ['', p, `${p}.`, `.${s}`, `${p}.${s}.x`, `${p}.${s.slice(0, 10)}`, `${p}!.${s}`, 'scry_pat_abc_def']) {
      expect(await verifyPreviewToken(bad, PROJECT, env, NOW), JSON.stringify(bad)).toBeNull();
    }
  });

  it('rejects a well-signed payload with the wrong shape', async () => {
    for (const p of [
      payload({ v: 2 }),
      payload({ uid: '' }),
      payload({ exp: 'soon' }),
      payload({ nonce: undefined }),
      { hello: 'world' },
    ]) {
      const token = await signPreviewToken(p, SECRET);
      expect(await verifyPreviewToken(token, PROJECT, env, NOW), JSON.stringify(p)).toBeNull();
    }
    const notJson = `${b64url(new TextEncoder().encode('not json'))}`;
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(notJson))));
    expect(await verifyPreviewToken(`${notJson}.${sig}`, PROJECT, env, NOW)).toBeNull();
  });

  it('accepts the previous secret during a rotation, and only then', async () => {
    const token = await signPreviewToken(payload(), PREVIOUS);
    expect(await verifyPreviewToken(token, PROJECT, env, NOW)).toBeNull();
    const rotating = { PREVIEW_TOKEN_SECRET: SECRET, PREVIEW_TOKEN_SECRET_PREVIOUS: PREVIOUS } as any;
    expect(await verifyPreviewToken(token, PROJECT, rotating, NOW)).toMatchObject({ uid: UID });
    const current = await signPreviewToken(payload(), SECRET);
    expect(await verifyPreviewToken(current, PROJECT, rotating, NOW)).toMatchObject({ uid: UID });
    expect(previewTokenSecrets(rotating)).toEqual([SECRET, PREVIOUS]);
    expect(previewTokenSecrets({ PREVIEW_TOKEN_SECRET: '', PREVIEW_TOKEN_SECRET_PREVIOUS: PREVIOUS } as any)).toEqual([PREVIOUS]);
  });

  it('fails closed when no secret is configured', async () => {
    const token = await signPreviewToken(payload(), SECRET);
    expect(await verifyPreviewToken(token, PROJECT, {} as any, NOW)).toBeNull();
    expect(await verifyPreviewToken(token, PROJECT, { PREVIEW_TOKEN_SECRET: '' } as any, NOW)).toBeNull();
  });
});

describe('previewCookie', () => {
  it('scopes the cookie to the project path and the token lifetime, partitioned for third-party embedding', () => {
    const cookie = previewCookie('tok.sig', { uid: UID, projectId: PROJECT, exp: 1, remainingSeconds: 417 });
    expect(cookie).toBe(`__scry_preview=tok.sig; Path=/${PROJECT}/; Secure; HttpOnly; SameSite=None; Partitioned; Max-Age=417`);
  });
});
