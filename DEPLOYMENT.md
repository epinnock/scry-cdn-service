# Cloudflare Deployment Guide

This guide walks you through deploying the Scry CDN Service to Cloudflare Workers with **path-based routing**.

## URL Format

**Path-Based Routing:** `https://view.scrymore.com/{uuid}/path/to/file`

Examples:
- `https://view.scrymore.com/storybook/` → serves index.html from storybook.zip
- `https://view.scrymore.com/abc123/index.html` → serves from abc123.zip
- `https://view.scrymore.com/my-project/assets/style.css` → serves assets/style.css

## Quick Deployment

```bash
# 1. Upload your ZIP to R2 (correctly structured - files at root)
export CLOUDFLARE_API_TOKEN=$(grep CLOUDFLARE_API_TOKEN secrets/cloudflare.login | cut -d'=' -f2)
npx wrangler r2 object put scry-static-sites/storybook.zip --file=storybook-fixed.zip --remote

# 2. Deploy to production
npm run deploy:cloudflare

# 3. Add DNS record (one-time setup)
# In Cloudflare: Type=AAAA, Name=view, IPv6=100::, Proxied=Yes

# 4. Access
https://view.scrymore.com/storybook/
```

## ⚠️ Authentication Troubleshooting

If you see `Unable to authenticate request [code: 10001]`, your API token has issues. **Use interactive login instead:**

```bash
npx wrangler login
```

This opens a browser for OAuth authentication - more reliable than API tokens.

### Why API Tokens Fail
- Token expired
- Insufficient permissions (needs: Workers Edit, R2 Edit, KV Edit, Account Read)
- Invalid token format
- Token revoked

### How to Generate a Valid API Token
If you prefer API tokens:

1. Visit: https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use "Edit Cloudflare Workers" template
4. Add these permissions:
   - Account → Workers Scripts → Edit
   - Account → Account Settings → Read
   - Zone → Workers Routes → Edit
   - Account → Workers KV Storage → Edit
   - Account → R2 → Edit
5. Copy the token
6. Update [`secrets/cloudflare.login`](secrets/cloudflare.login):
   ```bash
   CLOUDFLARE_API_TOKEN=your-new-token-here
   ```

---

## Prerequisites

- Cloudflare account
- Domain configured in Cloudflare
- Node.js 20+ installed
- Project dependencies installed (`npm install`)

## Step 1: Authenticate with Cloudflare

### ✅ Recommended: Interactive Login
```bash
npx wrangler login
```
This opens a browser window for OAuth authentication - most reliable method.

### Alternative: Using Your API Token
If you have a valid token in [`secrets/cloudflare.login`](secrets/cloudflare.login):

```bash
# Export the token from secrets file
source scripts/setup-cloudflare-env.sh

# Verify it's set
npx wrangler whoami
```

If you get authentication errors, use interactive login instead.

## Step 2: Create R2 Buckets

Create the production bucket:
```bash
npx wrangler r2 bucket create scry-static-sites
```

Create the preview/staging bucket:
```bash
npx wrangler r2 bucket create scry-static-sites-preview
```

Verify buckets were created:
```bash
npx wrangler r2 bucket list
```

## Step 3: Create KV Namespaces

Create the production KV namespace:
```bash
npx wrangler kv:namespace create CDN_CACHE
```

This will output something like:
```
{ binding = "CDN_CACHE", id = "abc123..." }
```

**Save the `id` value - you'll need it in Step 4!**

Create the preview KV namespace:
```bash
npx wrangler kv:namespace create CDN_CACHE --preview
```

This will output:
```
{ binding = "CDN_CACHE", preview_id = "xyz789..." }
```

**Save the `preview_id` value - you'll need it in Step 4!**

## Step 4: Update wrangler.toml

Edit `cloudflare/wrangler.toml` and update the KV namespace IDs:

```toml
# Around line 33 - Production KV namespace
[[env.production.kv_namespaces]]
binding = "CDN_CACHE"
id = "YOUR_PRODUCTION_KV_ID_HERE"  # Replace with id from Step 3

# Staging KV namespace (reuse the existing preview namespace)
[[env.staging.kv_namespaces]]
binding = "CDN_CACHE"
id = "YOUR_PREVIEW_KV_ID_HERE"  # Same existing namespace for staging deploys
preview_id = "YOUR_PREVIEW_KV_ID_HERE"  # Replace with preview_id from Step 3
```

