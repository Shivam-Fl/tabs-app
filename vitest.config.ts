import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The DOM is supplied per file by a `// @vitest-environment jsdom` docblock in
    // tests/components/**, rather than by environmentMatchGlobs.
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.{test,spec}.{ts,tsx}'],
    // sdlc:verify invokes `vitest run` directly rather than through the `test`
    // script, so this is the declaration that actually reaches the suite.
    env: { TABS_ENV: 'local' },
    // scrypt at N=2^17 is about 128 MB per verification and each integration file
    // holds a WASM PGlite. One file at a time keeps several of those from landing
    // on the same runner at once.
    fileParallelism: false,
  },
});