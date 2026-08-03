import { defineConfig } from '@playwright/test';
import { env } from './src/config/env';

/**
 * The system under test is a live third-party production API, so this config is
 * shaped by two constraints that would not apply to an in-house service:
 *
 *  - Rate limits (5000 req/hr authenticated, plus secondary limits that punish
 *    bursts of writes). Workers are capped rather than left unbounded.
 *  - No control over releases. Retries are deliberately minimal so that a real
 *    regression is not masked by a green retry.
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,

  // Retry once in CI to absorb genuine network flake; never locally, where a
  // flaky test should be visible immediately.
  retries: process.env.CI ? 1 : 0,

  // Capping workers alone does not bound the write *rate* — four workers with
  // nothing between them and the API still emptied the whole suite's ~170 writes
  // into 30 seconds, four times over GitHub's 80/min cap. The actual cap is
  // enforced by src/utils/write-throttle.ts, which divides an account-wide
  // budget between exactly this many workers. The number therefore lives in
  // env.ts, where both files can read the same one.
  workers: env.workers,

  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'results.xml' }],
    [
      'allure-playwright',
      {
        resultsDir: 'allure-results',
        // Surfaced as filterable metadata on every test in the report. The API
        // version matters most: a suite run against 2022-11-28 and one run against
        // 2026-03-10 are testing materially different contracts (see SCH-10), and
        // a report that does not say which is misleading.
        environmentInfo: {
          base_url: env.baseUrl,
          api_version: env.apiVersion,
          node: process.version,
          ci: process.env.CI ? 'true' : 'false',
          // Two runs of the same suite at different write rates are not
          // comparable on duration, and a throttled run is explained by this
          // number more often than by anything in the test code.
          workers: String(env.workers),
          write_rate_per_min: String(env.writeRatePerMin),
        },
      },
    ],
  ],

  // Generous, because a test's wall-clock is now mostly spent queueing for a
  // write slot rather than waiting on the API. SCH-11 creates and then deletes
  // 10 gists — 20 paced writes, over a minute of it deliberate waiting. The
  // per-assertion timeout stays tight, so a genuinely hung request still fails
  // fast; this ceiling only has to be above the worst legitimate queue.
  timeout: 150_000,
  expect: { timeout: 5_000 },

  use: {
    baseURL: env.baseUrl,
    trace: 'retain-on-failure',
    extraHTTPHeaders: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': env.apiVersion,
    },
  },

  projects: [{ name: 'api', testDir: './tests/api' }],
});