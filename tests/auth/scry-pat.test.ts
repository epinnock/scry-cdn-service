import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/firestore-auth', () => ({
  getFirestoreAccessToken: vi.fn(),
  isServiceAccountConfigured: vi.fn(),
}));
import { getFirestoreAccessToken, isServiceAccountConfigured } from '@/services/firestore-auth';
import { parseScryPat, isScryPat, verifyScryPat } from '@/auth/scry-pat';

const TOKEN = 'scry_pat_p6Bc64ctJTbf7ws1W1cekBRbUs83_abc-DEF_ghi123';
const UID = 'p6Bc64ctJTbf7ws1W1cekBRbUs83';

function envWith(kv?: { get: any; put: any }) {
  return {
    FIREBASE_PROJECT_ID: 'scry-test',
    FIREBASE_CLIENT_EMAIL: 'svc@test',
    FIREBASE_PRIVATE_KEY: 'k',
    CDN_CACHE: kv,
  } as any;
}

function runQueryReply(fields: Record<string, unknown> | null) {
  return {
    ok: true,
    json: async () => (fields ? [{ document: { name: 'users/x/personalAccessTokens/pat1', fields } }] : [{ readTime: 'x' }]),
  } as any;
}

describe('parseScryPat', () => {
  it('extracts the uid and tolerates underscores in the random part', () => {
    expect(parseScryPat(TOKEN)).toEqual({ uid: UID });
    expect(isScryPat(TOKEN)).toBe(true);
  });
  it('rejects malformed tokens', () => {
    for (const t of ['', 'scry_pat_', 'scry_pat_uidonly', 'scry_pat__x', 'scry_pat_bad!uid_x', 'Bearer x', 'sk-ant-123']) {
      expect(parseScryPat(t), t).toBeNull();
    }
  });
});

describe('verifyScryPat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isServiceAccountConfigured as any).mockReturnValue(true);
    (getFirestoreAccessToken as any).mockResolvedValue('gcp-token');
  });

  it('queries users/{uid}/personalAccessTokens by sha256 hash and accepts an active token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(runQueryReply({ status: { stringValue: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await verifyScryPat(TOKEN, envWith());
    expect(result).toEqual({ uid: UID });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain(`/documents/users/${UID}:runQuery`);
    const body = JSON.parse(init.body);
    expect(body.structuredQuery.from[0].collectionId).toBe('personalAccessTokens');
    expect(body.structuredQuery.where.fieldFilter.field.fieldPath).toBe('hash');
    expect(body.structuredQuery.where.fieldFilter.value.stringValue).toMatch(/^[0-9a-f]{64}$/);
    expect(init.headers.Authorization).toBe('Bearer gcp-token');
  });

  it('rejects unknown, revoked and expired tokens', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runQueryReply(null)));
    expect(await verifyScryPat(TOKEN, envWith())).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runQueryReply({ status: { stringValue: 'revoked' } })));
    expect(await verifyScryPat(TOKEN, envWith())).toBeNull();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runQueryReply({ status: { stringValue: 'active' }, expiresAt: { timestampValue: '2020-01-01T00:00:00Z' } })));
    expect(await verifyScryPat(TOKEN, envWith())).toBeNull();
  });

  it('accepts a future expiry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(runQueryReply({ status: { stringValue: 'active' }, expiresAt: { timestampValue: '2099-01-01T00:00:00Z' } })));
    expect(await verifyScryPat(TOKEN, envWith())).toEqual({ uid: UID });
  });

  it('fails closed when Firestore errors or the service account is missing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 } as any));
    expect(await verifyScryPat(TOKEN, envWith())).toBeNull();
    (isServiceAccountConfigured as any).mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyScryPat(TOKEN, envWith())).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a repeat lookup from KV without touching Firestore', async () => {
    const store = new Map<string, string>();
    const kv = {
      get: vi.fn(async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null)),
      put: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
    };
    const fetchMock = vi.fn().mockResolvedValue(runQueryReply({ status: { stringValue: 'active' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await verifyScryPat(TOKEN, envWith(kv))).toEqual({ uid: UID });
    expect(await verifyScryPat(TOKEN, envWith(kv))).toEqual({ uid: UID });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(kv.put).toHaveBeenCalledTimes(1);
  });
});
