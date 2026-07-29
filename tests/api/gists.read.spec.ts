import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { errorSchema, gistListSchema, gistSchema } from '../../src/models/gist.schemas';
import { eventually, expectApiError, expectSchema, expectStatus } from '../../src/utils/assertions';

test.describe('GET /gists — read', () => {
  test('RD-01 returns a gist by id with content intact @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('notes.txt', 'round trip me').build(),
    );

    const response = await ownerClient.getById(created.id);
    await expectStatus(response, 200);

    const gist = await expectSchema(response, gistSchema);
    expect(gist.id).toBe(created.id);
    expect(gist.files['notes.txt'].content).toBe('round trip me');
    expect(gist.files['notes.txt'].truncated).toBe(false);
  });

  test('RD-02 returns 404 for a non-existent id @smoke @P0', async ({ ownerClient }) => {
    const response = await ownerClient.getById('0'.repeat(32));

    await expectApiError(response, 404);
  });

  test('RD-03 rejects malformed ids without leaking anything @P1 @security', async ({
    ownerClient,
  }) => {
    // Inputs that reach the API handler get the documented JSON error contract.
    for (const id of ['!!!', "1' OR '1'='1"]) {
      const response = await ownerClient.getById(encodeURIComponent(id));

      await expectStatus(response, 404);
      const error = await expectSchema(response, errorSchema);
      expect(error.message).toBe('Not Found');
    }

    // An encoded path traversal never reaches the handler: it is rejected at the
    // edge with 400 and an **HTML** body, so the JSON error contract every client
    // is written against does not hold here. A client that blindly parses error
    // responses as JSON throws instead of handling the error. Recorded as a
    // contract inconsistency in docs/findings.md #17.
    const traversal = await ownerClient.getById(encodeURIComponent('../../user'));

    await expectStatus(traversal, 400);
    expect(traversal.headers()['content-type']).toContain('text/html');
    const body = await traversal.text();
    expect(body).not.toContain('"files"');
  });

  test('RD-04 the authenticated list includes the caller secret gists @smoke @P0', async ({
    ownerClient,
    gists,
  }) => {
    const secret = await gists.create(GistBuilder.aGist().secret().build());

    const response = await ownerClient.list({ per_page: 100 });
    await expectStatus(response, 200);

    const list = await expectSchema(response, gistListSchema);
    expect(list.map((g) => g.id)).toContain(secret.id);
  });

  test('RD-05 the anonymous list is a different resource entirely @P1', async ({
    anonClient,
    gists,
  }) => {
    const secret = await gists.create(GistBuilder.aGist().secret().build());

    const response = await anonClient.list({ per_page: 100 });
    await expectStatus(response, 200);

    // Same path, two contracts: authenticated returns *your* gists, anonymous
    // returns the global public feed. A client that assumes one shape breaks
    // silently when the token expires. See docs/findings.md #2.
    const list = await expectSchema(response, gistListSchema);
    expect(list.map((g) => g.id)).not.toContain(secret.id);
    expect(list.every((g) => g.public)).toBe(true);
  });

  // Authenticated on purpose: /gists/public needs no token, and the anonymous
  // budget (60/hr per IP) is reserved for tests where anonymity is the subject.
  test('RD-06 the public feed is ordered by creation, not update @P1', async ({ ownerClient }) => {
    const response = await ownerClient.listPublic({ per_page: 100 });
    await expectStatus(response, 200);

    const list = await expectSchema(response, gistListSchema);
    expect(list.length).toBeGreaterThan(0);

    // Assert the invariant, never the contents — this is shared global state.
    //
    // The docs describe this feed as "sorted by most recently updated", but it is
    // not: a gist edited after creation keeps its original position. Ordering by
    // created_at holds exactly. Asserted against observed behaviour, with the
    // documentation mismatch recorded in docs/findings.md #13.
    const created = list.map((g) => Date.parse(g.created_at));
    expect(created).toEqual([...created].sort((a, b) => b - a));
  });

  test('RD-07 a user gist list hides secret gists from everyone but the owner @smoke @P0 @security', async ({
    ownerClient,
    otherClient,
    anonClient,
    gists,
    ownerLogin,
  }) => {
    const secret = await gists.create(GistBuilder.aGist().secret().build());
    const shown = await gists.create(GistBuilder.aGist().withPublic(true).build());

    // The endpoint is caller-aware, not simply "public only": account A sees its
    // own secret gists here. That is the correct behaviour and it is the opposite
    // of what the endpoint's name suggests, so it is asserted rather than assumed.
    const own = await expectSchema(
      await ownerClient.listForUser(ownerLogin, { per_page: 100 }),
      gistListSchema,
    );
    expect(own.map((g) => g.id)).toContain(shown.id);
    expect(own.map((g) => g.id)).toContain(secret.id);

    // Now the assertion that actually guards a security boundary: nobody else
    // sees the secret gist.
    //
    // A non-owner's view of this endpoint is eventually consistent. Under
    // parallel load the just-created public gist has been observed missing from
    // it, though it appears instantly when the API is idle. The mechanism is not
    // confirmed: the obvious candidate — the `private, max-age=60` cache header —
    // was ruled out by direct probing (no `age` header, no stale body). So this
    // polls rather than claiming a cause it cannot demonstrate.
    //
    // Polling for the *public* gist does double duty. It removes the flake, and
    // it proves the list is fresh — which is what makes the absence of the secret
    // gist a real assertion instead of a vacuous one against a stale list that is
    // simply missing both.
    const otherIds = await eventually(
      async () =>
        (
          await expectSchema(
            await otherClient.listForUser(ownerLogin, { per_page: 100 }),
            gistListSchema,
          )
        ).map((g) => g.id),
      (ids) => ids.includes(shown.id),
      { timeoutMs: 20_000, intervalMs: 2_000 },
    );

    expect(otherIds, 'account B should see the public gist').toContain(shown.id);
    expect(otherIds, 'account B must NOT see the secret gist').not.toContain(secret.id);

    // Anonymous gets a single request, deliberately: the anonymous budget is
    // 60/hr per IP and polling here would be the most expensive thing in the
    // suite. Account B above has already established that the listing is fresh,
    // so one check is enough to cover the no-token partition.
    const anonIds = (
      await expectSchema(
        await anonClient.listForUser(ownerLogin, { per_page: 100 }),
        gistListSchema,
      )
    ).map((g) => g.id);

    expect(anonIds, 'anonymous must NOT see the secret gist').not.toContain(secret.id);
  });

  test('RD-08 returns 404 for a non-existent user @P1', async ({ ownerClient }) => {
    const response = await ownerClient.listForUser('this-user-should-not-exist-qa-auto-xyz');

    await expectApiError(response, 404);
  });

  test('RD-09 list responses omit file content, detail responses include it @P1 @contract', async ({
    ownerClient,
    gists,
  }) => {
    const created = await gists.create(
      GistBuilder.aGist().withFile('notes.txt', 'detail only').build(),
    );

    const list = await expectSchema(
      await ownerClient.list({ per_page: 100 }),
      gistListSchema,
    );
    const listed = list.find((g) => g.id === created.id);
    expect(listed, 'newly created gist missing from the authenticated list').toBeDefined();

    // The contract difference most clients discover the hard way.
    expect(listed!.files['notes.txt'].content).toBeUndefined();

    const detail = await expectSchema(await ownerClient.getById(created.id), gistSchema);
    expect(detail.files['notes.txt'].content).toBe('detail only');
  });

  test('RD-10 conditional requests are supported @P2', async ({ ownerClient, tempGist }) => {
    // 304 is an optimisation, not a guarantee. RFC 9110 explicitly permits a
    // server to answer a conditional GET with the full representation even when
    // the validator still matches, and GitHub was observed doing exactly that
    // under parallel load — a 200 with a current, valid If-None-Match.
    //
    // Two hypotheses were tested and disproved before landing here: response
    // caching (no `age` header, nothing stale ever served) and ETag instability
    // (six consecutive reads of an unchanged gist returned one identical ETag,
    // and conditional requests succeeded 5/5 in isolation).
    //
    // So the assertion is that the *capability* works, not that it fires on any
    // particular request. A single strict check would be asserting something the
    // spec does not promise, which is a flaky test by construction. If no attempt
    // ever yields a 304, conditional requests are genuinely broken and this fails.
    let etag = '';
    const second = await eventually(
      async () => {
        const first = await ownerClient.getById(tempGist.id);
        etag = first.headers().etag;
        expect(etag, 'no ETag returned — conditional requests are unavailable').toBeTruthy();
        return ownerClient.getByIdWithEtag(tempGist.id, etag);
      },
      (response) => response.status() === 304,
      { timeoutMs: 6_000, intervalMs: 1_000 },
    );

    await expectStatus(second, 304);
    expect(await second.text()).toBe('');

    // GitHub documents 304s as free, and a serial probe confirms it: remaining is
    // unchanged across the pair. That assertion is deliberately NOT made here —
    // all four workers share one token bucket, so x-ratelimit-remaining moves
    // underneath this test for reasons that have nothing to do with the 304.
    // Asserting it would buy a flaky test in exchange for no extra coverage.
    // Measurement is in docs/findings.md #14.
  });

  test('NFR-01 rate limit headers are present on every response @P1', async ({ ownerClient }) => {
    const headers = (await ownerClient.list()).headers();

    for (const header of [
      'x-ratelimit-limit',
      'x-ratelimit-remaining',
      'x-ratelimit-used',
      'x-ratelimit-reset',
    ]) {
      expect(headers[header], `missing ${header}`).toBeDefined();
    }
    expect(Number(headers['x-ratelimit-limit'])).toBe(5000);
  });
});