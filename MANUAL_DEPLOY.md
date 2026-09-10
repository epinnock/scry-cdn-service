# Manual Deployment to Cloudflare Workers

## Prerequisites

You need a Cloudflare API token with Workers permissions.

## Option 1: Using Environment Variable (Recommended)

```bash
# 1. Set your API token
export CLOUDFLARE_API_TOKEN="your-cloudflare-api-token-here"

# 2. Navigate to cloudflare directory
cd cloudflare

# 3. Deploy to production
npx wrangler deploy --env production
```

## Option 2: Using wrangler login

```bash
# 1. Login to Cloudflare (opens browser)
npx wrangler login

# 2. Navigate to cloudflare directory
cd cloudflare

# 3. Deploy to production
npx wrangler deploy --env production
```

## Option 3: Load Token from secrets file

If you have your token in `secrets/cloudflare.login`:

```bash
# 1. Load token from file
export CLOUDFLARE_API_TOKEN=$(grep CLOUDFLARE_API_TOKEN secrets/cloudflare.login | cut -d"=" -f2)

# 2. Navigate to cloudflare directory
cd cloudflare

# 3. Deploy to production
npx wrangler deploy --env production
```

## Verify Deployment

After deploying:

```bash
# Check deployment status
npx wrangler deployments list --env production

# View recent logs (real-time)
npx wrangler tail --env production

# You'll also get a preview URL after deployment
# Example: https://scry-cdn-service.your-subdomain.workers.dev
```

## Test the Viewer

### Production URL
```bash
# Test your Storybook
curl -I https://view.scrymore.com/design-system-v1-0-0/

# Full response
curl -v https://view.scrymore.com/design-system-v1-0-0/
```

### Preview URL (from deployment output)
```bash
# Use the preview URL from deployment output
curl -I https://scry-cdn-service.your-subdomain.workers.dev/design-system-v1-0-0/
```

### With Real-time Logging
```bash
# In one terminal, watch logs
npx wrangler tail --env production

# In another terminal, make requests
curl https://view.scrymore.com/design-system-v1-0-0/
```

## Deploy to Staging

```bash
cd cloudflare
npx wrangler deploy --env staging
```

## Troubleshooting

### Error: "Not authenticated"
- Option A: Run `npx wrangler login`
- Option B: Set `CLOUDFLARE_API_TOKEN` environment variable

### Error: "No such bucket"
- Verify bucket exists in Cloudflare dashboard
- Check `wrangler.toml` has correct bucket names

### Error: "Insufficient permissions"
- Verify API token has Workers:Edit and R2:Read permissions
- Create new token at: https://dash.cloudflare.com/profile/api-tokens