/**
 * A PLUGIN IS REMOVABLE (Brad, 2026-10-11: "its own plugin, keeping it easy to remove"): no file
 * outside a plugin's folder imports it, except the one list that names it (src/plugins/index.ts).
 * Deleting the folder and its line there leaves an app that builds.
 */
export {};
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync(p: string, e: string): string;
  readdirSync(p: string, o: {withFileTypes: true}): {name: string; isDirectory(): boolean}[];
};
const path = require('path') as {join(...parts: string[]): string; relative(a: string, b: string): string};

const ROOT = path.join(__dirname, '..', '..', '..');
const BACKSLASH = String.fromCharCode(92);
const PLUGINS = ['passwords'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(d =>
    d.isDirectory() ? (d.name === 'node_modules' ? [] : files(path.join(dir, d.name))) : /\.(ts|tsx|js)$/.test(d.name) ? [path.join(dir, d.name)] : [],
  );
}

test.each(PLUGINS)('nothing outside src/plugins/%s imports it but the plugin list', name => {
  const scanned = [path.join(ROOT, 'App.tsx'), path.join(ROOT, 'index.js'), ...files(path.join(ROOT, 'src')), ...files(path.join(ROOT, '__e2e_tests__'))];
  const inside = `src/plugins/${name}/`;
  const offenders = scanned
    .map(f => path.relative(ROOT, f).split(BACKSLASH).join('/'))
    .filter(rel => !rel.startsWith(inside) && rel !== 'src/plugins/index.ts')
    .filter(rel => new RegExp(`['"][./]*(src/)?plugins/${name}(/[^'"]*)?['"]`).test(fs.readFileSync(path.join(ROOT, rel), 'utf8')));
  expect(offenders).toEqual([]);
});

test('the plugin list names each plugin once', () => {
  const list = fs.readFileSync(path.join(ROOT, 'src', 'plugins', 'index.ts'), 'utf8');
  for (const name of PLUGINS) expect(list.match(new RegExp(`from '\./${name}/plugin'`, 'g'))?.length).toBe(1);
});
