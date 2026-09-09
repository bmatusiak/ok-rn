# The app smoke test died when the specs outgrew their mocks

## What happened

`__tests__/App.test.tsx` — the only test that renders the whole app — has been
failing at import time, not at an assertion:

```
Invariant Violation: TurboModuleRegistry.getEnforcing(...): 'NativeSecrets'
could not be found. Verify that a module by this name is registered in the
native binary.
  at Object.require (specs/NativeSecrets.ts:62:36)
  at Object.require (src/screens/SlotEditorScreen.tsx:15:1)
  at Object.require (App.tsx:23:1)
  at Object.require (__tests__/App.test.tsx:7:1)
```

Found while running the suite after an unrelated change; the failure predates
that change.

## Why

`getEnforcing` throws when the native module is absent, which under Jest it
always is. `jest.setup.js` mocks specs to prevent that. It mocked three:
`NativeUsbHid`, `NativeFidoGatt`, `NativeOkEmu`.

There are six. `NativeSecrets`, `NativeShare` and `NativeBtKeyboard` were added
later and none was mocked. The app imports all of them transitively, so the
smoke test threw on whichever unmocked one it reached first.

The header comment is the tell. It read:

> Both specs are mocked here so component tests can import the app without a
> native runtime.

"Both" — written when there were two. The file was never a list of what exists,
it was a snapshot of what existed once, and nothing connected adding a spec to
updating it.

## Why it went unnoticed

The suite was not silent — it was red, and 26 other tests passed alongside it.
A single failing suite in a run that otherwise passes reads as a known
irrelevance, especially when its message is about a native module rather than
about the app's behaviour. Nothing distinguished "this test is broken" from
"this test found something".

## Severity

Low direct impact, moderate as a gap. No shipped behaviour was wrong. But the
one test that would catch a screen crashing on mount was not running, across
every change made while it was dead — including the wipe-on-lock remount key
added to `App.tsx` itself.

## Fixed

`jest.setup.js` now mocks all six, and its header says "every spec in `specs/`"
with a note that adding a spec means adding it here. Full suite: 5 suites, 27
tests, green.

## What would prevent a repeat

The mock list is still maintained by hand, so it can drift again. A test that
reads `specs/` and asserts each file has a `jest.mock` would close it, and is
worth writing when the next spec is added.
