import { log } from "../lib/log";
import { Hono } from "hono";
import { createStorageAdapter } from "@/adapters/storage/factory";
import { parsePathForUUID } from "@/utils/subdomain";
import { getMimeType } from "@/utils/mime-types";
import type { Env } from "@/types/env";

export const staticRoutes = new Hono<{ Bindings: Env }>();

staticRoutes.get("/*", async (c) => {
  const url = new URL(c.req.url);
  const storage = await createStorageAdapter(c.env);

  // Extract UUID and file path from URL path
  const pathInfo = parsePathForUUID(url.pathname);

  if (!pathInfo || !pathInfo.isValid) {
    return c.text(
      "Invalid path format. Expected: /{uuid}/path/to/file.html",
      400,
    );
  }

  const { uuid, filePath } = pathInfo;

  // Construct storage key
  const objectKey = `${uuid}/${filePath}`;

  try {
    // Fetch from storage
    const object = await storage.get(objectKey);

    if (!object) {
      // Try index.html for potential SPA routing
      if (!filePath.includes(".")) {
        const indexKey = `${uuid}/index.html`;
        const indexObject = await storage.get(indexKey);

        if (indexObject) {
          return serveObject(c, indexObject, "text/html");
        }
      }

      return c.text("Not Found", 404);
    }

    // Determine content type
    const contentType = object.contentType || getMimeType(filePath);

    return serveObject(c, object, contentType);
  } catch {
    log.error("error serving file", { err_code: "static_serve_failed" });
    return c.text("Internal Server Error", 500);
  }
});

function serveObject(c: any, object: any, contentType: string) {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control":
      c.env.CACHE_CONTROL || "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": c.env.ALLOWED_ORIGINS || "*",
  };

  if (object.size) {
    headers["Content-Length"] = object.size.toString();
  }

  if (object.etag) {
    headers["ETag"] = object.etag;
  }

  // Handle different body types
  if (object.body instanceof ReadableStream) {
    return new Response(object.body, { headers });
  }

  return new Response(object.body, { headers });
}
