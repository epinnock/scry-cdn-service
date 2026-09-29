import type { Env } from "@/types/env";
import {
  getFirestoreAccessToken,
  isServiceAccountConfigured,
} from "@/services/firestore-auth";

/**
 * Sign-out revocation for `__session` cookies (dashboard bug signout-session-race,
 * ISSUES.md #62).
 *
 * The viewer has no Firebase Admin, so it cannot ask Firebase whether a session
 * cookie was revoked. The dashboard's logout route calls revokeRefreshTokens(uid)
 * and writes the resulting `tokensValidAfterTime` (epoch seconds) to Firestore
 * `sessionRevocations/{uid}.validAfter`. A cookie whose `auth_time` is at or before
 * that instant is refused here.
 *
 * Cost: one Firestore document read per (uid, 30 s, isolate) on the session-cookie
 * path only (PAT, preview-token and public requests never reach it). Latency: a
 * sign-out takes effect on the viewer within CACHE_TTL_MS (30 s) plus the
 * dashboard's own write. Failure: a lookup error is thrown, and the caller denies.
 */
export const SESSION_REVOCATIONS_COLLECTION = "sessionRevocations";
const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 1_000;

const cache = new Map<string, { validAfter: number; at: number }>();

/** Epoch seconds of the user's last sign-out cut-off; 0 when they never signed out. */
export async function getSessionValidAfter(
  uid: string,
  env: Env,
  now: number = Date.now(),
): Promise<number> {
  const hit = cache.get(uid);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.validAfter;

  const firebaseProjectId = env.FIREBASE_PROJECT_ID;
  if (!firebaseProjectId) {
    throw new Error("FIREBASE_PROJECT_ID not configured");
  }

  const headers: Record<string, string> = {};
  if (isServiceAccountConfigured(env)) {
    const token = await getFirestoreAccessToken(env);
    if (!token) throw new Error("Failed to authenticate with Firestore");
    headers["Authorization"] = `Bearer ${token}`;
  }

  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/${SESSION_REVOCATIONS_COLLECTION}/${encodeURIComponent(uid)}`;
  const response = await fetch(url, { headers });

  let validAfter = 0;
  if (response.status === 404) {
    validAfter = 0;
  } else if (!response.ok) {
    throw new Error(`Firestore request failed: ${response.status}`);
  } else {
    const doc = (await response.json()) as {
      fields?: { validAfter?: { integerValue?: string; doubleValue?: number } };
    };
    const field = doc.fields?.validAfter;
    const parsed =
      field?.integerValue !== undefined
        ? Number(field.integerValue)
        : field?.doubleValue;
    if (parsed === undefined || !Number.isFinite(parsed)) {
      // A revocation document exists but is unreadable: do not treat it as "never
      // signed out".
      throw new Error("sessionRevocations document has no numeric validAfter");
    }
    validAfter = parsed;
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(uid, { validAfter, at: now });
  return validAfter;
}

/**
 * True when the cookie must be refused. A cookie with no auth_time/iat cannot be
 * placed before or after a sign-out, so it is refused whenever a cut-off exists.
 */
export function isSessionRevoked(
  authTime: number | undefined,
  validAfter: number,
): boolean {
  if (validAfter <= 0) return false;
  return authTime === undefined || authTime <= validAfter;
}

/** Test hook. */
export function resetSessionRevocationCache(): void {
  cache.clear();
}
