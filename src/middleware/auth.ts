import { log } from "../lib/log";
import type { Context, Next } from "hono";
import type { Env } from "@/types/env";
import {
  parseCookies,
  validateFirebaseSessionCookie,
} from "@/auth/firebase-session";
import { getProjectVisibility, isProjectMember } from "@/services/visibility";
import {
  getSessionValidAfter,
  isSessionRevoked,
} from "@/auth/session-revocation";
import { isScryPat, verifyScryPat } from "@/auth/scry-pat";
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_QUERY_PARAM,
  previewCookie,
  verifyPreviewToken,
} from "@/auth/preview-token";
import { uidTag } from "@/auth/log-id";

const SESSION_COOKIE_NAME = "__session";

/**
 * HTML of a private project must not hand its URL to other origins: the
 * Storybook's own asset requests (same origin) keep a full Referer — the
 * absolute-path redirect in app.ts depends on it — while anything it loads
 * from a third party gets none at all.
 */
const PRIVATE_HTML_REFERRER_POLICY = "same-origin";

async function servePrivate(c: Context<{ Bindings: Env }>, next: Next) {
  await next();
  if (c.res.headers.get("Content-Type")?.includes("text/html")) {
    c.res.headers.set("Referrer-Policy", PRIVATE_HTML_REFERRER_POLICY);
  }
}

export interface AuthContext {
  uid?: string;
  email?: string;
  isAuthenticated: boolean;
}

/**
 * Record the project for the request line. Called ONLY once the project exists in storage
 * (looked up) AND the caller is authorized for it, never from the raw path: a client-chosen
 * path segment must not reach the log store (guarantee G1, UAT F41).
 */
function markVerifiedProject(c: Context<{ Bindings: Env }>, projectId: string) {
  if (/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) c.set("projectId", projectId);
}

