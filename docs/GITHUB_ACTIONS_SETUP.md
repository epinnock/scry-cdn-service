# GitHub Actions Deployment Setup

This guide explains how to configure GitHub Actions for automated Cloudflare Workers deployment.

## Required GitHub Secrets

You need to configure the following secrets in your GitHub repository:

### 1. CLOUDFLARE_API_TOKEN

A Cloudflare API token with the following permissions:
- **Account → Workers Scripts → Edit**
- **Account → Account Settings → Read**
- **Zone → Workers Routes → Edit**
- **Account → Workers KV Storage → Edit**
- **Account → R2 → Edit**

**How to create:**
1. Go to https://dash.cloudflare.com/profile/api-tokens
2. Click "Create Token"
3. Use the "Edit Cloudflare Workers" template
4. Add the additional permissions listed above
5. Copy the generated token

### 2. CLOUDFLARE_ACCOUNT_ID

Your Cloudflare account ID.

**How to find:**
1. Go to https://dash.cloudflare.com
2. Select your account
3. The account ID is in the URL: `https://dash.cloudflare.com/{account_id}/...`
4. Or find it in the right sidebar of any zone's overview page

The account ID for this project is: `f54b9c10de9d140756dbf449aa124f1e`

## Repository Secrets vs Environment Secrets

GitHub offers two places to store secrets:

### Repository Secrets (Recommended for this project)
- **Location**: Settings → Secrets and variables → Actions → Repository secrets
- **Scope**: Available to all workflows in the repository
- **Use when**: Secret is the same across all environments (staging, production)

### Environment Secrets
- **Location**: Settings → Environments → [env name] → Environment secrets
- **Scope**: Only available when workflow runs in that specific environment
- **Use when**: Secret values differ between environments

**Rule of thumb:**
- Use **Repository Secrets** when the value is the same everywhere (like `CLOUDFLARE_ACCOUNT_ID`)
- Use **Environment Secrets** when values differ per environment (like different API keys for staging vs production)

For this project, use **Repository Secrets** for both:
- `CLOUDFLARE_API_TOKEN` - Same token deploys to both staging and production
- `CLOUDFLARE_ACCOUNT_ID` - Same account for all environments

## Wrangler Secrets (Runtime Secrets in Cloudflare)

These are **completely different** from GitHub secrets. Wrangler secrets are:
- Stored in Cloudflare's infrastructure (not GitHub)
- Available to your worker code at runtime
- Set using the Wrangler CLI, not the GitHub UI
- **Optional** for this CDN service

### Firebase Authentication (Optional)

If you want to enable Firebase authentication for protected routes:

```bash
# Set Firebase service account JSON
npx wrangler secret put FIREBASE_SERVICE_ACCOUNT --env production
# Paste your Firebase service account JSON when prompted

# Set Firebase API key
npx wrangler secret put FIREBASE_API_KEY --env production
# Paste your Firebase API key when prompted
```

### How to Set Wrangler Secrets

Wrangler secrets are encrypted and stored in Cloudflare, not in your repository. Set them using the Wrangler CLI:

```bash
# For production environment
npx wrangler secret put SECRET_NAME --env production

# For staging environment
npx wrangler secret put SECRET_NAME --env staging

# List existing secrets
npx wrangler secret list --env production
```

### Summary of All Secrets

| Secret | Where to Set | Required | When Used |
|--------|--------------|----------|-----------|
| `CLOUDFLARE_API_TOKEN` | GitHub Repository Secrets | ✅ Yes | During deployment (GitHub Actions) |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Repository Secrets | ✅ Yes | During deployment (GitHub Actions) |
| `FIREBASE_SERVICE_ACCOUNT` | Wrangler Secrets (Cloudflare) | ❌ No | At runtime (worker code) |
| `FIREBASE_API_KEY` | Wrangler Secrets (Cloudflare) | ❌ No | At runtime (worker code) |

## Setting Up Secrets in GitHub

1. Go to your GitHub repository
2. Navigate to **Settings** → **Secrets and variables** → **Actions**
3. Click **New repository secret**
4. Add each secret:

| Secret Name | Value |
|-------------|-------|
| `CLOUDFLARE_API_TOKEN` | Your Cloudflare API token |
| `CLOUDFLARE_ACCOUNT_ID` | `f54b9c10de9d140756dbf449aa124f1e` |

