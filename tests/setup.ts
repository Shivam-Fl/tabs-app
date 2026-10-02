import '@testing-library/jest-dom/vitest';

/**
 * The single vitest setup file.
 *
 * The assertion is here so a suite that ever runs without it fails with a legible message,
 * rather than with a throw from loadEnv inside an unrelated test. sdlc:verify invokes
 * `vitest run` directly rather than through the `test` script, so vitest.config.ts's
 * `test.env.TABS_ENV` is the declaration that actually reaches the suite.
 */
if (process.env.TABS_ENV !== 'local') {
  throw new Error(
    `tests must run with TABS_ENV=local (got ${JSON.stringify(process.env.TABS_ENV)}). ` +
      'vitest.config.ts sets it; if you are running vitest with your own config, set it there.',
  );
}