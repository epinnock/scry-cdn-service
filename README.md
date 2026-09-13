# Scry CDN Service

A production-ready CDN service built with [Hono](https://hono.dev/) for serving static Storybook builds and other static sites directly from Cloudflare R2 (or filesystem storage) using subdomain-based routing and partial ZIP extraction.

## Features

✅ **Partial ZIP Extraction**
- Fetch only required byte ranges from `{uuid}.zip`
- Cache central directory metadata in Cloudflare KV (24 hr TTL), validated against the current R2 ETag on every request
- Supports stored and deflate-compressed entries via `pako`

✅ **Multi-Platform Support**
- Cloudflare Workers with R2 storage
- Docker/Node.js with R2 or filesystem storage
- Shared TypeScript codebase across platforms

✅ **CDN Capabilities**
- Subdomain routing (`view-{uuid}.domain.com`)
- SPA fallbacks with smart path resolution
- Automatic MIME type detection and cache headers
- CORS support and custom cache policies
- Edge-optimized responses

✅ **Developer Experience**
- TypeScript throughout
- Dedicated ZIP utilities and services
- Comprehensive Vitest unit suite
- Hot reload for local development

### Redeploying the same version

ZIP paths such as `{project}/main/storybook.zip` can be overwritten. Before
reusing `cd:<zipKey>`, the viewer reads R2 metadata and compares its ETag with
the cached directory's ETag. Missing or mismatched identities trigger a fresh
parse, including for legacy cache entries. No upload-side cache purge is needed;
the 24-hour TTL controls retention, not freshness. This adds one R2 HEAD per ZIP
asset request (also reused for the archive size on a cache miss).

Directory and file range reads use R2 `onlyIf.etagMatches` to avoid combining
offsets and bytes from different archives. An overwrite during a request can
fail that request with 500; the next request reads the new archive. KV read or
write failures fall back to R2. Browser cache policies are unchanged.

## Architecture

```
scry-cdn-service/
├── src/
│   ├── adapters/
│   │   ├── storage/              # R2 / filesystem backends
│   │   └── zip/                  # R2 range reader for unzipit
│   ├── services/
│   │   └── zip/                  # Central directory + extraction logic
│   ├── routes/                   # Route handlers (zip-static, health, etc.)
│   ├── utils/                    # Shared helpers (zip-utils, mime-types)
│   └── types/                    # Shared TypeScript types
├── docs/                         # Architecture & implementation docs
│   ├── PARTIAL_ZIP_ARCHITECTURE.md
│   ├── IMPLEMENTATION_PLAN.md
│   └── IMPLEMENTATION_SUMMARY.md
├── cloudflare/                   # Cloudflare Worker entrypoint + config
├── docker/                       # Node server & local docker assets
└── package.json
```

## Getting Started

### Prerequisites

- Node.js 20+
- npm or pnpm
- Docker (for Docker deployment)
- Cloudflare account with Workers & R2 (for Cloudflare deployment)

### Installation

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env

# Edit .env with your configuration
```

### Development

#### Cloudflare Workers

```bash
# Option 1: Run from cloudflare directory (recommended for full wrangler features)
cd cloudflare
npx wrangler dev --remote

# Option 2: Run from project root (using npm script)
npm run dev:cloudflare

# Option 3: Run from project root directly with wrangler
npm run dev:cloudflare:local

# The service will be available at http://localhost:8787
```

**Note:** If you encounter "Missing entry-point" errors on different machines, ensure you're either:
- Running from the `cloudflare/` directory, OR
- Using `npm run dev:cloudflare` or `npm run dev:cloudflare:local` from the project root

#### Docker/Node.js

```bash
# Run with Docker Compose
npm run docker:run

# Or run directly with tsx
npm run dev:docker

# The service will be available at http://localhost:3000
```

## Deployment

Feature branches open PRs into `stage`. The single [deployment workflow](.github/workflows/deploy.yml)
runs tests and typecheck on PRs, deploys pushes to `stage` to staging, and deploys
pushes to `main` to production. Manual runs choose `staging` or `production`.
Documentation-only pushes are filtered with `paths-ignore`. CI uses Node 22 and
Wrangler 4.99.0 and verifies the deployed commit at `/healthz`.

| Environment | Worker | Health URL | Manual script |
|-------------|--------|------------|---------------|
| staging | `scry-cdn-service-dev` | https://scry-cdn-service-dev.epinnock.workers.dev/healthz | `pnpm run deploy:cloudflare:staging` |
| production | `scry-cdn-service` | https://view.scrymore.com/healthz | `pnpm run deploy:cloudflare` |

The Wrangler environment key is `staging`; the existing dev worker name and
resources stay unchanged. Local bulk-secret files use `.secrets.staging.json`
and `.secrets.production.json`. See [CI setup and post-merge steps](docs/GITHUB_ACTIONS_SETUP.md).

### Cloudflare Workers

1. **Create R2 bucket:**
```bash
wrangler r2 bucket create scry-static-sites
```

2. **Create KV namespace:**
```bash
wrangler kv:namespace create CDN_CACHE
wrangler kv:namespace create CDN_CACHE --preview
```

3. **Update `wrangler.toml` with KV IDs**

4. **Set secrets:**
```bash
wrangler secret put FIREBASE_SERVICE_ACCOUNT
wrangler secret put FIREBASE_API_KEY
```

5. **Deploy:**
```bash
npm run deploy:cloudflare
```

### Docker

1. **Build image:**
```bash
npm run docker:build
```

2. **Run container:**
```bash
docker run -d \
  -p 3000:3000 \
  -e STORAGE_PATH=/data \
  -e FIREBASE_SERVICE_ACCOUNT="$(cat service-account.json)" \
  -v /var/data/static-sites:/data \
  scry-cdn-service:latest
```

Or use Docker Compose:
```bash
docker-compose -f docker/docker-compose.yml up -d
```

## Configuration

### Environment Variables

```bash
# Platform
PLATFORM=cloudflare          # cloudflare | docker

# Firebase
FIREBASE_PROJECT_ID=your-project-id
FIREBASE_SERVICE_ACCOUNT={}  # JSON service account

# Storage (Docker only)
STORAGE_TYPE=filesystem      # filesystem | r2
STORAGE_PATH=/data/static-sites

# R2 (if using R2 with Docker)
R2_BUCKET=bucket-name
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=key
R2_SECRET_ACCESS_KEY=secret

# ZIP extraction
ZIP_EXTRACTION_ENABLED=true
ZIP_CACHE_TTL=86400
ZIP_MAX_FILE_SIZE=10485760

# CDN
CACHE_CONTROL=public, max-age=31536000, immutable

# CORS
# - If CORS_ALLOWED_ORIGINS is set, it is used as the allowlist (comma-separated).
# - Otherwise, ALLOWED_ORIGINS is used (legacy).
# - If either is set to "*", responses will use wildcard mode.
CORS_ALLOWED_ORIGINS=https://dashboard.scrymore.com,https://www.scrymore.com,http://localhost:3000,http://localhost:3001
CORS_FORCE_WILDCARD=false
ALLOWED_ORIGINS=*
```

### DNS Configuration

Add a wildcard DNS record:
- **Type:** AAAA
- **Name:** `*` or `view-*`
- **Content:** `100::`
- **Proxy:** Enabled (for Cloudflare)

### Worker Routes (Cloudflare)

Configure in `wrangler.toml`:
```toml
routes = [
  { pattern = "view-*.mysite.com/*", zone_name = "mysite.com" }
]
```

## Usage

### Upload Static Site

Upload each build as a single ZIP archive stored at:

```
static-sites/{project-uuid}.zip
```

- Place `index.html`, assets, and other files at their desired paths inside the archive.
- Central directory metadata is cached in KV (`cd:{project-uuid}.zip`) for 24 hours to accelerate repeat requests.
- Re-uploading a ZIP refreshes metadata automatically after TTL expiry; call [`clearCentralDirectoryCache()`](src/services/zip/central-directory.ts) to force an immediate refresh after replacing an archive.

### Access Site

Visit: `https://view-{project-uuid}.mysite.com`

The CDN will:
1. Parse `{project-uuid}` from the subdomain.
2. Load the ZIP central directory from KV (or hydrate from R2 using partial range reads).
3. Locate the requested entry, fetch only the necessary compressed bytes, decompress if required, and respond with the correct headers.

## API Endpoints

### Health Check
```bash
GET /health
```

Response:
```json
{
  "status": "healthy",
  "service": "scry-cdn-service",
  "platform": "cloudflare",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

### Static Files
```bash
GET /{any-path}
```

Serves files from storage based on subdomain UUID.

### Coverage Reports
Coverage report JSON files are served **alongside** Storybook builds, but are stored as **standalone objects** in R2:

```
{projectId}/{versionId}/coverage-report.json
```

They are accessible via:

```bash
GET /{projectId}/{versionId}/coverage-report.json
```

Example:

```bash
curl -H "Origin: https://dashboard.scrymore.com" \
  https://view.scrymore.com/test-project/v1.0.0/coverage-report.json
```

Expected headers:
- `Content-Type: application/json`
- `Cache-Control: public, max-age=31536000, immutable` (production)
- `Access-Control-Allow-Origin: *` or a reflected dashboard origin

## Storage Adapters

### R2 (Cloudflare)

- Primary deployment path.
- Archives live at `static-sites/{uuid}.zip` within the bound R2 bucket.
- Partial extraction powered by [`R2RangeReader`](src/adapters/zip/r2-range-reader.ts) and [`unzipit`](https://github.com/greggman/unzipit).

### Filesystem (Docker)

```bash
STORAGE_TYPE=filesystem
STORAGE_PATH=/data/static-sites
```

- Designed for local development parity.
- Serve pre-extracted directories that mimic the ZIP contents.

### R2 (Docker)

When running the Node/Docker runtime against R2:

```bash
STORAGE_TYPE=r2
R2_BUCKET=your-bucket-name
R2_ACCOUNT_ID=your-cloudflare-account-id
R2_ACCESS_KEY_ID=your-access-key
R2_SECRET_ACCESS_KEY=your-secret-key
```

- Enables testing the partial ZIP flow outside Workers.
- Shares the same ZIP extraction services used in production.

## Testing

### Unit Tests

```bash
# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Type checking
npm run typecheck
```

### Testing Subdomain Routing Locally

The service extracts the UUID from subdomains like `view-{uuid}.domain.com`. To test this locally:

#### Option 1: Using curl with Host Header

```bash
# Start local development server
npm run dev:cloudflare  # Port 8787
# OR
npm run dev:docker      # Port 3000

# Test with curl (replace {uuid} with your test UUID)
curl -H "Host: view-abc123.localhost:8787" http://localhost:8787/index.html

# For Docker:
curl -H "Host: view-abc123.localhost:3000" http://localhost:3000/index.html
```

#### Option 2: Using /etc/hosts

1. Add entries to `/etc/hosts`:
```bash
127.0.0.1 view-abc123.localhost
127.0.0.1 view-test-uuid.localhost
```

2. Access in browser:
- Cloudflare Workers: `http://view-abc123.localhost:8787`
- Docker: `http://view-test-uuid.localhost:3000`

#### Option 3: Testing ZIP Extraction Flow

```bash
# 1. Create a test ZIP with sample files
mkdir -p test-site
echo "<h1>Test Site</h1>" > test-site/index.html
zip -r abc123.zip test-site/*

# 2. Upload to your local R2/storage
# For Cloudflare Workers with wrangler dev:
wrangler r2 object put STATIC_SITES/abc123.zip --file=abc123.zip

# 3. Test the extraction
curl -H "Host: view-abc123.localhost:8787" http://localhost:8787/index.html
```

#### Verification Checklist

- [ ] Subdomain parsing extracts correct UUID
- [ ] ZIP central directory loads from KV/R2
- [ ] Files extract with proper MIME types
- [ ] SPA fallback works (e.g., `/about` → `/about/index.html`)
- [ ] 404 handling for missing files
- [ ] Cache headers applied correctly

## Building

```bash
# Build for Cloudflare
npm run build:cloudflare

# Build for Docker
npm run build:docker

# Build all
npm run build
```

## Integration with Build Service

Update your build service to generate viewer URLs:

```typescript
// lib/services/build.service.ts
async createBuild(projectId: string, userId: string, data: CreateBuildData) {
  // ... existing logic ...
  
  const buildData = {
    projectId,
    versionId: data.versionId,
    buildNumber,
    zipUrl: data.zipUrl,
    viewerUrl: `https://view-${projectId}.mysite.com`, // NEW!
    status: 'active',
    createdAt: FieldValue.serverTimestamp(),
    createdBy: userId,
  };
  
  // ... rest of logic
}
```

## Performance

- **Cache miss (first request):** ~62 ms end-to-end (central directory hydration + range read).
- **Cache hit:** ~31 ms (metadata served from KV with a single range request).
- **Data transfer:** ~50× less than downloading the full ZIP, reducing egress costs.

## Monitoring

### Cloudflare
- `wrangler tail` to observe extraction logs and KV fallback warnings.
- Cloudflare Dashboard → Workers → Analytics for R2 latency, KV hit rate, and cache effectiveness.

### Docker
- Standard logging to stdout/stderr (includes extraction failures).
- Health check endpoint: `/health`

## Security

- CORS configured per environment
- Public projects are served without authentication
- Files isolated by UUID namespace
- Optional rate limiting (add middleware)

### Private projects

`privateProjectAuth` (`src/middleware/auth.ts`) looks the project up in
Firestore (`visibility`, `memberIds`; cached in KV) and, for a private one,
accepts any of three credentials:

| Credential | Who sends it | Checked by |
|---|---|---|
| `__session` cookie (Firebase session) | Dashboard users in the browser | Google's public keys, then membership |
| `Authorization: Bearer scry_pat_…` (Scry PAT) | The Figma plugin's API calls | `users/{uid}/personalAccessTokens` by hash, then membership |
| `?scry_preview=<token>` → `__scry_preview` cookie | The plugin's preview `<iframe>` | HMAC with `PREVIEW_TOKEN_SECRET`, project + expiry — no Firestore call |

The preview token is minted by the dashboard (`POST /api/projects/:id/preview-token`,
membership checked there, ≤ 10 minutes). On the first navigation the CDN
exchanges it for a `Partitioned; SameSite=None; Path=/<projectId>/` cookie and
302s to the same URL without the parameter; every later asset request carries
the cookie. Set `PREVIEW_TOKEN_SECRET` (and, while rotating,
`PREVIEW_TOKEN_SECRET_PREVIOUS`) with `wrangler secret put` — without it the
parameter is rejected. Design and browser caveats:
[docs/PRIVATE_PREVIEW_SIGNED_COOKIES.md](docs/PRIVATE_PREVIEW_SIGNED_COOKIES.md).

## Troubleshooting

### Files not found
1. Check storage key format: `{uuid}/{path}`
2. Verify UUID extraction from subdomain
3. Check storage adapter configuration

### CORS errors
1. Verify `CORS_ALLOWED_ORIGINS` / `ALLOWED_ORIGINS` configuration
2. Check DNS/routing configuration
3. Ensure CORS middleware is active (see [`corsHeaders()`](src/middleware/cors.ts:1))

### Performance issues
1. Enable compression middleware
2. Set appropriate cache headers
3. Use CDN edge locations (Cloudflare)

## License

MIT

## Contributing

1. Fork the repository
2. Create your feature branch
3. Commit your changes
4. Push to the branch
5. Create a Pull Request

## Support

For issues and questions:
- GitHub Issues: [repo/issues]
- Documentation:
  - [`docs/PARTIAL_ZIP_ARCHITECTURE.md`](docs/PARTIAL_ZIP_ARCHITECTURE.md)
  - [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md)
  - [`docs/IMPLEMENTATION_SUMMARY.md`](docs/IMPLEMENTATION_SUMMARY.md)
