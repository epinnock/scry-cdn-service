# URL Pattern Change - Path-Based Structure

## Change Summary

**Date:** 2025-11-01  
**Version:** 224b51c8-8c60-4493-b27f-e8336c47f3b0  
**Change:** Replaced dash-based UUIDs with path-based URL structure

## New URL Pattern

### ✅ Current Pattern: `/projectId/versionId/`

URLs now use path segments instead of dashes to separate project and version:

**Format:**
```
https://view.scrymore.com/{projectId}/{versionId}/path/to/file
https://view.scrymore.com/{projectId}/path/to/file  (no version)
```

**Examples:**
- `https://view.scrymore.com/design-system/v1.0.1/`
- `https://view.scrymore.com/design-system/v1.0.0/`
- `https://view.scrymore.com/my-app/v2.3.1/`
- `https://view.scrymore.com/docs-site/` (no version)

### ❌ Old Pattern (No Longer Supported)

The previous dash-based pattern is no longer supported:

**Old Format (DEPRECATED):**
```
https://view.scrymore.com/{projectId}-{versionId}/
```

**Examples of old URLs that no longer work:**
- ❌ `https://view.scrymore.com/design-system-v1-0-1/`
- ❌ `https://view.scrymore.com/my-app-v2-3-1/`

## R2 Storage Structure

Files should be stored in UPLOAD_BUCKET (my-storybooks-production) following this structure:

### With Version
```
my-storybooks-production/
  ├── design-system/
  │   ├── v1.0.0/
  │   │   └── storybook.zip
  │   └── v1.0.1/
  │       └── storybook.zip
  └── my-app/
      └── v2.3.1/
          └── storybook.zip
```

**Upload Command:**
```bash
npx wrangler r2 object put my-storybooks-production/design-system/v1.0.1/storybook.zip \
  --file=storybook.zip
```

**View URL:**
```
https://view.scrymore.com/design-system/v1.0.1/
```

### Without Version
```
my-storybooks-production/
  ├── docs-site/
  │   └── storybook.zip
  └── temp-project/
      └── storybook.zip
```

**Upload Command:**
```bash
npx wrangler r2 object put my-storybooks-production/docs-site/storybook.zip \
  --file=storybook.zip
```

**View URL:**
```
https://view.scrymore.com/docs-site/
```

## URL Parsing Logic

> **Superseded (2026-09-26):** version detection below is historical. The viewer now reads the version by position and accepts every name the upload service accepts, dots included (ISSUES.md #53). See README "Which version names open".

The new parser in [`src/utils/subdomain.ts`](src/utils/subdomain.ts):

1. Splits the path into segments: `/design-system/v1.0.1/index.html`
2. First segment: `projectId` (design-system)
3. Second segment (optional): `versionId` if it matches `/^v[\d.]+$/` (v1.0.1)
4. Remaining segments: File path (index.html)

### Version Detection

A segment is considered a version if it:
- Starts with 'v'
- Followed by digits and dots
- Examples: `v1.0.0`, `v2.3.1`, `v10.5.2`

### Examples

| URL | projectId | versionId | filePath | ZIP Path |
|-----|-----------|-----------|----------|----------|
| `/design-system/v1.0.1/` | design-system | v1.0.1 | index.html | design-system/v1.0.1/storybook.zip |
| `/design-system/v1.0.1/assets/style.css` | design-system | v1.0.1 | assets/style.css | design-system/v1.0.1/storybook.zip |
| `/my-app/` | my-app | (none) | index.html | my-app/storybook.zip |
| `/docs/about.html` | docs | (none) | about.html | docs/storybook.zip |

## Testing

### Test New URLs
```bash
# With version
curl -I https://view.scrymore.com/design-system/v1.0.1/
# Expected: HTTP 200

# Without version (if you have such a file)
curl -I https://view.scrymore.com/my-project/
# Expected: HTTP 200 or 404 if not uploaded

# With asset path
curl -I https://view.scrymore.com/design-system/v1.0.1/assets/style.css
# Expected: HTTP 200
```

### Monitor Logs
```bash
npx wrangler tail --env production
```

You'll see debug output showing the path parsing:
```
[DEBUG] URL pathname: /design-system/v1.0.1/
[DEBUG] Parsed pathInfo: {
  "uuid": "design-system-v1-0-1",
  "filePath": "index.html",
  "isValid": true,
  "resolution": {
    "type": "compound",
    "project": "design-system",
    "version": "v1.0.1",
    "zipKey": "design-system/v1.0.1/storybook.zip",
    "bucket": "UPLOAD_BUCKET"
  }
}
```

## Migration Guide

If you have existing files using the old URL pattern, you don't need to move files in R2. The storage structure remains the same - only the URL pattern changed.

### URL Migration Map

| Old URL (Deprecated) | New URL (Current) |
|---------------------|-------------------|
| `/design-system-v1-0-0/` | `/design-system/v1.0.0/` |
| `/design-system-v1-0-1/` | `/design-system/v1.0.1/` |
| `/my-app-v2-3-1/` | `/my-app/v2.3.1/` |
| `/component-lib-v1-5-0/` | `/component-lib/v1.5.0/` |

### Update Your Links

Update any bookmarks, documentation, or embedded links to use the new path-based format:

**Before:**
```html
<a href="https://view.scrymore.com/design-system-v1-0-1/">View Storybook</a>
```

**After:**
```html
<a href="https://view.scrymore.com/design-system/v1.0.1/">View Storybook</a>
```

## Upload Service Integration

The Upload Service should generate view URLs using the new format:

```typescript
function generateViewUrl(projectId: string, versionId: string): string {
  return `https://view.scrymore.com/${projectId}/${versionId}/`;
}

// Example usage
const url = generateViewUrl("design-system", "v1.0.1");
// Returns: "https://view.scrymore.com/design-system/v1.0.1/"
```

Response format:
```json
{
  "success": true,
  "data": {
    "projectId": "design-system",
    "versionId": "v1.0.1",
    "zipUrl": "https://pub-xxx.r2.dev/design-system/v1.0.1/storybook.zip",
    "viewUrl": "https://view.scrymore.com/design-system/v1.0.1/"
  }
}
```

## Breaking Changes

⚠️ **Breaking Change:** Old dash-based URLs no longer work

If you have automated systems or documentation using the old URL format, they must be updated to use the new path-based format.

## Benefits

1. **More intuitive URLs** - Clear separation of project and version
2. **Standard REST-like structure** - Follows common web conventions
3. **Easier to parse** - Simple path segment splitting
4. **Better readability** - `design-system/v1.0.1` vs `design-system-v1-0-1`
5. **Matches R2 structure** - URL path mirrors storage path

## Current Deployment

- **Version ID:** 224b51c8-8c60-4493-b27f-e8336c47f3b0
- **Deployed:** 2025-11-01
- **Status:** ✅ Active in production

## Support

View real-time logs:
```bash
npx wrangler tail --env production
```

Test deployments:
```bash
curl -v https://view.scrymore.com/design-system/v1.0.1/