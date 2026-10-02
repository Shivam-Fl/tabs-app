import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * BUG-1 as a source guard: the boundary Tailwind generates from.
 *
 * Tailwind v4 finds the class names it generates by walking the repository, and that walk is
 * not restricted to src/. A spelling that exists only in a test therefore compiles into the
 * stylesheet every visitor downloads — the production CSS carried a max-width rule for three
 * of the four rejected ceilings tests/components/ui.test.tsx names in a comment, and a rule for
 * the focus:absolute beside them, because a test that asserts a class must never come back has
 * to write that class down.
 *
 * AC-6 asserts the emitted rule set, and it can only do that by building the app; a build is
 * not something this suite can run, so what is guarded here is the declaration that produces
 * it. The whole fix is one line in src/app/globals.css, and it fails in two directions that
 * look like success: a path that resolves too high deletes the product's own utilities, and a
 * path that resolves to nothing changes nothing at all while reading as a fix.
 */

const stylesheetPath = fileURLToPath(new URL('../../src/app/globals.css', import.meta.url));
const stylesheetDirectory = dirname(stylesheetPath);
const stylesheet = readFileSync(stylesheetPath, 'utf8');

/** The repository's tests/ directory, derived from the stylesheet's own location. */
const testsDirectory = resolve(stylesheetDirectory, '../../tests');

/** Every path an `@source not` excludes, as written, resolved against the stylesheet. */
const excluded = [...stylesheet.matchAll(/@source\s+not\s+['"]([^'"]+)['"]/g)].map((match) => ({
  written: match[1],
  absolute: resolve(stylesheetDirectory, match[1]),
}));

describe("the stylesheet's source boundary", () => {
  it('excludes tests/ from the walk that generates utilities', () => {
    expect(excluded.map((entry) => entry.absolute)).toContain(testsDirectory);
  });

  it('narrows the walk rather than disabling it, which is why it is not source(none)', () => {
    // `@import 'tailwindcss' source(none)` would also stop tests/ contributing, and it would
    // drop every utility the product uses with it — AC-6 passing is exactly what that looks
    // like, since a stylesheet with no rules has no rule for a tests/-only spelling either.
    expect(stylesheet).not.toMatch(/@import\s+['"]tailwindcss['"]\s+source\(none\)/);
    expect(stylesheet).not.toMatch(/@source\s+none\b/);
  });

  it('narrows a stylesheet that is still Tailwind’s, so the assertions above are not vacuous', () => {
    // Without the import, `@source not` excludes nothing from a walk that never happens, and
    // every assertion in this file would pass on a globals.css that styles nothing.
    expect(stylesheet).toMatch(/@import\s+['"]tailwindcss['"]/);
    // And the exclusion has to be a boundary around src/, not a replacement for it: the
    // theme block is the product's own declarations and a path that reached one level too
    // far would have taken them with it.
    expect(stylesheet).toMatch(/@theme\s*\{/);
  });

  it('resolves that path to tests/ exactly, and to a directory that exists', () => {
    // Equality on the resolved path, not a substring: `'../../test'`, `'../tests'` and an
    // absolute path all read as an exclusion and only one of them is the tests/ directory.
    expect(excluded.map((entry) => entry.absolute)).toEqual([testsDirectory]);
    // Tailwind ignores an @source path that does not exist, silently — a typo would leave
    // the stylesheet exactly as buggy as it was and this suite green.
    expect(existsSync(testsDirectory)).toBe(true);
    expect(statSync(testsDirectory).isDirectory()).toBe(true);
  });
});
