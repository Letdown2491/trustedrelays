import { describe, test, expect } from 'bun:test';
import { isBlockedHost } from './api.js';
import { DASHBOARD_HTML } from './dashboard-template.js';
import { ALGORITHM_VERSION } from './version.js';

describe('isBlockedHost (SSRF protection)', () => {
  test('blocks loopback / internal names', () => {
    for (const h of ['localhost', 'foo.localhost', 'relay.local', 'svc.internal', 'host.lan']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test('blocks private / loopback / link-local IPv4', () => {
    for (const h of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test('blocks loopback / ULA / link-local IPv6', () => {
    for (const h of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '[::1]', '::ffff:127.0.0.1']) {
      expect(isBlockedHost(h)).toBe(true);
    }
  });

  test('allows public hosts', () => {
    for (const h of ['relay.damus.io', 'nos.lol', '1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1']) {
      expect(isBlockedHost(h)).toBe(false);
    }
  });
});

describe('dashboard escaping (XSS) regression guards', () => {
  test('escHtml escapes quotes (attribute-safe)', () => {
    // The fix: escHtml must escape both double and single quotes.
    expect(DASHBOARD_HTML).toContain('&quot;');
    expect(DASHBOARD_HTML).toContain('&#39;');
  });

  test('escAttr delegates to the (quote-escaping) escHtml', () => {
    expect(DASHBOARD_HTML).toContain('function escAttr(s) { return escHtml(s); }');
  });
});

describe('version consolidation', () => {
  test('dashboard reports the single-source algorithm version', () => {
    expect(DASHBOARD_HTML).toContain(`Algorithm ${ALGORITHM_VERSION}`);
  });
});
