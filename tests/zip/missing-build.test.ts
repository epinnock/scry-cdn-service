// Guarantee G2 of scry-management/features/cdn-version-names-missing-zip/plan.md:
// a link to a build that was never uploaded says "not found" (404), never "server error".
// R2/KV faults stay 500 (the 404 must not swallow real storage errors).
import { describe, it, expect, vi } from 'vitest';
import { zipStaticRoutes } from '@/routes/zip-static';

const P = 'Pz7nQ4wLr8Yb2Vm5Hs1J';

function env(bucket: Record<string, unknown>) {
  const kv = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
  return { UPLOAD_BUCKET: bucket, CDN_CACHE: kv } as any;
}
const get = (path: string, e: any) => zipStaticRoutes.request(`https://view.scrymore.com${path}`, {}, e);

describe('guarantee-2 missing zip is 404 for dotted, free-text and allowlist names', () => {
  it.each(['1.8.2', 'v1.2.3-rc.1', '2026.09.26', 'nope.1', 'aug3-demo-20260803', 'v1.2.3', 'pr-12', 'latest', 'main'])(
    'GET /{project}/%s/index.html with no zip in R2 -> 404 "Not found"',
    async (v) => {
      const bucket = { head: vi.fn(async () => null), get: vi.fn(async () => null) };
      const res = await get(`/${P}/${v}/index.html`, env(bucket));
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Not found');
      // it looked for the version's own zip, not the project root
      expect(bucket.head).toHaveBeenCalledWith(`${P}/${v}/storybook.zip`);
    },
  );

  it('an R2 fault on a dotted version is still a 500, not a 404 (bad path)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const bucket = { head: vi.fn(async () => { throw new Error('R2 internal error'); }), get: vi.fn() };
    const res = await get(`/${P}/1.8.2/index.html`, env(bucket));
    expect(res.status).toBe(500);
  });
});
