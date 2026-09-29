import { log } from "../lib/log";
import type { Env } from "@/types/env";
import {
  getFirestoreAccessToken,
  isServiceAccountConfigured,
} from "@/services/firestore-auth";

export type ProjectVisibility = "public" | "private";

interface VisibilityCache {
  visibility: ProjectVisibility;
  memberIds: string[];
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 1000;
const KV_EXPIRATION_TTL = 300;

export async function getProjectVisibility(
  projectId: string,
  env: Env,
): Promise<{ visibility: ProjectVisibility; memberIds: string[] } | null> {
  const cacheKey = `visibility:${projectId}`;

  if (env.CDN_CACHE) {
    const cached = (await env.CDN_CACHE.get(
      cacheKey,
      "json",
    )) as VisibilityCache | null;

    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return {
        visibility: cached.visibility,
        memberIds: cached.memberIds,
      };
    }
  }

  try {
    const result = await fetchProjectFromFirestore(projectId, env);

    if (!result) {
      return null;
    }

    if (env.CDN_CACHE) {
      const cacheValue: VisibilityCache = {
        visibility: result.visibility,
        memberIds: result.memberIds,
        cachedAt: Date.now(),
      };

      await env.CDN_CACHE.put(cacheKey, JSON.stringify(cacheValue), {
        // KV TTL intentionally longer than CACHE_TTL_MS for stale-while-revalidate fallback.
        expirationTtl: KV_EXPIRATION_TTL,
      });
    }

    return result;
  } catch {
    log.error("project fetch failed", { err_code: "visibility_fetch_failed" });
    return { visibility: "private", memberIds: [] };
  }
}

async function fetchProjectFromFirestore(
  projectId: string,
  env: Env,
): Promise<{ visibility: ProjectVisibility; memberIds: string[] } | null> {
  const firebaseProjectId = env.FIREBASE_PROJECT_ID;

  if (!firebaseProjectId) {
    // Throw rather than return null. Returning null would report every project
    // as "not found", letting one missing binding decide access for every
    // project. Throwing routes into the caller's catch, which fails closed.
    log.error("firebase project not configured", {
      err_code: "firebase_project_unset",
    });
    throw new Error("FIREBASE_PROJECT_ID not configured");
  }

  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/projects/${projectId}`;

  log.debug("fetching project");

  // Build request headers - use service account auth if configured
  const headers: Record<string, string> = {};

  if (isServiceAccountConfigured(env)) {
    const accessToken = await getFirestoreAccessToken(env);

    if (!accessToken) {
      log.error("service account token failed", {
        err_code: "sa_token_failed",
      });
      throw new Error("Failed to authenticate with Firestore");
    }

    headers["Authorization"] = `Bearer ${accessToken}`;
    log.debug("using service account");
  } else {
    log.debug("using unauthenticated firestore");
  }

  const response = await fetch(url, { headers });

  log.debug("firestore responded");

  if (!response.ok) {
    if (response.status === 404) {
      log.debug("project not found");
      return null;
    }
    await response.text(); // drain the body; its text is never logged (may quote project data)
    log.error("firestore request failed", {
      err_code: "firestore_request_failed",
    });
    throw new Error(`Firestore request failed: ${response.status}`);
  }

  const doc = (await response.json()) as FirestoreDocument;

  const visibility =
    (doc.fields?.visibility?.stringValue as ProjectVisibility) || "public";
  const memberIds =
    doc.fields?.memberIds?.arrayValue?.values?.map(
      (value: { stringValue: string }) => value.stringValue,
    ) || [];

  return { visibility, memberIds };
}

interface FirestoreDocument {
  fields?: {
    visibility?: { stringValue: string };
    memberIds?: { arrayValue: { values: Array<{ stringValue: string }> } };
  };
}

export function isProjectMember(memberIds: string[], uid: string): boolean {
  return memberIds.includes(uid);
}
