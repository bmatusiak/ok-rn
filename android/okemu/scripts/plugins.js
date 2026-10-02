'use strict';
/*
 * SOFT-KEY FIRMWARE PLUGINS (owner, 2026-10-01).
 *
 * "New features pluggable, in their own folder, so experiments are removable
 * and easy to focus auditing" - and "under compatibility for softkey only".
 * An experimental firmware feature lives in okemu/plugins/<name>/ and is staged
 * INTO the soft key's firmware only when asked for:
 *
 *   OKEMU_PLUGINS=edge,hello  (comma list; unset or empty = none)
 *
 * With none selected the stage is exactly what it was - the base soft key, and
 * the staged digest proves it. Deleting a plugin's folder removes it. Hard keys
 * and the desktop emulator never see these: they are a soft-key column.
 *
 * A plugin folder holds:
 *   plugin.js   the manifest (below)
 *   src/        its own C/C++ - copied whole into the staged tree
 *   AUDIT.md    what it changes and why: every hook, every byte it stores
 *
 * plugin.js exports:
 *   name      must equal the folder name
 *   minBase   oldest firmware it is written against, e.g. '3.1.0' (a pinned
 *             release older than this is refused; the working tree is allowed)
 *   hooks     [{file, anchor, text, insert: 'before'|'after'}] - `file` is a
 *             path inside the staged libraries/onlykey or the sketch; `anchor`
 *             must occur EXACTLY ONCE in it or the stage stops. Unlike the
 *             stager's literal patches (which warn on a miss and replace every
 *             occurrence), a plugin that cannot hook exactly where it was
 *             written to hook must not build at all.
 *   notes     one line for the stage summary
 *
 * Plugin code is namespaced okplugin_<name>_* and lives under
 * .stage/libraries/onlykey/plugins/<name>/, which gen-sources.js walks (recursively,
 * just that folder) and which CMake already reaches through the
 * libraries/onlykey include directory - so a hook includes
 * "plugins/<name>/<header>.h" and nothing else in the build has to change.
 */
const fs = require('node:fs');
const path = require('node:path');

const PLUGINS_DIR = path.join(__dirname, '..', 'plugins');
const NAME_RE = /^[a-z][a-z0-9_]*$/;

/** The plugins asked for, by name, in the order given. */
function selected(env = process.env.OKEMU_PLUGINS) {
  if (!env) return [];
  const names = env.split(',').map((s) => s.trim()).filter(Boolean);
  for (const n of names) {
    if (!NAME_RE.test(n)) throw new Error(`OKEMU_PLUGINS: "${n}" is not a plugin name (lower case, digits, _)`);
  }
  return [...new Set(names)];
}

/** Every plugin folder there is (for listing; a folder starting with _ is ignored). */
function available() {
  if (!fs.existsSync(PLUGINS_DIR)) return [];
  return fs.readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('_') && fs.existsSync(path.join(PLUGINS_DIR, d.name, 'plugin.js')))
    .map((d) => d.name);
}

const versionKey = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function atLeast(v, min) {
  const a = versionKey(v);
  const b = versionKey(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

/** Load and check the manifests of the selected plugins. Throws naming what is wrong. */
function load(names, release) {
  return names.map((name) => {
    const dir = path.join(PLUGINS_DIR, name);
    const manifestPath = path.join(dir, 'plugin.js');
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`OKEMU_PLUGINS asks for "${name}", but there is no ${path.relative(process.cwd(), manifestPath)} (available: ${available().join(', ') || 'none'})`);
    }
    const m = require(manifestPath);
    if (m.name !== name) throw new Error(`plugins/${name}/plugin.js says its name is "${m.name}"`);
    if (!Array.isArray(m.hooks)) throw new Error(`plugins/${name}/plugin.js has no hooks list`);
    if (!fs.existsSync(path.join(dir, 'src'))) throw new Error(`plugins/${name} has no src/ folder`);
    if (!fs.existsSync(path.join(dir, 'AUDIT.md'))) throw new Error(`plugins/${name} has no AUDIT.md - a plugin says what it changes`);
    /* the working tree has no release name; a pinned release must be new enough */
    if (release.pins && m.minBase && !atLeast(release.version, m.minBase)) {
      throw new Error(`plugin "${name}" needs firmware ${m.minBase} or newer; this build stages ${release.version}`);
    }
    return { ...m, dir };
  });
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, ent.name);
    const d = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

/* An anchor's occurrences, in the file's own line endings. */
function locate(text, anchor) {
  for (const a of [anchor, anchor.replace(/\r?\n/g, '\r\n')]) {
    const first = text.indexOf(a);
    if (first < 0) continue;
    const again = text.indexOf(a, first + 1);
    return { anchor: a, count: again < 0 ? 1 : 2, at: first };
  }
  return { count: 0 };
}

/**
 * Stage the plugins: copy each one's src/ into the staged tree, then apply its
 * hooks. Every hook must find its anchor exactly once.
 * @returns {{name: string, hooks: number, files: number}[]}
 */
function apply(plugins, stageDir) {
  const libOnlykey = path.join(stageDir, 'libraries', 'onlykey');
  /* a plugin staged by an EARLIER run must not linger in this one */
  fs.rmSync(path.join(libOnlykey, 'plugins'), { recursive: true, force: true });
  return plugins.map((p) => {
    const dest = path.join(libOnlykey, 'plugins', p.name);
    copyTree(path.join(p.dir, 'src'), dest);
    let files = 0;
    (function count(d) {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        if (ent.isDirectory()) count(path.join(d, ent.name)); else files += 1;
      }
    })(dest);

    for (const [i, h] of p.hooks.entries()) {
      const where = `plugin "${p.name}" hook ${i + 1} (${h.file})`;
      const candidates = [path.join(libOnlykey, h.file), path.join(stageDir, h.file)];
      const file = candidates.find((f) => fs.existsSync(f));
      if (!file) throw new Error(`${where}: no such staged file`);
      const text = fs.readFileSync(file, 'utf8');
      const found = locate(text, h.anchor);
      if (found.count === 0) throw new Error(`${where}: the anchor is not in the staged file - the firmware moved; re-anchor the plugin`);
      if (found.count > 1) throw new Error(`${where}: the anchor occurs more than once - make it unique`);
      const crlf = found.anchor.includes('\r\n');
      const insert = crlf ? h.text.replace(/\r?\n/g, '\r\n') : h.text;
      const out = h.insert === 'before'
        ? text.slice(0, found.at) + insert + text.slice(found.at)
        : text.slice(0, found.at + found.anchor.length) + insert + text.slice(found.at + found.anchor.length);
      fs.writeFileSync(file, out);
    }
    return { name: p.name, hooks: p.hooks.length, files, notes: p.notes || '' };
  });
}

module.exports = { PLUGINS_DIR, selected, available, load, apply };
