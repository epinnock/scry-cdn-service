import pako from 'pako';
import type { ZipFileEntry } from '@/types/zip';
import type { R2Bucket } from '@cloudflare/workers-types';

/**
 * Extract a single file from a ZIP using range requests
 * Only fetches the compressed bytes needed for this specific file
 */
export async function extractFile(
  bucket: R2Bucket | any,
  zipKey: string,
  entry: ZipFileEntry,
  etag?: string
): Promise<ArrayBuffer> {
  // First, fetch the local file header to get the exact offset to compressed data
  // Local file header structure:
  // - Signature (4 bytes): 0x04034b50
  // - Version needed (2 bytes)
  // - Flags (2 bytes)
  // - Compression method (2 bytes)
  // - Last mod time (2 bytes)
  // - Last mod date (2 bytes)
  // - CRC-32 (4 bytes)
  // - Compressed size (4 bytes)
  // - Uncompressed size (4 bytes)
  // - Filename length (2 bytes)
  // - Extra field length (2 bytes)
  // Total: 30 bytes, followed by filename and extra field
  
  const headerObject = await (bucket as any).get(zipKey, {
    ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    range: {
      offset: entry.offset,
      length: 30
    }
  });

  if (!headerObject || !headerObject.body) {
    throw new Error(`Failed to read local header for: ${entry.name}`);
  }

  const headerBytes = new Uint8Array(await headerObject.arrayBuffer());
  
  // Read filename length and extra field length (bytes 26-27 and 28-29)
  const filenameLength = headerBytes[26] | (headerBytes[27] << 8);
  const extraFieldLength = headerBytes[28] | (headerBytes[29] << 8);
  
  // Calculate actual data offset
  const dataOffset = entry.offset + 30 + filenameLength + extraFieldLength;
  
  // Fetch only the compressed bytes for this file using range request
  const object = await (bucket as any).get(zipKey, {
    ...(etag ? { onlyIf: { etagMatches: etag } } : {}),
    range: {
      offset: dataOffset,
      length: entry.compressedSize
    }
  });

  if (!object || !object.body) {
    throw new Error(`Failed to extract file: ${entry.name}`);
  }

  const compressed = await object.arrayBuffer();

  // Decompress based on compression method
  if (entry.compressionMethod === 0) {
    // Stored (no compression)
    return compressed;
  } else if (entry.compressionMethod === 8) {
    // Deflate compression
    try {
      const compressedData = new Uint8Array(compressed);
      const decompressed = pako.inflateRaw(compressedData);
      return decompressed.buffer;
    } catch (error) {
      throw new Error(`Failed to decompress file ${entry.name}: ${error}`);
    }
  } else {
    throw new Error(
      `Unsupported compression method ${entry.compressionMethod} for file ${entry.name}`
    );
  }
}

/**
 * Extract multiple files from a ZIP
 */
export async function extractFiles(
  bucket: R2Bucket | any,
  zipKey: string,
  entries: ZipFileEntry[]
): Promise<Map<string, ArrayBuffer>> {
  const results = new Map<string, ArrayBuffer>();

  for (const entry of entries) {
    try {
      const data = await extractFile(bucket, zipKey, entry);
      results.set(entry.name, data);
    } catch (error) {
      console.error(`Failed to extract ${entry.name}: ${error}`);
      // Continue with other files
    }
  }

  return results;
}
