# The e2e harness, vendored

These four files were `node_modules/test-moniker`. They are copied here because
the suite needed something the package did not have — a way to say **"this
firmware does not have that feature"** — and a test harness we cannot change is
a harness that quietly shapes what we are willing to assert.

    harness.js      describe / it / skip / assert, and the runner
    MonikerView.js  the in-app screen that runs them
    MonikerTest.js  one sanity suite, included automatically
    index.js        the two together

`src/screens/E2EScreen.tsx` imports `MonikerView` from here rather than from the
package. The `test-moniker` CLI is still a dev dependency and still generates
`__e2e_tests__/index.js`; it is `tools/e2e.js` that actually drives a run.

## Kept close to the original on purpose

The formatting is upstream's — four-space indent, its own brace style — and it
does not match the rest of this app. That is deliberate: these files are a fork
of something that still exists, and a reformatted fork cannot be diffed against
what it came from. Everything we changed is marked `VENDORED:` so the next
person can see our edits without reading the whole file.

## What we changed

**`skip(reason)`**, passed into every test beside `assert`. It throws a sentinel
the runner catches and records apart from passes and failures.

Before it existed, a test that could not run had two options, and both lie in
different directions. Passing says the feature works. Asserting the refusal says
the device answered — which is right when it does, and wrong when the firmware
simply never had the feature and answers with whatever was in the buffer.

    skip('KEYTYPE_XWING does not exist before v3.0.2')

reads as `○ the X-Wing key type returns its split-custody pair -> KEYTYPE_XWING
does not exist before v3.0.2`, counts separately, and is carried through
`tools/e2e.js` and `tools/matrix.js` into the sweep table. A version that skips
eleven tests is visibly a different device, not a worse one.

**Skips are counted, never hidden.** A run that skips everything is not a pass,
and the totals say so.
