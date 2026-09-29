import * as jose from "jose";

const GOOGLE_CERTS_URL =
  "https://www.googleapis.com/identitytoolkit/v3/relyingparty/publicKeys";

const GOOGLE_KEYS_CACHE_KEY = "firebase:public-keys";

async function getGooglePublicKeys(
  cache?: KVNamespace,
): Promise<Record<string, string>> {
  if (cache) {
    const cached = (await cache.get(GOOGLE_KEYS_CACHE_KEY, "json")) as {
      keys: Record<string, string>;
    } | null;
    if (cached?.keys && Object.keys(cached.keys).length > 0) {
      return cached.keys;
    }
  }

  const response = await fetch(GOOGLE_CERTS_URL);

  if (!response.ok) {
    throw new Error(`Failed to fetch Google public keys: ${response.status}`);
  }

  const keys = (await response.json()) as Record<string, string>;

  const cacheControl = response.headers.get("Cache-Control");
  let maxAge = 3600;

  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/);
    if (match) {
      maxAge = Number.parseInt(match[1], 10);
    }
  }

  if (cache) {
    await cache.put(GOOGLE_KEYS_CACHE_KEY, JSON.stringify({ keys }), {
      expirationTtl: maxAge,
    });
  }

  return keys;
}

export interface SessionValidationResult {
  valid: boolean;
  uid?: string;
  email?: string;
  /** `auth_time` (falls back to `iat`), epoch seconds: when the user signed in. */
  authTime?: number;
  error?: string;
}

export async function validateFirebaseSessionCookie(
  sessionCookie: string,
  firebaseProjectId: string,
  cache?: KVNamespace,
): Promise<SessionValidationResult> {
  try {
    console.info(
      "[AUTH] Validating session cookie, length:",
      sessionCookie.length,
    );

    const header = jose.decodeProtectedHeader(sessionCookie);
    console.info("[AUTH] JWT header:", { alg: header.alg, kid: header.kid });

    if (!header.kid) {
      console.error("[AUTH] Missing key ID in JWT header");
      return { valid: false, error: "Missing key ID in JWT header" };
    }

    const publicKeys = await getGooglePublicKeys(cache);
    const publicKeyPem = publicKeys[header.kid];

    if (!publicKeyPem) {
      console.error("[AUTH] Unknown key ID:", header.kid);
      console.info("[AUTH] Available key IDs:", Object.keys(publicKeys));
      return { valid: false, error: "Unknown key ID" };
    }

    console.info("[AUTH] Found matching public key for kid:", header.kid);

    const publicKey = await jose.importX509(publicKeyPem, "RS256");

    const expectedIssuer = `https://session.firebase.google.com/${firebaseProjectId}`;
    console.info("[AUTH] Expected issuer:", expectedIssuer);
    console.info("[AUTH] Expected audience:", firebaseProjectId);

    const { payload } = await jose.jwtVerify(sessionCookie, publicKey, {
      issuer: expectedIssuer,
      audience: firebaseProjectId,
    });

    const uid = payload.sub;
    const email = payload.email as string | undefined;

    // Never log the payload, email or uid here: the caller logs an opaque
    // uid tag and the outcome (audit 2026-09-26, gap 6).
    if (!uid) {
      console.error("[AUTH] Missing user ID (sub) in token payload");
      return { valid: false, error: "Missing user ID in token" };
    }

    const rawAuthTime = payload.auth_time ?? payload.iat;
    const authTime = typeof rawAuthTime === "number" ? rawAuthTime : undefined;

    return {
      valid: true,
      uid,
      email,
      authTime,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[AUTH] Session validation failed:", message);
    if (error instanceof Error && error.stack) {
      console.error("[AUTH] Stack trace:", error.stack);
    }
    return { valid: false, error: message };
  }
}

export function parseCookies(
  cookieHeader: string | null,
): Record<string, string> {
  if (!cookieHeader) return {};

  const cookies: Record<string, string> = {};

  cookieHeader.split(";").forEach((cookie) => {
    const [rawName, ...rest] = cookie.split("=");
    const name = rawName?.trim();
    const value = rest.join("=").trim();
    if (name) {
      cookies[name] = value;
    }
  });

  return cookies;
}
