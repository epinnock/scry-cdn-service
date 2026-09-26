// regression-cdn-version-names-missing-zip (scry-management/features/cdn-version-names-missing-zip; ISSUES.md #3, #7, #53).
// Moved from the Stage-2 reproduction (tests/repro/) unchanged in substance.
// R1/R2 are the originally reported defects (fixed by #19, 73013e5): they FAIL on 73013e5^ and PASS on origin/main.
// R3/R4 are the residual defect: they FAIL on origin/main (deployed f2e1d25).
import { describe, it, expect, vi } from 'vitest';
import { parsePathForUUID } from '@/utils/subdomain';
import { zipStaticRoutes } from '@/routes/zip-static';
import type { CompoundUUID } from '@/utils/path-resolver';

const version = (r: ReturnType<typeof parsePathForUUID>) => (r?.resolution as CompoundUUID | undefined)?.version;

// Minimal stored ZIP: index.html only (same fixture family as tests/zip/redeploy.test.ts).
const zip = Buffer.from('UEsDBBQAAAAAAAAAIVxZzq/NJQAAACUAAAAKAAAAaW5kZXguaHRtbDxzY3JpcHQgc3JjPSJhc3NldHMvb2xkLmpzIj48L3NjcmlwdD5QSwMEFAAAAAAAAAAhXJZXnR8SAAAAEgAAAA0AAABhc3NldHMvb2xkLmpzY29uc29sZS5sb2coIm9sZCIpUEsBAhQDFAAAAAAAAAAhXFnOr80lAAAAJQAAAAoAAAAAAAAAAAAAAIABAAAAAGluZGV4Lmh0bWxQSwECFAMUAAAAAAAAACFclledHxIAAAASAAAADQAAAAAAAAAAAAAAgAFNAAAAYXNzZXRzL29sZC5qc1BLBQYAAAAAAgACAHMAAACKAAAAAAA=', 'base64');

/** R2 mock that holds exactly one key; everything else is absent (head/get -> null). */
function viewer(storedKey: string | null) {
  const values = new Map<string, string>();
  const kv = { get: vi.fn(async (k: string) => JSON.parse(values.get(k) ?? 'null')), put: vi.fn(async (k: string, v: string) => { values.set(k, v); }) };
  const bucket = {
    head: vi.fn(async (key: string) => (key === storedKey ? { size: zip.length, etag: 'e1' } : null)),
    get: vi.fn(async (key: string, options?: { range?: { offset: number; length: number } }) => {
      if (key !== storedKey) return null;
      const { offset, length } = options!.range!;
      const bytes = Uint8Array.from(zip.subarray(offset, offset + length));
      return { body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer, etag: 'e1' };
    }),
  };
  return {
    bucket,
    get: (path: string) => zipStaticRoutes.request(`https://view.scrymore.com${path}`, {}, { UPLOAD_BUCKET: bucket, CDN_CACHE: kv } as any),
  };
}

describe('regression-cdn-version-names-missing-zip R1 (ISSUES #3): a free-text version name keeps its place in the R2 key', () => {
  it('aug3-demo-20260803 resolves to {project}/aug3-demo-20260803/storybook.zip', () => {
    const r = parsePathForUUID('/U9m2H2yeC9wFiR4hlMta/aug3-demo-20260803/index.html');
    expect(version(r)).toBe('aug3-demo-20260803');
    expect(r?.resolution?.zipKey).toBe('U9m2H2yeC9wFiR4hlMta/aug3-demo-20260803/storybook.zip');
  });
});

describe('regression-cdn-version-names-missing-zip R2 (ISSUES #7): a build that was never uploaded is 404, not 500', () => {
  it('R2 get/head -> null answers 404', async () => {
    const { get } = viewer(null);
    const res = await get('/U9m2H2yeC9wFiR4hlMta/latest/index.html');
    expect(res.status).toBe(404);
  });
});

describe('regression-cdn-version-names-missing-zip R3 (residual): a dotted version name keeps its place in the R2 key', () => {
  for (const v of ['1.8.2', '1.0.0', 'v1.2.3-rc.1', 'v0.0.0-smoke', '2026.09.26']) {
    it(`${v} is read as the version`, () => {
      const r = parsePathForUUID(`/Pz7nQ4wLr8Yb2Vm5Hs1J/${v}/iframe.html`);
      expect(r?.resolution?.zipKey).toBe(`Pz7nQ4wLr8Yb2Vm5Hs1J/${v}/storybook.zip`);
      expect(r?.filePath).toBe('iframe.html');
    });
  }
});

describe('regression-cdn-version-names-missing-zip R4 (residual): a healthy build under a dotted version is served', () => {
  it('GET /{project}/1.8.2/index.html with the zip at {project}/1.8.2/storybook.zip -> 200', async () => {
    const { get } = viewer('Pz7nQ4wLr8Yb2Vm5Hs1J/1.8.2/storybook.zip');
    const res = await get('/Pz7nQ4wLr8Yb2Vm5Hs1J/1.8.2/index.html');
    expect(res.status).toBe(200);
  });
});

describe('regression-cdn-version-names-missing-zip adjacent (must stay true before and after any fix)', () => {
  it('/{project}/{file.ext} with no version still reads the segment as a file', () => {
    const r = parsePathForUUID('/Pz7nQ4wLr8Yb2Vm5Hs1J/iframe.html');
    expect(version(r)).toBe('');
    expect(r?.filePath).toBe('iframe.html');
  });
  it('v1.2.3 is still a version', () => {
    expect(version(parsePathForUUID('/p1234/v1.2.3/index.html'))).toBe('v1.2.3');
  });
});