## GitHub Environments

The workflow records deployments under `staging` and `production`, each with its
service URL. Configure branch policies in Settings → Environments to allow
`stage` for staging and `main` for production. A manual run uses the selected
branch, so that branch must be allowed by the target environment's policy.

## Workflow Triggers

The single deployment workflow is `.github/workflows/deploy.yml`:

| Trigger | Action |
|---------|--------|
| Pull request (including feature PRs into `stage`) | Tests + typecheck only; never deploys |
| Push to `stage` | Tests + typecheck → deploy to **staging** → verify commit |
| Push to `main` | Tests + typecheck → deploy to **production** → verify commit |
| Manual workflow dispatch | Tests + typecheck → deploy to selected environment → verify commit |

Pushes changing only `**/*.md` or `docs/**` are ignored using `paths-ignore`.
Use these path filters for documentation changes; omit skip directives from
commit messages so code changes run CI. CI uses Node 22, pnpm 9, a frozen
lockfile, and Wrangler 4.99.0. Deployments retain the Phase 0 commit/build stamp
and serialize by Git ref (`deploy-${{ github.ref }}`, cancellation disabled).

## After the Phase 1 Merge

1. Create the remote `stage` branch from the merged `main`. Feature PRs then
   target `stage`; promotion fast-forwards `main` to the tested `stage` commit.
2. Confirm GitHub environments `staging` and `production` allow their respective
   branches. If `development` had environment-specific secrets or settings,
   carry those settings over to `staging` in the console.
3. Keep the existing repository secrets `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`; no new runtime secrets or cloud resources are needed
   for this rename. The worker stays `scry-cdn-service-dev`, retaining its secrets,
   buckets, Firebase project and existing preview KV namespace. The staging KV
   `id` now matches `preview_id`; local preview use retains `preview_id`.
4. Rename any local secrets file for the former environment to `.secrets.staging.json`
   before using your bulk-secret tooling. Such local files are not changed by
   this migration.
5. Resolve the pre-existing `UUIDResolution.project` type error in `src/app.ts`
   separately before expecting a green deployment run: typecheck is a required
   gate, so this error currently prevents either environment from deploying.

No DNS or Worker console change is required for the existing workers.dev URL.
A custom staging domain is optional and outside this phase.

## Manual Deployment

In GitHub Actions, select "Deploy CDN Service to Cloudflare", click **Run
workflow**, choose the branch and `staging` or `production`, then run it.
For a stamped CLI deploy from the repository root, use:

```bash
pnpm run deploy:cloudflare:staging
pnpm run deploy:cloudflare
```

When using Wrangler directly, run it from `cloudflare/` (or pass
`--config cloudflare/wrangler.toml`). Use `--env staging` for the staging worker.

## Verifying Deployment

CI requires `/healthz` to report the exact deployed Git SHA. It retries up to
six times with ten seconds between attempts and fails if none match.

```bash
# Production
curl -fsS https://view.scrymore.com/healthz

# Staging (worker name and URL are unchanged)
curl -fsS https://scry-cdn-service-dev.epinnock.workers.dev/healthz
```

Check the `commit` field against the workflow SHA and `env` against `staging`
or `production`. The response also includes `branch`, `builtAt`, `deployId`
and `actor` from the Phase 0 stamp.

## Troubleshooting

### Authentication Errors

If you see `Unable to authenticate request [code: 10001]`:
- Verify the API token is correct
- Check token permissions include all required scopes
- Ensure the token hasn't expired

### Deployment Failures

1. Check the GitHub Actions logs for detailed error messages
2. Verify wrangler.toml configuration is correct
3. Ensure R2 buckets and KV namespaces exist

### Missing Secrets

If the workflow fails with "secret not found":
1. Verify secret names match exactly (case-sensitive)
2. Check secrets are set at repository level, not environment level (unless using environments)

## Workflow File Location

The workflow is defined in:
```
.github/workflows/deploy.yml
```

## Related Documentation

- [Cloudflare Wrangler Action](https://github.com/cloudflare/wrangler-action)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [GitHub Actions Documentation](https://docs.github.com/en/actions)
