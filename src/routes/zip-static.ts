import { Hono } from "hono";
import { parsePathForUUID } from "@/utils/subdomain";
import { getMimeType } from "@/utils/mime-types";
import { getCentralDirectory } from "@/services/zip/central-directory";
import { extractFile } from "@/services/zip/extractor";
import { normalizePath, isPathSafe, getCacheControl } from "@/utils/zip-utils";
import type { Env } from "@/types/env";

export const zipStaticRoutes = new Hono<{ Bindings: Env }>();

function isCoverageReportRequest(filePath: string): boolean {
  const pathNoQuery = filePath.split("?")[0];
  return pathNoQuery.endsWith("coverage-report.json");
}

function getCoverageCacheControl(env: Env): string {
  // Coverage reports are immutable once created.
  // Use aggressive caching in production and short caching elsewhere.
  const isProd = env.NODE_ENV === "production";
  return isProd ? "public, max-age=31536000, immutable" : "public, max-age=60";
}

/**
 * Serve static files from ZIP archives stored in R2
 * Uses HTTP range requests for efficient partial extraction
 * Supports both legacy (simple UUID) and Upload Service (compound UUID) patterns
 */
zipStaticRoutes.get("/*", async (c) => {
  const url = new URL(c.req.url);
  const cache = c.env.CDN_CACHE as any;

  // Extract UUID from path (view.domain.com/{uuid}/path)
  const pathInfo = parsePathForUUID(url.pathname);

  console.log("[DEBUG] URL pathname:", url.pathname);
  console.log("[DEBUG] Parsed pathInfo:", JSON.stringify(pathInfo, null, 2));

  if (!pathInfo || !pathInfo.isValid || !pathInfo.resolution) {
    console.error("[ERROR] Invalid path format:", {
      pathInfo,
      pathname: url.pathname,
    });
    return c.text("Invalid format. Expected: view.domain.com/{uuid}/path", 400);
  }

  const { uuid, filePath, resolution } = pathInfo;
  console.log("[DEBUG] UUID:", uuid);
  console.log("[DEBUG] File path:", filePath);
  console.log("[DEBUG] Resolution:", JSON.stringify(resolution, null, 2));

  // NEW: Select bucket based on resolution type
  const storage =
    resolution.bucket === "UPLOAD_BUCKET"
      ? (c.env.UPLOAD_BUCKET! as any)
      : (c.env.STATIC_SITES! as any);

  // NEW: Use resolved ZIP key from path resolver
  const zipKey = resolution.zipKey;

  console.log("[DEBUG] Selected bucket:", resolution.bucket);
  console.log("[DEBUG] ZIP key:", zipKey);
  console.log("[DEBUG] Storage bucket available:", storage ? "YES" : "NO");

  // Coverage report requests are stored as standalone JSON objects in R2:
  //   {projectId}/{versionId}/coverage-report.json
  // They are not part of storybook.zip.
  if (isCoverageReportRequest(filePath)) {
    // Derive the coverage key from the resolved zip key:
    //   {project}/{version}/storybook.zip -> {project}/{version}/coverage-report.json
    //   {project}/storybook.zip           -> {project}/coverage-report.json
    const coverageKey = zipKey.replace(
      /\/storybook\.zip$/,
      "/coverage-report.json",
    );

    const object = await storage.get(coverageKey);

    if (!object) {
      return new Response(
        JSON.stringify({ error: "Coverage report not found" }),
        {
          status: 404,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    }

    const cacheControl = getCoverageCacheControl(c.env);

    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Cache-Control", cacheControl);

    // Hint for CDNs that understand separate cache-control semantics.
    // (Harmless if ignored)
    headers.set(
      "CDN-Cache-Control",
      cacheControl.includes("31536000") ? "max-age=31536000" : "max-age=60",
    );

    // Best-effort metadata
    if (object.size) headers.set("Content-Length", String(object.size));
    if (object.etag) headers.set("ETag", object.etag);

    return new Response(object.body, { headers });
  }

  // Normalize and validate requested path
  const cleanPath = normalizePath("/" + filePath);

  if (!isPathSafe(cleanPath)) {
    return c.text("Invalid path", 400);
  }

  try {
    // Get central directory (cached in KV)
    console.log("[DEBUG] Fetching central directory for:", zipKey);
    const centralDir = await getCentralDirectory(storage, cache, zipKey);
    console.log(
      "[DEBUG] Central directory entries count:",
      Object.keys(centralDir.entries).length,
    );
    console.log(
      "[DEBUG] Available files:",
      Object.keys(centralDir.entries).slice(0, 10).join(", "),
    );

    // Find the requested file
    const fileEntry = centralDir.entries[cleanPath];
    console.log("[DEBUG] Looking for file:", cleanPath);
    console.log("[DEBUG] File found:", fileEntry ? "YES" : "NO");

    if (!fileEntry) {
      // Try index.html for potential SPA routing
      if (!cleanPath.includes(".")) {
        const indexEntry = centralDir.entries["index.html"];

        if (indexEntry) {
          const data = await extractFile(storage, zipKey, indexEntry, centralDir.etag);
          return new Response(data, {
            headers: {
              "Content-Type": "text/html",
              "Cache-Control": getCacheControl("index.html"),
              "Access-Control-Allow-Origin": c.env.ALLOWED_ORIGINS || "*",
            },
          });
        }
      }

      return c.text("Not Found", 404);
    }

    // Extract file using range request
    const fileData = await extractFile(storage, zipKey, fileEntry, centralDir.etag);

    // Determine content type
    const contentType = getMimeType(cleanPath);

    // Build response headers
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Cache-Control": getCacheControl(cleanPath),
      "Access-Control-Allow-Origin": c.env.ALLOWED_ORIGINS || "*",
      "Content-Length": fileEntry.size.toString(),
      ETag: `"${fileEntry.crc32}"`,
    };

    return new Response(fileData, { headers });
  } catch (error) {
    console.error("[ERROR] Error serving file from ZIP:", error);
    console.error("[ERROR] Details:", {
      bucket: resolution.bucket,
      zipKey: zipKey,
      uuid: uuid,
      filePath: filePath,
      cleanPath: cleanPath,
      errorMessage: error instanceof Error ? error.message : String(error),
      errorStack: error instanceof Error ? error.stack : undefined,
    });
    // A build that was never uploaded is not a server fault. Reporting 500
    // made an absent version indistinguishable from a corrupt one, which sent
    // an entire debugging session looking for a broken build that did not
    // exist (ISSUES.md #7).
    const message = error instanceof Error ? error.message : String(error);
    if (/ZIP file not found/i.test(message)) {
      return c.text("Not found", 404);
    }

    return c.text("Internal Server Error", 500);
  }
});
