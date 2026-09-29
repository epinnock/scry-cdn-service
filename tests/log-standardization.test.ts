/**
 * log-standardization (schema v1) contract tests for the CDN service.
 *   golden line      the request line validates against schema v1
 *   guarantee-1      the canary corpus never appears in log output or in a scrubbed Sentry event
 *   guarantee-3      x-scry-request-id is on 2xx, 4xx and 5xx (text and JSON) and equals the logged id
 *   guarantee-4      a broken log sink never fails a request
 * Plus: Sentry is off without a DSN, and a serving fault reaches the reporter with the request id.
 */
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/cloudflare', () => ({
  withSentry: (_options: unknown, handler: unknown) => handler,
  captureException: vi.fn(),
}));

import { createApp } from '@/app';
import { setExceptionReporter } from '@/lib/log';
import { validateLine } from '@/lib/scry-log';
import { scrubBreadcrumb, scrubEvent } from '@/sentry-scrub';

const canary = JSON.parse(readFileSync(new URL('../test-fixtures/canary.json', import.meta.url), 'utf8')) as {
  values: Record<string, string>;
  markers: string[];
};

const P = 'Pz7nQ4wLr8Yb2Vm5Hs1J';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let lines: string[];
const reports: Array<{ err: unknown; tags: Record<string, string> }> = [];

function captureConsole() {
  lines = [];
  const grab = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, m).mockImplementation(grab);
}
const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const requestLines = () => parsed().filter((l) => l.msg === 'request');

function env(over: Record<string, unknown> = {}, visibility: 'public' | 'private' = 'public') {
  return {
    SCRY_ENV: 'staging',
    UPLOAD_BUCKET: { head: vi.fn(async () => null), get: vi.fn(async () => null) },
    CDN_CACHE: {
      get: vi.fn().mockResolvedValue({ visibility, memberIds: [], cachedAt: Date.now() }),
      put: vi.fn(async () => {}),
    },
    ...over,
  } as any;
}
const get = (path: string, e: any, headers: Record<string, string> = {}) =>
  createApp().fetch(new Request(`https://view.scrymore.com${path}`, { headers }), e);

beforeEach(() => {
  vi.restoreAllMocks();
  reports.length = 0;
  setExceptionReporter((err, tags) => reports.push({ err, tags }));
  captureConsole();
});

describe('golden line', () => {
  it('a request line validates against schema v1 and carries the project, no raw URL', async () => {
    const res = await get(`/${P}/v1.0.0/index.html?token=${canary.values.jwt}`, env());
    expect(res.status).toBe(404);
    const [line] = requestLines();
    expect(validateLine(line)).toEqual({ ok: true, errors: [] });
    expect(line).toMatchObject({ v: 1, level: 'warn', service: 'cdn', env: 'staging', status: 404, project: P });
    expect(line.request_id).toBe(res.headers.get('x-scry-request-id'));
    expect(String(line.route)).not.toContain(P);
    expect(JSON.stringify(line)).not.toContain('token');
  });

  it('every line emitted for a failing request is schema-valid', async () => {
    const bucket = { head: vi.fn(async () => { throw new Error('R2 internal error'); }), get: vi.fn() };
    await get(`/${P}/1.8.2/index.html`, env({ UPLOAD_BUCKET: bucket }));
    expect(lines.length).toBeGreaterThan(0);
    for (const l of parsed()) expect(validateLine(l), JSON.stringify(l)).toEqual({ ok: true, errors: [] });
  });
});

