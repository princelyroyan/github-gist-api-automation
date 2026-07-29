import type { APIRequestContext, APIResponse } from '@playwright/test';
import { env } from '../config/env';
import { formatRateLimit, readRateLimit } from '../utils/rate-limit';

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

  protected async send(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    options?: Parameters<APIRequestContext['get']>[1],
  ): Promise<APIResponse> {
    const response = await this.request[method](path, options);
    if (env.logRateLimit) {
      // eslint-disable-next-line no-console
      console.log(formatRateLimit(method.toUpperCase(), path, readRateLimit(response)));
    }
    return response;
  }

  /** Resolves the login behind the token this client is using. */
  getAuthenticatedUser(): Promise<APIResponse> {
    return this.send('get', '/user');
  }
}