// x-scry-request-id middleware (features observability-request-id, log-standardization).
// Mounted first on the Hono app so every response, including 401/404/500, carries an id:
//   1. always mint a ULID: this service faces browsers and the plugin, so an inbound
//      x-scry-request-id is never trusted (trust rule);
//   2. c.set('requestId') and open the log context so deep code logs with it;
//   3. echo it as x-scry-request-id;
//   4. add "request_id" to every JSON error body (status >= 400) that lacks one;
//   5. write one schema-v1 request line at the end (allow-listed fields only).
// A failing logger or header write never changes the response.

import type { Context, Next } from "hono";
import { REQUEST_ID_HEADER, mintRequestId } from "../lib/request-id.js";
import {
  configureLog,
  log,
  reportError,
  withLogContext,
  type LogBindings,
} from "../lib/log.js";

declare module "hono" {
  interface ContextVariableMap {
    /** This request's x-scry-request-id (always set by requestIdMiddleware). */
    requestId: string;
    /** Set by handlers that know them, for the request line. */
    projectId: string;
    /** First 12 hex of sha256(salt:uid), set by the auth middleware. */
    uidHash: string;
  }
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function routePattern(c: Context<any>): string {
  try {
    const routes = c.req.matchedRoutes;
    for (let i = routes.length - 1; i >= 0; i--) {
      if (routes[i].method !== "ALL") return routes[i].path;
    }
    return "unmatched";
  } catch {
    return "unmatched";
  }
}

async function withRequestIdInBody(
  res: Response,
  requestId: string,
): Promise<Response> {
  if (res.status < 400) return res;
  const type = res.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return res;
  if ((body as Record<string, unknown>).request_id === requestId) return res;
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(
    JSON.stringify({
      ...(body as Record<string, unknown>),
      request_id: requestId,
    }),
    {
      status: res.status,
      statusText: res.statusText,
      headers,
    },
  );
}

export async function requestIdMiddleware(
  c: Context<any>,
  next: Next,
): Promise<void> {
  const started = Date.now();
  const requestId = mintRequestId();
  c.set("requestId", requestId);
  try {
    configureLog(c.env as LogBindings | undefined);
  } catch {
    // default logger
  }

  await withLogContext({ request_id: requestId }, () => next());

  try {
    let res = await withRequestIdInBody(c.res, requestId);
    try {
      res.headers.set(REQUEST_ID_HEADER, requestId);
    } catch {
      res = new Response(res.body, res);
      res.headers.set(REQUEST_ID_HEADER, requestId);
    }
    if (res !== c.res) {
      c.res = undefined as unknown as Response;
      c.res = res;
    }
  } catch {
    // the caller still gets the response the handler produced
  }

  try {
    const fields: Record<string, string> = {};
    const route = routePattern(c);
    // G1: `project` is logged only when the route matched a known pattern AND the auth middleware
    // verified the project (exists in storage and the caller is authorized). Never read from the
    // raw path or c.req.param: an unmatched or unauthenticated path segment is client-controlled.
    const projectId = c.get("projectId") as string | undefined;
    if (route !== "unmatched" && projectId && SAFE_ID.test(projectId))
      fields.project = projectId;
    const uid = c.get("uidHash") as string | undefined;
    if (uid && /^[0-9a-f]{12}$/.test(uid)) fields.uid_hash = uid;
    log.request({
      request_id: requestId,
      route,
      status: c.res.status,
      ms: Date.now() - started,
      ...fields,
    });
  } catch {
    // a failing logger never changes the response
  }
}

/** app.onError: unhandled errors reach the exception reporter with the request id. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function errorHandler(err: unknown, c: Context<any>): Response {
  withLogContext({ request_id: c.get("requestId") }, () =>
    reportError(err, "unhandled error", "unhandled_error"),
  );
  return c.text("Internal Server Error", 500);
}
