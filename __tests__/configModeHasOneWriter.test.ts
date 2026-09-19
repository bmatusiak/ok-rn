/*
 * CONFIG MODE HAS EXACTLY ONE WRITER.
 *
 * ## Why there is a test at all
 *
 * The whole feature was deleted on 2026-09-19 - 873 lines, every panel, gate
 * and flag - at the user's instruction: *"the reason why i want it fully
 * removed is because it caused you to drift and not understand it... if there
 * is anything in the app for config mode, then it will cause you to drift
 * again"*.
 *
 * It is going back one piece at a time, for the purpose it always had: config
 * mode decides which features the app offers. Things usable in it, things not.
 *
 * What made the old one fail was not the idea. It was that FOUR separate
 * things could assert the flag - a panel's Enter button, a switch in testing
 * mode, a per-screen state, a hand-written device read - and six screens
 * interpreted the result. They disagreed with each other and with the key. On
 * a production hard key, which the app cannot press at all, one tap on a
 * button turned the whole thing on with the key untouched.
 *
 * So the rule that carries forward is not "be careful". It is: ONE writer.
 *
 * ## The rule
 *
 *   App.tsx                          declares the state
 *   src/screens/TestingScreen.tsx    the switch, the only thing that sets it
 *
 * Nothing else may set it, and no other file may keep a config-mode state of
 * its own. Reading the flag is fine and is the point - it is a prop, and
 * screens will gate on it as features are attached one at a time.
 *
 * ALLOWED BY NAME, and unrelated to the app's flag:
 *
 *   src/hooks/useConfigMode.ts       the hold-and-prove sequence
 *   src/screens/FirmwareScreen.tsx   the signed-firmware reboot, which the
 *                                    firmware accepts only in config mode
 *
 * Those are the firmware updater's own step. *"dont touch firmware"*.
 *
 * IF THIS FAILS you are adding a second writer. Take the prop instead.
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

/** The firmware updater's own step, which is not the app's flag. */
const FIRMWARE = [join('src', 'hooks', 'useConfigMode.ts'), join('src', 'screens', 'FirmwareScreen.tsx')];

/** The two files that are allowed to write it. */
const WRITERS = ['App.tsx', join('src', 'screens', 'TestingScreen.tsx')];

/*
 * COMMENTS ARE NOT CODE. Every paragraph above would trip these checks, and so
 * would the ones in App.tsx explaining what the flag is not.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

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
  return out.filter(f => !FIRMWARE.includes(f));
}

describe('config mode has exactly one writer', () => {
  const files = sourceFiles();

  it('finds the app sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('App.tsx');
    for (const w of WRITERS) expect(files).toContain(w);
  });

  it('names setConfigMode in the two files allowed to, and no others', () => {
    const offenders = files.filter(f => !WRITERS.includes(f) && /\bsetConfigMode\b/.test(code(f)));
    expect(offenders).toEqual([]);
  });

  it('keeps the state in App and nowhere else', () => {
    /* `const [configMode, setX] = useState(...)` in any shape. */
    const offenders = files.filter(
      f => f !== 'App.tsx' && /\[\s*configMode\s*,/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('has no dimming wrapper back', () => {
    /*
     * ConfigModeRequired and ConfigModeBlocked stay gone. Gating is a plain
     * condition on the prop, which is how it was rebuilt: `unavailable={...}`
     * on the Section that is actually affected, one panel at a time.
     *
     * ConfigModePanel came OFF this list on 2026-09-19, when the way into
     * config mode was rebuilt. It is a different thing from its namesake: the
     * old one set the flag itself on the tap, which is the defect the whole
     * removal came from. This one calls onWant() and App decides - which the
     * two checks above are what actually enforce.
     */
    const offenders = files.filter(f =>
      /ConfigModeRequired|ConfigModeBlocked/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });
});
