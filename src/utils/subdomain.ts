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
 * Detect if a path segment is a version identifier
 *
 * Supports multiple version formats:
 * - Semantic: v1.0.0, v2.1.5
 * - Extended: v0.0.0.1, v1.2.3.4
 * - PR builds: pr-001, pr-123
 * - Development: dev-123, dev-snapshot-456
 * - Named: beta-2024, alpha-v2, canary-latest
 * - Environment: staging, latest, main
 */
function isVersionSegment(segment: string): boolean {
  // Minimum length check
  if (segment.length < 2) return false;

  // Well-known shapes first. These are checked before the filename heuristic
  // below because dotted versions (v1.2.3, v0.0.0.1) would otherwise look like
  // they carry a file extension.
  const commonPatterns =
    /^(v[\d.-]+|pr-\d+|dev-[\w-]+|beta[\w-]*|alpha[\w-]*|canary[\w-]*|rc-?\d*|staging|latest|main|production)$/i;
  if (commonPatterns.test(segment)) return true;

  // Anything else carrying a file extension is a filename, not a version:
  // /{project}/{file.ext} must not read its file as a version.
  if (/\.[A-Za-z0-9]{1,8}$/.test(segment)) return false;

  // Otherwise accept any plausible version label. Deploy versions are
  // user-chosen strings, and an allowlist silently reinterpreted every name
  // outside it as a filename — dropping the version from the R2 key and
  // returning 500 for a perfectly healthy build. The runbook's own
  // "aug3-demo-20260803" could never resolve (ISSUES.md #3).
  //
  // Deliberately excludes segments containing '.' so that a dotted filename
  // without a recognised extension still reads as a file.
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
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

    let versionId = "";
    if (segments.length >= 2 && isVersionSegment(segments[1])) {
      versionId = segments[1];
    }

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

  let versionId = "";
  let filePathStartIndex = 1;

  // Check if second segment is a version using flexible detection
  if (segments.length >= 2 && isVersionSegment(segments[1])) {
    versionId = segments[1];
    filePathStartIndex = 2;
  }

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
