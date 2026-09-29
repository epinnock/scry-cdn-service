// Structured logging for the CDN service (feature log-standardization, schema v1).
//
// One process logger; the current request/job context (request_id, project, build_id) rides in an
// AsyncLocalStorage so deep pipeline code logs with the right ids without threading them through
// every signature. `msg` is words only; variable data goes in the allowed fields; the exception
// goes to Sentry, never into a log line.

import { AsyncLocalStorage } from "node:async_hooks";
import {
  createLogger,
  type Env,
  type LineFields,
  type Logger,
} from "./scry-log/index.js";

/**
 * Exception reporter, registered by the Cloudflare entry (cloudflare/worker.ts) so the shared app code
 * never imports the Sentry SDK (the Docker/Node build of this service has none). No reporter = no-op.
 */
type Reporter = (err: unknown, tags: Record<string, string>) => void;
let reporter: Reporter | undefined;
export function setExceptionReporter(fn: Reporter | undefined): void {
  reporter = fn;
}

export interface LogBindings {
  SCRY_ENV?: string;
  SCRY_COMMIT?: string;
  SCRY_LOG_DEBUG?: string;
}

export interface LogContext {
  request_id?: string;
  project?: string;
  build_id?: string;
}

const als = new AsyncLocalStorage<LogContext>();

/** Run `fn` with ids that every line logged inside it carries. Inherits and overrides the outer context. */
export function withLogContext<T>(ctx: LogContext, fn: () => T): T {
  const outer = als.getStore() ?? {};
  const merged: LogContext = { ...outer };
  for (const [k, v] of Object.entries(ctx))
    if (v) (merged as Record<string, string>)[k] = v;
  return als.run(merged, fn);
}

/** Add ids to the current context (e.g. once the build id is known). No-op outside a context. */
export function setLogContext(ctx: LogContext): void {
  const store = als.getStore();
  if (!store) return;
  for (const [k, v] of Object.entries(ctx))
    if (v) (store as Record<string, string>)[k] = v;
}

/** The request id of the current context, if any (used for outbound calls). */
export function currentRequestId(): string | undefined {
  return als.getStore()?.request_id;
}

let current: Logger | undefined;
let currentKey = "";

function tier(value: string | undefined): Env {
  return value === "production" || value === "staging" ? value : "development";
}

/** (Re)build the logger when the deploy identity changes. Cheap; called per request/job. */
export function configureLog(bindings?: LogBindings): Logger {
  const b = bindings ?? {};
  const key = `${b.SCRY_ENV ?? ""}|${b.SCRY_COMMIT ?? ""}|${b.SCRY_LOG_DEBUG ?? ""}`;
  if (!current || key !== currentKey) {
    current = createLogger({
      service: "cdn",
      env: tier(b.SCRY_ENV),
      version: b.SCRY_COMMIT,
      debug: b.SCRY_LOG_DEBUG === "1",
    });
    currentKey = key;
  }
  return current;
}

function withCtx(fields?: LineFields): LineFields {
  const ctx = als.getStore();
  return ctx ? { ...ctx, ...(fields ?? {}) } : (fields ?? {});
}

/** The configured logger, or a default one before the first configureLog(). Never reconfigures. */
function active(): Logger {
  return current ?? configureLog();
}

/** The process logger. Every line gets the ambient request context. */
export const log: Logger = {
  info: (m, f) => active().info(m, withCtx(f)),
  warn: (m, f) => active().warn(m, withCtx(f)),
  error: (m, f) => active().error(m, withCtx(f)),
  debug: (m, f) => active().debug(m, withCtx(f)),
  request: (f) => active().request(withCtx(f)),
  flush: () => active().flush(),
};

/**
 * Log an error line and send the exception to Sentry with the request id.
 * `msg` and `code` are fixed strings; the exception itself goes only to Sentry (whose
 * beforeSend scrubber removes credentials), never into the log line.
 */
export function reportError(
  err: unknown,
  msg: string,
  code: string,
  extra?: LineFields,
  tags?: Record<string, string>,
): void {
  const fields = withCtx({ err_code: code, ...extra });
  log.error(msg, fields);
  try {
    reporter?.(err, {
      ...(tags ?? {}),
      request_id: fields.request_id ?? "none",
      err_code: code,
    });
  } catch {
    // telemetry must never break the request
  }
}