Also update your domain in the routes section (around line 24):
```toml
[env.production]
name = "scry-cdn-service"
vars = { PLATFORM = "cloudflare", ENVIRONMENT = "production" }
routes = [
  { pattern = "view-*.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Replace `yourdomain.com` with your actual domain.

## Step 5: Configure DNS

In your Cloudflare dashboard:

1. Go to your domain → DNS
2. Add a wildcard AAAA record:
   - **Type:** AAAA
   - **Name:** `view-*` (or just `*` for all subdomains)
   - **IPv6 address:** `100::`
   - **Proxy status:** Proxied (orange cloud)
   - **TTL:** Auto

This enables `view-{uuid}.yourdomain.com` routing.

## Step 6: Set Secrets (Optional)

If you're using Firebase authentication:

```bash
# Set Firebase service account
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --env production
# Paste your JSON service account when prompted

# Set Firebase API key
npx wrangler secret put FIREBASE_API_KEY --env production
# Paste your API key when prompted
```

## Step 7: Deploy to Production

Deploy to Cloudflare Workers:

```bash
npm run deploy:cloudflare
```

Or manually:
```bash
npx wrangler deploy --env production
```

This will:
1. Build your worker
2. Upload it to Cloudflare
3. Configure routes
4. Bind R2 buckets and KV namespaces

## Step 8: Verify Deployment

Check deployment status:
```bash
npx wrangler deployments list
```

Test the health endpoint:
```bash
curl https://view-test.yourdomain.com/health
```

Expected response:
```json
{
  "status": "healthy",
  "service": "scry-cdn-service",
  "platform": "cloudflare",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

## Step 9: Upload a Test Site

Create a test ZIP:
```bash
# Create test files
mkdir -p test-site
echo "<h1>Hello from Scry CDN</h1>" > test-site/index.html

# Create ZIP
cd test-site && zip -r ../test-abc123.zip . && cd ..
```

Upload to R2:
```bash
npx wrangler r2 object put scry-static-sites/abc123.zip --file=test-abc123.zip
```

Test in browser:
```
https://view-abc123.yourdomain.com
```

## Staging Deployment

To deploy to the staging environment:

```bash
npm run deploy:cloudflare:staging
```

Or:
```bash
cd cloudflare
npx wrangler deploy --env staging
```

## Monitoring

### View Logs
```bash
npx wrangler tail --env production
```

### Analytics
Visit: `https://dash.cloudflare.com` → Workers & Pages → scry-cdn-service

## Troubleshooting

### Error: "Unable to authenticate request"
- Your API token may lack permissions
- Try using `npx wrangler login` instead
- Ensure token has Workers, R2, and KV permissions

### Error: "Bucket not found"
- Verify bucket names match `wrangler.toml`
- Check bucket was created: `npx wrangler r2 bucket list`

### Error: "KV namespace not found"
- Ensure you updated the IDs in `wrangler.toml` (Step 4)
- Verify namespaces exist: `npx wrangler kv:namespace list`

### Files not serving
- Check subdomain format: `view-{uuid}.yourdomain.com`
- Verify ZIP was uploaded to correct path: `{uuid}.zip`
- Check logs: `npx wrangler tail --env production`

### CORS issues
- Update `ALLOWED_ORIGINS` in `wrangler.toml` vars
- Ensure DNS record is proxied (orange cloud)

## Updating the Worker

After making code changes:

1. Test locally:
   ```bash
   npm run dev:cloudflare
   ```

2. Deploy:
   ```bash
   npm run deploy:cloudflare
   ```

3. Verify:
   ```bash
   npx wrangler tail --env production
   ```

## Rollback

If you need to rollback to a previous version:

```bash
# List deployments
npx wrangler deployments list

# Rollback to specific deployment
npx wrangler rollback [deployment-id]
```

## Cost Estimation

Cloudflare Workers pricing (as of 2024):
- **Workers:** $5/month for 10M requests
- **R2 Storage:** $0.015/GB/month
- **R2 Reads:** $0.36 per million Class B operations
- **KV:** $0.50 per million reads

For typical usage (1M requests/month, 10GB storage):
- Workers: ~$0.50
- R2 Storage: ~$0.15
- R2 Reads: ~$0.36
- KV: ~$0.50
- **Total: ~$1.51/month**

## Next Steps

1. ✅ Deploy worker
2. 📤 Integrate with your build service to upload ZIPs
3. 🔗 Update viewer URLs in your application
4. 📊 Monitor performance in Cloudflare dashboard
5. 🔐 Configure rate limiting (optional)
6. 🌍 Add additional domains/routes as needed

## Support

- [Cloudflare Workers Docs](https://developers.cloudflare.com/workers/)
- [R2 Documentation](https://developers.cloudflare.com/r2/)
- [Wrangler CLI Docs](https://developers.cloudflare.com/workers/wrangler/)