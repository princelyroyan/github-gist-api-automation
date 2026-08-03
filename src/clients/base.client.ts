import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/env';
import { formatRateLimit, readRateLimit } from '../utils/rate-limit';
import { backoffMs, classifyThrottle, isWrite, paceWrite } from '../utils/write-throttle';

/**
 * Shared request plumbing. Clients are deliberately assertion-free: they know how
 * to reach an endpoint and nothing about whether the answer was correct. That
 * keeps every expectation visible in the spec that owns it.
 */
export abstract class BaseClient {
  protected constructor(protected readonly request: APIRequestContext) {}

  /** Escape hatch for the few tests that need to drive the raw context. */
  get context(): APIRequestContext {
    return this.request;
  }

  /**
   * Every request in the suite goes through here, which makes it the one place
   * that can keep the whole run inside GitHub's burst limits.
   *
   * Writes are paced before they are sent, and any request that comes back
   * throttled is retried with back-off. Both are deliberately invisible to the
   * specs: a test asserting that a PATCH returns 200 should not have to know
   * that the account is shared with three other workers. What a spec still sees
   * is a throttle that survived the retries — `assertNotRateLimited` then names
   * it for what it is rather than letting it read as a product defect.
   */
  protected async send(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    options?: Parameters<APIRequestContext['get']>[1],
  ): Promise<APIResponse> {
    for (let attempt = 0; ; attempt++) {
      if (isWrite(method)) await paceWrite();

      const response = await this.request[method](path, options);
      if (env.logRateLimit) {
        // eslint-disable-next-line no-console
        console.log(formatRateLimit(method.toUpperCase(), path, readRateLimit(response)));
      }

      const throttle = await classifyThrottle(response, method);
      if (!throttle || attempt >= env.throttleRetries) return response;

      const waitMs = backoffMs(response, attempt);
      // eslint-disable-next-line no-console
      console.warn(
        `[throttle] ${method.toUpperCase()} ${path} -> ${response.status()} (${throttle}); ` +
          `retrying in ${Math.round(waitMs / 1000)}s ` +
          `(attempt ${attempt + 1} of ${env.throttleRetries})`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  /** Resolves the login behind the token this client is using. */
  getAuthenticatedUser(): Promise<APIResponse> {
    return this.send('get', '/user');
  }
}