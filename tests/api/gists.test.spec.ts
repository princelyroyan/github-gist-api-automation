import { test, expect, GistBuilder, trackIfCreated } from '../../src/fixtures/api.fixtures';
import { gistSchema } from '../../src/models/gist.schemas';
import { expectSchema, expectStatus } from '../../src/utils/assertions';
import { runId } from '../../src/utils/unique';


test.describe('gists creation', () => {
    test('TST-01 creates a public gist with a single file', async ({ ownerClient, gists }) => {
        const gist = await gists.create(
            GistBuilder.aGist().withPublic(true).withFile('test.txt', 'hello Prince').build(),
        );
        await trackIfCreated(await ownerClient.getById(gist.id), gists);
        //expect right status
        await expectStatus(await ownerClient.getById(gist.id), 200);
        console.log("response", JSON.stringify(gist));
        expect(gist.id).toBeTruthy();
        expect(gist.public).toBe(true);
        expect(gist.files['test.txt'].content).toBe('hello Prince');
        // validate schema of the response
        await expectSchema(await ownerClient.getById(gist.id), gistSchema);
    });
    test('TST-02 create a multiple file gist', async ({ ownerClient, gists }) => {
        const payload = await GistBuilder.multiFile(3);
        const gist = await gists.create(payload);
        // pause for 30 seconds
        // console.log("PAUSED for 30 seconds")
        // await new Promise(resolve => setTimeout(resolve, 30_000));
        await trackIfCreated(await ownerClient.getById(gist.id), gists);
        //expect right status
        await expectStatus(await ownerClient.getById(gist.id), 200);
        console.log("response", JSON.stringify(gist));
        expect(Object.keys(gist.files)).toHaveLength(3);
        for (const [filename, file] of Object.entries(payload.files)) {
            expect(gist.files[filename].content).toBe(file.content);
        }
        // validate schema of the response
        await expectSchema(await ownerClient.getById(gist.id), gistSchema);
    });
    test('TST-03 create 10 gists in sequence with different files @smoke', async ({ gists }) => {
        for (let i = 0; i < 10; i += 1) {
            const filename = `contract-${runId}-${i}.txt`;
            const gist = await gists.create(
                GistBuilder.aGist().withPublic(true).withFile(filename, `${filename} Prince`).build(),
            );
            expect(gist.files[filename]).toBeTruthy();
        }
    });
});