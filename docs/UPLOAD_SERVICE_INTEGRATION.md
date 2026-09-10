# Scry View Service - Upload Service Integration Guide

This document explains how the **Scry View Service** works and provides guidelines for the **Upload Service** team to ensure proper integration and alignment.

## Table of Contents

1. [Overview](#overview)
2. [Automatic Upload Service Integration New:](#automatic-upload-service-integration)
3. [**URL Structure**](#url-structure)
4. [ZIP File Requirements](#zip-file-requirements)
5. [R2 Storage Format](#r2-storage-format)
6. [How the View Service Works](#how-the-view-service-works)
7. [Cache Invalidation](#cache-invalidation)
8. [Testing Your Uploads](#testing-your-uploads)
9. [Best Practices](#best-practices)
10. [Troubleshooting](#troubleshooting)

---

## Overview

The **Scry View Service** is a CDN that serves static websites directly from ZIP files stored in Cloudflare R2. It uses **partial ZIP extraction** via HTTP range requests to efficiently serve individual files without extracting the entire archive.

### Key Components

- **R2 Buckets:** 
  - `scry-static-sites` (production) / `scry-static-sites-preview` (staging) - Legacy sites
  - `my-storybooks-production` / `my-storybooks-staging` - **NEW:** Upload Service integration
- **KV Namespace:** `CDN_CACHE` - stores central directory metadata for 24 hours
- **URL Format:** Path-based routing: `https://view.scrymore.com/{uuid}/path/to/file`

---

## Automatic Upload Service Integration

### 🎉 NEW: Direct Integration with Upload Service

The View Service now **automatically serves** Storybooks uploaded via the Upload Service without any manual copying or syncing!

When you upload a Storybook to the Upload Service at:
```
my-storybooks-production/{project}/{version}/storybook.zip
```

It becomes **immediately viewable** at:
```
https://view.scrymore.com/{project}-{version}/
```

### URL Pattern Mapping

The View Service automatically detects compound UUIDs and maps them to the Upload Service storage structure:

| Upload Service Path | View Service URL | Status |
|---------------------|------------------|--------|
| `design-system/v1.0.0/storybook.zip` | `view.scrymore.com/design-system-v1-0-0/` | ✅ Automatic |
| `my-app/v2.1.5/storybook.zip` | `view.scrymore.com/my-app-v2-1-5/` | ✅ Automatic |
| `component-lib/v3.0.0/storybook.zip` | `view.scrymore.com/component-lib-v3-0-0/` | ✅ Automatic |

### How It Works

1. **Upload Service** stores at: `my-storybooks-production/{project}/{version}/storybook.zip`
2. **View Service** detects compound UUID pattern: `{project}-v{major}-{minor}-{patch}`
3. **Automatic mapping**: Converts URL to storage path
   - URL: `design-system-v1-0-0` → Path: `design-system/v1.0.0/storybook.zip`
4. **Serves directly** from Upload Service bucket

### Version Format Rules

**In Upload Service (storage path):**
- Format: `{project}/{version}/storybook.zip`
- Version uses **dots**: `v1.0.0`, `v2.1.5`
- Example: `design-system/v1.0.0/storybook.zip`

**In View Service (URL):**
- Format: `{project}-{version}/`
- Version uses **dashes**: `v1-0-0`, `v2-1-5`
- Example: `view.scrymore.com/design-system-v1-0-0/`

**Conversion:**
- Dots (`.`) in version → Dashes (`-`) in URL
- `v1.0.0` → `v1-0-0`
- `v2.1.5` → `v2-1-5`

### Complete Examples

**Example 1: Design System**
```bash
# Upload via Upload Service
POST /upload/design-system/v1.0.0
→ Stores at: my-storybooks-production/design-system/v1.0.0/storybook.zip

# Automatically viewable at
https://view.scrymore.com/design-system-v1-0-0/
```

**Example 2: Multi-word Project**
```bash
# Upload via Upload Service  
POST /upload/component-library/v2.3.1
→ Stores at: my-storybooks-production/component-library/v2.3.1/storybook.zip

# Automatically viewable at
https://view.scrymore.com/component-library-v2-3-1/
```

### Upload Service Response Enhancement

**Recommended:** The Upload Service should return the View URL in its response:

```json
{
  "success": true,
  "message": "Upload successful",
  "data": {
    "buildId": "abc123",
    "buildNumber": 5,
    "zipUrl": "https://pub-my-storybooks-production.../design-system/v1.0.0/storybook.zip",
    "viewUrl": "https://view.scrymore.com/design-system-v1-0-0/"
  }
}
```

**Helper function for Upload Service:**
```typescript
function generateViewUrl(project: string, version: string): string {
  // Convert version dots to dashes: v1.0.0 → v1-0-0
  const versionSlug = version.replace(/\./g, '-');
  return `https://view.scrymore.com/${project}-${versionSlug}/`;
}

// Example usage
generateViewUrl("design-system", "v1.0.0")
// Returns: "https://view.scrymore.com/design-system-v1-0-0/"
```

---

## URL Structure

### Production URLs

The View Service supports **two URL patterns**:

#### Pattern 1: Legacy Simple UUID (existing)
```
https://view.scrymore.com/{uuid}/path/to/file.html
```

**Examples:**
- `https://view.scrymore.com/storybook/` → serves from `scry-static-sites/storybook.zip`
- `https://view.scrymore.com/my-app/index.html` → serves from `scry-static-sites/my-app.zip`

#### Pattern 2: Upload Service Compound UUID (NEW)
```
https://view.scrymore.com/{project}-{version}/path/to/file.html
```

**Examples:**
- `https://view.scrymore.com/design-system-v1-0-0/` → serves from `my-storybooks-production/design-system/v1.0.0/storybook.zip`
- `https://view.scrymore.com/my-app-v2-1-5/assets/style.css` → serves from `my-storybooks-production/my-app/v2.1.5/storybook.zip`

### URL Components

| Component | Description | Example |
|-----------|-------------|---------|
| **Domain** | Always `view.scrymore.com` | `view.scrymore.com` |
| **UUID** | Simple or compound identifier | `storybook` (simple)<br/>`design-system-v1-0-0` (compound) |
| **File Path** | Path to file within the ZIP | `assets/style.css`, `about.html` |

### UUID Requirements

**Simple UUID (legacy):**
- Format: `/^[a-zA-Z0-9-]{3,}$/`
- No version pattern required
- Examples: `storybook`, `my-app`, `abc-123`

**Compound UUID (Upload Service):**
- Format: `{project}-v{major}-{minor}-{patch}`
- Must contain version starting with `v` followed by numbers
- Version parts separated by dashes
- Examples: `design-system-v1-0-0`, `my-app-v2-1-5`

---

## ZIP File Requirements

### ✅ Critical: File Structure

**Files MUST be at the root of the ZIP, NOT in a subdirectory.**

#### ✅ Correct Structure

```
mysite.zip
├── index.html
├── about.html
├── assets/
│   ├── style.css
│   └── logo.png
└── js/
    └── app.js
```

**How to create:**
```bash
cd my-website-folder
zip -r ../mysite.zip .
```

#### ❌ Incorrect Structure

```
mysite.zip
└── my-website-folder/    ← DON'T DO THIS
    ├── index.html
    ├── about.html
    └── assets/
```

**Why this fails:**
- View service looks for `index.html` at ZIP root
- If nested in `my-website-folder/index.html`, it won't be found

### Supported Compression

- **Method 0:** Stored (no compression) ✅
- **Method 8:** Deflate (standard compression) ✅
- **Other methods:** Not supported ❌

Standard ZIP tools (zip, 7-Zip, etc.) use Method 8 by default, which is fully supported.

### File Size Limits

- **Individual file size:** No hard limit, but consider network performance
- **Total ZIP size:** Limited by R2 storage (5TB per object max)
- **Recommended:** Keep individual files under 50MB for optimal performance

---

## R2 Storage Format

### Naming Convention

**Format:** `{uuid}.zip`

**Examples:**
- `storybook.zip`
- `my-app-v2.zip`
- `abc-123.zip`

### Storage Locations

| Environment | Bucket Name | Purpose |
|-------------|-------------|---------|
| **Production** | `scry-static-sites` | Live sites served to users |
| **Staging** | `scry-static-sites-preview` | Testing and development |

### Upload Methods

#### Option 1: Wrangler CLI (Recommended)

```bash
# Set API token
export CLOUDFLARE_API_TOKEN="your-token-here"

# Upload to production
npx wrangler r2 object put scry-static-sites/{uuid}.zip --file=yourfile.zip

# Upload to preview
npx wrangler r2 object put scry-static-sites-preview/{uuid}.zip --file=yourfile.zip
```

#### Option 2: Cloudflare R2 API

```bash
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/{account_id}/r2/buckets/scry-static-sites/objects/{uuid}.zip" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/zip" \
  --data-binary @yourfile.zip
```

#### Option 3: S3-Compatible API

R2 supports S3-compatible APIs. Use AWS SDK or s3cmd with R2 credentials.

---

## How the View Service Works

### Request Flow

```
1. User requests: https://view.scrymore.com/storybook/assets/style.css
   ↓
2. Parse URL → UUID: "storybook", File: "assets/style.css"
   ↓
3. Check KV cache for central directory of "storybook.zip"
   ↓
4. If cached: use cached metadata
   If not: read central directory from R2 (first-time only)
   ↓
5. Find file entry in central directory
   ↓
6. Use HTTP range request to fetch ONLY the compressed bytes for this file
   ↓
7. Decompress file using pako (if needed)
   ↓
8. Return file with proper Content-Type and caching headers
```

### Technical Details

#### Central Directory Caching

- **First request:** Reads central directory from ZIP using range requests (~1-5KB typically)
- **Cached in KV:** For 24 hours
- **Subsequent requests:** Use cached metadata (no R2 reads except for file data)

This means:
- **First file access:** 2 R2 requests (central directory + file data)
- **All other files:** 1 R2 request (file data only)

#### File Extraction Process

1. **Read local file header** (30 bytes + filename + extra field length)
2. **Calculate data offset** accounting for variable-length headers
3. **Range request** for exact compressed bytes needed
4. **Decompress** using Deflate algorithm if needed
5. **Return** raw bytes to browser

#### Performance Characteristics

- **Cold start:** ~500ms (includes central directory read)
- **Warm cache:** ~200-300ms per file
- **Network overhead:** Minimal - only fetches exact bytes needed
- **Memory usage:** Only decompressed file held in memory

---

## Cache Invalidation

### When to Invalidate

Invalidate the cache when you:
- Upload a new version of an existing ZIP
- Modify files within a ZIP
- Need to force refresh of central directory

### How to Invalidate

#### Option 1: Delete KV Entry (Recommended)

```typescript
// Using Wrangler CLI
await kv.delete(`cd:${uuid}.zip`);
```

#### Option 2: Upload with New UUID

Instead of invalidating, upload with a new UUID:
- `my-app-v1.zip` → `my-app-v2.zip`
- Users get instant updates via new URL
- Old version remains accessible

#### Option 3: Wait 24 Hours

Cache expires automatically after 24 hours.

---

## Testing Your Uploads

### Step 1: Upload to Preview Bucket

```bash
export CLOUDFLARE_API_TOKEN="your-token"
npx wrangler r2 object put scry-static-sites-preview/test-site.zip --file=mysite.zip
```

### Step 2: Test Locally with Wrangler Dev

```bash
# From the view service directory
npm run dev:cloudflare

# Access your site
# http://localhost:8788/test-site/
```

### Step 3: Verify File Structure

```bash
# List files in ZIP to verify structure
unzip -l mysite.zip | head -20

# Should show files at root:
#   index.html
#   assets/style.css
# NOT:
#   mysite/index.html  ← BAD
```

### Step 4: Test All Routes

Test these URLs to ensure proper routing:
- `/` or `/index.html` → main page
- `/assets/style.css` → CSS file
- `/about.html` → other pages
- `/nonexistent` → should return 404

### Step 5: Upload to Production

```bash
npx wrangler r2 object put scry-static-sites/test-site.zip --file=mysite.zip
```

### Step 6: Verify in Production

```bash
curl -I https://view.scrymore.com/test-site/
# Should return: 200 OK
# Content-Type: text/html
```

---

## Best Practices

### For Upload Service

1. **Validate ZIP structure before upload**
   - Check that files are at root, not in subdirectory
   - Verify at least `index.html` exists at root

2. **Generate UUIDs carefully**
   - Use URL-safe characters only: `[a-zA-Z0-9-]`
   - Consider including version numbers: `app-v1`, `app-v2`
   - Minimum 3 characters

3. **Use consistent naming**
   - `{project}-{version}.zip` format recommended
   - Examples: `storybook-v1.zip`, `docs-2024-01.zip`

4. **Provide feedback to users**
   - Return the view URL after successful upload
   - Format: `https://view.scrymore.com/{uuid}/`

5. **Handle errors gracefully**
   - Validate file size before upload
   - Check ZIP integrity
   - Retry failed uploads with exponential backoff

### For ZIP Creation

1. **Always zip from inside the directory**
   ```bash
   cd site-folder && zip -r ../site.zip .
   ```

2. **Exclude unnecessary files**
   ```bash
   zip -r site.zip . -x "*.DS_Store" -x "node_modules/*" -x ".git/*"
   ```

3. **Use compression**
   - Standard deflate (method 8) is optimal
   - Don't use `-0` (no compression) unless needed

4. **Include index.html**
   - Required for root path access
   - Should be at ZIP root level

### For End Users

1. **Provide clear upload instructions**
   - Document the correct ZIP structure
   - Show examples of good vs bad structure
   - Provide validation before upload

2. **Auto-fix common issues**
   - Detect nested structure and auto-flatten if possible
   - Strip leading directories automatically

3. **Validate on upload**
   - Check for `index.html` at root
   - Verify ZIP integrity
   - Test extraction before R2 upload

---

## Troubleshooting

### "Not Found" (404) Error

**Symptom:** `https://view.scrymore.com/mysite/index.html` returns 404

**Possible causes:**
1. **ZIP not uploaded to R2**
   - Check: Does `mysite.zip` exist in R2 bucket?
   - Fix: Upload the ZIP file

2. **Files nested in subdirectory**
   - Check: Run `unzip -l mysite.zip | head -10`
   - If you see `mysite/index.html`, files are nested
   - Fix: Re-zip from inside the directory: `cd mysite && zip -r ../mysite.zip .`

3. **Wrong filename in ZIP**
   - Check: Look for `index.html` vs `Index.html` (case sensitive)
   - Fix: Rename file in source and re-zip

4. **UUID mismatch**
   - Check: Is the UUID in the URL the same as the ZIP filename?
   - `view.scrymore.com/storybook/` needs `storybook.zip` in R2
   - Fix: Upload with matching UUID

### "Internal Server Error" (500)

**Possible causes:**
1. **Corrupted ZIP file**
   - Test: `unzip -t mysite.zip`
   - Fix: Re-create ZIP from source

2. **Unsupported compression method**
   - Check: ZIP uses method 0 (stored) or 8 (deflate)
   - Fix: Re-zip with standard tools

3. **R2 bucket not accessible**
   - Check: Verify bucket exists and permissions are correct
   - Fix: Check Cloudflare dashboard

### "Invalid format" (400) Error

**Cause:** UUID doesn't match validation pattern

**Fix:** 
- Use only alphanumeric characters and hyphens
- Minimum 3 characters
- Example: `my-site-v1` ✅, `my_site` ❌ (underscore not allowed)

### Cache Issues

**Symptom:** Updated ZIP not reflecting in view service

**Solutions:**
1. **Use new UUID:** Upload as `mysite-v2.zip` instead of updating `mysite.zip`
2. **Clear KV cache:** Delete the KV entry for `cd:mysite.zip`
3. **Wait:** Cache expires in 24 hours

### Performance Issues

**Symptom:** Slow file loading

**Possible causes:**
1. **Large individual files**
   - Files over 50MB may be slow
   - Consider splitting or optimizing

2. **No caching headers**
   - View service sets proper cache headers
   - Check browser cache is enabled

3. **Cold start**
   - First request reads central directory
   - Subsequent requests are faster

---

## API Integration Example

Here's how your upload service might integrate:

```typescript
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

async function uploadToScry(
  zipBuffer: Buffer,
  uuid: string,
  environment: "production" | "preview" = "production"
): Promise<{ url: string; size: number }> {
  // Validate UUID
  if (!/^[a-zA-Z0-9-]{3,}$/.test(uuid)) {
    throw new Error("Invalid UUID format");
  }

  const bucketName = environment === "production" 
    ? "scry-static-sites" 
    : "scry-static-sites-preview";

  const key = `${uuid}.zip`;

  // Upload to R2 using S3-compatible API
  const s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });

  await s3Client.send(
    new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: zipBuffer,
      ContentType: "application/zip",
    })
  );

  // Return view URL
  return {
    url: `https://view.scrymore.com/${uuid}/`,
    size: zipBuffer.length,
  };
}
```

---

## Support and Questions

If you have questions or need clarification:

1. **Check this document first** for common scenarios
2. **Review the view service source code:**
   - [`src/routes/zip-static.ts`](../src/routes/zip-static.ts) - Main routing logic
   - [`src/utils/subdomain.ts`](../src/utils/subdomain.ts) - UUID parsing
   - [`src/services/zip/extractor.ts`](../src/services/zip/extractor.ts) - File extraction
3. **Test in preview environment** before production
4. **Contact the view service team** for integration support

---

## Quick Reference

### ✅ Upload Checklist

- [ ] ZIP files at root level (not in subdirectory)
- [ ] `index.html` exists at root
- [ ] UUID is valid: `/^[a-zA-Z0-9-]{3,}$/`
- [ ] Filename matches pattern: `{uuid}.zip`
- [ ] Upload to correct bucket (production or preview)
- [ ] Test URL: `https://view.scrymore.com/{uuid}/`
- [ ] Verify all assets load correctly

### 📋 Common Commands

```bash
# Create proper ZIP structure
cd my-site && zip -r ../my-site.zip .

# Verify ZIP structure
unzip -l my-site.zip | head -20

# Upload to production
export CLOUDFLARE_API_TOKEN="token"
npx wrangler r2 object put scry-static-sites/my-site.zip --file=my-site.zip

# Test locally
npm run dev:cloudflare
# Then visit: http://localhost:8788/my-site/
```

### 🔗 Important URLs

- **Production domain:** `view.scrymore.com`
- **URL format:** `https://view.scrymore.com/{uuid}/path`
- **R2 dashboard:** `https://dash.cloudflare.com → R2`
- **KV dashboard:** `https://dash.cloudflare.com → Workers → KV`

---

**Document Version:** 1.0  
**Last Updated:** 2025-10-31  
**Maintained by:** Scry View Service Team