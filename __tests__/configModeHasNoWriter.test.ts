import {readFileSync, readdirSync} from 'fs';
import {join} from 'path';

/*
 * THE APP MUST NOT BE ABLE TO ASSERT CONFIG MODE.
 *
 * Config mode is a firmware state with no signal on the wire: the firmware
 * logs CONFIG_MODE to a debug console production builds do not have, and sends
 * the same UNLOCKED broadcast from inside it. The ONLY evidence it exists is
 * that the key locks itself on the way in.
 *
 * So the library treats the lock as the proof - `session.configMode` is set in
 * exactly one place, inside the branch where a label read came back refused
 * (node-onlykey-lib/plugins/device/index.js:1252) - and the app reads that
 * back through `device.inConfigMode`.
 *
 * The app used to keep its own copy: a useState in App.tsx threaded into six
 * screens with a setConfigMode beside it, plus a switch in Testing mode and a
 * hand-written reader in KeyScreen. Four things could assert it, and one
 * asserted it wrongly - the Enter button set it on the tap, before any key had
 * been touched. On a production hard key, which the app cannot press at all,
 * the entire app then believed a key was in config mode that nobody had
 * reached for. Reported 2026-09-19: "i click on the button to enter config
 * mode.. but the key i never touched".
 *
 * This test exists because that is a drift that comes BACK. A local
 * `configMode` state is the obvious thing to write, it compiles, it looks
 * right on the soft key - where the app can press, so the tap and the truth
 * usually agree - and it is wrong on the hardware the feature is for.
 *
 * If this fails: you do not need a setter. Read `useInConfigMode()`, and if
 * the value is not turning true, the key did not lock, which means it is not
 * in config mode.
 */

const SOURCE_DIRS = ['src', '.'];

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
  return out;
}

/*
 * COMMENTS ARE NOT CODE, and this file would otherwise fail on the paragraphs
 * that explain why the thing it forbids was removed - which is where those
 * paragraphs have to live, next to the empty space they explain. Stripped
 * crudely: no string in this codebase contains a comment opener, and a false
 * strip would only ever hide a match, which the next reader of the real file
 * sees anyway.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');
}

describe('config mode has exactly one writer, and it is not in the app', () => {
  const files = sourceFiles();

  it('finds the app sources', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain('App.tsx');
  });

  it('has no setConfigMode anywhere', () => {
    const offenders = files.filter(f =>
      /\bsetConfigMode\b/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('has no local config-mode state', () => {
    /* `const [configMode, setX] = useState(...)` in any shape. */
    const offenders = files.filter(f =>
      /useState[^\n]*\n?[^\n]*configMode|\[\s*configMode\s*,/.test(code(f)),
    );
    expect(offenders).toEqual([]);
  });

  it('reads it from the library, in one hook', () => {
    const readers = files.filter(f => /device\.inConfigMode/.test(code(f)));
    expect(readers).toEqual([join('src', 'hooks', 'useInConfigMode.ts')]);
  });
});
