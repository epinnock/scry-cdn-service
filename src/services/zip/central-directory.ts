import { unzip } from 'unzipit';
import { R2RangeReader } from '@/adapters/zip/r2-range-reader';
import type { ZipCentralDirectory } from '@/types/zip';
import type { R2Bucket, R2Object } from '@cloudflare/workers-types';

/**
 * Get central directory from cache or read from R2.
 *
 * In some local-dev modes KV may not be bound; caching is optional.
 */
export async function getCentralDirectory(
  bucket: R2Bucket,
  kv: KVNamespace | undefined,
  zipKey: string
): Promise<ZipCentralDirectory> {
  const cacheKey = `cd:${zipKey}`;
  // Paths are mutable (for example /main/). Validate against R2 even on a
  // cache hit; a TTL or KV deletion alone cannot make an overwrite coherent.
  const object = await bucket.head(zipKey);
  if (!object) throw new Error(`ZIP file not found: ${zipKey}`);

  // Try KV cache first (if available)
  if (kv) {
    try {
      const cached = await kv.get<ZipCentralDirectory>(cacheKey, 'json');
      if (object.etag && cached?.etag === object.etag) {
        return cached;
      }
    } catch (error) {
      console.warn(`Failed to read central directory from KV cache: ${error}`);
      // Continue to read from R2
    }
  }

  // Read from R2 using range requests
  const centralDir = await readCentralDirectoryFromR2(bucket, zipKey, object);

  // Cache for 24 hours (best-effort)
  if (kv && object.etag) {
    try {
      await kv.put(cacheKey, JSON.stringify(centralDir), {
        expirationTtl: 86400,
      });
    } catch (error) {
      console.warn(`Failed to cache central directory in KV: ${error}`);
      // Continue even if caching fails
    }
  }

  return centralDir;
}

/**
 * Read central directory from R2 using unzipit
 */
async function readCentralDirectoryFromR2(
  bucket: R2Bucket,
  zipKey: string,
  object: R2Object
): Promise<ZipCentralDirectory> {
  const reader = new R2RangeReader(bucket, zipKey, object);

  try {
    const { entries } = await unzip(reader);

    const centralDir: ZipCentralDirectory = {
      entries: {},
      etag: object.etag,
      totalSize: await reader.getLength(),
      cachedAt: new Date().toISOString()
    };

    // Convert unzipit entries to our format
    for (const [name, entry] of Object.entries(entries)) {
      // Get offset from the raw entry
      const offset = (entry as any)._rawEntry?.relativeOffsetOfLocalHeader || 0;
        
      centralDir.entries[name] = {
        name,
        size: (entry as any).size,
        compressedSize: (entry as any).compressedSize,
        offset,
        crc32: (entry as any).crc32 || (entry as any)._rawEntry?.crc32,
        compressionMethod: (entry as any).compressionMethod
      };
    }

    return centralDir;
  } catch (error) {
    throw new Error(`Failed to read central directory from ZIP: ${error}`);
  }
}

/**
 * Clear central directory cache for a specific ZIP
 * Useful when ZIP is updated
 */
export async function clearCentralDirectoryCache(
  kv: KVNamespace,
  zipKey: string
): Promise<void> {
  const cacheKey = `cd:${zipKey}`;
  try {
    await kv.delete(cacheKey);
  } catch (error) {
    console.warn(`Failed to clear central directory cache: ${error}`);
  }
}
