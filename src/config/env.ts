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
} as const;