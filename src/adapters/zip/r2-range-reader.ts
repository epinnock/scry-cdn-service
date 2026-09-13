import type { R2Bucket, R2Object } from '@cloudflare/workers-types';

/**
 * Custom Reader for unzipit that uses R2 range requests
 * Enables efficient partial ZIP extraction without downloading entire file
 */
export class R2RangeReader {
  private length: number | undefined;

  constructor(
    private bucket: R2Bucket,
    private key: string,
    private object?: Pick<R2Object, 'size' | 'etag'>
  ) {
    this.length = object?.size;
  }

  /**
   * Get the total size of the ZIP file
   */
  async getLength(): Promise<number> {
    if (this.length === undefined) {
      const head = await this.bucket.head(this.key);
      if (!head) {
        throw new Error(`ZIP file not found: ${this.key}`);
      }
      this.length = head.size;
      this.object = head;
    }
    return this.length as number;
  }

  /**
   * Read a specific byte range from the ZIP file using R2 range request
   */
  async read(offset: number, length: number): Promise<Uint8Array> {
    const object = await this.bucket.get(this.key, {
      range: { offset, length },
      // Do not parse a mix of two ZIPs if a redeploy races the range reads.
      ...(this.object?.etag ? { onlyIf: { etagMatches: this.object.etag } } : {})
    });

    if (!object || !('body' in object) || !object.body) {
      throw new Error(`Failed to read range [${offset}, ${offset + length}] from ${this.key}`);
    }

    const arrayBuffer = await object.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }
}
