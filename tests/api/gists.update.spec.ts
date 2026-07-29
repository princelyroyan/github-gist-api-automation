import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { gistSchema } from '../../src/models/gist.schemas';
import { eventually, expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';

/**
 * PATCH is the most complex logic in the API and the one place where a
 * misunderstanding causes silent data loss, so it gets the most coverage.
 *
 * Decision table for the `files` map (UPD-01..08):
 *
 *   content | filename | key exists | outcome
 *   --------|----------|------------|---------------------------
 *   set     | absent   | yes        | content updated
 *   absent  | set      | yes        | renamed
 *   set     | set      | yes        | renamed and updated
 *   absent  | absent   | yes        | file deleted
 *   null (whole object)| yes        | file deleted
 *   set     | absent   | no         | new file created
 *   (file omitted from payload)     | untouched
 */
test.describe('PATCH /gists/{id} — update semantics', () => {
  test('UPD-01 updates the description without touching files @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('notes.txt', 'unchanged').build(),
    );

    const response = await ownerClient.update(created.id, { description: 'new description' });
    await expectStatus(response, 200);

    const gist = await expectSchema(response, gistSchema);
    expect(gist.description).toBe('new description');
    expect(gist.files['notes.txt'].content).toBe('unchanged');
  });

  test('UPD-02 updates one file and leaves the others alone @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist()
        .withFile('a.txt', 'A original')
        .withFile('b.txt', 'B original')
        .build(),
    );

    const response = await ownerClient.update(created.id, {
      files: { 'a.txt': { content: 'A updated' } },
    });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(gist.files['a.txt'].content).toBe('A updated');
    // The real assertion: PATCH merges, so an unmentioned file must survive.
    expect(gist.files['b.txt'].content).toBe('B original');
    expect(Object.keys(gist.files)).toHaveLength(2);
  });

  test('UPD-03 adds a new file @smoke @P0', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.aGist().withFile('a.txt', 'A').build());

    const response = await ownerClient.update(created.id, {
      files: { 'b.txt': { content: 'B' } },
    });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(Object.keys(gist.files).sort()).toEqual(['a.txt', 'b.txt']);
  });

  test('UPD-04 deletes a file when it is set to null @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('keep.txt', 'keep').withFile('drop.txt', 'drop').build(),
    );

    const response = await ownerClient.update(created.id, { files: { 'drop.txt': null } });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(Object.keys(gist.files)).toEqual(['keep.txt']);
  });

  test('UPD-05 renames a file and preserves its content @P0', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.aGist().withFile('old.md', 'body').build());

    const response = await ownerClient.update(created.id, {
      files: { 'old.md': { filename: 'new.md' } },
    });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(gist.files['old.md']).toBeUndefined();
    expect(gist.files['new.md'].content).toBe('body');
  });

  test('UPD-06 renames and rewrites in one request @P1', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.aGist().withFile('old.md', 'before').build());

    const response = await ownerClient.update(created.id, {
      files: { 'old.md': { filename: 'new.md', content: 'after' } },
    });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(gist.files['old.md']).toBeUndefined();
    expect(gist.files['new.md'].content).toBe('after');
  });

  test('UPD-07 an empty file object deletes the file @P1', async ({ ownerClient, gists }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('keep.txt', 'keep').withFile('drop.txt', 'drop').build(),
    );

    // The obscure rule: no `content` and no `filename` means delete. A client that
    // sends `{}` as a harmless no-op loses the file.
    const response = await ownerClient.update(created.id, { files: { 'drop.txt': {} } });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(Object.keys(gist.files)).toEqual(['keep.txt']);
  });

  test('UPD-08 deleting the only file is rejected @P1', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.aGist().withFile('only.txt', 'x').build());

    const response = await ownerClient.update(created.id, { files: { 'only.txt': null } });

    // Boundary: a gist cannot exist with zero files, so the API refuses rather
    // than cascading into a delete.
    await expectApiError(response, 422);
    expect((await ownerClient.getById(created.id)).status()).toBe(200);
  });

  test('UPD-10 patching a non-existent gist returns 404 @smoke @P0', async ({ ownerClient }) => {
    await expectApiError(await ownerClient.update('0'.repeat(32), { description: 'x' }), 404);
  });

  test('UPD-11 updated_at advances after a change @P1', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.minimal());

    const response = await ownerClient.update(created.id, {
      files: { 'notes.txt': { content: 'changed' } },
    });
    await expectStatus(response, 200);

    const gist = await response.json();
    expect(Date.parse(gist.updated_at)).toBeGreaterThanOrEqual(Date.parse(created.updated_at));
    expect(gist.created_at).toBe(created.created_at);
  });

  test('UPD-13 a secret gist cannot be made public via PATCH @P2', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(GistBuilder.aGist().secret().build());

    const response = await ownerClient.update(created.id, { public: true } as never);
    await expectStatus(response, 200);

    // Accepted but ignored — visibility is immutable after creation, matching the
    // UI, which also offers no way to promote a secret gist. Silent no-ops on
    // unknown fields are worth pinning: a client would have no way to tell.
    expect((await response.json()).public).toBe(false);
  });

  test('SCH-03 each update appends a revision @P1 @contract', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.minimal());
    expect(await (await ownerClient.listCommits(created.id)).json()).toHaveLength(1);

    await expectStatus(
      await ownerClient.update(created.id, { files: { 'notes.txt': { content: 'v2' } } }),
      200,
    );

    // The commits list lags the write it records: a 200 from PATCH does not mean
    // the new revision is queryable yet. Polled rather than asserted outright.
    const commits = await eventually(
      async () => (await ownerClient.listCommits(created.id)).json(),
      (c: unknown[]) => c.length === 2,
      { timeoutMs: 10_000, intervalMs: 1_000 },
    );

    expect(commits).toHaveLength(2);
    await expectSchema(await ownerClient.getById(created.id), gistSchema);
  });
});