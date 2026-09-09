/**
 * Which suites to run. Empty means all of them.
 *
 * Written by tools/e2e.js when it is given `--only`, and ALWAYS restored to
 * empty when that run finishes - including when it fails or is interrupted. A
 * committed state of anything but `[]` would mean the next full run silently
 * skipped most of the suite while reporting a pass, which is worse than slow.
 *
 * Names are the suite functions' own names, which is what each file passes to
 * describe(): `derive`, `deriveParity`, `identity`, `cryptoSign` and so on. A
 * name that matches nothing is an error rather than an empty run - a typo here
 * would otherwise look exactly like a suite that has no tests.
 */
module.exports = [];
