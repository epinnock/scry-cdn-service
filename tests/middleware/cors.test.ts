import { describe, it, expect } from 'vitest';
import {
  corsHeaders,
  handleOptions,
  parseAllowedOrigins,
  DEFAULT_ALLOWED_ORIGINS
} from '@/middleware/cors';

describe('CORS middleware', () => {
  describe('parseAllowedOrigins', () => {
    it('returns undefined for empty values', () => {
      expect(parseAllowedOrigins(undefined)).toBeUndefined();
      expect(parseAllowedOrigins('')).toBeUndefined();
      expect(parseAllowedOrigins('   ')).toBeUndefined();
    });

    it('treats "*" as wildcard (empty allowlist)', () => {
      expect(parseAllowedOrigins('*')).toEqual([]);
    });

    it('parses comma-separated origins', () => {
      expect(parseAllowedOrigins('https://a.com, https://b.com')).toEqual([
        'https://a.com',
        'https://b.com'
      ]);
    });
  });

  describe('corsHeaders', () => {
    it('reflects whitelisted origins and sets Vary: Origin', () => {
      const req = new Request('https://view.scrymore.com/x/y/coverage-report.json', {
        headers: {
          Origin: 'https://dashboard.scrymore.com'
        }
      });

      const headers = corsHeaders(req, { allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
      expect(headers.get('Access-Control-Allow-Origin')).toBe('https://dashboard.scrymore.com');
      expect(headers.get('Vary')).toBe('Origin');
      expect(headers.get('Access-Control-Allow-Credentials')).toBe('true');
    });

    it('falls back to wildcard for non-whitelisted origins', () => {
      const req = new Request('https://view.scrymore.com/x/y/coverage-report.json', {
        headers: {
          Origin: 'https://evil.example'
        }
      });

      const headers = corsHeaders(req, { allowedOrigins: DEFAULT_ALLOWED_ORIGINS });
      expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
    });

    it('forces wildcard when forceWildcard=true', () => {
      const req = new Request('https://view.scrymore.com/x/y/coverage-report.json', {
        headers: {
          Origin: 'https://dashboard.scrymore.com'
        }
      });

      const headers = corsHeaders(req, {
        allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
        forceWildcard: true
      });

      expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });

    it('sets allow methods/headers/max-age defaults', () => {
      const req = new Request('https://view.scrymore.com/x/y/coverage-report.json');
      const headers = corsHeaders(req);

      expect(headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
      expect(headers.get('Access-Control-Allow-Headers')).toBe('Content-Type, Accept, Cookie, Authorization');
      expect(headers.get('Access-Control-Max-Age')).toBe('86400');
    });

    it('handles null origin when allowNullOrigin is true', () => {
      const req = new Request('https://view.scrymore.com/x/y/file.json', {
        headers: {
          Origin: 'null'
        }
      });

      const headers = corsHeaders(req, { allowNullOrigin: true });
      expect(headers.get('Access-Control-Allow-Origin')).toBe('*');
      expect(headers.get('Access-Control-Allow-Credentials')).toBeNull();
    });
  });

  describe('handleOptions', () => {
    it('returns 204 with CORS headers', async () => {
      const req = new Request('https://view.scrymore.com/x/y/coverage-report.json', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://dashboard.scrymore.com',
          'Access-Control-Request-Method': 'GET'
        }
      });

      const res = handleOptions(req);
      expect(res.status).toBe(204);
      expect(res.headers.get('Access-Control-Allow-Methods')).toBe('GET, HEAD, OPTIONS');
    });
  });
});
