// Guarantees G1, G3, G4 of scry-management/features/cdn-version-names-missing-zip/plan.md
// (ISSUES.md #53: a version with a dot uploaded fine but could not be opened).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parsePathForUUID, extractProjectFromReferer, UPLOAD_VERSION_REGEX } from '@/utils/subdomain';
import type { CompoundUUID } from '@/utils/path-resolver';
import names from '../fixtures/prod-version-names-2026-09-26.json';

const P = 'Pz7nQ4wLr8Yb2Vm5Hs1J';
const r2Names: string[] = names.r2VersionNames.map((n) => n.name);
const r2WithZip = names.r2VersionNames.filter((n) => n.withZip > 0);
const resolved = (path: string) => parsePathForUUID(path)?.resolution as CompoundUUID;

/** The deployed parser's decision (scry-cdn-service f2e1d25, src/utils/subdomain.ts:55-79), frozen for G3/G4. */
function deployedIsVersion(segment: string): boolean {
  if (segment.length < 2) return false;
  if (/^(v[\d.-]+|pr-\d+|dev-[\w-]+|beta[\w-]*|alpha[\w-]*|canary[\w-]*|rc-?\d*|staging|latest|main|production)$/i.test(segment)) return true;
  if (/\.[A-Za-z0-9]{1,8}$/.test(segment)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
}
function deployedZipKey(path: string): string {
  const segs = path.replace(/^\//, '').split('/').filter(Boolean);
  const v = segs.length >= 2 && deployedIsVersion(segs[1]) ? segs[1] : '';
  return v ? `${segs[0]}/${v}/storybook.zip` : `${segs[0]}/storybook.zip`;
}

/** Deterministic generator of names the upload service accepts (mulberry32). */
function uploadLegalNames(count: number, seed = 20260926): string[] {
  let s = 0x9e3779b9 ^ seed;
  const rnd = () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const first = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rest = first + '._-';
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = 1 + Math.floor(rnd() * 128); // 1..128, the upload limit
    let n = first[Math.floor(rnd() * first.length)];
    for (let j = 1; j < len; j++) n += rest[Math.floor(rnd() * rest.length)];
    out.push(n);
  }
  return out;
}

const handPicked = [
  '1.8.2', '1.0.0', '0.0.1', '0.0.3', 'v1.2.3-rc.1', 'v0.0.0-smoke', '2026.09.26', 'v1.0.e',
  '1.2.3-smoke', 'x', '1', 'a.', '1..2', 'index.html', 'storybook.zip', 'v2.json',
  'aug3-demo-20260803', 'v1.2.3', 'pr-12', 'latest', 'A'.repeat(128),
];

afterEach(() => vi.restoreAllMocks());

describe('guarantee-1 every upload-legal version resolves to its own zip', () => {
  const all = [...new Set([...handPicked, ...r2Names, ...names.firestoreDottedVersionNames, ...uploadLegalNames(2000)])];

  it('the corpus is upload-legal (sanity: the generator and fixtures obey the upload grammar)', () => {
    expect(all.length).toBeGreaterThan(2000);
    for (const n of all) expect(UPLOAD_VERSION_REGEX.test(n), n).toBe(true);
  });

  it('/{project}/{version}/{file} and /{project}/{version}/ resolve to {project}/{version}/storybook.zip', () => {
    for (const n of all) {
      const deep = parsePathForUUID(`/${P}/${n}/iframe.html`);
      expect((deep?.resolution as CompoundUUID).zipKey, n).toBe(`${P}/${n}/storybook.zip`);
      expect(deep?.filePath, n).toBe('iframe.html');
      const nested = parsePathForUUID(`/${P}/${n}/assets/x.js`);
      expect((nested?.resolution as CompoundUUID).zipKey, n).toBe(`${P}/${n}/storybook.zip`);
      expect(nested?.filePath, n).toBe('assets/x.js');
      const slash = parsePathForUUID(`/${P}/${n}/`);
      expect((slash?.resolution as CompoundUUID).zipKey, n).toBe(`${P}/${n}/storybook.zip`);
      expect(slash?.filePath, n).toBe('index.html');
    }
  });

  it('the Referer extractor reads the same version', () => {
    for (const n of all) {
      expect(extractProjectFromReferer(`https://view.scrymore.com/${P}/${n}/iframe.html?id=x`), n).toEqual({ projectId: P, versionId: n });
      expect(extractProjectFromReferer(`https://view.scrymore.com/${P}/${n}/`), n).toEqual({ projectId: P, versionId: n });
    }
  });

  it('both dotted names found in production R2 (0.0.1, 0.0.3) now resolve', () => {
    const rejectedBefore = names.r2VersionNames.filter((n) => n.deployedParser !== 'ok').map((n) => n.name);
    expect(rejectedBefore.sort()).toEqual(['0.0.1', '0.0.3']);
    for (const n of rejectedBefore) expect(resolved(`/${P}/${n}/index.html`).version).toBe(n);
  });

  it('a segment the upload grammar refuses is not read as a version, and the fallback is logged (bad path)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const bad of ['_x', '-x', '.hidden', 'A'.repeat(129), 'a b', 'a%2Fb']) {
      const r = parsePathForUUID(`/${P}/${bad}/index.html`);
      expect(resolved(`/${P}/${bad}/index.html`).version, bad).toBe('');
      expect(r?.filePath, bad).toBe(`${bad}/index.html`);
    }
    expect(warn).toHaveBeenCalledTimes(12); // 6 names x 2 parses
    expect(warn.mock.calls[0][0]).toMatch(/rejected by upload grammar/);
  });
});

