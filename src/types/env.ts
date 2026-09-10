// Environment types for both Cloudflare Workers and Docker

export interface Env {
  // Public deployment metadata (never secrets)
  SCRY_ENV?: "staging" | "production" | "dev";
  SCRY_COMMIT?: string;
  SCRY_BRANCH?: string;
  SCRY_BUILD_TIME?: string;
  SCRY_DEPLOY_ID?: string;
  SCRY_ACTOR?: string;

  // Cloudflare Workers bindings
  STATIC_SITES?: R2Bucket;
  UPLOAD_BUCKET?: R2Bucket; // NEW: Upload Service bucket
  CDN_CACHE?: KVNamespace;

  // Common environment variables
  PLATFORM?: "cloudflare" | "docker";
  FIREBASE_PROJECT_ID?: string;
  FIREBASE_SERVICE_ACCOUNT?: string;
  FIREBASE_API_KEY?: string;

  // Service account auth for Firestore (Option B)
  FIREBASE_CLIENT_EMAIL?: string;
  FIREBASE_PRIVATE_KEY?: string;

  /**
   * HMAC secret shared with the dashboard for signed preview tokens
   * (docs/PRIVATE_PREVIEW_SIGNED_COOKIES.md). Unset = the feature is off and
   * `?scry_preview` is rejected. `_PREVIOUS` is accepted during a rotation.
   */
  PREVIEW_TOKEN_SECRET?: string;
  PREVIEW_TOKEN_SECRET_PREVIOUS?: string;

  // Docker/R2 specific
  STORAGE_TYPE?: "r2" | "filesystem";
  STORAGE_PATH?: string;
  R2_BUCKET?: string;
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;

  // Cache
  REDIS_URL?: string;
  CACHE_TTL?: string;

  // Server
  PORT?: string;
  NODE_ENV?: "development" | "production" | "test";
  LOG_LEVEL?: "debug" | "info" | "warn" | "error";

  // CDN
  /** Legacy / general allow-origin configuration (use '*' or a comma-separated list) */
  ALLOWED_ORIGINS?: string;
  /** Preferred CORS allowlist (comma-separated list) */
  CORS_ALLOWED_ORIGINS?: string;
  /** Force wildcard mode even if allowlist contains matches */
  CORS_FORCE_WILDCARD?: string;

  MAX_FILE_SIZE?: string;
  CACHE_CONTROL?: string;
  BASE_DOMAIN?: string;
  SUBDOMAIN_PATTERN?: string;

  // ZIP Extraction Configuration
  ZIP_EXTRACTION_ENABLED?: string;
  ZIP_CACHE_TTL?: string;
  ZIP_MAX_FILE_SIZE?: string;
}

export interface CloudflareEnv extends Env {
  STATIC_SITES: R2Bucket;
  UPLOAD_BUCKET: R2Bucket; // NEW: Upload Service bucket (required in Cloudflare)
  CDN_CACHE: KVNamespace;
  FIREBASE_PROJECT_ID: string;
  PLATFORM: "cloudflare";
}

export interface DockerEnv extends Env {
  PLATFORM: "docker";
  STORAGE_TYPE: "r2" | "filesystem";
}
