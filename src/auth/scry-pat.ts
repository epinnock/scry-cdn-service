/**
 * Scry personal access tokens (PATs) as a bearer credential for private projects.
 *
 * The Figma plugin runs in a sandboxed iframe with a `null` origin: it can send
 * an Authorization header but never a cookie. It already holds a Scry PAT
 * (minted by the dashboard's device-code login), so private Storybooks accept
 * that token here, validated exactly the way the dashboard validates it:
 *
 *   token  = scry_pat_{uid}_{random}
 *   lookup = users/{uid}/personalAccessTokens where hash == sha256(token)
 *   valid  = status === "active" && (no expiresAt || expiresAt > now)
 *
 * Only the uid comes back; membership is the caller's job. Positive results are
 * cached briefly in KV so a Storybook's dozens of asset requests do not each
 * cost a Firestore query.
 */
import type { Env } from "@/types/env";
import {
  getFirestoreAccessToken,
  isServiceAccountConfigured,
} from "@/services/firestore-auth";

export const SCRY_PAT_PREFIX = "scry_pat_";
const CACHE_TTL_MS = 60 * 1000;
const KV_EXPIRATION_TTL = 120;

export function isScryPat(token: string): boolean {
  return token.startsWith(SCRY_PAT_PREFIX);
}

/** Extract the uid from `scry_pat_{uid}_{random}`; null when malformed. */
export function parseScryPat(token: string): { uid: string } | null {
  if (!isScryPat(token)) return null;
  const rest = token.slice(SCRY_PAT_PREFIX.length);
  const sep = rest.indexOf("_");
  if (sep <= 0 || sep === rest.length - 1) return null;
  const uid = rest.slice(0, sep);
  if (!/^[A-Za-z0-9]+$/.test(uid)) return null;
  return { uid };
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

interface PatCache {
  uid: string;
  cachedAt: number;
}

interface RunQueryRow {
  document?: {
    name?: string;
    fields?: {
      status?: { stringValue?: string };
      expiresAt?: { timestampValue?: string };
    };
  };
}

/**
 * Verify a Scry PAT. Returns the owning uid, or null when the token is
 * malformed, unknown, revoked, expired, or Firestore is unreachable (fail closed).
 */
export async function verifyScryPat(
  token: string,
  env: Env,
): Promise<{ uid: string } | null> {
  const parsed = parseScryPat(token);
  if (!parsed) return null;
  const hash = await sha256Hex(token);
  const cacheKey = `pat:${hash}`;

  if (env.CDN_CACHE) {
    try {
      const cached = (await env.CDN_CACHE.get(
        cacheKey,
        "json",
      )) as PatCache | null;
      if (
        cached &&
        cached.uid === parsed.uid &&
        Date.now() - cached.cachedAt < CACHE_TTL_MS
      ) {
        return { uid: cached.uid };
      }
    } catch {
      /* cache miss */
    }
  }

  const firebaseProjectId = env.FIREBASE_PROJECT_ID;
  if (!firebaseProjectId || !isServiceAccountConfigured(env)) {
    console.error(
      "[PAT] Firestore service account not configured; rejecting bearer",
    );
    return null;
  }
  const accessToken = await getFirestoreAccessToken(env);
  if (!accessToken) return null;

  const url = `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents/users/${encodeURIComponent(parsed.uid)}:runQuery`;
  const body = {
    structuredQuery: {
      from: [{ collectionId: "personalAccessTokens" }],
      where: {
        fieldFilter: {
          field: { fieldPath: "hash" },
          op: "EQUAL",
          value: { stringValue: hash },
        },
      },
      limit: 1,
    },
  };

  let rows: RunQueryRow[];
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      console.error("[PAT] Firestore runQuery failed:", res.status);
      return null;
    }
    rows = (await res.json()) as RunQueryRow[];
  } catch (error) {
    console.error("[PAT] Firestore runQuery error:", error);
    return null;
  }

  const doc = rows.find((r) => r.document)?.document;
  if (!doc) return null;
  if (doc.fields?.status?.stringValue !== "active") return null;
  const expiresAt = doc.fields?.expiresAt?.timestampValue;
  if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) return null;

  if (env.CDN_CACHE) {
    try {
      const value: PatCache = { uid: parsed.uid, cachedAt: Date.now() };
      await env.CDN_CACHE.put(cacheKey, JSON.stringify(value), {
        expirationTtl: KV_EXPIRATION_TTL,
      });
    } catch {
      /* best effort */
    }
  }
  return { uid: parsed.uid };
}
