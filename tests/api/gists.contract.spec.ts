import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import {
  errorSchema,
  gistListSchema,
  gistSchema,
  strictGistSchema,
} from '../../src/models/gist.schemas';
import { expectSchema, expectStatus } from '../../src/utils/assertions';

/**
 * Contract tests exist because we do not control this API's release cadence. They
 * are the cheapest possible detector for a breaking change shipped without notice.
 */
test.describe('Response contract', () => {
  test('SCH-01 the gist detail response matches the schema @smoke @P0 @contract', async ({
    ownerClient,
    tempGist,
  }) => {
    await expectSchema(await ownerClient.getById(tempGist.id), gistSchema);
  });

  test('SCH-02 the gist list response matches the list schema @P0 @contract', async ({
    ownerClient,
  }) => {
    const response = await ownerClient.list({ per_page: 10 });
    await expectStatus(response, 200);

    await expectSchema(response, gistListSchema);
  });

  test('SCH-05 the error response has a usable shape @P1 @contract', async ({ ownerClient }) => {
    const response = await ownerClient.getById('0'.repeat(32));
    await expectStatus(response, 404);

    // Error contracts deserve the same treatment as success contracts — a client's
    // error handling breaks just as loudly when the shape changes.
    const error = await expectSchema(response, errorSchema);
    expect(error.message).toBe('Not Found');
    expect(error.documentation_url).toContain('docs.github.com');
  });

  test('SCH-05 a validation error carries an errors array @P1 @contract', async ({
    ownerClient,
  }) => {
    const response = await ownerClient.create(GistBuilder.aGist().buildRaw());
    await expectStatus(response, 422);

    const error = await expectSchema(response, errorSchema);
    expect(error.message).toBeTruthy();
  });

  test('SCH-06 timestamps are ISO 8601 UTC @P1 @contract', async ({ ownerClient, tempGist }) => {
    const gist = await expectSchema(await ownerClient.getById(tempGist.id), gistSchema);

    for (const value of [gist.created_at, gist.updated_at]) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    }
  });

  test('SCH-07 URLs in the response are well formed and reachable @P1 @contract', async ({
    ownerClient,
    tempGist,
  }) => {
    const gist = await expectSchema(await ownerClient.getById(tempGist.id), gistSchema);

    expect(new URL(gist.url).host).toBe('api.github.com');
    expect(new URL(gist.html_url).host).toBe('gist.github.com');

    // The raw URL is what a client follows when a file is truncated, so a broken
    // one is a silent data-access failure rather than an obvious 404.
    const raw = await ownerClient.context.get(gist.files['notes.txt'].raw_url);
    await expectStatus(raw, 200);
    expect(await raw.text()).toBe('initial content');
  });

  test('SCH-08 no unexpected fields on the gist object @P1 @contract @drift', async ({
    ownerClient,
    tempGist,
  }) => {
    const body = await (await ownerClient.getById(tempGist.id)).json();
    const result = strictGistSchema.safeParse(body);

    // Informational drift detector, deliberately separate from the passthrough
    // schemas above: a failure here means GitHub added a field, which is a
    // documentation task, not a broken build. Kept out of @smoke for that reason.
    expect(
      result.success,
      result.success
        ? ''
        : `New or changed fields on the gist object:\n${JSON.stringify(result.error.issues, null, 2)}`,
    ).toBe(true);
  });

  test('SCH-10 the pinned API version has dropped history and forks @P1 @contract @drift', async ({
    ownerClient,
    tempGist,
  }) => {
    // The breaking change between the two supported versions, pinned deliberately.
    //
    // 2022-11-28 embeds `history` and `forks` in the gist object; 2026-03-10
    // removed both, so a client that reads `gist.history[0].version` to find a
    // revision SHA gets `undefined` the moment it adopts the newer version — with
    // no error and no deprecation visible in the response.
    //
    // This is exactly the class of change a contract suite exists to catch, and
    // the reason every revision assertion in this suite reads /commits instead.
    const current = await (await ownerClient.getById(tempGist.id)).json();
    expect(current.history, 'history reappeared — re-check the revision tests').toBeUndefined();
    expect(current.forks).toBeUndefined();

    const legacy = await ownerClient.context.get(`/gists/${tempGist.id}`, {
      headers: { 'X-GitHub-Api-Version': '2022-11-28' },
    });
    await expectStatus(legacy, 200);
    const legacyBody = await legacy.json();
    expect(Array.isArray(legacyBody.history)).toBe(true);

    // /commits is the representation that works on both versions.
    const commits = await ownerClient.listCommits(tempGist.id);
    await expectStatus(commits, 200);
    expect((await commits.json())[0].version).toBe(legacyBody.history[0].version);
  });

  test('SCH-09 responses are JSON with a charset @P2 @contract', async ({ ownerClient }) => {
    const headers = (await ownerClient.list({ per_page: 1 })).headers();

    expect(headers['content-type']).toBe('application/json; charset=utf-8');
  });
});