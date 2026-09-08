/**
 * Signed preview tokens: the credential behind in-plugin previews of private
 * Storybooks (docs/PRIVATE_PREVIEW_SIGNED_COOKIES.md).
 *
 * An <iframe> navigation cannot carry an Authorization header, and neither can
 * the dozens of chunk/CSS/index.json requests Storybook makes once it boots.
 * So the dashboard mints a short-lived token bound to one user and one project,
 * the plugin puts it on the first navigation (`?scry_preview=<token>`), and
 * privateProjectAuth exchanges it for a partitioned, path-scoped cookie that
 * every later sub-request carries automatically.
 *
 *   token   = base64url(JSON payload) "." base64url(HMAC-SHA256(secret, payloadB64))
 *   payload = { v: 1, uid, projectId, exp (unix seconds), nonce }
 *
 * Verification is pure CPU — no Firestore call. The CDN trusts the dashboard's
 * membership decision at mint time; the token's projectId must equal the path
 * project, and it is never good for more than PREVIEW_TOKEN_MAX_AGE_S. Two
 * secrets are accepted (PREVIEW_TOKEN_SECRET, PREVIEW_TOKEN_SECRET_PREVIOUS)
 * so the shared secret can be rotated without a window of broken previews.
 */
import type { Env } from "@/types/env";

export const PREVIEW_QUERY_PARAM = "scry_preview";
export const PREVIEW_COOKIE_NAME = "__scry_preview";
/** Longest lifetime a token may claim, in seconds (the dashboard mints 10 min). */
export const PREVIEW_TOKEN_MAX_AGE_S = 10 * 60;
/** Tolerated clock difference between the dashboard and this Worker. */
const CLOCK_SKEW_S = 60;

export interface PreviewTokenPayload {
  v: 1;
  uid: string;
  projectId: string;
  /** Unix time in seconds. */
  exp: number;
  nonce: string;
}

export interface VerifiedPreviewToken {
  uid: string;
  projectId: string;
  exp: number;
  /** Whole seconds until `exp`; always ≥ 1 for a verified token. */
  remainingSeconds: number;
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(input)) return null;
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(new ArrayBuffer(binary.length));
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

/** The secrets to try, current first; empty when none is configured. */
export function previewTokenSecrets(env: Env): string[] {
  return [env.PREVIEW_TOKEN_SECRET, env.PREVIEW_TOKEN_SECRET_PREVIOUS].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
}

function parsePayload(payloadB64: string): PreviewTokenPayload | null {
  const bytes = base64UrlDecode(payloadB64);
  if (!bytes) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  if (typeof p.uid !== "string" || p.uid.length === 0) return null;
  if (typeof p.projectId !== "string" || p.projectId.length === 0) return null;
  if (typeof p.exp !== "number" || !Number.isFinite(p.exp)) return null;
  if (typeof p.nonce !== "string" || p.nonce.length === 0) return null;
  return {
    v: 1,
    uid: p.uid,
    projectId: p.projectId,
    exp: p.exp,
    nonce: p.nonce,
  };
}

/**
 * Verify a preview token for `projectId`. Returns the verified claims, or null
 * when the token is malformed, signed with an unknown secret, expired, valid
 * for longer than PREVIEW_TOKEN_MAX_AGE_S, bound to another project, or when no
 * secret is configured (fail closed).
 */
export async function verifyPreviewToken(
  token: string,
  projectId: string,
  env: Env,
  nowMs: number = Date.now(),
): Promise<VerifiedPreviewToken | null> {
  const secrets = previewTokenSecrets(env);
  if (secrets.length === 0) {
    console.error("[PREVIEW] PREVIEW_TOKEN_SECRET not configured; rejecting");
    return null;
  }
  if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
    return null;
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  if (sigB64.includes(".")) return null;
  const signature = base64UrlDecode(sigB64);
  if (!signature || signature.length !== 32) return null;

  // Signature first: nothing about an unsigned payload is worth reading.
  const data = new TextEncoder().encode(payloadB64);
  let signed = false;
  for (const secret of secrets) {
    const key = await importHmacKey(secret);
    // crypto.subtle.verify is constant-time.
    if (await crypto.subtle.verify("HMAC", key, signature, data)) {
      signed = true;
      break;
    }
  }
  if (!signed) return null;

  const payload = parsePayload(payloadB64);
  if (!payload) return null;
  if (payload.projectId !== projectId) return null;

  const nowS = Math.floor(nowMs / 1000);
  const remainingSeconds = payload.exp - nowS;
  if (remainingSeconds <= 0) return null;
  if (remainingSeconds > PREVIEW_TOKEN_MAX_AGE_S + CLOCK_SKEW_S) return null;

  return {
    uid: payload.uid,
    projectId: payload.projectId,
    exp: payload.exp,
    remainingSeconds,
  };
}

/**
 * The Set-Cookie value that carries a verified token to every sub-request of
 * one project's Storybook, embedded in a third-party page (the Figma plugin):
 *
 *   Path=/<projectId>/  — one project per cookie, never sent for another
 *   SameSite=None       — the CDN is a third party under figma.com
 *   Partitioned         — CHIPS: keyed by the top-level site, so browsers that
 *                         block third-party cookies still send it
 *   Max-Age=<remaining> — lives exactly as long as the token
 */
export function previewCookie(
  token: string,
  verified: VerifiedPreviewToken,
): string {
  return [
    `${PREVIEW_COOKIE_NAME}=${token}`,
    `Path=/${verified.projectId}/`,
    "Secure",
    "HttpOnly",
    "SameSite=None",
    "Partitioned",
    `Max-Age=${verified.remainingSeconds}`,
  ].join("; ");
}
