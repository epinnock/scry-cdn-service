# PR Version Support Implementation Plan

> **Superseded (2026-09-26).** The allowlist described below was replaced by position-based parsing against the upload service's version grammar (ISSUES.md #53, features/cdn-version-names-missing-zip). See the README section "Which version names open" and `src/utils/subdomain.ts`. Kept for history only.

## Executive Summary

This document outlines the implementation plan to enable flexible version string support in the scry-cdn-service, allowing PR builds (`pr-001`), extended semantic versions (`v0.0.0.1`), and custom version identifiers to work alongside traditional semantic versions.

**Status**: Upload service already supports flexible versions ✅ | CDN service needs updates ❌

**Priority**: High - Blocking PR preview deployments

---

## Problem Statement

### Current Behavior

The scry-cdn-service has restrictive regex patterns that only accept version formats like `v1.0.0` (v + digits + dots). This prevents accessing Storybook uploads with PR-based versions.

**Example URL that fails**: `https://view.scrymore.com/3KZmzDwWam6N5a0fpvao/pr-001/`

### Upload Service (Working) ✅

File: [`scry-storybook-upload-service/src/app.ts:94`](scry-storybook-upload-service/src/app.ts:94)

```typescript
version: z.string().min(1).openapi({ example: '1.0.0' })
```

**Status**: Already accepts any non-empty string including `pr-001`

### CDN Service (Broken) ❌

The CDN service has two restrictive regex patterns:

#### Issue 1: Path Version Detection

File: [`src/utils/subdomain.ts:79`](src/utils/subdomain.ts:79)

```typescript
if (segments.length >= 2 && /^v[\d.]+$/.test(segments[1]))
```

**Pattern**: `/^v[\d.]+$/`  
**Matches**: `v1.0.0`, `v2.1`, `v10.20.30`  
**Rejects**: `pr-001`, `v0.0.0.1`, `beta-2024`, `dev-123`

#### Issue 2: Compound UUID Parsing

File: [`src/utils/path-resolver.ts:56`](src/utils/path-resolver.ts:56)

```typescript
const versionStartIndex = parts.findIndex(part => /^v\d+$/.test(part));
```

**Pattern**: `/^v\d+$/`  
**Matches**: `v1`, `v2`, `v10`  
**Rejects**: `pr`, `beta`, `dev`, any multi-character version parts

---

## Solution Architecture

### Design Principles

1. **Backward Compatibility**: All existing version formats must continue to work
2. **Flexibility**: Support any valid version identifier scheme
3. **Clarity**: Version detection should be predictable and well-documented
4. **Performance**: No significant performance impact from flexible matching

### Supported Version Formats (After Implementation)

| Format | Example | Use Case |
|--------|---------|----------|
| Semantic | `v1.0.0`, `v2.1.5` | Production releases |
| Extended Semantic | `v0.0.0.1`, `v1.2.3.4` | Detailed versioning |
| Pull Request | `pr-001`, `pr-123` | PR preview builds |
| Development | `dev-123`, `dev-snapshot-456` | Development snapshots |
| Named Release | `beta-2024`, `alpha-v2` | Pre-release versions |
| Environment | `staging`, `latest`, `main` | Environment-specific |
| Canary | `canary-latest`, `canary-20240116` | Canary releases |

### Version Detection Strategy

Instead of restrictive patterns, we'll use **flexible heuristics**:

1. Check if segment matches common version prefixes/patterns
2. Allow alphanumeric characters, hyphens, and dots
3. Minimum length validation (3+ characters)
4. Fallback to treating ambiguous segments as file paths

---

## Implementation Plan

### Phase 1: Update Version Detection in subdomain.ts

**File**: [`src/utils/subdomain.ts`](src/utils/subdomain.ts)

#### Change 1: Add Version Detection Helper (Before line 44)

