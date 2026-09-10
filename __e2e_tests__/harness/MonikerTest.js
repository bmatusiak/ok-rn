// VENDORED from the test-moniker package - see ./README.md.
// Kept in upstream's formatting so this stays diffable against where it
// came from; every edit of ours is marked VENDORED.
module.exports = function MonikerTest({ describe, it }) {
    describe(MonikerTest.name, () => {
        it('harness basic sanity', async ({ log, assert }) => {
            log('init: basic sanity check (simulating work)');
            //delay to simulate work
            await new Promise(resolve => setTimeout(resolve, 1000));
            assert.ok(true, 'basic truthy check');
        });
    });
};

