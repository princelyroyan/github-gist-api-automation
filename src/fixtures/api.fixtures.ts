import { test as base, request, type APIRequestContext, type APIResponse } from '@playwright/test';
import { GistsClient } from '../clients/gists.client';
import { CommentsClient } from '../clients/comments.client';
import { env } from '../config/env';
import { GistBuilder } from '../builders/gist.builder';
import type { CreateGistPayload } from '../models/gist.types';
import type { Gist } from '../models/gist.schemas';
import { assertNotRateLimited, eventually } from '../utils/assertions';

/**
 * Personas are equivalence partitions over authorization, so they are modelled as
 * fixtures rather than as a token argument threaded through every call. A spec
 * declares which personas it needs and gets exactly those.
 */
export type Persona = 'owner' | 'other' | 'anonymous' | 'invalid';

/**
 * Creates gists and guarantees their removal.
 *
 * Cleanup lives in the fixture's teardown phase, which Playwright runs even when
 * the test throws — an `afterEach` can be skipped, a teardown cannot. This is
 * what makes `fullyParallel` safe against a live production API.
 */
export type GistFactory = {
  create(payload?: CreateGistPayload): Promise<Gist>;
  /** Registers a gist created outside the factory (e.g. a fork) for cleanup. */
  track(gistId: string, client?: GistsClient): void;
};

type WorkerFixtures = {
  ownerLogin: string;
  otherLogin: string;
};

type TestFixtures = {
  ownerClient: GistsClient;
  otherClient: GistsClient;
  anonClient: GistsClient;
  invalidTokenClient: GistsClient;
  ownerComments: CommentsClient;
  otherComments: CommentsClient;
  anonComments: CommentsClient;
  gists: GistFactory;
  otherGists: GistFactory;
  /** A secret, single-file gist owned by account A, deleted after the test. */
  tempGist: Gist;
};

function headers(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': env.apiVersion,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function newContext(token?: string): Promise<APIRequestContext> {
  return request.newContext({ baseURL: env.baseUrl, extraHTTPHeaders: headers(token) });
}

/** Wires a context into a client, hands it to the test, then disposes it. */
async function withClient<T>(
  token: string | undefined,
  make: (ctx: APIRequestContext) => T,
  use: (value: T) => Promise<void>,
): Promise<void> {
  const ctx = await newContext(token);
  try {
    await use(make(ctx));
  } finally {
    await ctx.dispose();
  }
}

async function resolveLogin(token: string, configured: string | undefined): Promise<string> {
  if (configured) return configured;
  const ctx = await newContext(token);
  try {
    const response = await ctx.get('/user');
    if (!response.ok()) {
      throw new Error(
        `Could not resolve the login for this token (GET /user -> ${response.status()}). ` +
          'Check the token is valid, or set GITHUB_USERNAME_A / GITHUB_USERNAME_B in .env.',
      );
    }
    return (await response.json()).login as string;
  } finally {
    await ctx.dispose();
  }
}

