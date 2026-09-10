import { Hono } from "hono";
import { logger } from "hono/logger";
import { compress } from "hono/compress";
import { zipStaticRoutes } from "./routes/zip-static";
import { healthRoutes, healthzRoutes } from "./routes/health";
import { privateProjectAuth } from "./middleware/auth";
import { parsePathForUUID, extractProjectFromReferer } from "./utils/subdomain";
import type { Env } from "./types/env";
import {
  corsHeaders,
  handleOptions,
  parseAllowedOrigins,
  DEFAULT_ALLOWED_ORIGINS,
} from "./middleware/cors";

function resolveCorsConfig(env: Env) {
  // Prefer explicit CORS_ALLOWED_ORIGINS, fallback to legacy ALLOWED_ORIGINS.
  const fromEnv =
    parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS) ??
    parseAllowedOrigins(env.ALLOWED_ORIGINS);

  // IMPORTANT: Do NOT force wildcard when using credentialed requests.
  // Browsers reject Access-Control-Allow-Origin='*' with credentials: include.
  // Only force wildcard if explicitly set via CORS_FORCE_WILDCARD=true.
  const forceWildcard = env.CORS_FORCE_WILDCARD === "true";

  const allowedOrigins =
    fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_ALLOWED_ORIGINS;
  const debug = env.NODE_ENV !== "production";

  // Debug logging for CORS configuration
  if (debug) {
    console.log("[CORS] Config resolved:", {
      forceWildcard,
      allowedOrigins: allowedOrigins.slice(0, 5), // Log first 5 origins
      envCorsAllowedOrigins: env.CORS_ALLOWED_ORIGINS,
      envAllowedOrigins: env.ALLOWED_ORIGINS,
    });
  }

  return {
    allowedOrigins,
    forceWildcard,
    debug,
  };
}

export function createApp() {
  const app = new Hono<{
    Bindings: Env;
    Variables: { corsConfig: ReturnType<typeof resolveCorsConfig> };
  }>();

  // Global middleware
  app.use("*", logger());

  // Resolve CORS config once per request for reuse.
  app.use("*", async (c, next) => {
    const corsConfig = resolveCorsConfig(c.env);
    c.set("corsConfig", corsConfig);
    await next();
  });

  // CORS (CRITICAL): must be applied before dashboard can fetch coverage reports.
  app.use("*", async (c, next) => {
    const corsConfig = c.get("corsConfig") ?? resolveCorsConfig(c.env);

    // Handle preflight requests.
    if (c.req.method === "OPTIONS") {
      return handleOptions(c.req.raw, corsConfig);
    }

    try {
      await next();
    } finally {
      // Ensure CORS headers are present on all responses (including 404s).
      const cors = corsHeaders(c.req.raw, corsConfig);
      cors.forEach((value, key) => {
        c.res.headers.set(key, value);
      });
    }
  });

  // Temporarily disabled for testing
  // app.use('*', compress());

  // Health check routes (no auth required)
  app.route("/health", healthRoutes);
  app.route("/healthz", healthzRoutes);

  // Redirect mis-resolved asset requests before auth can reject them.
  // Components with absolute paths (e.g., src="/pets/hero.png" or src="/placeholder.svg")
  // hit the wrong path on the CDN. We use the Referer header to detect
  // these and redirect to /{projectId}/{versionId}/{asset} so the
  // subsequent request goes through auth normally.
  //
  // Two cases:
  // 1. Path is invalid (e.g., /placeholder.svg — dot fails UUID check)
  // 2. Path resolves to a different project than the Referer
  //    (e.g., /pets/hero.png resolves to project "pets" but Referer
  //    is from project "TjYmKAiAQuIdYFlBnVOa")
  app.use("*", async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith("/health")) {
      return next();
    }

    const referer = c.req.header("Referer");
    if (!referer) {
      return next();
    }

    const refProject = extractProjectFromReferer(referer);
    if (!refProject) {
      return next();
    }

    const pathInfo = parsePathForUUID(url.pathname);
    const pathInvalid = !pathInfo || !pathInfo.isValid || !pathInfo.resolution;
    // Only compound UUIDs carry a project; a simple UUID never matches the
    // referer's project, which keeps the redirect behaviour unchanged.
    const resolvedProject =
      pathInfo?.resolution?.type === "compound"
        ? pathInfo.resolution.project
        : undefined;
    const projectMismatch =
      !pathInvalid && refProject.projectId !== resolvedProject;

    if (pathInvalid || projectMismatch) {
      const originalPath = url.pathname.slice(1);
      const redirectUrl = refProject.versionId
        ? `/${refProject.projectId}/${refProject.versionId}/${originalPath}${url.search}`
        : `/${refProject.projectId}/${originalPath}${url.search}`;
      c.header("Vary", "Referer");
      return c.redirect(redirectUrl, 302);
    }

    return next();
  });

  // Auth middleware for viewer routes only (exclude /health)
  app.use("/:projectId/*", privateProjectAuth);

  // ZIP-based static file serving (primary)
  app.route("/", zipStaticRoutes);

  // 404 handler
  app.notFound((c) => {
    return c.text("Not Found", 404);
  });

  // Error handler
  app.onError((err, c) => {
    console.error("Application error:", err);
    // Ensure CORS headers are present on error responses as well
    const corsConfig = c.get("corsConfig") ?? resolveCorsConfig(c.env);
    const cors = corsHeaders(c.req.raw, corsConfig);
    cors.forEach((value, key) => {
      c.res.headers.set(key, value);
    });
    return c.text("Internal Server Error", 500);
  });

  return app;
}
