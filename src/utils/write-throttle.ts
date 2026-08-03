/**
 * Keeping the suite inside GitHub's *secondary* rate limits.
 *
 * The primary budget (5000/hr) is not the constraint — a full run spends about
 * 400 of it. What stops the suite is the burst limit on writes, which fires
 * while `x-ratelimit-remaining` still reads healthy and sends no `retry-after`.
 * GitHub enforces several at once; the two this suite can breach are:
 *
 *   - **80 content-generating requests per minute** (POST/PATCH/PUT/DELETE),
 *     and 500 per hour.
 *   - **900 points per minute**, where a write costs 5 points and a read 1.
 *
 * A full run makes roughly 170 writes and 220 reads. Unpaced across 4 workers
 * that lands in about 30 seconds — around 340 writes/min and ~2000 points/min,
 * four times and twice over the respective caps. Passing at all was luck.
 *
 * Two mechanisms here, in order of preference:
 *
 *   1. `paceWrite()` — prevention. Spaces writes so the run stays under the cap
 *      by construction rather than by hoping.
 *   2. `classifyThrottle()` / `backoffMs()` — recovery. If a throttle fires
 *      anyway (another run on the same token, say), back off and retry rather
 *      than fail a test over a budget problem.
 *
 * See docs/findings.md #20 and #23.
 */

import type { APIResponse } from '@playwright/test';
import { env } from '../config/env';

const CONTENT_METHODS = new Set(['post', 'patch', 'put', 'delete']);

/** Does this method count against the content-creation limit? */
export function isWrite(method: string): boolean {
  return CONTENT_METHODS.has(method.toLowerCase());
}

/**
 * Each worker is its own process, so no worker can see the account-wide rate.
 * The budget is therefore divided up front: every worker gets `1/workers` of it
 * and enforces that locally. Conservative when a worker is idle, which is the
 * right direction to be wrong in.
 */
export const writeGapMs = Math.ceil((60_000 * env.workers) / env.writeRatePerMin);

/** The gap for a single-process writer, which owns the whole budget. */
export const soloWriteGapMs = Math.ceil(60_000 / env.writeRatePerMin);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A pacer that admits one caller per `gapMs`.
 *
 * Callers are serialised through a promise chain rather than each checking a
 * clock, so two concurrent tests in the same worker cannot both decide the gap
 * has elapsed and fire together. The slot is claimed *before* the request goes
 * out, so real spacing is the gap plus the request's own latency — erring
 * towards slower than the cap rather than faster.
 */
export function createWritePacer(gapMs: number): () => Promise<void> {
  let queue: Promise<unknown> = Promise.resolve();
  let previousWriteAt = 0;

  return () => {
    const turn = queue.then(async () => {
      const elapsed = Date.now() - previousWriteAt;
      if (elapsed < gapMs) await sleep(gapMs - elapsed);
      previousWriteAt = Date.now();
    });
    // Never let a rejection poison the chain for every subsequent write.
    queue = turn.catch(() => undefined);
    return turn;
  };
}

/** The suite's pacer: one worker's share of the account-wide budget. */
export const paceWrite = createWritePacer(writeGapMs);

/** The throttles worth retrying, each with a distinct signature. */
export type ThrottleKind =
  /** 403 + "secondary rate limit" in the body. The burst-write throttle. */
  | 'secondary'
  /** 429. Rare against this API, but unambiguous when it happens. */
  | 'too-many-requests'
  /**
   * 409 "Gist cannot be updated." A gist is a git repository, and GitHub
   * refuses a PATCH that lands too close behind the previous write to it. It
   * is a throttle wearing a conflict's status code — REV-02 and SCH-03 hit it
   * in the same run that hit the 403s, which is not a coincidence.
   */
  | 'gist-conflict';

/**
 * Names the throttle behind a response, or null if the response is the API
 * answering the question it was asked.
 *
 * Only reads the body for the three statuses that can carry a throttle, so this
 * costs nothing on the happy path.
 */
export async function classifyThrottle(
  response: APIResponse,
  method: string,
): Promise<ThrottleKind | null> {
  const status = response.status();
  if (status !== 403 && status !== 409 && status !== 429) return null;

  if (status === 429) return 'too-many-requests';

  const body = (await response.text().catch(() => '')).toLowerCase();

  // A 403 is also the honest answer to "may I edit someone else's comment?", so
  // the body is what distinguishes a throttle from an authorization decision.
  if (status === 403) return body.includes('secondary rate limit') ? 'secondary' : null;

  return isWrite(method) && body.includes('cannot be updated') ? 'gist-conflict' : null;
}

/**
 * How long to wait before retrying.
 *
 * GitHub's own guidance: honour `retry-after` if present, wait for
 * `x-ratelimit-reset` if the primary budget is spent, otherwise back off
 * exponentially. For the secondary limit it sends neither header — finding #20
 * — so in practice the exponential path is the one that runs.
 */
export function backoffMs(response: APIResponse, attempt: number): number {
  const headers = response.headers();

  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;

  if (headers['x-ratelimit-remaining'] === '0') {
    const resetIn = Number(headers['x-ratelimit-reset']) * 1000 - Date.now();
    // Capped: an exhausted hourly budget can be an hour away, and waiting that
    // out inside a test helps nobody. Let the assertion report it instead.
    if (Number.isFinite(resetIn) && resetIn > 0) return Math.min(resetIn + 1_000, 30_000);
  }

  // 5s, 15s, 45s. Long enough to matter against a per-minute window, short
  // enough to stay inside a test timeout.
  return 5_000 * 3 ** attempt;
}