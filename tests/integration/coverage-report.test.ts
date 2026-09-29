import { describe, it, expect, vi } from 'vitest';
import { createApp } from '@/app';

describe('coverage report serving', () => {
  it('serves coverage-report.json from R2 with correct headers (200)', async () => {
    const app = createApp();

    const bucketGet = vi.fn(async (key: string) => {
      expect(key).toBe('test-project/v1.0.0/coverage-report.json');
      return {
        body: new Response(JSON.stringify({ ok: true })).body!,
        size: 11,
        etag: 'etag-1'
      };
    });

    const env: any = {
      NODE_ENV: 'production',
      UPLOAD_BUCKET: {
        get: bucketGet
      },
      CDN_CACHE: {
        get: vi.fn().mockResolvedValue({
          visibility: 'public',
          memberIds: [],
          cachedAt: Date.now(),
        }),
      }
    };

    const req = new Request('https://view.scrymore.com/test-project/v1.0.0/coverage-report.json', {
      headers: {
        Origin: 'https://dashboard.scrymore.com'
      }
    });

    const res = await app.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dashboard.scrymore.com');

    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it('returns 404 JSON when coverage-report.json is missing', async () => {
    const app = createApp();

    const env: any = {
      NODE_ENV: 'production',
      UPLOAD_BUCKET: {
        get: vi.fn(async () => null)
      },
      CDN_CACHE: {
        get: vi.fn().mockResolvedValue({
          visibility: 'public',
          memberIds: [],
          cachedAt: Date.now(),
        }),
      }
    };

    const req = new Request('https://view.scrymore.com/test-project/v1.0.0/coverage-report.json', {
      headers: {
        Origin: 'https://dashboard.scrymore.com'
      }
    });

    const res = await app.fetch(req, env);
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://dashboard.scrymore.com');

    const body = await res.json();
    expect(body).toEqual({ error: 'Coverage report not found', request_id: res.headers.get('x-scry-request-id') });
  });

  it('uses short cache in non-production environments', async () => {
    const app = createApp();

    const env: any = {
      NODE_ENV: 'development',
      UPLOAD_BUCKET: {
        get: vi.fn(async () => ({
          body: new Response('{"x":1}').body!
        }))
      },
      CDN_CACHE: {
        get: vi.fn().mockResolvedValue({
          visibility: 'public',
          memberIds: [],
          cachedAt: Date.now(),
        }),
      }
    };

    const req = new Request('https://view.scrymore.com/test-project/v1.0.0/coverage-report.json');
    const res = await app.fetch(req, env);

    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
  });
});
