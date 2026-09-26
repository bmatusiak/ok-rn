// VENDORED from the test-moniker package - see ./README.md.
// Kept in upstream's formatting so this stays diffable against where it
// came from; every edit of ours is marked VENDORED.
// Minimal mocha-like test harness for in-app tests.
// Usage:
// const h = require('./harness');
// h.describe('suite', () => { h.it('does something', async ({ExpoWorker, DeviceEventEmitter, log, assert}) => { ... }) });
// module.exports = { run: (ctx) => h.run(ctx) }

const suites = [];
let currentSuite = null;

function describe(name, fn) {
    const suite = { name, tests: [] };
    suites.push(suite);
    currentSuite = suite;
    try {
        fn();
    } finally {
        currentSuite = null;
    }
}

// VENDORED: it(name, fn, {timeoutMs}) - a test that is slow by nature (the key
// TYPING a full backup, which grows with what is stored on it) asks for its own
// limit, rather than every test waiting longer before a real hang is called.
function it(name, fn, opts = {}) {
    if (!currentSuite) throw new Error('it() must be called inside describe()');
    currentSuite.tests.push({ name, fn, timeoutMs: opts.timeoutMs });
}

// VENDORED: skip(reason).
//
// A test that cannot run on THIS device had two options before this, and both
// say something false. Passing claims the feature works. Asserting the refusal
// claims the device answered - which is right when it does, and wrong when the
// firmware never had the feature and answers with whatever was in the buffer.
//
// A sentinel class rather than a magic string on a plain Error, so a test that
// happens to throw the word "skip" is still a failure.
class Skipped extends Error {
    constructor(reason) {
        super(reason || 'skipped');
        this.name = 'Skipped';
    }
}

function skip(reason) {
    throw new Skipped(reason);
}

function ok(cond, msg) {
    if (!cond) throw new Error(msg || 'Assertion failed');
}

function equal(a, b, msg) {
    if (a !== b) throw new Error(msg || `Expected ${a} === ${b}`);
}

function notEqual(a, b, msg) {
    if (a === b) throw new Error(msg || `Expected ${a} !== ${b}`);
}

async function run(context = {}) {
    // VENDORED: `skipped` alongside passed and failed. Counted, never hidden -
    // a run that skips everything is not a pass, and the totals have to say so.
    const results = { suites: [], passed: 0, failed: 0, skipped: 0 };
    const {
        timeoutMs = 0,
        testFilter,
        onTestStart,
        onTestEnd,
        // VENDORED: stop after the suite a failure happened in - see below.
        bail = false,
    } = context;

    const log = (context.log && typeof context.log === 'function')
        ? context.log
        : ((...args) => { try { console.log('[harness]', ...args); } catch (_) { } });

    for (const suite of suites) {
        const suiteRes = { name: suite.name, tests: [] };
        /*
         * VENDORED: whether anything in THIS suite failed. Reset per suite,
         * because bail stops between suites and not inside one.
         */
        let suiteFailed = false;
        log(`suite: ${suite.name}`);
        for (const t of suite.tests) {
            if (typeof testFilter === 'function' && !testFilter(t.name, suite.name)) {
                continue;
            }

            const testRes = { name: t.name, ok: false, error: null };

            try { if (onTestStart) onTestStart({ suiteName: suite.name, testName: t.name }); } catch (_) { }
            try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'running' }); } catch (_e) { }

            try {
                const testPromise = (async () => {
                    // VENDORED: skip is handed in beside assert.
                    await t.fn({ ...context, skip, assert: { ok, equal, notEqual } });
                })();

                const limitMs = t.timeoutMs || timeoutMs;
                if (limitMs > 0) {
                    const timeoutPromise = new Promise((_, rej) => {
                        const id = setTimeout(() => {
                            rej(new Error(`Test timeout after ${limitMs}ms`));
                        }, limitMs);
                        testPromise.then(() => clearTimeout(id), () => clearTimeout(id));
                    });
                    await Promise.race([testPromise, timeoutPromise]);
                } else {
                    await testPromise;
                }

                try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'passed' }); } catch (_e) { }
                testRes.ok = true;
                results.passed++;
                log(`  ✓ ${t.name}`);
            } catch (e) {
                // VENDORED: a skip is not a failure and not a pass.
                if (e instanceof Skipped) {
                    testRes.ok = true;
                    testRes.skipped = true;
                    testRes.reason = e.message;
                    try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'skipped', error: e.message }); } catch (_e) { }
                    results.skipped++;
                    log(`  ○ ${t.name} -> ${e.message}`);
                } else {
                    testRes.ok = false;
                    testRes.error = e && (e.stack || e.message || String(e));
                    try { if (context.onTestUpdate) context.onTestUpdate({ suiteName: suite.name, testName: t.name, status: 'failed', error: testRes.error }); } catch (_e) { }
                    results.failed++;
                    suiteFailed = true;
                    log(`  ✗ ${t.name} -> ${testRes.error}`);
                }
            }

            try { if (onTestEnd) onTestEnd({ suiteName: suite.name, testName: t.name, result: testRes }); } catch (_e) { }

            suiteRes.tests.push(testRes);
        }
        results.suites.push(suiteRes);

        /*
         * VENDORED: BAIL, AND IT STOPS BETWEEN SUITES RATHER THAN INSIDE ONE.
         *
         * One real failure usually produces dozens of meaningless ones, and
         * they are not free. A v2.1.2 sweep failed a single unlock and then
         * reported 120 failures, every one of them a timeout paid in full - and
         * the repeated attempts exhausted the device's PIN attempts for the
         * session, so everything after answered "password attempts for this
         * session exceeded". The cascade did not merely waste minutes; it
         * destroyed the state the rest of the run needed.
         *
         * The suite still finishes. Two reasons, and both matter:
         *
         *   * A suite's LAST test is often its teardown - the one that hands
         *     the key back or releases the USB interface. Stopping on the
         *     failing test would skip it and leave the device claimed.
         *   * A failure in the middle of a suite is where the gaps show. The
         *     tests after it in the same suite are the ones that say how far
         *     the damage goes, and they cost seconds rather than minutes.
         *
         * `bailedAfter` names the suite so the report can say the run stopped
         * early. A bailed run always has failures, so it can never be mistaken
         * for a short pass.
         */
        if (bail && suiteFailed) {
            results.bailedAfter = suite.name;
            log(`bail: stopping after ${suite.name} - it had failures`);
            break;
        }
    }

    return results;
}

function getRegisteredSuites() {
    return suites.map(s => ({ name: s.name, tests: s.tests.map(t => ({ name: t.name })) }));
}

// VENDORED: skip and Skipped are exported too, so a caller can classify a
// result without matching on text.
module.exports = { describe, it, run, skip, Skipped, assert: { ok, equal, notEqual }, getRegisteredSuites };
