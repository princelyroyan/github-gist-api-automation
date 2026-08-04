import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { gistListSchema } from '../../src/models/gist.schemas';
import {
  eventually,
  expectApiError,
  expectSchema,
  expectStatus,
} from '../../src/utils/assertions';

/**
 * Star is a two-state machine (unstarred <-> starred) reached by three endpoints.
 * It is cheap to cover exhaustively, which makes it the best place in the suite to
 * demonstrate state-transition coverage rather than sampled cases.
 */
test.describe('Star lifecycle', () => {
  test('STR-01/02/03/06 walks the full star state machine @P1', async ({
    ownerClient,
    tempGist,
  }) => {
    // 404 here means "not starred", not "no such gist" — an overloaded status
    // code the client cannot disambiguate. See docs/findings.md #4.
    await expectStatus(await ownerClient.isStarred(tempGist.id), 404);

    await expectStatus(await ownerClient.star(tempGist.id), 204);
    await expectStatus(await ownerClient.isStarred(tempGist.id), 204);

    await expectStatus(await ownerClient.unstar(tempGist.id), 204);
    await expectStatus(await ownerClient.isStarred(tempGist.id), 404);
  });

  test('STR-04 a starred gist appears in the starred list @P1', async ({
    ownerClient,
    tempGist,
  }) => {
    await expectStatus(await ownerClient.star(tempGist.id), 204);

    // /gists/starred is account-wide state, so this deliberately asserts only
    // that the test's own gist is present — never a count, never a position.
    // Other workers star and unstar their own gists in the same account
    // throughout the run.
    //
    // Polled for the same reason as RD-04: this is a list read immediately
    // after a write, and the list representation settles behind the write that
    // caused it (findings #19). The 204 from PUT .../star is not a promise that
    // the starred list has caught up.
    const starredIds = await eventually(
      async () => {
        const response = await ownerClient.listStarred({ per_page: 100 });
        await expectStatus(response, 200);
        return (await expectSchema(response, gistListSchema)).map((g) => g.id);
      },
      (ids) => ids.includes(tempGist.id),
      { timeoutMs: 20_000, intervalMs: 2_000 },
    );

    expect(starredIds).toContain(tempGist.id);

    await ownerClient.unstar(tempGist.id);
  });

  test('STR-05 starring twice is idempotent @P1', async ({ ownerClient, tempGist }) => {
    await expectStatus(await ownerClient.star(tempGist.id), 204);
    await expectStatus(await ownerClient.star(tempGist.id), 204);

    await expectStatus(await ownerClient.isStarred(tempGist.id), 204);
  });

  test('STR-07 unstarring an unstarred gist is idempotent @P2', async ({
    ownerClient,
    tempGist,
  }) => {
    await expectStatus(await ownerClient.unstar(tempGist.id), 204);
    await expectStatus(await ownerClient.unstar(tempGist.id), 204);
  });

  test('STR-08 starring a non-existent gist returns 404 @P2', async ({ ownerClient }) => {
    await expectApiError(await ownerClient.star('0'.repeat(32)), 404);
  });

  test('STR-09 starring requires authentication @P1 @security', async ({
    anonClient,
    tempGist,
  }) => {
    await expectApiError(await anonClient.star(tempGist.id), 401);
  });

  test('STR-10 user B can star user A public gist @P2', async ({ otherClient, gists }) => {
    const gist = await gists.create(GistBuilder.aGist().withPublic(true).build());

    // Starring is not a write to the gist, so unlike PATCH it is allowed
    // cross-user. Worth stating explicitly next to AUTH-05.
    await expectStatus(await otherClient.star(gist.id), 204);
    await expectStatus(await otherClient.isStarred(gist.id), 204);

    await otherClient.unstar(gist.id);
  });
});