/*
 * CONFIG MODE IS NOT IN THIS APP, and this test is why it stays out.
 *
 * It was removed on 2026-09-19 at the user's instruction, after several
 * attempts to make it work: *"the reason why i want it fully removed is
 * because it caused you to drift and not understand it... if there is anything
 * in the app for config mode, then it will cause you to drift again"*.
 *
 * That is a fair reading of what happened. Config mode is a firmware state
 * with NO signal on the wire - the firmware logs it to a debug console
 * production builds do not have, and keeps sending the same UNLOCKED
 * broadcast from inside it - so every part of the app that tried to show it
 * was guessing, and the guesses disagreed. At its worst the app carried: a
 * flag anything could set, four PIN pads, two panels on one tab, six dimming
 * wrappers, and a switch in Testing mode that asserted the whole thing
 * outright. On a production hard key, which the app cannot press at all, one
 * tap turned it all on with the key untouched.
 *
 * So the rule is not "do it more carefully". The rule is that it is not here.
 *
 * WHAT IS ALLOWED, and only this:
 *
 *   src/hooks/useConfigMode.ts     the hold-and-prove sequence
 *   src/screens/FirmwareScreen.tsx the signed-firmware reboot, which the
 *                                  firmware accepts ONLY in config mode
 *
 * Those two are the firmware updater's own step, not an app-wide mode, and
 * the user asked for them to be left alone ("dont touch firmware").
 *
 * IF THIS TEST FAILS you are adding it back. Do not. The thing you are
 * reaching for - dimming a section, explaining a lock, asking whether the PIN
 * went back in - is the shape that kept going wrong.
 */

/*
 * The node idiom this repo already uses in a jest file - see
 * firmwareFile.test.ts. `import {readFileSync} from 'fs'` does not typecheck
 * here: tsconfig is the React Native one and does not carry node's types.
 * `require` itself is declared once already, in that file, and the two share
 * one TS program - so declaring it again is a duplicate.
 */
const {readFileSync, readdirSync} = require('fs') as {
  readFileSync(p: string, encoding: string): string;
  readdirSync(p: string, opts: {withFileTypes: true}): {name: string; isDirectory(): boolean}[];
};
const {join} = require('path') as {join(...parts: string[]): string};

/** The firmware updater's own step. Everything else must be clean. */
const ALLOWED = [join('src', 'hooks', 'useConfigMode.ts'), join('src', 'screens', 'FirmwareScreen.tsx')];

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth > 0) walk(full, depth - 1);
      } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
  };
  walk('src', 6);
  out.push('App.tsx');
  return out.filter(f => !ALLOWED.includes(f));
}


/*
 * COMMENTS ARE CHECKED SEPARATELY. What must not exist is code: an identifier,
 * a prop, a component. The paragraphs explaining why config mode was taken out
 * have to live next to the empty space they explain, and several files still
 * describe firmware behaviour that is simply true.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('config mode is not in the app', () => {
  const files = sourceFiles();

  it('finds the app sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('App.tsx');
  });

  it('has no config-mode identifier', () => {
    const offenders = files.filter(f => /configMode|ConfigMode/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('has no config-mode component left to render', () => {
    const offenders = files.filter(f =>
      /ConfigModePanel|ConfigModeRequired|ConfigModeBlocked/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });
});
