// QA's test plan, run as a Playwright suite. Owned by the framework; sdlc-qa copies it next to the
// runner it installs (qa-run/) before QA starts, and QA runs it from the workspace root:
//
//   qa-run/node_modules/.bin/playwright test -c qa-run/playwright.config.mjs
//
// Every test gets a trace, a video and a screenshot, and the run writes one HTML report and a JSON
// result into the evidence directory — the uploaded artifact. The first QA runs did this and later
// ones drove the browser with one-off scripts, which left screenshots but no traces and no report.
import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// Absolute: Playwright resolves relative output paths against this file's directory, not the cwd.
const evidence = resolve(process.env.QA_EVIDENCE_DIR ?? 'qa-evidence');

export default defineConfig({
  testDir: './tests',
  outputDir: `${evidence}/test-results`,
  // One app, one data set. Cases that race on purpose do it inside one test.
  workers: 1,
  fullyParallel: false,
  // A flaky failure is a finding, not something to retry away.
  retries: 0,
  timeout: 120_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${evidence}/playwright-report`, open: 'never' }],
    ['json', { outputFile: `${evidence}/results.json` }],
  ],
  use: {
    baseURL: process.env.PREVIEW_URL,
    trace: 'on',
    video: 'on',
    screenshot: 'on',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
