import { expect, type APIResponse } from '@playwright/test';
import type { z } from 'zod';
import { errorSchema } from '../models/gist.schemas';

/**
 * Validates a response body against a Zod schema and returns the parsed value,
 * so a spec can carry on asserting on typed data after the contract check.
 *
 * On failure the whole issue list is printed — a schema failure with no detail is
 * one of the most expensive kinds of red build to debug.
 */
export async function expectSchema<T extends z.ZodTypeAny>(
  response: APIResponse,
  schema: T,
): Promise<z.infer<T>> {
  const body = await response.json();
  const result = schema.safeParse(body);

  expect(
    result.success,
    result.success
      ? ''
      : `Schema validation failed:\n${JSON.stringify(result.error.issues, null, 2)}\n\nBody:\n${JSON.stringify(body, null, 2)}`,
  ).toBe(true);

  return (result as z.SafeParseSuccess<z.infer<T>>).data;
}

/**
 * Asserts a status and surfaces the response body when it does not match.
 * Playwright's default failure message shows only the numbers, which hides the
 * `message`/`errors[]` payload that usually explains the failure.
 */
export async function expectStatus(response: APIResponse, expected: number): Promise<void> {
  if (response.status() === expected) {
    expect(response.status()).toBe(expected);
    return;
  }

  await assertNotRateLimited(response);

  const body = await response.text().catch(() => '<unreadable body>');
  expect(
    response.status(),
    `Expected ${expected} from ${response.url()} but got ${response.status()}.\nBody: ${body}`,
  ).toBe(expected);
}

/**
 * Turns a rate limit into one obvious message instead of a scattering of
 * unrelated-looking assertion failures.
 *
 * GitHub enforces two independent limits, and they fail in completely different
 * ways:
 *
 *  - The **primary** hourly budget — 5000/hr per token, 60/hr per IP for
 *    anonymous callers. Signalled by `x-ratelimit-remaining: 0`, with a reset
 *    timestamp you can wait for.
 *  - The **secondary** limit on burst content creation. Signalled only by a 403
 *    and a message in the body: `x-ratelimit-remaining` is still healthy, and no
 *    `retry-after` header is sent. Running this suite back to back triggers it
 *    within two runs. See docs/findings.md #20.
 *
 * Both are budget problems, not product defects, and saying so explicitly saves
 * whoever sees the red build from debugging the wrong thing.
 */
export async function assertNotRateLimited(response: APIResponse): Promise<void> {
  if (response.status() !== 403) return;

  const headers = response.headers();
  const body = await response.text().catch(() => '');

  if (body.includes('secondary rate limit')) {
    throw new Error(
      'SECONDARY rate limit — GitHub has temporarily blocked content creation for this token.\n' +
        'This is a burst-write throttle, not the hourly budget: x-ratelimit-remaining is still ' +
        `${headers['x-ratelimit-remaining']}.\n` +
        'GitHub sends no retry-after header, so there is no reliable wait time. Leave a few ' +
        'minutes between full runs.\n' +
        `Request: ${response.url()}`,
    );
  }

  if (headers['x-ratelimit-remaining'] !== '0') return;

  const resetAt = new Date(Number(headers['x-ratelimit-reset']) * 1000).toISOString();
  const limit = headers['x-ratelimit-limit'];
  const persona = limit === '60' ? 'ANONYMOUS (60/hr per IP)' : `authenticated (${limit}/hr)`;

  throw new Error(
    `PRIMARY rate limit exhausted for the ${persona} persona — a budget problem, not a product defect.\n` +
      `Budget resets at ${resetAt}. Re-run after that, or reduce anonymous usage.\n` +
      `Request: ${response.url()}`,
  );
}

/** Asserts the response is a well-formed GitHub error and returns it. */
export async function expectApiError(
  response: APIResponse,
  expectedStatus: number,
): Promise<z.infer<typeof errorSchema>> {
  await expectStatus(response, expectedStatus);
  return expectSchema(response, errorSchema);
}

/**
 * Polls until `check` passes. Used instead of a fixed sleep wherever GitHub is
 * eventually consistent across resources (forks are the known case).
 */
export async function eventually<T>(
  action: () => Promise<T>,
  check: (value: T) => boolean,
  { timeoutMs = 15_000, intervalMs = 1_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = await action();
  while (!check(last) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    last = await action();
  }
  return last;
}