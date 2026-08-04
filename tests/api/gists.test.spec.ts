import { test, expect, GistBuilder } from '../../src/fixtures/api.fixtures';
import { gistSchema } from '../../src/models/gist.schemas';
import { expectSchema, expectStatus } from '../../src/utils/assertions';
import { runId } from '../../src/utils/unique';


test.describe('gists creation', () => {
    test('TST-01 creates a public gist with a single file', async ({ ownerClient, gists }) => {
        // `gists.create()` already registered this gist for teardown and settled
        // it. The `trackIfCreated(await ownerClient.getById(...))` call that used
        // to sit here was a no-op — it only tracks a 201, and a GET returns 200 —
        // so it read as leak protection while providing none.
        const gist = await gists.create(
            GistBuilder.aGist().withPublic(true).withFile('test.txt', 'hello Prince').build(),
        );
        //expect right status
        await expectStatus(await ownerClient.getById(gist.id), 200);
        expect(gist.id).toBeTruthy();
        expect(gist.public).toBe(true);
        expect(gist.files['test.txt'].content).toBe('hello Prince');
        // validate schema of the response
        await expectSchema(await ownerClient.getById(gist.id), gistSchema);
    });
    test('TST-02 create a multiple file gist', async ({ ownerClient, gists }) => {
        const payload = await GistBuilder.multiFile(3);
        const gist = await gists.create(payload);
        // Same no-op `trackIfCreated` removed here as in TST-01, along with a
        // commented-out 30s sleep: the repo settles fresh data by polling in the
        // factory, never by waiting a fixed interval.
        //expect right status
        await expectStatus(await ownerClient.getById(gist.id), 200);
        expect(Object.keys(gist.files)).toHaveLength(3);
        for (const [filename, file] of Object.entries(payload.files)) {
            expect(gist.files[filename].content).toBe(file.content);
        }
        // validate schema of the response
        await expectSchema(await ownerClient.getById(gist.id), gistSchema);
    });
    test.skip('TST-03 create 10 gists in sequence with different files @smoke', async ({ gists }) => {
        for (let i = 0; i < 10; i += 1) {
            const filename = `contract-${runId}-${i}.txt`;
            const gist = await gists.create(
                GistBuilder.aGist().withPublic(true).withFile(filename, `${filename} Prince`).build(),
            );
            expect(gist.files[filename]).toBeTruthy();
        }
    });
});