```typescript
/**
 * Detect if a path segment is a version identifier
 * 
 * Supports multiple version formats:
 * - Semantic: v1.0.0, v2.1.5
 * - Extended: v0.0.0.1, v1.2.3.4
 * - PR builds: pr-001, pr-123
 * - Development: dev-123, dev-snapshot-456
 * - Named: beta-2024, alpha-v2, canary-latest
 * - Environment: staging, latest, main
 */
function isVersionSegment(segment: string): boolean {
  // Minimum length check
  if (segment.length < 2) return false;
  
  // Match common version patterns:
  // 1. Starts with 'v' followed by version number (v1.0.0, v0.0.0.1)
  // 2. PR format (pr-001, pr-123)
  // 3. Dev format (dev-123, dev-snapshot-456)
  // 4. Common identifiers (beta, alpha, canary, rc)
  // 5. Environment names (staging, latest, main, production)
  const commonPatterns = /^(v[\d.\-]+|pr-\d+|dev-[\w\-]+|beta[\w\-]*|alpha[\w\-]*|canary[\w\-]*|rc-?\d*|staging|latest|main|production)$/i;
  
  return commonPatterns.test(segment);
}
```

#### Change 2: Update Version Detection Logic (Line 79)

**Before**:
```typescript
if (segments.length >= 2 && /^v[\d.]+$/.test(segments[1])) {
```

**After**:
```typescript
if (segments.length >= 2 && isVersionSegment(segments[1])) {
```

---

### Phase 2: Update Compound UUID Parsing in path-resolver.ts

**File**: [`src/utils/path-resolver.ts`](src/utils/path-resolver.ts)

#### Change 1: Add Version Part Detection Helper (After line 41)

```typescript
/**
 * Detect if a UUID part represents the start of a version identifier
 * 
 * This is used when parsing compound UUIDs like "my-project-pr-001"
 * to identify where the project name ends and version begins.
 */
function isVersionPart(part: string): boolean {
  // Match common version prefixes that mark the start of a version
  return /^(v\d+|pr|dev|beta|alpha|canary|rc|staging|latest|main)$/i.test(part);
}
```

#### Change 2: Update Version Start Detection (Line 56)

**Before**:
```typescript
const versionStartIndex = parts.findIndex(part => /^v\d+$/.test(part));
```

**After**:
```typescript
const versionStartIndex = parts.findIndex(part => isVersionPart(part));
```

#### Change 3: Update Version Reconstruction (Line 69-70)

**Before**:
```typescript
// Everything from version onward, convert dashes to dots
// v1-0-0 → v1.0.0
const versionParts = parts.slice(versionStartIndex);
const version = versionParts.join('.').replace(/-/g, '.');
```

**After**:
```typescript
// Everything from version onward
// Keep original format for non-semantic versions (pr-001, dev-123)
// Only convert semantic versions (v1-0-0 → v1.0.0)
const versionParts = parts.slice(versionStartIndex);
const firstPart = versionParts[0];

// If it starts with 'v' followed by a digit, convert dashes to dots
if (/^v\d+/.test(firstPart)) {
  const version = versionParts.join('.').replace(/-/g, '.');
} else {
  // Keep original hyphen-based format for PR/dev/named versions
  const version = versionParts.join('-');
}
```

---

### Phase 3: Add Comprehensive Test Coverage

#### File 1: Update Existing Tests in path-resolver.test.ts

**File**: [`tests/utils/path-resolver.test.ts`](tests/utils/path-resolver.test.ts)

Add new test suite:

