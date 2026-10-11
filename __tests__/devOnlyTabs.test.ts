/**
 * THE LOG TAB IS NOT IN PRODUCTION (Brad, 2026-10-11: "Log tab,, is for testing debugging so it
 * should not be included in production"). Read from the source, as consentOneCheck does: the
 * drawer leaves it out of a release build (DEV_ONLY_TABS) and its render branch is gated on
 * __DEV__, so a release bundle does not carry it.
 */
export {};
declare const __dirname: string;
const fs = require('fs') as {readFileSync(p: string, e: string): string};
const path = require('path') as {join(...parts: string[]): string};
const app = fs.readFileSync(path.join(__dirname, '..', 'App.tsx'), 'utf8');

test('Log is a debug-build-only tab in the drawer', () => {
  const m = /const DEV_ONLY_TABS: readonly Tab\[\] = \[([^\]]*)\]/.exec(app);
  expect(m).not.toBeNull();
  expect(m![1]).toContain("'Log'");
  expect(app).toMatch(/\(__DEV__ \|\| !DEV_ONLY_TABS\.includes\(t\)\)/);
});

test('the Log screen is drawn only in a debug build', () => {
  expect(app).toContain("__DEV__ && tab === 'Log'");
  expect(app).not.toMatch(/\) : tab === 'Log' \?/);
});
