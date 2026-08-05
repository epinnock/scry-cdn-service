import type { Context, Next } from "hono";
import type { Env } from "@/types/env";
import {
  parseCookies,
  validateFirebaseSessionCookie,
} from "@/auth/firebase-session";
import { getProjectVisibility, isProjectMember } from "@/services/visibility";

const SESSION_COOKIE_NAME = "__session";

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

  // Private project - check authentication
  const cookieHeader = c.req.header("Cookie");
  console.info("[AUTH] Cookie header present:", !!cookieHeader);

  const cookies = parseCookies(cookieHeader ?? null);
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

  return next();
}
