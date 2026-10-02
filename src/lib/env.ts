/**
 * Every environment variable this application has, and the answer to what "production"
 * means here.
 *
 * NODE_ENV cannot be the discriminator. `next start` sets it to production itself, so a
 * check keyed on it can never tell a real deployment from CI or from QA. The discriminator
 * is TABS_ENV, and the polarity is strict by default: anything that has not explicitly
 * declared itself local must name every variable it needs, because a deployment that
 * forgets one must fail loudly rather than silently come up on in-process PGlite and lose
 * every write on the next cold start.
 *
 * `TABS_ENV=local` means this boot is local, CI or QA. It substitutes the documented local
 * defaults below and logs one line naming each.
 *
 * This module NEVER throws on import. Validation runs when config() is called, which is a
 * boot-time call `next build` never reaches — a module that throws at import would break the
 * production build over a variable only the running server needs.
 */

/**
 * Development-only. Not a secret, deliberately: the name says so, the value is prefixed so
 * anything that ever reads it in a log recognises it, and a deployment that ships it has
 * published a key whose only job is to make an email address non-reversible by wordlist.
 */
export const LOCAL_HMAC_KEY = 'tabs-local-development-key-not-a-secret';

export const LOCAL_DATABASE_URL = '';

export interface EnvConfig {
  /** Empty when unset, which selects the in-process PGlite. */
  databaseUrl: string;
  hmacKey: string;
  /** 'local' only when this boot declared itself local. */
  tabsEnv: string;
  /** Which defaults loadEnv substituted, for the log line and for tests. */
  defaultsUsed: string[];
}

type Source = Record<string, string | undefined>;

export type Log = (message: string) => void;

export const REQUIRED_VARIABLES = ['DATABASE_URL', 'TABS_HMAC_KEY'] as const;

export function loadEnv(source: Source, log: Log = () => {}): EnvConfig {
  const tabsEnv = source.TABS_ENV ?? '';

  if (tabsEnv === 'local') {
    const databaseUrl = source.DATABASE_URL ?? LOCAL_DATABASE_URL;
    const hmacKey = source.TABS_HMAC_KEY ?? LOCAL_HMAC_KEY;
    const defaultsUsed: string[] = [];
    if (!source.DATABASE_URL) defaultsUsed.push('DATABASE_URL unset — in-process PGlite');
    if (!source.TABS_HMAC_KEY) defaultsUsed.push('TABS_HMAC_KEY — the local development key, not a secret');

    log(
      `tabs: TABS_ENV=local, booting on local defaults (${defaultsUsed.join('; ')}). ` +
        'These defaults lose every write on the next cold start.',
    );

    return { databaseUrl, hmacKey, tabsEnv, defaultsUsed };
  }

  const missing = REQUIRED_VARIABLES.filter((name) => !source[name]);
  if (missing.length > 0) {
    throw new Error(
      `tabs: cannot start — missing required environment ${missing.length > 1 ? 'variables' : 'variable'}: ` +
        `${missing.join(', ')}. Set them, or set TABS_ENV=local to boot on the documented local ` +
        'defaults instead (an in-process PGlite that loses every write on the next cold start).',
    );
  }

  return {
    databaseUrl: source.DATABASE_URL as string,
    hmacKey: source.TABS_HMAC_KEY as string,
    tabsEnv,
    defaultsUsed: [],
  };
}

let memoised: EnvConfig | undefined;

/** The resolved configuration, resolved once per process. */
export function config(): EnvConfig {
  memoised ??= loadEnv(process.env, (message) => console.warn(message));
  return memoised;
}