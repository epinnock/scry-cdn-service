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
  } catch (error) {
    console.error("[VISIBILITY] Failed to fetch project:", error);
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
    console.error("[VISIBILITY] FIREBASE_PROJECT_ID not configured");
    throw new Error("FIREBASE_PROJECT_ID not configured");
  }

  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/projects/${projectId}`;

  console.info("[VISIBILITY] Fetching project from Firestore:", {
    projectId,
    firebaseProjectId,
    url,
  });

  // Build request headers - use service account auth if configured
  const headers: Record<string, string> = {};

  if (isServiceAccountConfigured(env)) {
    const accessToken = await getFirestoreAccessToken(env);

    if (!accessToken) {
      console.error(
        "[VISIBILITY] Service account configured but failed to get access token",
      );
      throw new Error("Failed to authenticate with Firestore");
    }

    headers["Authorization"] = `Bearer ${accessToken}`;
    console.info("[VISIBILITY] Using service account authentication");
  } else {
    console.info(
      "[VISIBILITY] Using unauthenticated Firestore access (requires public rules)",
    );
  }

  const response = await fetch(url, { headers });

  console.info("[VISIBILITY] Firestore response status:", response.status);

  if (!response.ok) {
    if (response.status === 404) {
      console.info("[VISIBILITY] Project not found in Firestore:", projectId);
      return null;
    }
    const errorText = await response.text();
    console.error("[VISIBILITY] Firestore request failed:", {
      status: response.status,
      error: errorText,
    });
    throw new Error(`Firestore request failed: ${response.status}`);
  }

  const doc = (await response.json()) as FirestoreDocument;

  console.info("[VISIBILITY] Raw Firestore document fields:", {
    hasVisibility: !!doc.fields?.visibility,
    hasMemberIds: !!doc.fields?.memberIds,
    visibilityValue: doc.fields?.visibility?.stringValue,
    memberIdsCount: doc.fields?.memberIds?.arrayValue?.values?.length,
  });

  const visibility =
    (doc.fields?.visibility?.stringValue as ProjectVisibility) || "public";
  const memberIds =
    doc.fields?.memberIds?.arrayValue?.values?.map(
      (value: { stringValue: string }) => value.stringValue,
    ) || [];

  console.info("[VISIBILITY] Parsed project data:", {
    projectId,
    visibility,
    memberIds,
  });

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
