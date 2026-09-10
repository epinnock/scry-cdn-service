# Viewer 404 Fix - Production Issue

## Problem Summary

Your Storybook at `my-storybooks-production/design-system/v1.0.0/storybook.zip` is returning 404 in production, but works in local/dev environments.

**Error:**
```
GET /design-system-v1-0-0/index.html
HTTP 404
```

## Root Cause

The production deployment likely doesn't have the latest code changes that support compound UUIDs and the Upload Service bucket integration.

## Solution: Redeploy to Production

### Quick Fix (3 Steps)

1. **Verify your API token exists:**
   ```bash
   cat secrets/cloudflare.login
   ```
   Should contain: `CLOUDFLARE_API_TOKEN=your-token-here`

2. **Deploy to production:**
   ```bash
   npm run deploy:cloudflare
   ```

3. **Test the viewer:**
   ```bash
   curl -I https://view.scrymore.com/design-system-v1-0-0/
   ```
   Should return: `HTTP/2 200`

### Detailed Debugging

Run the debug script for step-by-step guidance:
```bash
./scripts/test-viewer-debug.sh
```

## How It Works

### URL Mapping
Your compound UUID format automatically maps to the Upload Service bucket:

| Component | Value |
|-----------|-------|
| **Viewer URL** | `https://view.scrymore.com/design-system-v1-0-0/` |
| **Compound UUID** | `design-system-v1-0-0` |
| **Resolves to** | `design-system/v1.0.0/storybook.zip` |
| **Bucket** | `my-storybooks-production` |

### Code Flow

1. **Request:** `GET /design-system-v1-0-0/index.html`

2. **UUID Detection:** [`src/utils/path-resolver.ts:37`](src/utils/path-resolver.ts:37)
   - Detects compound UUID pattern (contains `v1`, `v2`, etc.)
   - Returns type: `compound`

3. **Path Resolution:** [`src/utils/path-resolver.ts:104`](src/utils/path-resolver.ts:104)
   - Parses: `design-system-v1-0-0`
   - Converts to: `design-system/v1.0.0/storybook.zip`

4. **Bucket Selection:** [`src/routes/zip-static.ts:30`](src/routes/zip-static.ts:30)
   - Compound UUIDs use: `UPLOAD_BUCKET` (my-storybooks-production)
   - Simple UUIDs use: `STATIC_SITES` (scry-static-sites)

5. **File Extraction:** [`src/routes/zip-static.ts:46`](src/routes/zip-static.ts:46)
   - Reads central directory from ZIP
   - Extracts requested file using range requests
   - Returns file with proper headers

## Verification Checklist

Before deploying, verify:

- [ ] File exists in R2: `my-storybooks-production/design-system/v1.0.0/storybook.zip`
- [ ] ZIP has index.html at root (not in subdirectory)
- [ ] Local dev works: `npm run dev:cloudflare` → `http://localhost:8788/design-system-v1-0-0/`
- [ ] API token is configured in `secrets/cloudflare.login`
- [ ] Wrangler.toml has correct bucket binding for production

## Post-Deployment Testing

### 1. Test Main Page
```bash
curl -v https://view.scrymore.com/design-system-v1-0-0/
```
Expected: 200 OK, Content-Type: text/html

### 2. Test Assets
```bash
curl -I https://view.scrymore.com/design-system-v1-0-0/assets/style.css
```
Expected: 200 OK, Content-Type: text/css

### 3. Monitor Logs
```bash
npx wrangler tail --env production
```
Then make a request and watch for errors

## Common Issues

### Issue: Still getting 404 after deployment

**Cause:** Deployment might not have completed or bucket binding is wrong

**Fix:**
1. Check deployment status:
   ```bash
   cd cloudflare && npx wrangler deployments list --env production
   ```

2. Verify bucket binding in [`cloudflare/wrangler.toml:39`](cloudflare/wrangler.toml:39):
   ```toml
   [[env.production.r2_buckets]]
   binding = "UPLOAD_BUCKET"
   bucket_name = "my-storybooks-production"
   ```

3. Verify file path in R2:
   ```bash
   npx wrangler r2 object get my-storybooks-production/design-system/v1.0.0/storybook.zip \
     --file=/tmp/verify.zip
   ```

### Issue: "Invalid format" error

**Cause:** UUID doesn't match expected pattern

**Fix:** Ensure URL uses dashes in version: `v1-0-0` (not `v1.0.0`)
- Correct: `design-system-v1-0-0`
- Wrong: `design-system-v1.0.0`

### Issue: ZIP file not found

**Cause:** File is at wrong path in R2

**Your case:** File is at `my-storybooks-production/design-system/v1.0.0/storybook.zip` ✅

The code expects exactly this path for compound UUID `design-system-v1-0-0`.

## Why Local/Dev Works but Production Doesn't

Local and dev environments are running the latest code from your workspace, which includes:
- Compound UUID detection
- Upload Service bucket integration
- Proper path resolution

Production is running an older deployment that doesn't have these features.

**Solution:** Deploy the latest code to production.

## Deployment Command Reference

```bash
# Development (staging bucket)
npm run deploy:cloudflare:staging

# Production
npm run deploy:cloudflare

# Check current deployment
cd cloudflare && npx wrangler deployments list --env production

# View logs
npx wrangler tail --env production

# Test locally first
npm run dev:cloudflare
```

## Support

If issues persist after redeployment:

1. Run the debug script: `./scripts/test-viewer-debug.sh`
2. Check Worker logs: `npx wrangler tail --env production`
3. Verify R2 file exists and ZIP structure is correct
4. Review [`src/routes/zip-static.ts`](src/routes/zip-static.ts) for the serving logic

---

**Last Updated:** 2025-10-31  
**Issue:** Production 404 for compound UUID  
**Solution:** Redeploy with latest code