describe('guarantee-3 all 160 R2 prefixes that resolve today resolve to the same key', () => {
  it('fixture covers the 160 zip-bearing prefixes', () => {
    expect(r2WithZip.reduce((a, n) => a + n.withZip, 0)).toBe(160);
  });

  it.each(['/index.html', '/iframe.html', '/', '/assets/x.js', '', '/iframe.html?id=button--primary'])(
    'every name the deployed parser accepted gets the identical zip key for suffix "%s"',
    (suffix) => {
      for (const { name } of names.r2VersionNames.filter((n) => n.deployedParser === 'ok')) {
        const path = `/${P}/${name}${suffix}`;
        if (suffix === '/') {
          // deployed parser: trailing slash with an accepted name -> version
          expect(resolved(path).zipKey, path).toBe(`${P}/${name}/storybook.zip`);
        } else {
          expect(resolved(path).zipKey, path).toBe(deployedZipKey(path.split('?')[0]));
        }
      }
    },
  );
});

describe('guarantee-4 bare project-root files stay files', () => {
  it.each(['iframe.html', 'index.html', 'favicon.ico', 'placeholder.svg', 'main.js', 'styles.css', 'project.json', 'sb-common-assets.woff2', 'coverage-report.json', 'index.json'])(
    '/{project}/%s is a file at the project root, exactly as before',
    (file) => {
      const r = parsePathForUUID(`/${P}/${file}`);
      expect(resolved(`/${P}/${file}`).version).toBe('');
      expect(r?.filePath).toBe(file);
      expect(resolved(`/${P}/${file}`).zipKey).toBe(deployedZipKey(`/${P}/${file}`));
    },
  );

  it('a bare dotted name keeps the deployed heuristic (no trailing-slash redirect was approved)', () => {
    // /{p}/1.8.2 with nothing after it is ambiguous; plan.md "Defaults taken" keeps today's rule.
    expect(resolved(`/${P}/1.8.2`).zipKey).toBe(deployedZipKey(`/${P}/1.8.2`));
    expect(resolved(`/${P}/v1.2.3`).version).toBe('v1.2.3');
    expect(resolved(`/${P}/v1`).version).toBe('v1');
  });
});