function makeFactory(client: GistsClient): { factory: GistFactory; cleanup: () => Promise<void> } {
  const tracked: Array<{ id: string; client: GistsClient }> = [];

  const factory: GistFactory = {
    async create(payload = GistBuilder.minimal()) {
      const response = await client.create(payload);
      if (response.status() !== 201) {
        // Names a rate limit as a rate limit. Without this, a throttled run
        // reports 47 identical "fixture setup failed" errors and reads like the
        // suite is broken rather than the account being temporarily blocked.
        await assertNotRateLimited(response);
        throw new Error(
          `Fixture setup failed: POST /gists returned ${response.status()} — ${await response.text()}`,
        );
      }
      const gist = (await response.json()) as Gist;
      tracked.push({ id: gist.id, client });

      // A 201 does not mean the gist is usable yet. Reads and even the owner's
      // own writes have been observed returning 404 immediately after creation —
      // UPD-04 failed on `PATCH` of a gist its own test had just made. That is
      // read-after-write lag in the system under test, not a defect in the test.
      //
      // Settling here rather than in each spec is deliberate: the alternative is
      // a retry bolted onto every test that touches fresh data, which is both
      // repetitive and easy to forget on the next test someone adds. It costs one
      // extra GET per gist — trivial against the 5000/hr authenticated budget.
      await eventually(
        () => client.getById(gist.id),
        (r) => r.ok(),
        { timeoutMs: 10_000, intervalMs: 500 },
      );

      // The commits list settles separately from the gist itself, so several
      // tests that read /commits straight after creation (REV-01, REV-03, REV-06,
      // CRE-01) can see an empty list even once getById succeeds. Waiting for the
      // creation commit here covers all of them. Tests that assert on commits
      // added by a later PATCH still poll for themselves — that is a different
      // write, and the factory cannot know about it.
      await eventually(
        async () => (await client.listCommits(gist.id)).json().catch(() => []),
        (commits: unknown) => Array.isArray(commits) && commits.length >= 1,
        { timeoutMs: 10_000, intervalMs: 500 },
      );

      return gist;
    },
    track(gistId, withClientOverride) {
      tracked.push({ id: gistId, client: withClientOverride ?? client });
    },
  };

  const cleanup = async () => {
    // Reverse order so forks are removed before their originals.
    for (const { id, client: owner } of tracked.reverse()) {
      // A test may legitimately have deleted the gist itself; a failed delete here
      // must never fail the test, only leave an orphan for scripts/cleanup.ts.
      await owner.delete(id).catch(() => undefined);
    }
  };

  return { factory, cleanup };
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // --- Worker-scoped: resolved once per worker, not once per test -----------

  ownerLogin: [
    async ({}, use) => {
      await use(await resolveLogin(env.tokenOwner, env.usernameOwner));
    },
    { scope: 'worker' },
  ],

  otherLogin: [
    async ({}, use) => {
      await use(await resolveLogin(env.tokenOther, env.usernameOther));
    },
    { scope: 'worker' },
  ],

  // --- Personas ------------------------------------------------------------

  ownerClient: async ({}, use) => {
    await withClient(env.tokenOwner, (ctx) => new GistsClient(ctx), use);
  },

  otherClient: async ({}, use) => {
    await withClient(env.tokenOther, (ctx) => new GistsClient(ctx), use);
  },

  anonClient: async ({}, use) => {
    await withClient(undefined, (ctx) => new GistsClient(ctx), use);
  },

  invalidTokenClient: async ({}, use) => {
    await withClient('ghp_thisTokenIsDeliberatelyInvalid0000000000', (ctx) => new GistsClient(ctx), use);
  },

  ownerComments: async ({}, use) => {
    await withClient(env.tokenOwner, (ctx) => new CommentsClient(ctx), use);
  },

  otherComments: async ({}, use) => {
    await withClient(env.tokenOther, (ctx) => new CommentsClient(ctx), use);
  },

  anonComments: async ({}, use) => {
    await withClient(undefined, (ctx) => new CommentsClient(ctx), use);
  },

  // --- Test data -----------------------------------------------------------

  gists: async ({ ownerClient }, use) => {
    const { factory, cleanup } = makeFactory(ownerClient);
    await use(factory);
    await cleanup();
  },

  otherGists: async ({ otherClient }, use) => {
    const { factory, cleanup } = makeFactory(otherClient);
    await use(factory);
    await cleanup();
  },

  tempGist: async ({ gists }, use) => {
    await use(await gists.create(GistBuilder.minimal()));
  },
});

/**
 * Registers a gist for cleanup straight off the creation response, before any
 * assertion has had the chance to throw.
 *
 * Tests that need the raw response (to assert on its status or schema) cannot use
 * `factory.create`, and the obvious shape — assert, parse, then track — leaks the
 * gist whenever an assertion fails. Which is exactly when it happens: two orphans
 * were left behind by a failing schema assertion during development. Track first,
 * assert second.
 *
 * A non-201 is ignored: there is nothing to clean up.
 */
export async function trackIfCreated(
  response: APIResponse,
  factory: GistFactory,
): Promise<void> {
  if (response.status() !== 201) return;
  const body = await response.json().catch(() => null);
  if (body?.id) factory.track(body.id);
}

export { expect } from '@playwright/test';
export { GistBuilder } from '../builders/gist.builder';