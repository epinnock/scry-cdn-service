/**
 * Opaque, log-safe tag for a user id.
 *
 * Workers Logs must never carry an email, a raw uid or cookie names
 * (observability audit 2026-09-26, gap 6). When LOG_HASH_SALT is set, a uid is
 * logged as the first 8 hex chars of sha256(salt + ":" + uid) — enough to
 * correlate one user's requests within the log window, not enough to recover
 * the uid without the salt. With no salt configured nothing identifying is
 * logged at all ("none").
 */
export async function uidTag(
  uid: string | undefined | null,
  salt: string | undefined,
): Promise<string> {
  if (!uid || !salt) return "none";
  const bytes = new TextEncoder().encode(`${salt}:${uid}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest).slice(0, 4))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
