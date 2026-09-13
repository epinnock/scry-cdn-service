import { describe, it, expect, vi } from 'vitest';
import { zipStaticRoutes } from '@/routes/zip-static';

// Real stored ZIPs with index.html and assets/{old,new}.js, generated with
// Python zipfile. Equal byte sizes but reversed entry order exercise changed
// offsets as well as changed file names after an overwrite.
const oldZip = Buffer.from('UEsDBBQAAAAAAAAAIVxZzq/NJQAAACUAAAAKAAAAaW5kZXguaHRtbDxzY3JpcHQgc3JjPSJhc3NldHMvb2xkLmpzIj48L3NjcmlwdD5QSwMEFAAAAAAAAAAhXJZXnR8SAAAAEgAAAA0AAABhc3NldHMvb2xkLmpzY29uc29sZS5sb2coIm9sZCIpUEsBAhQDFAAAAAAAAAAhXFnOr80lAAAAJQAAAAoAAAAAAAAAAAAAAIABAAAAAGluZGV4Lmh0bWxQSwECFAMUAAAAAAAAACFclledHxIAAAASAAAADQAAAAAAAAAAAAAAgAFNAAAAYXNzZXRzL29sZC5qc1BLBQYAAAAAAgACAHMAAACKAAAAAAA=', 'base64');
const newZip = Buffer.from('UEsDBBQAAAAAAAAAIVyFLJVBEgAAABIAAAANAAAAYXNzZXRzL25ldy5qc2NvbnNvbGUubG9nKCJuZXciKVBLAwQUAAAAAAAAACFc8v5twiUAAAAlAAAACgAAAGluZGV4Lmh0bWw8c2NyaXB0IHNyYz0iYXNzZXRzL25ldy5qcyI+PC9zY3JpcHQ+UEsBAhQDFAAAAAAAAAAhXIUslUESAAAAEgAAAA0AAAAAAAAAAAAAAIABAAAAAGFzc2V0cy9uZXcuanNQSwECFAMUAAAAAAAAACFc8v5twiUAAAAlAAAACgAAAAAAAAAAAAAAgAE9AAAAaW5kZXguaHRtbFBLBQYAAAAAAgACAHMAAACKAAAAAAA=', 'base64');

function setup() {
  let zip: Buffer | null = oldZip;
  let etag = 'old';
  const values = new Map<string, string>();
  const kv = {
    get: vi.fn(async (key: string) => JSON.parse(values.get(key) ?? 'null')),
    put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
  };
  const bucket = {
    head: vi.fn(async () => zip ? { size: zip.length, etag } : null),
    get: vi.fn(async (_key: string, options: { range: { offset: number; length: number }; onlyIf?: { etagMatches: string } }) => {
      if (!zip) return null;
      if (options.onlyIf && options.onlyIf.etagMatches !== etag) return { etag };
      const { offset, length } = options.range;
      const bytes = Uint8Array.from(zip.subarray(offset, offset + length));
      return { body: new Response(bytes).body, arrayBuffer: async () => bytes.buffer };
    }),
  };
  const request = (path: string) => zipStaticRoutes.request(
    `https://view.scrymore.com/test-project/v1/${path}`, {},
    { UPLOAD_BUCKET: bucket, CDN_CACHE: kv } as any,
  );
  return {
    request, bucket, kv, values,
    overwrite: () => { zip = newZip; etag = 'new'; },
    remove: () => { zip = null; },
  };
}

describe('same-path ZIP redeploy', () => {
  it('immediately serves the new index, asset and SPA fallback with a warm cache', async () => {
    expect(oldZip.length).toBe(newZip.length);
    const { request, overwrite, kv, bucket } = setup();
    const first = await request('index.html');
    expect(first.status).toBe(200);
    expect(await first.text()).toContain('assets/old.js');
    expect(kv.put).toHaveBeenCalledTimes(1);

    // An unchanged ZIP reuses the table and only reads the local header + data.
    bucket.get.mockClear();
    expect(await (await request('assets/old.js')).text()).toBe('console.log("old")');
    expect(bucket.get).toHaveBeenCalledTimes(2);
    expect(kv.put).toHaveBeenCalledTimes(1);

    overwrite();
    const second = await request('index.html');
    expect(second.status).toBe(200);
    expect(await second.text()).toContain('assets/new.js');
    expect(await (await request('assets/new.js')).text()).toBe('console.log("new")');
    expect((await request('assets/old.js')).status).toBe(404);
    expect(await (await request('nested/route')).text()).toContain('assets/new.js');
    expect(kv.put).toHaveBeenCalledTimes(2);
  });

  it('rejects an old KV value even if it reappears after the overwrite', async () => {
    const { request, overwrite, values } = setup();
    await request('index.html');
    const stale = new Map(values);
    overwrite();
    await request('index.html');
    for (const [key, value] of stale) values.set(key, value);
    expect(await (await request('assets/new.js')).text()).toBe('console.log("new")');
  });

  it('returns 404 for a deleted ZIP despite a warm cache', async () => {
    const { request, remove } = setup();
    await request('index.html');
    remove();
    expect((await request('index.html')).status).toBe(404);
  });

  it('does not cache a directory when an overwrite races its range reads', async () => {
    const { request, overwrite, bucket, kv } = setup();
    bucket.head.mockImplementationOnce(async () => {
      overwrite();
      return { size: oldZip.length, etag: 'old' };
    });
    expect((await request('index.html')).status).toBe(500);
    expect(kv.put).not.toHaveBeenCalled();
    expect(await (await request('index.html')).text()).toContain('assets/new.js');
  });

  it('does not extract new ZIP bytes with cached old offsets during a race', async () => {
    const { request, overwrite, bucket } = setup();
    await request('index.html');
    bucket.head.mockImplementationOnce(async () => {
      overwrite();
      return { size: oldZip.length, etag: 'old' };
    });
    expect((await request('index.html')).status).toBe(500);
    expect(await (await request('index.html')).text()).toContain('assets/new.js');
  });
});
