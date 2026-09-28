import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '@/app';

const STAGE = 'https://dashboard-stage.scrymore.com';
const PREVIEW = 'https://scry-developer-dashboard-git-red-0d146d-ejiro-pinnocks-projects.vercel.app';
const configured = (name: string) => {
  // Exercise the checked-in deployment bindings, not a second hand-written allowlist.
  const toml = readFileSync(new URL('../../cloudflare/wrangler.toml', import.meta.url), 'utf8');
  const section = toml.split(`[env.${name}]`)[1].split(/\n\[/)[0];
  const vars = section.match(/vars\s*=\s*\{([\s\S]*?)\}/)![1];
  return Object.fromEntries([...vars.matchAll(/([A-Z_]+)\s*=\s*"([^"]*)"/g)].map((m) => [m[1], m[2]]));
};
const env = (more = {}) => ({
  ...configured('staging'), NODE_ENV: 'production',
  // The stage secret may contain additional legitimate callers; preserve it.
  CORS_ALLOWED_ORIGINS: 'https://existing-stage-consumer.example,https://dashboard.scrymore.com',
  UPLOAD_BUCKET: { get: vi.fn().mockResolvedValue(null) },
  CDN_CACHE: { get: vi.fn().mockResolvedValue({ visibility: 'public', memberIds: [], cachedAt: Date.now() }), put: vi.fn() },
  ...more,
});
const request = (origin: string, method = 'GET', path = '/healthz') => new Request(`https://cdn.example${path}`, {
  method, headers: { Origin: origin, ...(method === 'OPTIONS' ? { 'Access-Control-Request-Method': 'GET' } : {}) },
});
function credentialed(response: Response, origin: string) {
  expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
  expect(response.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  expect(response.headers.get('Vary')?.split(',').map((v) => v.trim())).toContain('Origin');
}
beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {}); });

describe('stage credentialed coverage CORS', () => {
  it.each([STAGE, PREVIEW])('allows exact stage caller %s on preflight, success, missing artifact and private denial', async (origin) => {
    const app = createApp(); const bindings = env();
    for (const [method, path, status] of [['OPTIONS', '/project/v1/coverage-report.json', 204], ['GET', '/healthz', 200], ['GET', '/project/v1/coverage-report.json', 404]] as const) {
      const res = await app.fetch(request(origin, method, path), bindings as any);
      expect(res.status).toBe(status); credentialed(res, origin);
    }
    const privateBindings = env({ CDN_CACHE: { get: vi.fn().mockResolvedValue({ visibility: 'private', memberIds: ['synthetic-member'], cachedAt: Date.now() }) } });
    const denied = await app.fetch(request(origin, 'GET', '/private-project/v1/coverage-report.json'), privateBindings as any);
    expect(denied.status).toBe(401); credentialed(denied, origin);
    expect(privateBindings.UPLOAD_BUCKET.get).not.toHaveBeenCalled();
    const broken = env({ UPLOAD_BUCKET: { get: vi.fn().mockRejectedValue(new Error('synthetic bucket failure')) } });
    const failed = await app.fetch(request(origin, 'GET', '/project/v1/coverage-report.json'), broken as any);
    expect(failed.status).toBe(500); credentialed(failed, origin);
  });

  it('preserves existing secret and legacy allowlists', async () => {
    for (const override of [{}, { CORS_ALLOWED_ORIGINS: undefined, ALLOWED_ORIGINS: 'https://existing-stage-consumer.example' }]) {
      const app = createApp();
      credentialed(await app.fetch(request('https://existing-stage-consumer.example'), env(override) as any), 'https://existing-stage-consumer.example');
    }
  });

  it.each(['https://arbitrary.example', 'https://other-preview.vercel.app', `${STAGE}.attacker.example`])('does not grant credentialed access to %s', async (origin) => {
    for (const method of ['GET', 'OPTIONS']) {
      const res = await createApp().fetch(request(origin, method), env() as any);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    }
  });

  it('keeps production callers and ignores a stage extension accidentally present on production', async () => {
    const bindings = env({ ...configured('production'), CORS_STAGE_ALLOWED_ORIGINS: `${STAGE},${PREVIEW}` });
    credentialed(await createApp().fetch(request('https://dashboard.scrymore.com'), bindings as any), 'https://dashboard.scrymore.com');
    for (const origin of [STAGE, PREVIEW]) {
      const res = await createApp().fetch(request(origin), bindings as any);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    }
  });

  it('requires the stage Firebase project and ignores malformed extension origins', async () => {
    for (const more of [
      { FIREBASE_PROJECT_ID: 'scry-dev-dashboard' },
      { CORS_STAGE_ALLOWED_ORIGINS: '*,https://*.vercel.app,https://user:password@dashboard-stage.scrymore.com,https://dashboard-stage.scrymore.com/path' },
    ]) {
      const res = await createApp().fetch(request(STAGE), env(more) as any);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(res.headers.has('Access-Control-Allow-Credentials')).toBe(false);
    }
  });
});
