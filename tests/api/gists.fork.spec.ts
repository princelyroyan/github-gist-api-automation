import { test, expect, GistBuilder, trackIfCreated } from '../../src/fixtures/api.fixtures';
import { gistSchema } from '../../src/models/gist.schemas';
import { eventually, expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';

test.describe('Fork', () => {
  test('FRK-01 user B forks user A public gist @P1 @slow', async ({
    otherClient,
    otherGists,
    gists,
  }) => {
    const original = await gists.create(
      GistBuilder.aGist().withPublic(true).withFile('a.txt', 'forked content').build(),
    );

    const response = await otherClient.fork(original.id);
    // Registered with account B's client so teardown deletes it as its owner,
    // and registered before any assertion so a failure cannot leak it.
    await trackIfCreated(response, otherGists);
    await expectStatus(response, 201);

    const fork = await expectSchema(response, gistSchema);
    expect(fork.id).not.toBe(original.id);

    // The 201 body uses the *list* representation — file metadata but no
    // `content` — even though POST /gists returns the full detail shape. A client
    // that reads `content` straight off the fork response silently gets undefined,
    // so the content assertion has to re-fetch. See docs/findings.md #16.
    expect(fork.files['a.txt'].content).toBeUndefined();

    const refetched = await expectSchema(await otherClient.getById(fork.id), gistSchema);
    expect(refetched.files['a.txt'].content).toBe('forked content');
  });

  test('FRK-02 the fork shows up on the original @P2 @slow', async ({
    ownerClient,
    otherClient,
    otherGists,
    gists,
  }) => {
    const original = await gists.create(GistBuilder.aGist().withPublic(true).build());
    const fork = await (await otherClient.fork(original.id)).json();
    otherGists.track(fork.id);

    // Fork propagation is eventually consistent — poll rather than sleep.
    const forks = await eventually(
      async () => (await ownerClient.listForks(original.id)).json(),
      (list: Array<{ id: string }>) => list.some((f) => f.id === fork.id),
    );

    expect(forks.map((f: { id: string }) => f.id)).toContain(fork.id);
  });

  test('FRK-03 forking your own gist is rejected @P1', async ({ ownerClient, gists }) => {
    const original = await gists.create(GistBuilder.aGist().withPublic(true).build());

    const response = await ownerClient.fork(original.id);
    await trackIfCreated(response, gists);

    await expectApiError(response, 422);
  });

  test('FRK-05 forking requires authentication @P1 @security', async ({ anonClient, gists }) => {
    const original = await gists.create(GistBuilder.aGist().withPublic(true).build());

    await expectApiError(await anonClient.fork(original.id), 401);
  });

  test('FRK-06 editing a fork does not affect the original @P1 @slow', async ({
    ownerClient,
    otherClient,
    otherGists,
    gists,
  }) => {
    const original = await gists.create(
      GistBuilder.aGist().withPublic(true).withFile('a.txt', 'original content').build(),
    );
    const fork = await (await otherClient.fork(original.id)).json();
    otherGists.track(fork.id);

    await expectStatus(
      await otherClient.update(fork.id, { files: { 'a.txt': { content: 'fork content' } } }),
      200,
    );

    // The isolation guarantee. If this ever fails, one user can rewrite another
    // user's data through a fork — the worst failure mode in the whole feature.
    const reread = await expectSchema(await ownerClient.getById(original.id), gistSchema);
    expect(reread.files['a.txt'].content).toBe('original content');
  });
});