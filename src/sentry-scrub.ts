/**
 * Redaction for anything sent to error reporting.
 *
 * Callers here are internal — the queue and hand-run HTTP triggers — so the
 * exposure is smaller than the upload service, which receives customer API keys
 * in a header. It is applied anyway for two reasons: this service talks to
 * OpenAI, Jina and Milvus, and their error responses are quoted back verbatim;
 * and a scrubber that exists on one service and not its neighbour is one nobody
 * remembers to add to the third.
 *
 * Vendored rather than shared. There is no common package across these repos,
 * and publishing one would mean another release pipeline and another npm token
 * to expire — of which three had already rotted since January.
 */

import { scrubString as sharedScrub } from "./lib/scry-log/index.js";

/** Header names whose values must never be sent, compared case-insensitively. */
const SENSITIVE_HEADERS = [
  "x-api-key",
  "authorization",
  "cookie",
  "x-cleanup-token",
];

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Presigned URLs. Keep the object path — it identifies the failing operation —
  // and drop the query string, which carries X-Amz-Signature: a time-limited
  // write credential for the bucket.
  [/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1?<redacted>"],
  [/scry_proj_[A-Za-z0-9_-]+/g, "scry_proj_<redacted>"],
  [/(X-Amz-Signature=)[^&\s]+/gi, "$1<redacted>"],
  [/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1<redacted>"],
];

export function scrubString(value: string): string {
  // Local rules first (they keep the object path of a presigned URL), then the shared scry-log
  // scrubber (emails, JWT-like strings, provider keys, cookies, ?query=) so no Sentry event carries
  // what the log lines cannot (log-standardization guarantee-1).
  return sharedScrub(
    SECRET_PATTERNS.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      value,
    ),
  );
}

/** Scrub every string in a breadcrumb (message and data) before it is recorded. */
export function scrubBreadcrumb<
  T extends { message?: string; data?: Record<string, unknown> },
>(crumb: T): T {
  if (typeof crumb.message === "string")
    crumb.message = scrubString(crumb.message);
  if (crumb.data) {
    for (const [key, value] of Object.entries(crumb.data)) {
      if (typeof value === "string") crumb.data[key] = scrubString(value);
    }
  }
  return crumb;
}

/**
 * Strip credentials from a Sentry event before it leaves the Worker.
 *
 * Takes `any` on purpose. The SDK's event shape shifts between versions, and a
 * scrubber that fails to compile after a routine upgrade is a scrubber someone
 * deletes under time pressure. Loose typing here buys durability where it
 * matters more than precision does.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose on purpose, see above
export function scrubEvent(event: any): any {
  const request = event.request as
    | {
        headers?: Record<string, string>;
        query_string?: unknown;
        data?: unknown;
      }
    | undefined;

  if (request?.headers) {
    for (const name of Object.keys(request.headers)) {
      if (SENSITIVE_HEADERS.includes(name.toLowerCase()))
        request.headers[name] = "<redacted>";
    }
  }

  // Bodies and query strings are never needed to diagnose a failure here, and
  // both can carry keys.
  if (request) {
    delete request.data;
    delete request.query_string;
    // A URL can carry a query (a presigned signature, a token); keep the path, which names the route.
    const r = request as { url?: unknown; cookies?: unknown };
    if (typeof r.url === "string") r.url = r.url.split(/[?#]/)[0];
    delete r.cookies;
  }

  if (typeof event.message === "string")
    event.message = scrubString(event.message);

  for (const entry of event.exception?.values ?? []) {
    if (typeof entry.value === "string") entry.value = scrubString(entry.value);
  }

  if (event.extra) {
    for (const [key, value] of Object.entries(event.extra)) {
      if (typeof value === "string") event.extra[key] = scrubString(value);
    }
  }

  return event;
}
