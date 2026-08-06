import { describe, it, expect } from 'vitest';
import { parsePathForUUID, isValidUUID, extractProjectFromReferer } from '../../src/utils/subdomain';
import type { CompoundUUID } from '../../src/utils/path-resolver';

describe('subdomain path parsing with flexible versions', () => {
  describe('parsePathForUUID with PR versions', () => {
    it('detects pr-001 as version', () => {
      const result = parsePathForUUID('/my-project/pr-001/index.html');
      expect(result?.isValid).toBe(true);
      expect(result?.resolution?.type).toBe('compound');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('pr-001');
      expect(resolution.zipKey).toBe('my-project/pr-001/storybook.zip');
      expect(result?.filePath).toBe('index.html');
    });

    it('detects pr-123 as version', () => {
      const result = parsePathForUUID('/app/pr-123/components/button.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('pr-123');
      expect(result?.filePath).toBe('components/button.html');
    });

    it('handles PR version with no file path', () => {
      const result = parsePathForUUID('/project/pr-456/');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('pr-456');
      expect(result?.filePath).toBe('index.html');
    });
  });

  describe('parsePathForUUID with extended semantic versions', () => {
    it('detects v0.0.0.1 as version', () => {
      const result = parsePathForUUID('/app/v0.0.0.1/page.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v0.0.0.1');
      expect(resolution.zipKey).toBe('app/v0.0.0.1/storybook.zip');
    });

    it('detects v1.2.3.4 as version', () => {
      const result = parsePathForUUID('/service/v1.2.3.4/index.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v1.2.3.4');
    });

    it('detects v1.2.3.4.5 as version', () => {
      const result = parsePathForUUID('/lib/v1.2.3.4.5/docs.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v1.2.3.4.5');
    });
  });

  describe('parsePathForUUID with named versions', () => {
    it('detects beta-2024 as version', () => {
      const result = parsePathForUUID('/lib/beta-2024/docs.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('beta-2024');
    });

    it('detects canary-latest as version', () => {
      const result = parsePathForUUID('/app/canary-latest/index.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('canary-latest');
    });

    it('detects dev-snapshot-123 as version', () => {
      const result = parsePathForUUID('/project/dev-snapshot-123/test.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('dev-snapshot-123');
    });

    it('detects alpha-v2 as version', () => {
      const result = parsePathForUUID('/component/alpha-v2/story.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('alpha-v2');
    });

    it('detects rc-1 as version', () => {
      const result = parsePathForUUID('/lib/rc-1/release.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('rc-1');
    });
  });

  describe('parsePathForUUID with environment versions', () => {
    it('detects staging as version', () => {
      const result = parsePathForUUID('/app/staging/index.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('staging');
    });

    it('detects latest as version', () => {
      const result = parsePathForUUID('/service/latest/docs.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('latest');
    });

    it('detects main as version', () => {
      const result = parsePathForUUID('/project/main/test.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('main');
    });

    it('detects production as version', () => {
      const result = parsePathForUUID('/app/production/app.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('production');
    });
  });

  describe('parsePathForUUID backward compatibility', () => {
    it('still works with traditional semantic versions', () => {
      const result = parsePathForUUID('/app/v1.0.0/index.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v1.0.0');
      expect(resolution.zipKey).toBe('app/v1.0.0/storybook.zip');
    });

    it('still works with v2.1.5', () => {
      const result = parsePathForUUID('/lib/v2.1.5/components.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v2.1.5');
    });

    it('handles paths without versions', () => {
      const result = parsePathForUUID('/simple-project/index.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('');
      expect(resolution.zipKey).toBe('simple-project/storybook.zip');
    });

    it('handles project with no file path', () => {
      const result = parsePathForUUID('/my-app/');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('');
      expect(result?.filePath).toBe('index.html');
    });
  });

  describe('parsePathForUUID edge cases', () => {
    it('handles deep file paths with PR versions', () => {
      const result = parsePathForUUID('/app/pr-123/components/buttons/primary.html');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('pr-123');
      expect(result?.filePath).toBe('components/buttons/primary.html');
    });

    it('handles paths with query parameters', () => {
      const result = parsePathForUUID('/project/v1.0.0/index.html?param=value');
      const resolution = result?.resolution as CompoundUUID;
      expect(resolution.version).toBe('v1.0.0');
      expect(result?.filePath).toBe('index.html?param=value');
    });

    it('rejects invalid project names', () => {
      const result = parsePathForUUID('/ab/index.html');
      expect(result?.isValid).toBe(false);
    });

    it('handles empty path', () => {
      const result = parsePathForUUID('/');
      expect(result).toBeNull();
    });
  });
});

describe('version names outside the old allowlist (ISSUES.md #3)', () => {
  // The allowlist silently reinterpreted any unrecognised version as a
  // *filename*, dropping it from the R2 key and returning 500 for a perfectly
  // healthy build. The runbook's own prescribed version could never resolve.
  it.each([
    'aug3-demo-20260803',
    'release-2026-08-03',
    'demo',
    'build-42',
    'feature-branch-x',
  ])('treats %s as a version', (version) => {
    const info = parsePathForUUID(`/proj123/${version}/index.html`);
    expect(info?.resolution?.version).toBe(version);
    expect(info?.resolution?.zipKey).toBe(`proj123/${version}/storybook.zip`);
    expect(info?.filePath).toBe('index.html');
  });

  // The discriminator that must keep working: a filename is not a version.
  it.each([
    'index.html',
    'placeholder.svg',
    'main.js',
    'styles.css',
  ])('still treats %s as a file, not a version', (file) => {
    const info = parsePathForUUID(`/proj123/${file}`);
    expect(info?.resolution?.version).toBe('');
    expect(info?.filePath).toBe(file);
  });

  // Dotted versions must survive the filename heuristic.
  it.each(['v1.2.3', 'v0.0.0.1', 'v2026.08.03'])('keeps %s a version', (v) => {
    expect(parsePathForUUID(`/proj123/${v}/index.html`)?.resolution?.version).toBe(v);
  });
});

describe('extractProjectFromReferer', () => {
  it('extracts projectId and versionId from a valid Referer', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/TjYmKAiAQuIdYFlBnVOa/main/iframe.html');
    expect(result).toEqual({ projectId: 'TjYmKAiAQuIdYFlBnVOa', versionId: 'main' });
  });

  it('extracts projectId with semantic version', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/my-project/v1.0.0/iframe.html');
    expect(result).toEqual({ projectId: 'my-project', versionId: 'v1.0.0' });
  });

  it('extracts projectId with PR version', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/my-project/pr-123/iframe.html');
    expect(result).toEqual({ projectId: 'my-project', versionId: 'pr-123' });
  });

  it('extracts projectId without version when second segment is not a version', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/TjYmKAiAQuIdYFlBnVOa/iframe.html');
    expect(result).toEqual({ projectId: 'TjYmKAiAQuIdYFlBnVOa', versionId: '' });
  });

  it('returns null for Referer with no path segments', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/');
    expect(result).toBeNull();
  });

  it('returns null for Referer with invalid projectId', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/ab/main/iframe.html');
    expect(result).toBeNull();
  });

  it('returns null for invalid URL', () => {
    const result = extractProjectFromReferer('not-a-url');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = extractProjectFromReferer('');
    expect(result).toBeNull();
  });

  it('works with different domains (does not validate domain)', () => {
    const result = extractProjectFromReferer('https://other-domain.com/my-project/main/iframe.html');
    expect(result).toEqual({ projectId: 'my-project', versionId: 'main' });
  });

  it('handles Referer with query parameters', () => {
    const result = extractProjectFromReferer('https://view.scrymore.com/my-project/main/iframe.html?id=button--primary');
    expect(result).toEqual({ projectId: 'my-project', versionId: 'main' });
  });
});