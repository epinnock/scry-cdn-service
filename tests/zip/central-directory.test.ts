import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getCentralDirectory, clearCentralDirectoryCache } from '@/services/zip/central-directory';
import type { ZipCentralDirectory } from '@/types/zip';

const { mockUnzip, mockR2RangeReader } = vi.hoisted(() => ({
  mockUnzip: vi.fn(),
  mockR2RangeReader: vi.fn()
}));

vi.mock('unzipit', () => ({
  unzip: mockUnzip
}));

vi.mock('@/adapters/zip/r2-range-reader', () => ({
  R2RangeReader: mockR2RangeReader
}));

describe('Central Directory Service', () => {
  let mockBucket: { head: ReturnType<typeof vi.fn>; get: ReturnType<typeof vi.fn> };
  let mockKV: {
    get: ReturnType<typeof vi.fn>;
    put: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  let mockReader: { getLength: ReturnType<typeof vi.fn>; read: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockUnzip.mockReset();
    mockR2RangeReader.mockReset();

    mockBucket = {
      head: vi.fn().mockResolvedValue({ size: 5000, etag: 'zip-v1' }),
      get: vi.fn()
    };

    mockKV = {
      get: vi.fn(),
      put: vi.fn(),
      delete: vi.fn()
    };

    mockReader = {
      getLength: vi.fn().mockResolvedValue(5000),
      read: vi.fn()
    };

    mockR2RangeReader.mockImplementation(() => mockReader);
  });

  describe('getCentralDirectory', () => {
    it('returns cached central directory from KV', async () => {
      const cachedCD: ZipCentralDirectory = {
        etag: 'zip-v1',
        entries: {
          'index.html': {
            name: 'index.html',
            size: 1024,
            compressedSize: 512,
            offset: 0,
            crc32: 12345,
            compressionMethod: 8
          }
        },
        totalSize: 5000,
        cachedAt: new Date().toISOString()
      };

      mockKV.get.mockResolvedValue(cachedCD);

      const result = await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');

      expect(result).toEqual(cachedCD);
      expect(mockBucket.head).toHaveBeenCalledWith('test.zip');
      expect(mockKV.get).toHaveBeenCalledWith('cd:test.zip', 'json');
      expect(mockR2RangeReader).not.toHaveBeenCalled();
      expect(mockUnzip).not.toHaveBeenCalled();
    });

    it('hydrates from R2 when KV cache misses and caches result', async () => {
      mockKV.get.mockResolvedValue(null);

      mockUnzip.mockResolvedValue({
        entries: {
          'index.html': {
            size: 1024,
            compressedSize: 512,
            crc32: 12345,
            compressionMethod: 8,
            _rawEntry: {
              relativeOffsetOfLocalHeader: 256,
              crc32: 12345
            }
          },
          'styles.css': {
            size: 256,
            compressedSize: 200,
            crc32: 67890,
            compressionMethod: 0,
            _rawEntry: {
              relativeOffsetOfLocalHeader: 1024,
              crc32: 67890
            }
          }
        }
      });

      const result = await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');

      expect(mockKV.get).toHaveBeenCalledWith('cd:test.zip', 'json');
      expect(mockR2RangeReader).toHaveBeenCalledWith(mockBucket, 'test.zip', { size: 5000, etag: 'zip-v1' });
      expect(mockUnzip).toHaveBeenCalledWith(mockReader);
      expect(mockReader.getLength).toHaveBeenCalledTimes(1);

      expect(result.entries['index.html']).toMatchObject({
        name: 'index.html',
        size: 1024,
        compressedSize: 512,
        offset: 256,
        crc32: 12345,
        compressionMethod: 8
      });
      expect(result.entries['styles.css']).toMatchObject({
        name: 'styles.css',
        size: 256,
        compressedSize: 200,
        offset: 1024,
        crc32: 67890,
        compressionMethod: 0
      });
      expect(result.totalSize).toBe(5000);
      expect(typeof result.cachedAt).toBe('string');

      expect(mockKV.put).toHaveBeenCalledTimes(1);
      const [, payload, options] = mockKV.put.mock.calls[0];
      expect(options).toEqual({ expirationTtl: 86400 });

      const parsedPayload = JSON.parse(payload);
      expect(parsedPayload.entries['index.html']).toMatchObject({
        name: 'index.html',
        size: 1024,
        compressedSize: 512,
        offset: 256,
        crc32: 12345,
        compressionMethod: 8
      });
      expect(parsedPayload.totalSize).toBe(5000);
      expect(parsedPayload.etag).toBe('zip-v1');
      expect(typeof parsedPayload.cachedAt).toBe('string');
    });

    it.each([undefined, 'zip-v0'])('refreshes legacy or overwritten metadata (etag %s)', async (etag) => {
      mockKV.get.mockResolvedValue({ etag, entries: { 'old.js': {} }, totalSize: 5000 });
      mockUnzip.mockResolvedValue({ entries: { 'new.js': { size: 42, compressedSize: 42 } } });

      const result = await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');

      expect(result.etag).toBe('zip-v1');
      expect(result.entries).toHaveProperty('new.js');
      expect(result.entries).not.toHaveProperty('old.js');
      expect(mockKV.put).toHaveBeenCalledTimes(1);
    });

    it('does not serve a cached directory after the ZIP is deleted', async () => {
      mockBucket.head.mockResolvedValue(null);
      mockKV.get.mockResolvedValue({ etag: 'zip-v1', entries: {} });
      await expect(getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip'))
        .rejects.toThrow('ZIP file not found: test.zip');
      expect(mockKV.get).not.toHaveBeenCalled();
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('does not trust cached metadata when R2 HEAD fails', async () => {
      mockBucket.head.mockRejectedValue(new Error('R2 unavailable'));
      await expect(getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip'))
        .rejects.toThrow('R2 unavailable');
      expect(mockKV.get).not.toHaveBeenCalled();
    });

    it('works without a KV binding', async () => {
      mockUnzip.mockResolvedValue({ entries: {} });
      const result = await getCentralDirectory(mockBucket as any, undefined, 'test.zip');
      expect(result.etag).toBe('zip-v1');
      expect(mockUnzip).toHaveBeenCalled();
    });

    it('does not reuse or write an unverifiable cache entry when ETag is absent', async () => {
      mockBucket.head.mockResolvedValue({ size: 5000 });
      mockKV.get.mockResolvedValue({ entries: { 'old.js': {} }, totalSize: 5000 });
      mockUnzip.mockResolvedValue({ entries: {} });
      const result = await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');
      expect(result.entries).toEqual({});
      expect(mockKV.put).not.toHaveBeenCalled();
    });

    it('serves fresh metadata even if the KV write fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockKV.put.mockRejectedValue(new Error('KV unavailable'));
      mockUnzip.mockResolvedValue({ entries: {} });
      const result = await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');
      expect(result.etag).toBe('zip-v1');
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('falls back to R2 when KV read fails', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockKV.get.mockRejectedValue(new Error('KV error'));

      mockUnzip.mockResolvedValue({
        entries: {}
      });

      await getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip');

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to read central directory from KV cache')
      );
      expect(mockR2RangeReader).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('propagates errors from unzip when R2 access fails', async () => {
      mockKV.get.mockResolvedValue(null);
      const failure = new Error('range read failed');
      mockUnzip.mockRejectedValue(failure);

      await expect(getCentralDirectory(mockBucket as any, mockKV as any, 'test.zip')).rejects.toThrow(
        'Failed to read central directory from ZIP'
      );

      expect(mockKV.put).not.toHaveBeenCalled();
    });
  });

  describe('clearCentralDirectoryCache', () => {
    it('deletes central directory from KV', async () => {
      await clearCentralDirectoryCache(mockKV as any, 'test.zip');

      expect(mockKV.delete).toHaveBeenCalledWith('cd:test.zip');
    });

    it('swallows deletion errors', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockKV.delete.mockRejectedValue(new Error('Delete failed'));

      await expect(clearCentralDirectoryCache(mockKV as any, 'test.zip')).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to clear central directory cache')
      );
      warnSpy.mockRestore();
    });

    it('handles multiple ZIPs', async () => {
      await clearCentralDirectoryCache(mockKV as any, 'test1.zip');
      await clearCentralDirectoryCache(mockKV as any, 'test2.zip');

      expect(mockKV.delete).toHaveBeenNthCalledWith(1, 'cd:test1.zip');
      expect(mockKV.delete).toHaveBeenNthCalledWith(2, 'cd:test2.zip');
    });
  });
});
