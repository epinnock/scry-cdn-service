import { log } from "../lib/log";
import * as jose from "jose";
import type { Env } from "@/types/env";

/**
 * Service account authentication for Firestore REST API
 *
 * This module handles OAuth2 token exchange using a GCP service account.
 * The service account must have Firestore read permissions.
 *
 * Required secrets:
 * - FIREBASE_CLIENT_EMAIL: Service account email (e.g., cdn-worker@project.iam.gserviceaccount.com)
 * - FIREBASE_PRIVATE_KEY: Service account private key (PEM format, with \n escaped)
 */

interface TokenCache {
  accessToken: string;
  expiresAt: number;
}

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

// Token refresh buffer - refresh 60 seconds before expiry
const TOKEN_REFRESH_BUFFER_MS = 60 * 1000;

/**
 * Get a valid Firestore access token, using KV cache when available
 *
 * @param env - Worker environment with secrets and KV
 * @returns Access token string or null if auth is not configured
 */
export async function getFirestoreAccessToken(
  env: Env,
): Promise<string | null> {
  const clientEmail = env.FIREBASE_CLIENT_EMAIL;
  const privateKey = env.FIREBASE_PRIVATE_KEY;

  // If service account credentials are not configured, return null
  if (!clientEmail || !privateKey) {
    log.debug("service account not configured");
    return null;
  }

  const now = Date.now();
  const cacheKey = "firestore:access_token";

  // Check KV cache first
  if (env.CDN_CACHE) {
    try {
      const cached = (await env.CDN_CACHE.get(
        cacheKey,
        "json",
      )) as TokenCache | null;

      if (cached && cached.expiresAt > now + TOKEN_REFRESH_BUFFER_MS) {
        return cached.accessToken;
      }
    } catch {
      log.error("token cache read failed", {
        err_code: "token_cache_read_failed",
      });
    }
  }

  // Generate new token
  try {
    const jwt = await createServiceAccountJWT(clientEmail, privateKey);
    const tokenResponse = await exchangeJWTForAccessToken(jwt);

    // Cache the token
    if (env.CDN_CACHE) {
      const cacheValue: TokenCache = {
        accessToken: tokenResponse.access_token,
        expiresAt: now + tokenResponse.expires_in * 1000,
      };

      // KV TTL should be slightly less than token expiry
      const kvTtl = Math.max(60, tokenResponse.expires_in - 120);

      await env.CDN_CACHE.put(cacheKey, JSON.stringify(cacheValue), {
        expirationTtl: kvTtl,
      });
    }

    return tokenResponse.access_token;
  } catch {
    log.error("access token failed", { err_code: "access_token_failed" });
    return null;
  }
}

/**
 * Create a signed JWT for service account authentication
 *
 * @param clientEmail - Service account email
 * @param privateKey - Service account private key (PEM format)
 * @returns Signed JWT string
 */
async function createServiceAccountJWT(
  clientEmail: string,
  privateKey: string,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  // Handle escaped newlines in private key
  const normalizedKey = privateKey.replace(/\\n/g, "\n");

  // Import the private key
  const key = await jose.importPKCS8(normalizedKey, "RS256");

  // Create and sign the JWT
  const jwt = await new jose.SignJWT({
    iss: clientEmail,
    sub: clientEmail,
    aud: OAUTH_TOKEN_URL,
    scope: FIRESTORE_SCOPE,
  })
    .setProtectedHeader({ alg: "RS256", typ: "JWT" })
    .setIssuedAt(now)
    .setExpirationTime(now + 3600) // 1 hour
    .sign(key);

  return jwt;
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
}

/**
 * Exchange a signed JWT for a Google OAuth2 access token
 *
 * @param jwt - Signed JWT assertion
 * @returns Token response with access_token and expires_in
 */
async function exchangeJWTForAccessToken(jwt: string): Promise<TokenResponse> {
  const response = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as TokenResponse;
  return data;
}

/**
 * Check if service account authentication is configured
 *
 * @param env - Worker environment
 * @returns true if both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY are set
 */
export function isServiceAccountConfigured(env: Env): boolean {
  return Boolean(env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY);
}
