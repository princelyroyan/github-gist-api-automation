import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { eventually, expectApiError, expectStatus } from '../../src/utils/assertions';

test.describe('DELETE /gists/{id} — delete', () => {
  test('DEL-01/02 deletes a gist and the gist is then gone @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const gist = await gists.create(GistBuilder.minimal());

    const response = await ownerClient.delete(gist.id);

    await expectStatus(response, 204);
    expect(await response.text()).toBe('');

    // Deletion is the one operation with no undo, so verify it actually happened
    // rather than trusting the status code.
    await expectApiError(await ownerClient.getById(gist.id), 404);
  });

  test('DEL-03 a second delete returns 404 @P1', async ({ ownerClient, gists }) => {
    const gist = await gists.create(GistBuilder.minimal());
    await expectStatus(await ownerClient.delete(gist.id), 204);

    // Not idempotent in the 204-every-time sense: the resource is gone, so the
    // second call is a plain not-found.
    await expectApiError(await ownerClient.delete(gist.id), 404);
  });

  test('DEL-04 deleting a non-existent gist returns 404 @P1', async ({ ownerClient }) => {
    await expectApiError(await ownerClient.delete('0'.repeat(32)), 404);
  });

  test('DEL-02 a deleted secret gist stays anonymously readable from cache @P1 @security', async ({
    ownerClient,
    anonClient,
    gists,
  }) => {
    const gist = await gists.create(GistBuilder.aGist().secret().build());

    // Populate the CDN cache the way a leaked URL would.
    //
    // Polled for the same reason as AUTH-08: an anonymous read of a just-created
    // gist can 404 while the write settles (docs/findings.md #19). Without this
    // the test fails before it reaches the behaviour it exists to document.
    const beforeDelete = await eventually(
      () => anonClient.getById(gist.id),
      (r) => r.status() === 200,
      { timeoutMs: 12_000, intervalMs: 4_000 },
    );
    await expectStatus(beforeDelete, 200);
    expect(beforeDelete.headers()['cache-control']).toContain('max-age=60');

    await expectStatus(await ownerClient.delete(gist.id), 204);

    // The owner sees the delete immediately.
    await expectApiError(await ownerClient.getById(gist.id), 404);

    // An anonymous caller does not. Measured at 200 for at least 10 seconds after
    // deletion, consistent with the 60-second cache header above.
    //
    // Read alongside AUTH-08 ("secret" means unlisted, not private), this is the
    // finding with real user consequence: deleting a secret gist whose URL has
    // leaked does not revoke access for up to a minute, and nothing in the API
    // response tells the owner that. Pinned as current behaviour, not endorsed —
    // see docs/findings.md #15.
    //
    // Asserted at the cached state rather than polling past the 60s window, which
    // would add a minute of wall clock to every run for no extra signal.
    await expectStatus(await anonClient.getById(gist.id), 200);
  });
});