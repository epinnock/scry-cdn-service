# Partial ZIP Extraction – Implementation Plan

## Purpose

Deliver a production-ready capability to serve static Storybook builds directly from ZIP archives stored in Cloudflare R2 while leveraging KV-backed metadata caching. The plan enumerates implementation scope, architectural components, testing approach, observability, and rollout safeguards now that development is complete.

## Business Outcomes

- Sub-50 ms p95 responses for cached paths by eliminating full-ZIP downloads.
- Storage footprint limited to original ZIP assets (no extracted replicas).
- Operational cost under $1/month for 265K monthly requests.
- Safe-by-default static file delivery with path sanitization and SPA fallbacks.

## Functional Requirements

1. Serve assets from `{uuid}.zip` stored in R2 using HTTP range requests.
2. Cache ZIP central-directory metadata in KV with a configurable TTL.
3. Resolve subdomain-based project routing (`view-{uuid}.domain.com`).
4. Apply correct cache-control, MIME detection, and SPA fallback behavior.
5. Provide metrics hooks for extraction and caching operations.
6. Enforce path safety (no traversal, null bytes, or malformed requests).

## Non-Goals

- ZIP upload management (handled upstream).
- Pre-extraction or persistent unzipped storage.
- Streaming large binary responses beyond R2 range reads.
- Advanced rate limiting or analytics (left for future enhancements).

## Architecture Overview

```
Client → Hono Router → ZIP Static Route → Central Directory Service
                                  │
                                  └── Range Reader → R2 Bucket
                                         │
                                         └── KV Cache (metadata)
```

### Key Components

- [`src/adapters/zip/r2-range-reader.ts`](../src/adapters/zip/r2-range-reader.ts): Thin adapter exposing `getLength()` and `read()` for `unzipit` backed by R2 range requests.
- [`src/services/zip/central-directory.ts`](../src/services/zip/central-directory.ts): Retrieves and caches central-directory data, handling KV fallbacks and serialization.
- [`src/services/zip/extractor.ts`](../src/services/zip/extractor.ts): Fetches compressed byte ranges per file, supports stored and deflate entries, and surfaces decompression errors.
- [`src/utils/zip-utils.ts`](../src/utils/zip-utils.ts): Normalizes/sanitizes paths, drives SPA fallbacks, and selects cache-control headers.
- [`src/routes/zip-static.ts`](../src/routes/zip-static.ts): Hono route wiring subdomain resolution, path validation, MIME detection, and response composition.
- [`src/app.ts`](../src/app.ts): Registers ZIP route with the primary Worker application.

## Data & Control Flow

1. Parse subdomain to resolve `zipKey`.
2. Normalize request path, expand fallback candidates, and sanitize.
3. Fetch cached central directory from KV; on miss, hydrate via R2 range reader + `unzipit`, then cache.
4. Select the first matching entry across fallback paths; return 404 if none.
5. Use extractor to issue R2 byte-range fetch, decompress if needed, and return buffered content.
6. Apply cache-control, CORS, and SPA fallback headers.

## Configuration & Secrets

| Variable | Purpose | Default |
| --- | --- | --- |
| `ZIP_EXTRACTION_ENABLED` | Feature flag toggle | `true` |
| `ZIP_CACHE_TTL` | KV metadata TTL (seconds) | `86400` |
| `ZIP_MAX_FILE_SIZE` | Safety guard for large entries | `10485760` |
| `CACHE_CONTROL` | Default cache header | `public, max-age=31536000, immutable` |
| `ALLOWED_ORIGINS` | CORS allowlist | `*` |

Wrangler bindings must include the `CDN_CACHE` KV namespace and R2 bucket reference (see [`cloudflare/wrangler.toml`](../cloudflare/wrangler.toml)).

## Error Handling & Observability

- KV read/write failures logged as warnings; R2 fallback continues.
- R2 misses or corrupt entries emit descriptive errors consumed by Hono error middleware.
- Extraction metrics emitted via `ZipExtractionMetrics` structure (future hook).
- Console logs reserved for recoverable scenarios to aid debugging in Workers.

## Testing Strategy

### Unit Tests (Vitest)

- [`tests/zip/central-directory.test.ts`](../tests/zip/central-directory.test.ts): KV caching, R2 hydration path, and cache invalidation.
- [`tests/zip/extractor.test.ts`](../tests/zip/extractor.test.ts): Stored vs deflate extraction, failure propagation, multi-file traversal.
- [`tests/zip/r2-range-reader.test.ts`](../tests/zip/r2-range-reader.test.ts): Range head caching and error handling.
- [`tests/zip/zip-utils.test.ts`](../tests/zip/zip-utils.test.ts): Path normalization, sanitization, cache-control rules.

### Integration (Future Work)

- Replay recorded Worker requests against fixture ZIPs.
- Validate SPA fallback behavior with full route pipeline in a Miniflare harness.

### Manual Verification

1. Upload representative ZIPs (HTML/CSS/JS mix plus assets) to staging bucket.
2. Hit `view-{uuid}.staging-domain` for direct assets, nested routes, and 404 paths.
3. Confirm cache-control headers with `curl -I`.
4. Inspect Cloudflare dashboard for R2 range calls and KV hit rate.

## Deployment Plan

1. **Prerequisites**  
   - Provision KV namespace and bind as `CDN_CACHE`.  
   - Configure R2 bucket binding in Wrangler.  
   - Validate environment variables in Worker secrets.

2. **Build & Publish**  
   - `npm run build:cloudflare` to create `dist/worker.js`.  
   - Deploy to staging via `npm run deploy:cloudflare:staging`.
   - Promote to production with `npm run deploy:cloudflare` after smoke tests.

3. **Rollout Monitoring**  
   - Track KV hit ratio and R2 latency.  
  - Capture error logs for ZIP extraction failures.  
   - Observe response times via Cloudflare Analytics dashboard.

## Risk Register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Corrupt ZIP central directory | High | Validate offsets via `unzipit`; clear cache automatically on failure. |
| Large file extraction (memory) | Medium | Enforce `ZIP_MAX_FILE_SIZE`; stream future enhancements. |
| KV unavailability | Low | Graceful fallback to direct R2 reads with logging. |
| MIME misclassification | Medium | Maintain extension map in [`src/utils/mime-types.ts`](../src/utils/mime-types.ts). |

## Future Enhancements

- Predictive caching for `index.html` and hashed bundles.
- Brotli negotiation with client `Accept-Encoding`.
- Multi-region KV replication to reduce cold latency.
- Detailed telemetry (dimensions: zipKey, cache hit, compression method).
- Request-level rate limiting per subdomain.

---

**Status:** Implementation delivered per this plan and validated by the accompanying unit test suite. Ongoing work focuses on operational hardening and progressive enhancements enumerated above.