export async function privateProjectAuth(
  c: Context<{ Bindings: Env }>,
  next: Next,
) {
  const url = new URL(c.req.url);
  const pathParts = url.pathname.split("/").filter(Boolean);

  const projectId = pathParts[0];

  if (!projectId) {
    return c.text("Invalid path", 400);
  }

  log.debug("checking access");

  const project = await getProjectVisibility(projectId, c.env);

  if (!project) {
    // No Firestore document means an unknown project, not an open one. This
    // previously called next(), which served the entire hosted Storybook for any
    // project_id lacking a record — to unauthenticated callers. Transient
    // Firestore failures never reach here: getProjectVisibility() converts them
    // to { visibility: "private", memberIds: [] }, so null is specifically a 404.
    log.debug("project not found");
    return c.text("Not found", 404);
  }

  log.debug("project visibility");

  if (project.visibility === "public") {
    log.debug("public project allowed");
    markVerifiedProject(c, projectId);
    return next();
  }

  // Private project - check authentication.
  //
  // Bearer path first: the Figma plugin (sandboxed iframe, origin "null") cannot
  // send cookies but does hold a Scry PAT. A presented PAT is authoritative —
  // an invalid one is a 401, it never falls through to the cookie path.
  const authorization = c.req.header("Authorization");
  if (authorization?.startsWith("Bearer ")) {
    const bearer = authorization.slice("Bearer ".length).trim();
    if (isScryPat(bearer)) {
      const pat = await verifyScryPat(bearer, c.env);
      if (!pat) {
        log.warn("pat rejected", { err_code: "pat_rejected" });
        return c.text("Unauthorized", 401);
      }
      if (!isProjectMember(project.memberIds, pat.uid)) {
        log.warn("pat owner not member", { err_code: "pat_not_member" });
        return c.text("Forbidden", 403);
      }
      markVerifiedProject(c, projectId);
      return servePrivate(c, next);
    }
  }

  // Signed preview token (in-plugin previews of private Storybooks — see
  // docs/PRIVATE_PREVIEW_SIGNED_COOKIES.md). The first iframe navigation
  // carries `?scry_preview=<token>`; a valid one is exchanged for a
  // partitioned, path-scoped cookie and redirected to the same URL without the
  // parameter, so the token never sits in the address bar or a Referer. Like
  // the PAT, a presented token is authoritative: an invalid one is a 401.
  const previewParam = url.searchParams.get(PREVIEW_QUERY_PARAM);
  if (previewParam !== null) {
    const verified = await verifyPreviewToken(previewParam, projectId, c.env);
    if (!verified) {
      log.warn("preview token rejected", {
        err_code: "preview_token_rejected",
      });
      return c.text("Unauthorized", 401);
    }
    url.searchParams.delete(PREVIEW_QUERY_PARAM);
    log.debug("preview token exchanged");
    markVerifiedProject(c, projectId);
    c.header("Set-Cookie", previewCookie(previewParam, verified));
    c.header("Cache-Control", "no-store");
    return c.redirect(url.pathname + url.search, 302);
  }

  const cookieHeader = c.req.header("Cookie");
  log.debug("cookie header present");

  const cookies = parseCookies(cookieHeader ?? null);

  // Every sub-request of an exchanged preview carries the cookie. Verifying it
  // is pure CPU, so it goes before the session cookie (a JWT check against
  // Google's keys). A stale one is simply ignored — a first-party visitor with
  // a leftover partitioned cookie still gets the session path.
  const previewCookieValue = cookies[PREVIEW_COOKIE_NAME];
  if (previewCookieValue) {
    const verified = await verifyPreviewToken(
      previewCookieValue,
      projectId,
      c.env,
    );
    if (verified) {
      log.debug("preview cookie accepted");
      markVerifiedProject(c, projectId);
      return servePrivate(c, next);
    }
    log.debug("preview cookie invalid");
  }

  const sessionCookie = cookies[SESSION_COOKIE_NAME];

  log.debug("session cookie present");

  if (!sessionCookie) {
    // Only a count: cookie names and values are never logged (audit gap 6).
    log.debug("no session cookie");
    return c.text("Unauthorized", 401);
  }

  const firebaseProjectId = c.env.FIREBASE_PROJECT_ID;

  if (!firebaseProjectId) {
    log.error("firebase project not configured", {
      err_code: "firebase_project_unset",
    });
    return c.text("Server configuration error", 500);
  }

  log.debug("validating session cookie");

  const validation = await validateFirebaseSessionCookie(
    sessionCookie,
    firebaseProjectId,
    c.env.CDN_CACHE,
  );

  const tag = await uidTag(validation.uid, c.env.LOG_HASH_SALT);
  // The request line carries the salted uid hash (never the uid); "none" without a salt.
  if (tag !== "none") c.set("uidHash", tag);

  if (!validation.valid || !validation.uid) {
    log.warn("session invalid", { err_code: "session_invalid" });
    return c.text("Unauthorized", 401);
  }

  // Sign-out revokes every session issued before it (the dashboard's logout writes
  // sessionRevocations/{uid}.validAfter). A cookie signed in at or before that
  // instant is dead although its signature and expiry are fine. If the cut-off
  // cannot be read we cannot tell, so deny (503), never allow.
  let validAfter: number;
  try {
    validAfter = await getSessionValidAfter(validation.uid, c.env);
  } catch {
    log.error("session revocation lookup failed", {
      err_code: "revocation_lookup_failed",
    });
    return c.text("Unable to verify session", 503);
  }
  if (isSessionRevoked(validation.authTime, validAfter)) {
    log.warn("session predates signout", { err_code: "session_revoked" });
    return c.text("Unauthorized", 401);
  }

  if (!isProjectMember(project.memberIds, validation.uid)) {
    log.debug("session valid not member");
    return c.text("Forbidden", 403);
  }

  log.debug("access granted");
  markVerifiedProject(c, projectId);

  return servePrivate(c, next);
}
