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
vi.mock('@/auth/scry-pat', () => ({
  isScryPat: (t: string) => t.startsWith('scry_pat_'),
  verifyScryPat: vi.fn(),
}));

import { getProjectVisibility, isProjectMember } from '@/services/visibility';
import { validateFirebaseSessionCookie, parseCookies } from '@/auth/firebase-session';
import { verifyScryPat } from '@/auth/scry-pat';

describe('privateProjectAuth middleware', () => {
  let app: Hono;

  beforeEach(() => {
    vi.clearAllMocks();

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
});
