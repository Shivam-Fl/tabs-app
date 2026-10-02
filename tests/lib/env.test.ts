import { describe, expect, it } from 'vitest';

import { LOCAL_HMAC_KEY, REQUIRED_VARIABLES, TRUSTED_PROXIES_VARIABLE, loadEnv, trustedProxyCount } from '@/lib/env';

describe('loadEnv', () => {
  it('substitutes the documented local defaults and names each in its log line', () => {
    const logged: string[] = [];
    const resolved = loadEnv({ TABS_ENV: 'local' }, (message) => logged.push(message));

    expect(resolved.databaseUrl).toBe('');
    expect(resolved.hmacKey).toBe(LOCAL_HMAC_KEY);
    expect(resolved.tabsEnv).toBe('local');
    expect(resolved.defaultsUsed.join(' ')).toContain('DATABASE_URL');
    expect(resolved.defaultsUsed.join(' ')).toContain('TABS_HMAC_KEY');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain('DATABASE_URL');
    expect(logged[0]).toContain('TABS_HMAC_KEY');
  });

  it('prefers an explicitly-set variable over the local default', () => {
    const resolved = loadEnv({ TABS_ENV: 'local', TABS_HMAC_KEY: 'from-the-environment' });
    expect(resolved.hmacKey).toBe('from-the-environment');
    expect(resolved.defaultsUsed).toEqual(['DATABASE_URL unset — in-process PGlite']);
  });

  it('with TABS_ENV unset and variables missing, throws one message naming EVERY missing one', () => {
    expect(() => loadEnv({})).toThrowError(/DATABASE_URL/);
    let message = '';
    try {
      loadEnv({});
    } catch (error) {
      message = (error as Error).message;
    }
    for (const name of REQUIRED_VARIABLES) expect(message).toContain(name);
    expect(message).toContain('TABS_ENV=local');
  });

  it('with TABS_ENV=production and a variable missing, throws the same way', () => {
    expect(() => loadEnv({ TABS_ENV: 'production' })).toThrowError(/missing required environment variable/);
    expect(() => loadEnv({ TABS_ENV: 'production' })).toThrowError(/TABS_ENV=local/);
  });

  it('accepts a fully-set strict environment', () => {
    const resolved = loadEnv({ TABS_ENV: 'production', DATABASE_URL: 'postgres://db/x', TABS_HMAC_KEY: 'secret' });
    expect(resolved.databaseUrl).toBe('postgres://db/x');
    expect(resolved.hmacKey).toBe('secret');
  });

  it('the local HMAC default is visibly marked as a development value', () => {
    expect(LOCAL_HMAC_KEY).toMatch(/dev/i);
    // Not something a deployment would ever ship unchanged.
    expect(LOCAL_HMAC_KEY).not.toMatch(/^[a-f0-9]{32,}$/);
  });

  it('declares no trusted proxy unless an operator says so', () => {
    // Nothing in the header is evidence of an address until the operator names the hops, and
    // this must not be a REQUIRED_VARIABLE: absent means "trust nothing", not "refuse to boot".
    expect(REQUIRED_VARIABLES).not.toContain(TRUSTED_PROXIES_VARIABLE);

    expect(trustedProxyCount({})).toBe(0);
    expect(trustedProxyCount({ TABS_ENV: 'local' })).toBe(0);
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: '2' })).toBe(2);
  });

  it('reads a nonsense hop count as none, rather than as a number to walk a chain with', () => {
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: '' })).toBe(0);
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: '  ' })).toBe(0);
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: 'one' })).toBe(0);
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: '-1' })).toBe(0);
    expect(trustedProxyCount({ [TRUSTED_PROXIES_VARIABLE]: '1.5' })).toBe(0);
  });

  it('importing the module does not throw, whatever NODE_ENV says', () => {
    // The regression test for the defect that rejected v1. If anything reintroduces an
    // import-time or NODE_ENV-keyed throw, this file fails to load and the whole suite goes
    // red here rather than somewhere unrelated.
    // Next's types declare NODE_ENV readonly; the variable itself is not.
    const environment = process.env as Record<string, string | undefined>;
    const previous = environment['NODE_ENV'];
    environment['NODE_ENV'] = 'production';
    try {
      expect(typeof loadEnv).toBe('function');
      // NODE_ENV is consulted nowhere: a strict environment is decided by TABS_ENV alone.
      expect(() => loadEnv({})).toThrowError(/missing required environment variable/);
    } finally {
      if (previous === undefined) delete environment['NODE_ENV'];
      else environment['NODE_ENV'] = previous;
    }
  });
});