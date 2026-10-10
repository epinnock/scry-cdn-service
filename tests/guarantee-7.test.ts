/**
 * log-core-hardening G7 (S6 coverage), cdn half.
 *   guarantee-7a  an error event, a transaction and a span keep only the SAFE_HEADERS allow-list of
 *                 request headers; X-Scry-Caller, X-Api-Key, Cookie and any custom header never leave
 *                 the Worker (flutter-capture F44: error events used a deny-list).
 */
import { describe, expect, it } from 'vitest';
import { scrubEvent, scrubSpan, scrubTransaction } from '../src/sentry-scrub.js';

const SECRETS = ['SECRETCALLER', 'SECRETAPIKEY', 'SECRETCOOKIE', 'SECRETCUSTOM', 'SECRETFORWARD'];

function requestHeaders(): Record<string, string> {
  return {
    'X-Scry-Caller': 'SECRETCALLER',
    'X-Api-Key': 'SECRETAPIKEY',
    Cookie: 'session=SECRETCOOKIE',
    'X-Foo': 'SECRETCUSTOM',
    'X-Forwarded-For': 'SECRETFORWARD',
    'Content-Type': 'application/json',
    'User-Agent': 'scry-cli/1.0',
    Host: 'upload.example',
    Accept: 'application/json',
    'Content-Length': '12',
  };
}

const SAFE = ['content-type', 'content-length', 'accept', 'user-agent', 'host'];

describe('guarantee-7a: only SAFE_HEADERS survive on error events, transactions and spans', () => {
  it('an error event keeps none of X-Scry-Caller, X-Api-Key, Cookie, a custom header', () => {
    const event = scrubEvent({ request: { url: 'https://upload.example/x', headers: requestHeaders() } });
    expect(Object.keys(event.request.headers).map((h) => h.toLowerCase()).sort()).toEqual([...SAFE].sort());
    expect(JSON.stringify(event)).not.toMatch(new RegExp(SECRETS.join('|')));
  });

  it('header names match case-insensitively, whatever the casing', () => {
    const event = scrubEvent({ request: { headers: { 'x-scry-caller': 'SECRETCALLER', 'X-FOO': 'SECRETCUSTOM', 'CONTENT-TYPE': 'text/plain' } } });
    expect(event.request.headers).toEqual({ 'CONTENT-TYPE': 'text/plain' });
  });

  it('an error event with no request block, or no headers, still scrubs without throwing', () => {
    expect(scrubEvent({ message: 'boom' }).message).toBe('boom');
    expect(scrubEvent({ request: {} }).request).toEqual({});
  });

  it('a transaction keeps only SAFE_HEADERS', () => {
    const event = scrubTransaction({ request: { headers: requestHeaders() }, transaction: 'POST /upload' });
    expect(Object.keys(event.request.headers).map((h) => h.toLowerCase()).sort()).toEqual([...SAFE].sort());
    expect(JSON.stringify(event)).not.toMatch(new RegExp(SECRETS.join('|')));
  });

  it('a span drops request-header attributes that are not SAFE_HEADERS', () => {
    const span = scrubSpan({
      data: {
        'http.request.header.x-scry-caller': 'SECRETCALLER',
        'http.request.header.x-foo': 'SECRETCUSTOM',
        'http.request.header.content-type': 'application/json',
      },
    } as never) as { data: Record<string, unknown> };
    expect(Object.keys(span.data)).toEqual(['http.request.header.content-type']);
  });
});
