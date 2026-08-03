import 'dotenv/config';

/**
 * Reads the first name that is set. GitHub Actions reserves the `GITHUB_` prefix
 * for its own variables, so the canonical names here are `GIST_*`, with the
 * `GITHUB_*` spellings accepted as aliases for local convenience.
 */
function optional(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value && value.trim() !== '') return value.trim();
  }
  return undefined;
}

function required(...names: string[]): string {
  const value = optional(...names);
  if (!value) {
    throw new Error(
      `Missing required env var: ${names[0]}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

/** A positive number, or the default. A typo must not silently become `NaN`. */
function number(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number, got "${raw}".`);
  }
  return parsed;
}

/**
 * Config is validated at import time so a misconfigured run fails on the first
 * line rather than as a wall of confusing 401s halfway through the suite.
 */
export const env = {
  baseUrl: optional('BASE_URL') ?? 'https://api.github.com',
  apiVersion: optional('API_VERSION') ?? '2026-03-10',

  /** Account A — owns every gist the suite creates. */
  tokenOwner: required('GIST_TOKEN_A', 'GITHUB_TOKEN_A'),
  /** Account B — proves cross-user writes are rejected. */
  tokenOther: required('GIST_TOKEN_B', 'GITHUB_TOKEN_B'),

  /** Resolved from GET /user when omitted. */
  usernameOwner: optional('GIST_USERNAME_A', 'GITHUB_USERNAME_A'),
  usernameOther: optional('GIST_USERNAME_B', 'GITHUB_USERNAME_B'),

  logRateLimit: optional('LOG_RATE_LIMIT') === '1',

  /**
   * Parallel workers. Read here rather than only in `playwright.config.ts`
   * because the write pacer needs the same number: the budget below is
   * account-wide, and each worker is a separate process that can only enforce
   * its own share of it.
   */
  workers: number('PW_WORKERS', 4),

  /**
   * Account-wide content-generating requests per minute (POST/PATCH/PUT/DELETE).
   *
   * GitHub's undocumented-until-you-hit-it secondary limits cap this at 80/min
   * — and, separately, at 900 points/min where a write costs 5 points and a read
   * 1. 70 leaves headroom under both. See docs/findings.md #23.
   */
  writeRatePerMin: number('WRITE_RATE_PER_MIN', 70),

  /**
   * Back-off retries for a request that comes back throttled. Two is enough to
   * ride out a brief burst; more just extends a run that is already doomed.
   */
  throttleRetries: number('THROTTLE_RETRIES', 2),

  /**
   * IANA zone for the local time printed beside every UTC timestamp. Defaults to
   * the machine's own zone — which on a CI runner is UTC, and `formatInstant`
   * then prints the UTC time alone rather than twice.
   */
  reportTimeZone: optional('REPORT_TIMEZONE'),
} as const;