describe('guarantee-3 id echoed and logged', () => {
  it('2xx, 4xx, 401 (private), preflight and 5xx all carry the id, and it is the logged id', async () => {
    const r200 = await get('/health', env());
    const r404 = await get(`/${P}/v1/index.html`, env());
    const r401 = await get(`/${P}/v1/index.html`, env({}, 'private'));
    const bucket = { head: vi.fn(async () => { throw new Error('R2 internal error'); }), get: vi.fn() };
    const r500 = await get(`/${P}/1.8.2/index.html`, env({ UPLOAD_BUCKET: bucket }));
    const pre = await createApp().fetch(
      new Request(`https://view.scrymore.com/${P}/v1/x.json`, { method: 'OPTIONS', headers: { Origin: 'https://dashboard.scrymore.com', 'Access-Control-Request-Method': 'GET' } }),
      env(),
    );
    expect([r200.status, r404.status, r401.status, r500.status]).toEqual([200, 404, 401, 500]);
    const logged = new Map(requestLines().map((l) => [l.request_id as string, l]));
    for (const res of [r200, r404, r401, r500, pre]) {
      const id = res.headers.get('x-scry-request-id') ?? '';
      expect(id, `status ${res.status}`).toMatch(ULID);
      expect(logged.get(id)?.status, `logged line for ${res.status}`).toBe(res.status);
    }
  });

  it('error responses keep their format: text stays text, JSON gains request_id', async () => {
    const r404 = await get(`/${P}/v1/index.html`, env());
    expect(await r404.text()).toBe('Not found');
    const cov = await get(`/${P}/v1/coverage-report.json`, env());
    const body = (await cov.json()) as Record<string, unknown>;
    expect(body.error).toBe('Coverage report not found');
    expect(body.request_id).toBe(cov.headers.get('x-scry-request-id'));
  });

  it('an inbound x-scry-request-id is never trusted: this edge always mints', async () => {
    const res = await get('/health', env(), { 'x-scry-request-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    expect(res.headers.get('x-scry-request-id')).not.toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(JSON.stringify(lines)).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('a serving fault reaches the reporter with the request id; a missing build does not', async () => {
    const bucket = { head: vi.fn(async () => { throw new Error('R2 internal error'); }), get: vi.fn() };
    const res = await get(`/${P}/1.8.2/index.html`, env({ UPLOAD_BUCKET: bucket }));
    expect(res.status).toBe(500);
    expect(reports).toHaveLength(1);
    expect(reports[0].tags.request_id).toBe(res.headers.get('x-scry-request-id'));
    reports.length = 0;
    const missing = await get(`/${P}/1.8.2/index.html`, env());
    expect(missing.status).toBe(404);
    expect(reports).toHaveLength(0);
  });
});

describe('sentry wiring', () => {
  it('no DSN means the SDK is disabled; tier, release and a low trace rate are set', async () => {
    const { sentryOptions } = await import('../cloudflare/worker');
    expect(sentryOptions({}).dsn).toBeUndefined();
    expect(sentryOptions({ SENTRY_DSN: '' } as any).dsn).toBeUndefined();
    const o = sentryOptions({ SENTRY_DSN: 'https://k@o.example/1', SCRY_ENV: 'staging', SCRY_COMMIT: 'abc1234' } as any);
    expect(o).toMatchObject({ dsn: 'https://k@o.example/1', environment: 'staging', release: 'abc1234', tracesSampleRate: 0.1, sendDefaultPii: false, debug: false });
    expect(sentryOptions({}).environment).toBe('unknown');
    expect(o.dataCollection).toEqual({ userInfo: false, httpBodies: [] });
  });
});

describe('guarantee-1 canary corpus absent', () => {
  const hasMarker = (text: string) => canary.markers.filter((m) => text.includes(m));

  it('no marker in any log line when canaries ride in headers, cookies, query and paths', async () => {
    const v = canary.values;
    const failing = { head: vi.fn(async () => { throw new Error(`R2 said ${v.email} ${v.bearer}`); }), get: vi.fn() };
    await get(`/${P}/1.8.2/index.html?${v.query_pair}&scry_preview=${v.jwt}`, env({ UPLOAD_BUCKET: failing }), {
      Authorization: v.bearer,
      Cookie: `__session=${v.jwt}; ${v.cookie}`,
      'X-API-Key': v.sk_key,
      Referer: `https://view.scrymore.com/${P}/v1/x.html?${v.query_pair}`,
      'x-scry-request-id': v.email,
    });
    await get(`/${encodeURIComponent(v.email)}/${v.google_key}/index.html`, env());
    await get(`/${P}/v1/index.html`, env({}, 'private'), { Cookie: `__session=${v.jwt}`, Authorization: v.bearer });
    expect(lines.length).toBeGreaterThan(0);
    expect(hasMarker(lines.join('\n'))).toEqual([]);
  });

  it('no marker survives the Sentry scrubber (event, url query, cookies, breadcrumbs)', () => {
    const v = canary.values;
    const event = scrubEvent({
      message: `${v.email} ${v.bearer} ${v.query_url}`,
      exception: { values: [{ value: `${v.jwt} ${v.sk_key} ${v.google_key}` }] },
      extra: { note: v.cookie, q: v.query_pair },
      request: {
        url: `https://view.scrymore.com/p/v/index.html?${v.query_pair}&scry_preview=${v.jwt}`,
        cookies: { __session: v.jwt },
        headers: { authorization: v.bearer, cookie: v.cookie },
        data: v.email,
        query_string: v.query_pair,
      },
    });
    const crumb = scrubBreadcrumb({ message: v.email, data: { url: v.query_url, auth: v.bearer } });
    expect(hasMarker(JSON.stringify(event))).toEqual([]);
    expect(hasMarker(JSON.stringify(crumb))).toEqual([]);
  });
});

describe('guarantee-4 requests succeed when logging is broken', () => {
  it('console that throws does not change status, body or id', async () => {
    const before = await get('/health', env());
    const beforeBody = (await before.json()) as object;
    for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, m).mockImplementation(() => {
        throw new Error('sink down');
      });
    }
    const res = await get('/health', env());
    expect(res.status).toBe(200);
    expect(Object.keys((await res.json()) as object).sort()).toEqual(Object.keys(beforeBody).sort());
    expect(res.headers.get('x-scry-request-id')).toMatch(ULID);
    const missing = await get(`/${P}/v1/index.html`, env());
    expect(missing.status).toBe(404);
  });
});
