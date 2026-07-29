import { test, expect } from '../../src/fixtures/api.fixtures';
import { commentListSchema, commentSchema, gistSchema } from '../../src/models/gist.schemas';
import { expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';

test.describe('Gist comments', () => {
  test('CMT-01/02/03 creates a comment, lists it, and bumps the counter @P2', async ({
    ownerClient,
    ownerComments,
    tempGist,
  }) => {
    expect(tempGist.comments).toBe(0);

    const created = await ownerComments.create(tempGist.id, { body: 'a manual test comment' });
    await expectStatus(created, 201);
    const comment = await expectSchema(created, commentSchema);
    expect(comment.body).toBe('a manual test comment');

    const list = await expectSchema(
      await ownerComments.list(tempGist.id),
      commentListSchema,
    );
    expect(list.map((c) => c.id)).toContain(comment.id);

    // The counter lives on the parent gist, so it is a cross-resource side effect.
    const gist = await expectSchema(await ownerClient.getById(tempGist.id), gistSchema);
    expect(gist.comments).toBe(1);
  });

  test('CMT-04/05 updates and deletes its own comment @P2', async ({
    ownerComments,
    tempGist,
  }) => {
    const comment = await (
      await ownerComments.create(tempGist.id, { body: 'first' })
    ).json();

    const updated = await ownerComments.update(tempGist.id, comment.id, { body: 'second' });
    await expectStatus(updated, 200);
    expect((await updated.json()).body).toBe('second');

    await expectStatus(await ownerComments.delete(tempGist.id, comment.id), 204);
    await expectApiError(await ownerComments.getById(tempGist.id, comment.id), 404);
  });

  test('CMT-06 user B cannot edit user A comment @P2 @security', async ({
    ownerComments,
    otherComments,
    gists,
    ownerClient,
  }) => {
    // Public so account B can reach the gist at all — this isolates the comment
    // permission check from the gist visibility check.
    const gist = await gists.create({
      description: 'comment permissions',
      public: true,
      files: { 'notes.txt': { content: 'x' } },
    });
    const comment = await (await ownerComments.create(gist.id, { body: 'mine' })).json();

    const response = await otherComments.update(gist.id, comment.id, { body: 'hijacked' });

    expect([403, 404]).toContain(response.status());
    const reread = await ownerComments.getById(gist.id, comment.id);
    expect((await reread.json()).body).toBe('mine');
    await expectStatus(await ownerClient.getById(gist.id), 200);
  });

  test('CMT-07 an empty comment body is rejected @P2', async ({ ownerComments, tempGist }) => {
    await expectApiError(await ownerComments.create(tempGist.id, { body: '' }), 422);
  });

  test('CMT-08 commenting on a non-existent gist returns 404 @P2', async ({ ownerComments }) => {
    await expectApiError(await ownerComments.create('0'.repeat(32), { body: 'x' }), 404);
  });
});