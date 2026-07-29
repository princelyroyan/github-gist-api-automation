import { test, expect, GistBuilder, trackIfCreated } from '../../src/fixtures/api.fixtures';
import { gistSchema } from '../../src/models/gist.schemas';
import { expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';
import { uniqueDescription } from '../../src/utils/unique';

test.describe('POST /gists — create', () => {
  test('CRE-01 creates a public gist with a single file @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const gist = await gists.create(
      GistBuilder.aGist().withPublic(true).withFile('notes.txt', 'hello').build(),
    );

    expect(gist.id).toBeTruthy();
    expect(gist.public).toBe(true);
    expect(gist.files['notes.txt'].content).toBe('hello');

    // A brand-new gist has exactly one revision (REV-01). Read from /commits
    // rather than the gist object: API version 2026-03-10 dropped `history`.
    const commits = await (await ownerClient.listCommits(gist.id)).json();
    expect(commits).toHaveLength(1);

    // pause
    // console.log(`\n Paused (20s)\n`);
    // await new Promise((resolve) => setTimeout(resolve, 20_000));
  });

  test('CRE-02 creates a secret gist @smoke @P0', async ({ gists }) => {
    const gist = await gists.create(GistBuilder.aGist().secret().build());

    expect(gist.public).toBe(false);
  });

  test('CRE-03 creates a multi-file gist @smoke @P0', async ({ gists }) => {
    const payload = GistBuilder.multiFile(3);

    const gist = await gists.create(payload);

    expect(Object.keys(gist.files)).toHaveLength(3);
    for (const [filename, file] of Object.entries(payload.files)) {
      expect(gist.files[filename].content).toBe(file.content);
    }
  });

  test('CRE-04 creates a gist without a description @P1', async ({ ownerClient, gists }) => {
    const response = await ownerClient.create({ files: { 'notes.txt': { content: 'x' } } });
    // Register for cleanup before asserting anything: a failed assertion must not
    // be able to leak the gist it was inspecting.
    await trackIfCreated(response, gists);
    await expectStatus(response, 201);

    const gist = await expectSchema(response, gistSchema);
    expect(gist.description === null || gist.description === '').toBe(true);
  });

  test('CRE-05 rejects a payload with no files key @smoke @P0', async ({ ownerClient }) => {
    const response = await ownerClient.create({ description: uniqueDescription() });

    await expectApiError(response, 422);
  });

  test('CRE-06 rejects an empty files object @smoke @P0', async ({ ownerClient }) => {
    const response = await ownerClient.create(GistBuilder.aGist().buildRaw());

    const error = await expectApiError(response, 422);
    expect(error.message).toBeTruthy();
  });

  test('CRE-07 rejects a file with empty content @P1', async ({ ownerClient, gists }) => {
    const response = await ownerClient.create(
      GistBuilder.aGist().withFile('empty.txt', '').build(),
    );
    await trackIfCreated(response, gists);

    // Boundary: GitHub treats an empty file as no file at all, so the whole
    // payload fails validation rather than creating an empty file.
    // See docs/findings.md.
    await expectApiError(response, 422);
  });

  test('CRE-08 coerces public sent as the string "true" @P1', async ({ ownerClient, gists }) => {
    const response = await ownerClient.create(GistBuilder.aGist().withPublic('true').build());
    await trackIfCreated(response, gists);
    await expectStatus(response, 201);

    // Documented as "boolean or string" — a Rails-flavoured tolerance that clients
    // will rely on whether or not it was intended.
    const gist = await expectSchema(response, gistSchema);
    expect(gist.public).toBe(true);
  });

  test('CRE-10 round-trips unicode filenames and content @P1', async ({ gists }) => {
    const filename = 'ユニコード-🎯.md';
    const content = '# 標題\nemoji 🚀 — RTL مرحبا — combining é\n';

    const gist = await gists.create(
      GistBuilder.aGist().withFile(filename, content).build(),
    );

    expect(gist.files[filename]).toBeDefined();
    expect(gist.files[filename].content).toBe(content);
  });

  test('CRE-15 rejects a malformed JSON body @P1', async ({ ownerClient }) => {
    const response = await ownerClient.createRaw('{"files": {"a.txt": {"content": "x"');

    // 422, not the 400 you would expect from an unparseable body: GitHub falls
    // back to treating the whole body as a string and reports it as a *validation*
    // failure ("is not of type object"), quoting the raw input back. A client
    // branching on 400 to mean "I sent bad syntax" never sees it.
    const error = await expectApiError(response, 422);
    expect(error.message).toContain('is not of type');
  });

  test('SCH-01 the created gist matches the gist schema @smoke @P0 @contract', async ({
    ownerClient,
    gists,
  }) => {
    const response = await ownerClient.create(GistBuilder.minimal());
    await trackIfCreated(response, gists);
    await expectStatus(response, 201);

    await expectSchema(response, gistSchema);
    expect(response.headers()['content-type']).toContain('application/json');
  });
});