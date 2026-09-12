/**
 * How the next run behaves. Written by tools/e2e.js, ALWAYS restored.
 *
 * The same mechanism as only.js and for the same reason: the suite runs inside
 * the app on the phone, so a flag on the terminal command has no other way of
 * reaching it. Metro serves this file live, so writing it before the run and
 * putting it back afterwards is the whole of it.
 *
 * `bail` stops the run after the first suite that had a failure. The suite
 * itself always finishes - see the note in harness/harness.js for why the
 * boundary is the suite rather than the test.
 *
 * ON BY DEFAULT, and `--no-bail` turns it off. Waiting out a run that has
 * already failed tells nobody anything: one broken unlock produced 120
 * failures in a v2.1.2 sweep, each paying a full timeout, and the retries
 * exhausted the device's PIN attempts so everything after answered "password
 * attempts for this session exceeded". Fail fast is the default because the
 * first failure is almost always the only one worth reading.
 *
 * `--no-bail` is for the case where the whole picture is the question - what
 * an old firmware can and cannot do, rather than whether it is green.
 */
module.exports = {bail: true};
