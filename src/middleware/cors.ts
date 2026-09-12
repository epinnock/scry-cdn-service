/**
 * CORS middleware utilities.
 *
 * The dashboard fetches public artifacts (e.g. coverage reports) from the CDN.
 * CORS is therefore a blocking dependency for dashboard integration.
 *
 * Design goals:
 * - Allow known dashboard origins explicitly (reflect Origin)
 * - Support credentials (cookies) for private project authentication
 * - Otherwise allow public access (wildcard '*')
 * - Provide correct preflight (OPTIONS) responses
 *
 * IMPORTANT: When credentials are used (Access-Control-Allow-Credentials: true),
 * the browser requires Access-Control-Allow-Origin to be a specific origin,
 * NOT a wildcard '*'. We reflect the origin for whitelisted domains.
 *
 * ENVIRONMENT-SPECIFIC CORS:
 * - Production: Set CORS_ALLOWED_ORIGINS secret to restrict to production origins only
 * - Staging: Set CORS_ALLOWED_ORIGINS secret to include staging + production origins
 * - Local dev: Uses DEFAULT_ALLOWED_ORIGINS below (includes all origins for convenience)
 *
 * To set secrets:
 *   wrangler secret put CORS_ALLOWED_ORIGINS --env production
 *   # Enter: https://dashboard.scrymore.com,https://www.scrymore.com
 */

/**
 * Default allowed origins used when CORS_ALLOWED_ORIGINS env var is not set.
 * This is the fallback for local development.
 * For production/staging, set CORS_ALLOWED_ORIGINS as a Cloudflare secret.
 */
export const DEFAULT_ALLOWED_ORIGINS = [
  // Production origins
  "https://dashboard.scrymore.com",
  "https://www.scrymore.com",
  // Staging/dev origins
  "https://dev-dashboard.ejiro.world",
  // Local development origins
  "http://localhost:3000",
  "http://localhost:3004",
] as const;

export interface CorsConfig {
  /**
   * Allowlist of origins that should be reflected back (sets Vary: Origin).
   * If the request origin is not in this list, we fall back to '*'.
   */
  allowedOrigins?: readonly string[];

  /**
   * If true, always respond with Access-Control-Allow-Origin: '*'.
   * Use when you explicitly want wildcard mode.
   * NOTE: This disables credentials support.
   */
  forceWildcard?: boolean;

  /**
   * If true, allows requests with `Origin: null`.
   * This is required for Figma plugins and other sandboxed environments.
   */
  allowNullOrigin?: boolean;

  /** Optional override for Access-Control-Allow-Headers */
  allowHeaders?: string;

  /** Optional override for Access-Control-Allow-Methods */
  allowMethods?: string;

  /** Optional override for Access-Control-Max-Age */
  maxAgeSeconds?: number;

  /** Enable debug logging for CORS decisions. */
  debug?: boolean;

  /**
   * If true, include Access-Control-Allow-Credentials: true.
   * Required for the browser to send cookies with cross-origin requests.
   * Only works when origin is reflected (not wildcard).
   */
  allowCredentials?: boolean;
}

export function parseAllowedOrigins(value?: string): string[] | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  // Common legacy config: "*" means wildcard.
  if (trimmed === "*") return [];

  // Comma-separated list.
  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function corsHeaders(
  request: Request,
  config: CorsConfig = {},
): Headers {
  const origin = request.headers.get("Origin");

  // Handle `Origin: null` for Figma plugins and sandboxed environments.
  // We must respond with '*' because reflecting 'null' is not standards-compliant.
  if (origin === "null" && config.allowNullOrigin) {
    const nullOriginHeaders = new Headers({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": config.allowMethods ?? "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": config.allowHeaders ?? "Content-Type, Accept, Cookie",
      "Access-Control-Max-Age": String(config.maxAgeSeconds ?? 86400),
    });
    // Credentials are not supported with wildcard origin, so we don't set them here.
    return nullOriginHeaders;
  }

  const headers = new Headers();

  const allowMethods = config.allowMethods ?? "GET, HEAD, OPTIONS";
  // Authorization: the Figma plugin sends its Scry PAT as a bearer for private projects.
  const allowHeaders =
    config.allowHeaders ?? "Content-Type, Accept, Cookie, Authorization";
  const maxAgeSeconds = config.maxAgeSeconds ?? 86400;
  const allowCredentials = config.allowCredentials ?? true; // Default to true for private project support

  const allowedOrigins = config.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;

  // Track whether we're using a specific origin (required for credentials)
  let isSpecificOrigin = false;

  // Debug logging for CORS decision
  const originInAllowlist = origin ? allowedOrigins.includes(origin) : false;
  if (config.debug) {
    console.log("[CORS] Processing request:", {
      origin,
      forceWildcard: config.forceWildcard,
      originInAllowlist,
      allowedOriginsCount: allowedOrigins.length,
    });
  }

  if (config.forceWildcard) {
    if (config.debug) {
      console.log("[CORS] Using wildcard due to forceWildcard=true");
    }
    headers.set("Access-Control-Allow-Origin", "*");
  } else if (origin && originInAllowlist) {
    // Reflect whitelisted origins - required for credentials to work
    if (config.debug) {
      console.log("[CORS] Reflecting origin:", origin);
    }
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    isSpecificOrigin = true;
  } else {
    // Public, non-credentialed access.
    if (config.debug) {
      console.log("[CORS] Using wildcard - origin not in allowlist:", origin);
    }
    headers.set("Access-Control-Allow-Origin", "*");
  }

  // Only set Allow-Credentials when we have a specific origin
  // (browsers reject credentials with wildcard origin)
  if (allowCredentials && isSpecificOrigin) {
    headers.set("Access-Control-Allow-Credentials", "true");
  }

  headers.set("Access-Control-Allow-Methods", allowMethods);
  headers.set("Access-Control-Allow-Headers", allowHeaders);
  headers.set("Access-Control-Max-Age", String(maxAgeSeconds));

  return headers;
}

export function handleOptions(
  request: Request,
  config: CorsConfig = {},
): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, config),
  });
}
