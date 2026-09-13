/**
 * ZIP file central directory metadata
 * Cached in KV for fast lookups
 */
export interface ZipCentralDirectory {
  /** R2 identity used to reject stale metadata after an overwrite. Absent in legacy caches. */
  etag?: string;
  /** Map of file paths to their entries */
  entries: Record<string, ZipFileEntry>;
  /** Total size of the ZIP file in bytes */
  totalSize: number;
  /** ISO timestamp when cached */
  cachedAt: string;
}

/**
 * Individual file entry within a ZIP
 */
export interface ZipFileEntry {
  /** File path within ZIP */
  name: string;
  /** Uncompressed file size */
  size: number;
  /** Compressed size in ZIP */
  compressedSize: number;
  /** Byte offset within ZIP file */
  offset: number;
  /** CRC32 checksum */
  crc32: number;
  /** Compression method (0=stored, 8=deflate) */
  compressionMethod: number;
}

/**
 * ZIP extraction metrics for monitoring
 */
export interface ZipExtractionMetrics {
  zipKey: string;
  requestedPath: string;
  cacheHit: boolean;
  centralDirReadMs?: number;
  rangeRequestMs: number;
  decompressionMs: number;
  totalMs: number;
  fileSizeBytes: number;
  compressedSizeBytes: number;
}
