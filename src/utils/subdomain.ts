import { resolveUUID, type UUIDResolution } from "./path-resolver";

export interface SubdomainInfo {
  uuid: string;
  isValid: boolean;
}

/**
 * Parse subdomain to extract UUID
 * Expected format: view-{uuid}.domain.com
 */
export function parseSubdomain(hostname: string): SubdomainInfo | null {
  const parts = hostname.split(".");
  if (parts.length < 2) {
    return null;
  }

  const subdomain = parts[0];
  const match = subdomain.match(/^view-(.+)$/);

  if (!match) {
    return null;
  }

  const uuid = match[1];

  // Basic UUID validation (can be more strict)
  if (!uuid || uuid.length < 3) {
    return { uuid, isValid: false };
  }

  return { uuid, isValid: true };
}

/**
 * Validate UUID format (simple version)
 * Can be enhanced with proper UUID v4 validation
 */
export function isValidUUID(uuid: string): boolean {
  // Allow alphanumeric and hyphens, minimum 3 chars
  return /^[a-zA-Z0-9-]{3,}$/.test(uuid);
}

/**
 * The version-name grammar the upload service enforces. Copied verbatim from
 * scry-storybook-upload-service src/app.ts:47 (`VERSION_SEGMENT_REGEX`, line 48
 * on origin/main as of 2026-09-26). The two services share no package, so keep
 * this copy in sync by hand: every name the upload accepts must open here
 * (ISSUES.md #53; features/cdn-version-names-missing-zip).
 */
export const UPLOAD_VERSION_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * Heuristic for a *bare* second segment, i.e. `/{project}/{x}` with nothing
 * after it. There the URL has no delimiter between a version and a file at the
 * project root, so the spelling decides: a file extension means a file
 * (`/{project}/iframe.html`), otherwise a version (`/{project}/v1`). This is the
 * pre-2026-09-26 rule, unchanged, and it is used ONLY for the bare case.
 */
function isBareVersionSegment(segment: string): boolean {
  if (segment.length < 2) return false;

  // Well-known shapes first, so v1.2.3 is not mistaken for a file.
  const commonPatterns =
    /^(v[\d.-]+|pr-\d+|dev-[\w-]+|beta[\w-]*|alpha[\w-]*|canary[\w-]*|rc-?\d*|staging|latest|main|production)$/i;
  if (commonPatterns.test(segment)) return true;

  // Anything else carrying a file extension is a filename, not a version.
  if (/\.[A-Za-z0-9]{1,8}$/.test(segment)) return false;

  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
}

/**
 * Decide whether segments[1] is the version, by position:
 *
 * - `/{project}/{version}/{file...}` or `/{project}/{version}/`: when another
 *   segment (or a trailing slash) follows, segment 2 IS the version, provided it
 *   matches the upload grammar. `1.8.2`, `v1.2.3-rc.1`, `2026.09.26` all qualify.
 *   The old spelling-based check read anything ending in `.xxx` as a filename
 *   and dropped the version from the R2 key, so a healthy dotted build answered
 *   404 (ISSUES.md #53).
 * - `/{project}/{x}` with nothing after it: the bare heuristic above.
 *
 * A segment that is followed by more path but fails the upload grammar cannot
 * be a stored version; it falls back to "no version" as before, and says so in
 * the log, since that request can only resolve to the project root.
 */
function readVersion(segments: string[], trailingSlash: boolean): string {
  if (segments.length < 2) return "";
  const candidate = segments[1];
  const followed = segments.length >= 3 || trailingSlash;

  if (!followed) {
    return isBareVersionSegment(candidate) ? candidate : "";
  }
  if (UPLOAD_VERSION_REGEX.test(candidate)) {
    return candidate;
  }
  console.warn("[subdomain] version segment rejected by upload grammar", {
    segment: candidate.slice(0, 64),
    length: candidate.length,
  });
  return "";
}

function hasTrailingSlash(path: string): boolean {
  const q = path.search(/[?#]/);
  const p = q === -1 ? path : path.slice(0, q);
  return p.length > 1 && p.endsWith("/");
}

/**
 * Parse path to extract projectId, versionId, and file path
 * Expected format: /{projectId}/{versionId}/path/to/file.html
 * Or: /{projectId}/path/to/file.html (no version)
 */
export interface PathInfo {
  uuid: string; // Kept for compatibility, will be projectId-versionId
  filePath: string;
  isValid: boolean;
  resolution?: UUIDResolution;
}

/**
 * Extract projectId and versionId from a Referer URL.
 * Used to redirect root-level asset requests (e.g., /placeholder.svg)
 * back to the correct project/version path.
 */
export function extractProjectFromReferer(
  refererUrl: string,
): { projectId: string; versionId: string } | null {
  try {
    const url = new URL(refererUrl);
    const cleanPath = url.pathname.slice(1);
    const segments = cleanPath.split("/").filter((s) => s);

    if (segments.length === 0) {
      return null;
    }

    const projectId = segments[0];
    if (!isValidUUID(projectId)) {
      return null;
    }

    const versionId = readVersion(segments, hasTrailingSlash(url.pathname));

    return { projectId, versionId };
  } catch {
    return null;
  }
}

export function parsePathForUUID(pathname: string): PathInfo | null {
  // Remove leading slash
  const cleanPath = pathname.startsWith("/") ? pathname.slice(1) : pathname;

  // Split path into segments
  const segments = cleanPath.split("/").filter((s) => s); // Remove empty segments

  // Need at least projectId
  if (segments.length === 0) {
    return null;
  }

  const projectId = segments[0];

  // Validate projectId format (alphanumeric + hyphens, min 3 chars)
  if (!isValidUUID(projectId)) {
    return { uuid: projectId, filePath: "", isValid: false };
  }

  // Position decides whether segment 2 is the version (see readVersion).
  const versionId = readVersion(segments, hasTrailingSlash(cleanPath));
  const filePathStartIndex = versionId ? 2 : 1;

  // Remaining segments form the file path
  const filePath = segments.slice(filePathStartIndex).join("/");

  // Create resolution
  const zipKey = versionId
    ? `${projectId}/${versionId}/storybook.zip`
    : `${projectId}/storybook.zip`;

  const resolution: UUIDResolution = {
    type: "compound",
    uuid: versionId
      ? `${projectId}-${versionId.replace(/\./g, "-")}`
      : projectId,
    project: projectId,
    version: versionId,
    zipKey,
    bucket: "UPLOAD_BUCKET",
  };

  return {
    uuid: resolution.uuid,
    filePath: filePath || "index.html", // Default to index.html if no file path
    isValid: true,
    resolution,
  };
}