```typescript
describe('PR and extended version support', () => {
  describe('parseCompoundUUID with PR versions', () => {
    it('handles PR version format', () => {
      expect(parseCompoundUUID('my-project-pr-001')).toEqual({
        project: 'my-project',
        version: 'pr-001'
      });
    });

    it('handles PR version with multiple digits', () => {
      expect(parseCompoundUUID('app-pr-123')).toEqual({
        project: 'app',
        version: 'pr-123'
      });
    });

    it('handles dev version format', () => {
      expect(parseCompoundUUID('lib-dev-456')).toEqual({
        project: 'lib',
        version: 'dev-456'
      });
    });

    it('handles beta/alpha versions', () => {
      expect(parseCompoundUUID('lib-beta-2024')).toEqual({
        project: 'lib',
        version: 'beta-2024'
      });
      
      expect(parseCompoundUUID('app-alpha-v2')).toEqual({
        project: 'app',
        version: 'alpha-v2'
      });
    });
  });

  describe('parseCompoundUUID with extended semantic versions', () => {
    it('handles 4-part semantic versions', () => {
      expect(parseCompoundUUID('app-v0-0-0-1')).toEqual({
        project: 'app',
        version: 'v0.0.0.1'
      });
    });

    it('handles 5-part semantic versions', () => {
      expect(parseCompoundUUID('service-v1-2-3-4-5')).toEqual({
        project: 'service',
        version: 'v1.2.3.4.5'
      });
    });
  });

  describe('resolveUUID with PR versions', () => {
    it('correctly resolves PR version to storage path', () => {
      const result = resolveUUID('my-project-pr-001');
      expect(result).toEqual({
        type: 'compound',
        uuid: 'my-project-pr-001',
        project: 'my-project',
        version: 'pr-001',
        zipKey: 'my-project/pr-001/storybook.zip',
        bucket: 'UPLOAD_BUCKET'
      });
    });

    it('correctly resolves extended semantic version', () => {
      const result = resolveUUID('app-v0-0-0-1');
      expect(result).toEqual({
        type: 'compound',
        uuid: 'app-v0-0-0-1',
        project: 'app',
        version: 'v0.0.0.1',
        zipKey: 'app/v0.0.0.1/storybook.zip',
        bucket: 'UPLOAD_BUCKET'
      });
    });
  });
});
```

#### File 2: Add Tests for Subdomain Path Parsing

