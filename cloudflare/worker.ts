import * as Sentry from "@sentry/cloudflare";
import { createApp } from "../src/app";
import { setExceptionReporter } from "../src/lib/log";
import {
  scrubBreadcrumb,
  scrubEvent,
  scrubSpan,
  scrubTransaction,
} from "../src/sentry-scrub";
import type { Env } from "../src/types/env";

const app = createApp();

// Errors reach Sentry through the shared logger's reporter hook, so the app code stays free of the
// SDK (the Docker build has none). Without a DSN the SDK is disabled and this is a no-op.
setExceptionReporter((err, tags) => {
  try {
    Sentry.captureException(err, { tags });
  } catch {
    // telemetry must never break a request
  }
});

/** Sentry options; exported for tests. `dsn` undefined disables the SDK entirely. */
export function sentryOptions(env: Env) {
  return {
    dsn: env.SENTRY_DSN || undefined,
    // The tier from SCRY_ENV, never a silent "production" default (observability-request-id).
    environment: env.SCRY_ENV || "unknown",
    release: env.SCRY_COMMIT,
    // Errors are the point; traces stay a low fraction to protect the quota (standard L9).
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE
      ? Number(env.SENTRY_TRACES_SAMPLE_RATE)
      : 0.1,
    debug: false,
    sendDefaultPii: false,
    // Viewer requests carry session cookies, PATs and signed preview tokens: attach none of them.
    dataCollection: { userInfo: false, httpBodies: [] },
    initialScope: {
      tags: { service: "cdn-service", runtime: "cloudflare-workers" },
    },
    beforeBreadcrumb: (breadcrumb: Sentry.Breadcrumb) =>
      scrubBreadcrumb(breadcrumb),
    beforeSend: scrubEvent,
    // Transactions and spans skip beforeSend; without these the PAT bearer, the signed preview token and
    // IPs ride out on every sampled trace (log-standardization B1).
    beforeSendTransaction: scrubTransaction,
    beforeSendSpan: scrubSpan,
  };
}

const handler: ExportedHandler<Env> = {
  fetch: (request, env, ctx) => app.fetch(request, env, ctx),
};

export default Sentry.withSentry((env: Env) => sentryOptions(env), handler);
