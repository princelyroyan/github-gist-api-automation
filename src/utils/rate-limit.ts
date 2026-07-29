import type { APIResponse } from '@playwright/test';

export type RateLimit = {
  limit: number | null;
  remaining: number | null;
  used: number | null;
  /** Epoch seconds at which the window resets. */
  reset: number | null;
  resource: string | null;
};

function toNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * GitHub reports the caller's budget on every response. Reading it is cheaper and
 * safer than deliberately exhausting the limit to prove it exists (NFR-01/02).
 */
export function readRateLimit(response: APIResponse): RateLimit {
  const headers = response.headers();
  return {
    limit: toNumber(headers['x-ratelimit-limit']),
    remaining: toNumber(headers['x-ratelimit-remaining']),
    used: toNumber(headers['x-ratelimit-used']),
    reset: toNumber(headers['x-ratelimit-reset']),
    resource: headers['x-ratelimit-resource'] ?? null,
  };
}

export function formatRateLimit(method: string, url: string, rl: RateLimit): string {
  return `[rate-limit] ${method} ${url} -> ${rl.remaining ?? '?'}/${rl.limit ?? '?'} remaining`;
}