import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { gistSchema, gistHistoryEntrySchema } from '../../src/models/gist.schemas';
import { z } from 'zod';
import { eventually, expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';

/**
 * All revision access goes through GET /gists/{id}/commits rather than the gist
 * object's `history` array. API version 2026-03-10 removed `history` (and
 * `forks`) from the gist object; 2022-11-28 still returns both. `/commits` is the
 * only representation that works on either version. See docs/findings.md #12.
 */
type Commit = z.infer<typeof gistHistoryEntrySchema>;

test.describe('Revisions and history', () => {
  test('REV-01 a new gist has exactly one revision @P1', async ({ ownerClient, gists }) => {
    const gist = await gists.create(GistBuilder.minimal());

    const commits = await expectSchema(
      await ownerClient.listCommits(gist.id),
      z.array(gistHistoryEntrySchema),
    );
    expect(commits).toHaveLength(1);
    expect(commits[0].change_status.deletions).toBe(0);
  });

  test('REV-02 each update appends a commit @P1', async ({ ownerClient, gists }) => {
    const created = await gists.create(GistBuilder.minimal());

    await expectStatus(
      await ownerClient.update(created.id, { files: { 'notes.txt': { content: 'v2' } } }),
      200,
    );
    await expectStatus(
      await ownerClient.update(created.id, { files: { 'notes.txt': { content: 'v3' } } }),
      200,
    );

    // Same read-after-write lag as SCH-03 — poll for the expected count rather
    // than assuming the third commit is queryable the moment PATCH returns 200.
    await eventually(
      async () => (await ownerClient.listCommits(created.id)).json(),
      (c: unknown[]) => c.length === 3,
      { timeoutMs: 10_000, intervalMs: 1_000 },
    );

    const response = await ownerClient.listCommits(created.id);
    await expectStatus(response, 200);

    const commits = await expectSchema(response, z.array(gistHistoryEntrySchema));
    expect(commits).toHaveLength(3);
  });

  test('REV-03 an old revision still returns the old content @P1', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('notes.txt', 'version one').build(),
    );
    const firstSha = (await (await ownerClient.listCommits(created.id)).json())[0].version;

    await expectStatus(
      await ownerClient.update(created.id, { files: { 'notes.txt': { content: 'version two' } } }),
      200,
    );

    const response = await ownerClient.getRevision(created.id, firstSha);
    await expectStatus(response, 200);

    // The data-integrity guarantee behind the Revisions tab: history is immutable,
    // so an old SHA must never reflect a later edit.
    const revision = await expectSchema(response, gistSchema);
    expect(revision.files['notes.txt'].content).toBe('version one');

    // The same read-after-write lag REV-02 polls for, on the gist body rather
    // than on /commits: a 200 from PATCH does not mean the next GET has caught
    // up. Seen in CI on 2026-08-03, where the revision correctly returned the
    // old content and the *current* read also still returned it — which reads
    // like the update was lost, and is really just the read being stale. Only
    // once the throttling in findings #23 was fixed did this become visible.
    const currentContent = await eventually(
      async () =>
        (await (await ownerClient.getById(created.id)).json()).files['notes.txt'].content,
      (content: string) => content === 'version two',
      { timeoutMs: 10_000, intervalMs: 1_000 },
    );
    expect(currentContent).toBe('version two');
  });

  test('REV-04 change_status reflects the actual diff @P2', async ({ ownerClient, gists }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('notes.txt', 'line1\nline2\n').build(),
    );

    await expectStatus(
      await ownerClient.update(created.id, {
        files: { 'notes.txt': { content: 'line1\nline2\nline3\n' } },
      }),
      200,
    );

    // Poll for the second commit before reading commits[0]. Without this the test
    // reads the *creation* commit — whose change_status is 2 additions for a
    // two-line file — and fails claiming the diff is wrong when the real problem
    // is that the update's commit has not appeared yet (findings #19).
    const commits = await eventually(
      async (): Promise<Commit[]> => (await ownerClient.listCommits(created.id)).json(),
      (c) => c.length === 2,
      { timeoutMs: 10_000, intervalMs: 1_000 },
    );
    const latest = commits[0];

    expect(latest.change_status.additions).toBe(1);
    expect(latest.change_status.deletions).toBe(0);
    expect(latest.change_status.total).toBe(1);
  });

  test('REV-05 an invalid SHA is rejected @P2', async ({ ownerClient, tempGist }) => {
    const response = await ownerClient.getRevision(tempGist.id, 'not-a-sha');

    expect([404, 422]).toContain(response.status());
  });

  test('REV-06 a SHA from another gist is rejected @P2 @security', async ({
    ownerClient,
    gists,
  }) => {
    // The file contents must differ. Two gists created with identical content in
    // the same second produce the *same* commit SHA, so the "foreign" SHA is a
    // legitimate revision of both and the endpoint correctly returns 200 — a
    // false failure that says nothing about the boundary being tested.
    const [a, b] = await Promise.all([
      gists.create(GistBuilder.aGist().withFile('n.txt', 'alpha').build()),
      gists.create(GistBuilder.aGist().withFile('n.txt', 'beta').build()),
    ]);
    const shaOfB = (await (await ownerClient.listCommits(b.id)).json())[0].version;

    await expectApiError(await ownerClient.getRevision(a.id, shaOfB), 422);
  });
});