**File**: [`tests/utils/subdomain.test.ts`](tests/utils/subdomain.test.ts) (Create if doesn't exist)

```typescript
import { describe, it, expect } from 'vitest';
import { parsePathForUUID, isValidUUID } from '../../src/utils/subdomain';

describe('subdomain path parsing with flexible versions', () => {
  describe('parsePathForUUID with PR versions', () => {
    it('detects pr-001 as version', () => {
      const result = parsePathForUUID('/my-project/pr-001/index.html');
      expect(result?.isValid).toBe(true);
      expect(result?.resolution?.version).toBe('pr-001');
      expect(result?.resolution?.zipKey).toBe('my-project/pr-001/storybook.zip');
      expect(result?.filePath).toBe('index.html');
    });

    it('detects pr-123 as version', () => {
      const result = parsePathForUUID('/app/pr-123/components/button.html');
      expect(result?.resolution?.version).toBe('pr-123');
      expect(result?.filePath).toBe('components/button.html');
    });
  });

  describe('parsePathForUUID with extended semantic versions', () => {
    it('detects v0.0.0.1 as version', () => {
      const result = parsePathForUUID('/app/v0.0.0.1/page.html');
      expect(result?.resolution?.version).toBe('v0.0.0.1');
      expect(result?.resolution?.zipKey).toBe('app/v0.0.0.1/storybook.zip');
    });

    it('detects v1.2.3.4 as version', () => {
      const result = parsePathForUUID('/service/v1.2.3.4/index.html');
      expect(result?.resolution?.version).toBe('v1.2.3.4');
    });
  });

  describe('parsePathForUUID with named versions', () => {
    it('detects beta-2024 as version', () => {
      const result = parsePathForUUID('/lib/beta-2024/docs.html');
      expect(result?.resolution?.version).toBe('beta-2024');
    });

    it('detects canary-latest as version', () => {
      const result = parsePathForUUID('/app/canary-latest/index.html');
      expect(result?.resolution?.version).toBe('canary-latest');
    });

    it('detects dev-snapshot-123 as version', () => {
      const result = parsePathForUUID('/project/dev-snapshot-123/test.html');
      expect(result?.resolution?.version).toBe('dev-snapshot-123');
    });
  });

  describe('parsePathForUUID backward compatibility', () => {
    it('still works with traditional semantic versions', () => {
      const result = parsePathForUUID('/app/v1.0.0/index.html');
      expect(result?.resolution?.version).toBe('v1.0.0');
    });

    it('handles paths without versions', () => {
      const result = parsePathForUUID('/simple-project/index.html');
      expect(result?.resolution?.version).toBe('');
      expect(result?.resolution?.zipKey).toBe('simple-project/storybook.zip');
    });
  });
});
```

---

### Phase 4: Update API Documentation

**File**: [`scry-storybook-upload-service/src/app.ts`](scry-storybook-upload-service/src/app.ts)

#### Update Line 94: Enhance Version Schema Documentation

**Before**:
```typescript
version: z.string().min(1).openapi({ example: '1.0.0' })
```

**After**:
```typescript
version: z.string().min(1).openapi({ 
  example: 'v1.0.0',
  description: 'Version identifier - supports semantic versions (v1.0.0), PR builds (pr-001), extended versions (v0.0.0.1), and named releases (beta-2024)',
  examples: {
    semantic: { 
      value: 'v1.0.0', 
      summary: 'Semantic version',
      description: 'Standard semantic versioning'
    },
    pr: { 
      value: 'pr-001', 
      summary: 'Pull request build',
      description: 'PR preview deployments'
    },
    extended: { 
      value: 'v0.0.0.1', 
      summary: 'Extended semantic',
      description: 'Extended semantic versioning'
    },
    named: { 
      value: 'beta-2024', 
      summary: 'Named release',
      description: 'Named or dated releases'
    },
    dev: {
      value: 'dev-snapshot-123',
      summary: 'Development snapshot',
      description: 'Development builds'
    }
  }
})
```

---

### Phase 5: Integration Testing

#### Test Scenarios

**Test 1: PR Version Upload and Access**
```bash
# Upload with PR version
curl -X POST "http://localhost:3000/upload/test-project/pr-001" \
  -F "file=@storybook.zip"

# Verify storage
# Check R2 bucket has: test-project/pr-001/storybook.zip

# Access via CDN
curl "https://view.scrymore.com/test-project/pr-001/"
# Expected: 200 OK with Storybook index.html
```

**Test 2: Extended Semantic Version**
```bash
# Upload
curl -X POST "http://localhost:3000/upload/my-app/v0.0.0.1" \
  -F "file=@storybook.zip"

# Access
curl "https://view.scrymore.com/my-app/v0.0.0.1/"
# Expected: 200 OK
```

**Test 3: Named Versions**
```bash
# Beta release
curl -X POST "http://localhost:3000/upload/lib/beta-2024" \
  -F "file=@storybook.zip"

# Dev snapshot
curl -X POST "http://localhost:3000/upload/service/dev-snapshot-456" \
  -F "file=@storybook.zip"
```

**Test 4: Backward Compatibility**
```bash
# Traditional semantic version should still work
curl -X POST "http://localhost:3000/upload/app/v1.2.3" \
  -F "file=@storybook.zip"

curl "https://view.scrymore.com/app/v1.2.3/"
# Expected: 200 OK (no regression)
```

#### E2E Test Checklist

- [ ] PR versions upload successfully
- [ ] PR versions accessible via CDN
- [ ] Extended semantic versions work
- [ ] Named versions (beta, alpha, dev) work
- [ ] Environment versions (staging, latest) work
- [ ] Traditional semantic versions still work
- [ ] Paths without versions still work
- [ ] Error handling for invalid versions
- [ ] Performance is acceptable (< 50ms overhead)

---

## Files to Modify

### Primary Changes

1. **[`scry-cdn-service/src/utils/subdomain.ts`](scry-cdn-service/src/utils/subdomain.ts)**
   - Add `isVersionSegment()` helper function
   - Update line 79 version detection

2. **[`scry-cdn-service/src/utils/path-resolver.ts`](scry-cdn-service/src/utils/path-resolver.ts)**
   - Add `isVersionPart()` helper function
   - Update line 56 version start detection
   - Update lines 69-70 version reconstruction logic

3. **[`scry-cdn-service/tests/utils/path-resolver.test.ts`](scry-cdn-service/tests/utils/path-resolver.test.ts)**
   - Add PR version test cases
   - Add extended semantic version tests
   - Add named version tests

4. **[`scry-cdn-service/tests/utils/subdomain.test.ts`](scry-cdn-service/tests/utils/subdomain.test.ts)**
   - Create if doesn't exist
   - Add comprehensive path parsing tests

### Optional Documentation Updates

5. **[`scry-storybook-upload-service/src/app.ts`](scry-storybook-upload-service/src/app.ts)**
   - Update OpenAPI schema with version examples

---

## Success Criteria

### Functional Requirements

- [x] Upload service accepts any version string (already working)
- [ ] CDN accepts `pr-001` format versions
- [ ] CDN accepts `v0.0.0.1` extended versions
- [ ] CDN accepts named versions (`beta-2024`, `dev-123`)
- [ ] CDN accepts environment versions (`staging`, `latest`)
- [ ] Backward compatibility: traditional `v1.0.0` still works
- [ ] Paths without versions still work

### Testing Requirements

- [ ] All existing tests pass
- [ ] New tests cover PR versions
- [ ] New tests cover extended semantic versions
- [ ] New tests cover named versions
- [ ] Integration tests verify end-to-end flow
- [ ] Performance tests show < 50ms overhead

### Documentation Requirements

- [ ] Code comments explain version detection logic
- [ ] OpenAPI schema documents all version formats
- [ ] This implementation plan is complete
- [ ] Test cases document expected behavior

---

## Risk Analysis

### Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Breaking existing version formats | High | Low | Comprehensive test coverage + backward compatibility tests |
| Performance degradation | Medium | Low | Benchmark tests before/after |
| Ambiguous version detection | Medium | Medium | Clear heuristics + fallback to file path |
| Version collision with file names | Low | Low | Require minimum length + common prefix patterns |

### Rollback Plan

If issues arise post-deployment:

1. Revert changes to `subdomain.ts` and `path-resolver.ts`
2. Deploy previous version from version control
3. Existing deployments using traditional versions continue working
4. PR versions return 404 (same as current behavior)

---

## Timeline Estimate

- **Phase 1-2**: Code changes - 2 hours
- **Phase 3**: Test writing - 3 hours
- **Phase 4**: Documentation - 1 hour
- **Phase 5**: Integration testing - 2 hours
- **Total**: ~8 hours (1 day)

---

## Implementation Checklist

### Development

- [ ] Create feature branch: `feature/pr-version-support`
- [ ] Update `subdomain.ts` with `isVersionSegment()`
- [ ] Update `path-resolver.ts` with `isVersionPart()`
- [ ] Update version reconstruction logic
- [ ] Run existing tests - ensure no regressions
- [ ] Add new test cases for PR versions
- [ ] Add new test cases for extended versions
- [ ] Add new test cases for named versions
- [ ] Update OpenAPI documentation
- [ ] Run full test suite
- [ ] Code review

### Testing

- [ ] Unit tests pass (100% of new code covered)
- [ ] Integration tests pass
- [ ] Manual testing with PR versions
- [ ] Manual testing with extended versions
- [ ] Backward compatibility verified
- [ ] Performance benchmarked

### Deployment

- [ ] Merge to main branch
- [ ] Deploy to staging environment
- [ ] Verify staging with real PR builds
- [ ] Deploy to production
- [ ] Monitor error logs
- [ ] Update documentation

---

## Reference Links

- Original Issue: PR versions not accessible via CDN
- Upload Service: Already supports flexible versions
- CDN Service: Needs updates for flexible version matching
- Test Coverage: [`tests/utils/`](tests/utils/)

---

## Appendix: Version Format Examples

### Currently Supported (After Implementation)

```
✅ v1.0.0          - Semantic version
✅ v2.1.5          - Semantic version
✅ v0.0.0.1        - Extended semantic (4 parts)
✅ v1.2.3.4.5      - Extended semantic (5 parts)
✅ pr-001          - Pull request #1
✅ pr-123          - Pull request #123
✅ dev-456         - Development build #456
✅ dev-snapshot-789 - Named dev snapshot
✅ beta-2024       - Named beta release
✅ alpha-v2        - Named alpha release
✅ canary-latest   - Canary build
✅ rc-1            - Release candidate
✅ staging         - Environment deployment
✅ latest          - Latest build
✅ main            - Main branch build
```

### Currently NOT Supported (By Design)

```
❌ 1.0.0           - No 'v' prefix (ambiguous with file paths)
❌ pr001           - No hyphen (ambiguous)
❌ v              - Too short
❌ ./             - Invalid characters
```

---

*Last Updated: 2025-11-16*  
*Status: Ready for Implementation*