import { test, expect } from '../../src/fixtures/api.fixtures';
import { gistListSchema } from '../../src/models/gist.schemas';
import {
  eventually,
  expectApiError,
  expectSchema,
  expectStatus,
} from '../../src/utils/assertions';

/**
 * Pagination is asserted against the public feed, which is shared global state.
 * Every assertion here is therefore about an invariant (size, ordering,
 * disjointness), never about specific contents — the feed changes between the
 * two requests of a single test.
 *
 * These tests deliberately use the *authenticated* client even though
 * /gists/public needs no token. Anonymous callers get 60 requests per hour per
 * IP, which is the scarcest resource the suite consumes; the anonymous persona is
 * reserved for the handful of tests where being unauthenticated is the point.
 * See docs/findings.md #18.
 */
test.describe('Pagination and filtering', () => {
  test('PAG-01 the default page size is 30 @P1', async ({ ownerClient }) => {
    const list = await expectSchema(await ownerClient.listPublic(), gistListSchema);

    expect(list.length).toBeLessThanOrEqual(30);
  });

  test('PAG-02/03 per_page is honoured at both ends of the range @P1', async ({ ownerClient }) => {
    const one = await expectSchema(await ownerClient.listPublic({ per_page: 1 }), gistListSchema);
    expect(one).toHaveLength(1);

    const hundred = await expectSchema(
      await ownerClient.listPublic({ per_page: 100 }),
      gistListSchema,
    );
    expect(hundred.length).toBeLessThanOrEqual(100);
    expect(hundred.length).toBeGreaterThan(30);
  });

  test('PAG-04 per_page above the maximum is clamped, not rejected @P1', async ({
    ownerClient,
  }) => {
    const response = await ownerClient.listPublic({ per_page: 101 });
    await expectStatus(response, 200);

    const list = await expectSchema(response, gistListSchema);
    expect(list.length).toBeLessThanOrEqual(100);
  });

  test('PAG-06 the Link header advertises the next page @P1', async ({ ownerClient }) => {
    const response = await ownerClient.listPublic({ per_page: 5 });
    await expectStatus(response, 200);

    const link = response.headers().link;
    expect(link, 'no Link header — pagination is undiscoverable').toBeTruthy();
    expect(link).toContain('rel="next"');
  });

  test('PAG-07 consecutive pages do not overlap @P1', async ({ ownerClient, gists }) => {
    // Run against the caller's own gists rather than the public feed, which churns
    // far too fast for an overlap assertion to mean anything.
    //
    // The four gists are provisioned rather than assumed. An earlier version
    // skipped when the account happened to hold fewer than a page's worth, which
    // meant the test quietly stopped running on a fresh account — a skip is not a
    // pass, and a conditional one hides itself.
    await Promise.all([gists.create(), gists.create(), gists.create(), gists.create()]);

    const page = async (n: number) =>
      expectSchema(await ownerClient.list({ per_page: 2, page: n }), gistListSchema);

    // Even the caller's own list is shared mutable state: other workers in this
    // run create and delete gists in the same account, and an insertion between
    // the two requests pushes an item from page 1 onto page 2. That overlap is a
    // race in the test, not a pagination defect.
    //
    // So the collection is checked for movement rather than assumed still: re-read
    // page 1 afterwards and only trust the pair when it is unchanged. Retrying is
    // honest about the race; a bare assertion would just fail intermittently and
    // teach the team to ignore it.
    let first: Awaited<ReturnType<typeof page>> = [];
    let second: Awaited<ReturnType<typeof page>> = [];
    let stable = false;

    // Eight attempts, not five: five was exhausted once during a heavy parallel
    // run, failing with "the gist list kept changing" — the retry budget running
    // out rather than pagination being wrong. Each attempt is three cheap reads
    // against the 5000/hr authenticated budget, so widening the window is close
    // to free and removes the only remaining source of noise in this test.
    for (let attempt = 0; attempt < 8 && !stable; attempt += 1) {
      first = await page(1);
      second = await page(2);
      const recheck = await page(1);
      stable = JSON.stringify(recheck.map((g) => g.id)) === JSON.stringify(first.map((g) => g.id));
    }

    expect(stable, 'the gist list kept changing under the test after 8 attempts').toBe(true);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);

    const firstIds = new Set(first.map((g) => g.id));
    const overlap = second.filter((g) => firstIds.has(g.id));
    expect(overlap.map((g) => g.id)).toEqual([]);
  });

  test('PAG-08 a page far past the end is refused, not empty @P2', async ({ ownerClient }) => {
    const response = await ownerClient.listPublic({ per_page: 100, page: 99_999 });

    // 422, not an empty array. Deep pagination is capped for performance, so a
    // client walking pages until it gets `[]` never terminates — it hits an error
    // instead. The `Link` header (PAG-06) is the only safe way to paginate.
    const error = await expectApiError(response, 422);
    expect(error.message).toContain('pagination is limited');
  });

  test('PAG-09 since filters to newer results only @P1', async ({ ownerClient, gists }) => {
    const cutoff = new Date(Date.now() - 60_000).toISOString();
    const fresh = await gists.create();

    // Two assertions with different exposure to parallelism, so they are set up
    // differently:
    //
    //  - "the filter excludes nothing older than the cutoff" is an invariant. It
    //    holds no matter what the other workers are writing, because a
    //    concurrent write can only make a gist *newer*.
    //  - "my own gist is in the result" is a read of the list representation
    //    straight after a write, which lags under parallel load (findings #19,
    //    and RD-04/RD-07 for the same shape). Polled, not assumed.
    const list = await eventually(
      async () => {
        const response = await ownerClient.list({ since: cutoff, per_page: 100 });
        await expectStatus(response, 200);
        return expectSchema(response, gistListSchema);
      },
      (found) => found.some((g) => g.id === fresh.id),
      { timeoutMs: 20_000, intervalMs: 2_000 },
    );

    expect(list.map((g) => g.id)).toContain(fresh.id);
    expect(list.every((g) => Date.parse(g.updated_at) >= Date.parse(cutoff))).toBe(true);
  });

  test('PAG-11 a future-dated since returns nothing @P2', async ({ ownerClient }) => {
    const future = new Date(Date.now() + 86_400_000).toISOString();

    const list = await expectSchema(
      await ownerClient.list({ since: future, per_page: 100 }),
      gistListSchema,
    );

    expect(list).toEqual([]);
  });
});