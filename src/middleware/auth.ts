import type { Context, Next } from "hono";
import type { Env } from "@/types/env";
import {
  parseCookies,
  validateFirebaseSessionCookie,
} from "@/auth/firebase-session";
import { getProjectVisibility, isProjectMember } from "@/services/visibility";
import { isScryPat, verifyScryPat } from "@/auth/scry-pat";
import {
  PREVIEW_COOKIE_NAME,
  PREVIEW_QUERY_PARAM,
  previewCookie,
  verifyPreviewToken,
} from "@/auth/preview-token";

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

  console.info("[AUTH] Checking access for project:", projectId);

  const project = await getProjectVisibility(projectId, c.env);

  if (!project) {
    // No Firestore document means an unknown project, not an open one. This
    // previously called next(), which served the entire hosted Storybook for any
    // project_id lacking a record — to unauthenticated callers. Transient
    // Firestore failures never reach here: getProjectVisibility() converts them
    // to { visibility: "private", memberIds: [] }, so null is specifically a 404.
    console.info(
      "[AUTH] Project not found in Firestore, denying access:",
      projectId,
    );
    return c.text("Not found", 404);
  }

  console.info("[AUTH] Project visibility:", {
    projectId,
    visibility: project.visibility,
    memberCount: project.memberIds.length,
    memberIds: project.memberIds,
  });

  if (project.visibility === "public") {
    console.info("[AUTH] Public project, allowing access:", projectId);
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
        console.warn(
          "[AUTH] Rejected Scry PAT for private project:",
          projectId,
        );
        return c.text("Unauthorized", 401);
      }
      if (!isProjectMember(project.memberIds, pat.uid)) {
        console.warn("[AUTH] PAT owner is not a project member:", {
          uid: pat.uid,
          projectId,
        });
        return c.text("Forbidden", 403);
      }
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
      console.warn("[AUTH] Rejected preview token for project:", projectId);
      return c.text("Unauthorized", 401);
    }
    url.searchParams.delete(PREVIEW_QUERY_PARAM);
    console.info("[AUTH] Preview token exchanged for cookie:", {
      uid: verified.uid,
      projectId,
      remainingSeconds: verified.remainingSeconds,
    });
    c.header("Set-Cookie", previewCookie(previewParam, verified));
    c.header("Cache-Control", "no-store");
    return c.redirect(url.pathname + url.search, 302);
  }

  const cookieHeader = c.req.header("Cookie");
  console.info("[AUTH] Cookie header present:", !!cookieHeader);

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
      console.info("[AUTH] Preview cookie accepted:", {
        uid: verified.uid,
        projectId,
      });
      return servePrivate(c, next);
    }
    console.info("[AUTH] Preview cookie invalid or expired:", projectId);
  }

  const sessionCookie = cookies[SESSION_COOKIE_NAME];

  console.info("[AUTH] Session cookie present:", !!sessionCookie);
  console.info("[AUTH] All cookies received:", Object.keys(cookies));

  if (!sessionCookie) {
    console.info("[AUTH] No session cookie for private project:", {
      projectId,
      cookieHeader: cookieHeader ? `${cookieHeader.substring(0, 50)}...` : null,
    });
    return c.text("Unauthorized", 401);
  }

  const firebaseProjectId = c.env.FIREBASE_PROJECT_ID;

  if (!firebaseProjectId) {
    console.error("[AUTH] FIREBASE_PROJECT_ID not configured");
    return c.text("Server configuration error", 500);
  }

  console.info(
    "[AUTH] Validating session cookie for Firebase project:",
    firebaseProjectId,
  );

  const validation = await validateFirebaseSessionCookie(
    sessionCookie,
    firebaseProjectId,
    c.env.CDN_CACHE,
  );

  console.info("[AUTH] Session validation result:", {
    valid: validation.valid,
    uid: validation.uid,
    email: validation.email,
    error: validation.error,
  });

  if (!validation.valid || !validation.uid) {
    console.info("[AUTH] Invalid session cookie:", {
      projectId,
      error: validation.error,
    });
    return c.text("Unauthorized", 401);
  }

  const isMember = isProjectMember(project.memberIds, validation.uid);
  console.info("[AUTH] Membership check:", {
    uid: validation.uid,
    projectId,
    memberIds: project.memberIds,
    isMember,
  });

  if (!isMember) {
    console.info("[AUTH] User not a member:", {
      uid: validation.uid,
      projectId,
      memberIds: project.memberIds,
    });
    return c.text("Forbidden", 403);
  }

  console.info("[AUTH] Access granted:", { uid: validation.uid, projectId });

  return servePrivate(c, next);
}
