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

  // Capped to stay well inside GitHub's secondary rate limits on writes.
  workers: process.env.CI ? 4 : 4,

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
        },
      },
    ],
  ],

  timeout: 30_000,
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