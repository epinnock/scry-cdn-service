import type { StorageAdapter } from "./interface";
import { R2StorageAdapter } from "./r2";
import type { Env } from "@/types/env";

export async function createStorageAdapter(env: Env): Promise<StorageAdapter> {
  // Cloudflare Workers environment (R2)
  if (env.STATIC_SITES) {
    return new R2StorageAdapter(env.STATIC_SITES);
  }

  // Docker/Node.js environment
  const storageType = env.STORAGE_TYPE || "r2";

  if (storageType === "filesystem") {
    const storagePath = env.STORAGE_PATH || "/data/static-sites";
    try {
      // Use computed import path to prevent bundler from including this in Cloudflare builds
      const modulePath = "./file" + "system";
      const { FilesystemStorageAdapter } = await import(
        /* @vite-ignore */ modulePath
      );
      return new FilesystemStorageAdapter(storagePath);
    } catch {
      throw new Error(
        "Filesystem storage is not available in this environment",
      );
    }
  }

  if (storageType === "r2") {
    // R2 adapter would be imported here for Docker/Node.js environments
    // This would use the R2 REST API with credentials
    // return new R2APIStorageAdapter(...);
    throw new Error(
      "R2 storage adapter for Docker not yet implemented. Use Cloudflare Workers with R2 binding or filesystem storage.",
    );
  }

  throw new Error(`Unsupported storage type: ${storageType}`);
}
