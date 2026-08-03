import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { eventually, expectApiError, expectStatus } from '../../src/utils/assertions';

/**
 * Authentication and authorization.
 *
 * Personas are equivalence partitions: owner / other user / anonymous / invalid
 * token. The cross-user cases are the highest-value tests in the suite — a
 * regression here is a security incident, not a bug.
 */
test.describe('Authentication and authorization', () => {
  test('AUTH-01 a valid token can list its own gists @smoke @P0', async ({ ownerClient }) => {
    const response = await ownerClient.list();
    // log the response
    console.log("The response is", await response.json());
    await expectStatus(response, 200);
    expect(Array.isArray(await response.json())).toBe(true);
  });

  test('AUTH-02 GET /gists/starred requires authentication @smoke @P0', async ({ anonClient }) => {
    const response = await anonClient.listStarred();

    // The only list endpoint that hard-requires auth — every other one degrades
    // to a public view instead of rejecting the caller.
    const error = await expectApiError(response, 401);
    expect(error.message).toContain('Requires authentication');
  });

  test('AUTH-03 a garbage token is rejected with Bad credentials @smoke @P0', async ({
    invalidTokenClient,
  }) => {
    const response = await invalidTokenClient.list();

    const error = await expectApiError(response, 401);
    expect(error.message).toBe('Bad credentials');
  });

  test('AUTH-05 user B cannot update user A gist @smoke @P0 @security', async ({
    otherClient,
    tempGist,
  }) => {
    const response = await otherClient.update(tempGist.id, { description: 'hijacked' });

    // 404, not 403. GitHub refuses to confirm the resource exists to a caller who
    // has no right to it. Encode it deliberately, or someone will "fix" it later.
    await expectStatus(response, 404);
  });

  test('AUTH-06 user B cannot delete user A gist @smoke @P0 @security', async ({
    otherClient,
    ownerClient,
    tempGist,
  }) => {
    const response = await otherClient.delete(tempGist.id);
    await expectStatus(response, 404);

    // The rejection must be a no-op, not a partial delete.
    await expectStatus(await ownerClient.getById(tempGist.id), 200);
  });

  test('AUTH-07 anonymous callers cannot create a gist @smoke @P0 @security', async ({
    anonClient,
  }) => {
    const response = await anonClient.create(GistBuilder.minimal());

    await expectApiError(response, 401);
  });

  test('AUTH-08 anonymous callers CAN read a secret gist by id @smoke @P0 @security', async ({
    anonClient,
    tempGist,
  }) => {
    expect(tempGist.public).toBe(false);

    // An anonymous read of a just-created gist can 404 briefly — the same
    // eventual-consistency lag that affects RD-07's non-owner listing. Polled
    // rather than retried blindly, and bounded tightly: every attempt spends from
    // the 60/hr anonymous budget, so this allows three tries, not thirty.
    const response = await eventually(
      () => anonClient.getById(tempGist.id),
      (r) => r.status() === 200,
      { timeoutMs: 12_000, intervalMs: 4_000 },
    );

    // Not a bug — "secret" means unlisted, not access-controlled. This test exists
    // to pin the documented behaviour so that any change to it is caught, and to
    // make the obscurity model visible to anyone reading the suite.
    // See docs/findings.md #1.
    await expectStatus(response, 200);
    const gist = await response.json();
    expect(gist.files['notes.txt'].content).toBe('initial content');
  });

  test('AUTH-10 a malformed Authorization header is rejected @P2 @security', async ({
    ownerClient,
  }) => {
    const response = await ownerClient.context.get('/gists', {
      headers: { Authorization: 'Basic notatoken' },
    });

    await expectStatus(response, 401);
  });
});