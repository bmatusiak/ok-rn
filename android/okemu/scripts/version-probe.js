/**
 * How far is each released firmware version from being buildable here?
 *
 * The goal is a version matrix: build each release into its own emulator and
 * run the suite across all of them, so the version branches in
 * node-onlykey-lib/src/device/version.js become measurements instead of
 * transcriptions. Today every one of those branches is marked UNVERIFIED,
 * because the emulator is built from current firmware and CI can only ever
 * prove the current generation.
 *
 * This does not build anything. It answers the cheap question first: do
 * stage.js's patches still find their patterns in an older tree? Every patch
 * that misses is a place where the old source differs, and each one is either a
 * pattern to generalise or a version-specific edit to add. Counting them tells
 * us the size of the job before anyone spends an hour on a build.
 *
 * ## It does not touch the source repositories
 *
 * `git archive` writes a tarball from an object; it does not check anything
 * out, move HEAD, or alter the working tree. OnlyKey-Firmware and libraries
 * stay exactly as they are, which is required - they are read-only references
 * for this project.
 *
 * Usage:
 *   node scripts/version-probe.js            all versions in ok-versions.json
 *   node scripts/version-probe.js v3.0.2     just one
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const VERSIONS = path.join(ROOT, 'ok-versions.json');

/* The patch tables live in stage.js; importing them keeps one copy. */
const stage = require('./stage.js');

function sh(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
}

/** Does this repository have that object at all? */
function has(repo, sha) {
  try {
    sh(path.join(ROOT, repo), ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * One file's content at one commit, without checking anything out.
 *
 * `git show <sha>:<path>` reads straight from the object database, so the
 * working tree is untouched - which is the whole reason this is safe to run
 * against repositories outside our write scope.
 */
function fileAt(repo, sha, file) {
  try {
    return sh(path.join(ROOT, repo), ['show', `${sha}:${file}`]);
  } catch {
    return null;
  }
}

/**
 * Where a staged path actually came from.
 *
 * This is the distinction that decides how big the matrix job is, and getting
 * it wrong makes the job look far worse than it is. Most of .stage is NOT
 * version-pinned:
 *
 *   core/…                   the Teensy 3 core, from the fixed Arduino 1.6.5
 *                            toolchain checkout, with nine files overlaid from
 *                            OnlyKey-Firmware on top
 *   libraries/{Time,ADC,EEPROM}/…  stock Arduino libraries, same toolchain
 *   libraries/…              the OnlyKey `libraries` repo - VERSION PINNED
 *   sketch/…                 OnlyKey-Firmware/OnlyKey - VERSION PINNED
 *
 * So a patch against `core/kinetis.h` applies to every version equally; only
 * the pinned ones can drift as releases move.
 */
const TOOLCHAIN_LIBS = new Set(['Time', 'ADC', 'EEPROM']);

function locate(staged) {
  if (staged.startsWith('core/')) return { source: 'toolchain' };
  if (staged.startsWith('sketch/')) {
    return {
      source: 'pinned', repo: 'OnlyKey-Firmware',
      file: path.posix.join('OnlyKey', staged.slice('sketch/'.length)),
    };
  }
  if (staged.startsWith('libraries/')) {
    const rest = staged.slice('libraries/'.length);
    if (TOOLCHAIN_LIBS.has(rest.split('/')[0])) return { source: 'toolchain' };
    return { source: 'pinned', repo: 'libraries', file: rest };
  }
  return { source: 'unknown' };
}

function probe(name, pins) {
  const rows = [];
  let found = 0, missing = 0, absent = 0, fixed = 0;

  for (const patch of stage.PATCHES) {
    const at = locate(patch.file);

    /* Toolchain files do not move when a firmware release does. */
    if (at.source === 'toolchain') {
      fixed += patch.edits.length;
      continue;
    }
    if (at.source !== 'pinned') {
      rows.push({ file: patch.file, note: 'could not trace to a source - check locate()' });
      continue;
    }

    const text = fileAt(at.repo, pins[at.repo], at.file);
    if (text === null) {
      absent += patch.edits.length;
      rows.push({
        file: patch.file,
        note: `${at.file} did not exist in ${at.repo}@${pins[at.repo]}`,
      });
      continue;
    }

    for (const [from] of patch.edits) {
      const crlf = from.replace(/\r?\n/g, '\r\n');
      if (text.includes(from) || text.includes(crlf)) found++;
      else {
        missing++;
        rows.push({ file: patch.file, note: `pattern not found: ${from.slice(0, 64)}…` });
      }
    }
  }

  return { name, found, missing, absent, fixed, rows };
}

function main() {
  if (!fs.existsSync(VERSIONS)) {
    console.error(`version-probe: ${VERSIONS} not found`);
    process.exit(1);
  }
  const all = JSON.parse(fs.readFileSync(VERSIONS, 'utf8'));
  const only = process.argv[2];
  const names = only ? [only] : Object.keys(all);

  console.log('Probing stage.js patches against released firmware versions.');
  console.log('Nothing is built and no repository is modified.\n');

  for (const name of names) {
    const pins = all[name];
    if (!pins) {
      console.error(`version-probe: no such version "${name}"`);
      continue;
    }

    const unavailable = ['libraries', 'OnlyKey-Firmware']
      .filter((repo) => !has(repo, pins[repo]));
    if (unavailable.length) {
      console.log(`${name.padEnd(8)} SKIPPED - commit not in local checkout: ` +
        unavailable.map((r) => `${r}@${pins[r]}`).join(', '));
      continue;
    }

    const r = probe(name, pins);
    const pinned = r.found + r.missing + r.absent;
    const ok = r.missing === 0 && r.absent === 0;
    console.log(
      `${name.padEnd(8)} ${ok ? 'OK  ' : 'DIFF'} ` +
      `${r.found}/${pinned} version-pinned patterns match` +
      `  (+${r.fixed} toolchain patterns, version-independent)`);

    for (const row of r.rows) {
      console.log(`           ${row.file}: ${row.note}`);
    }
  }

  console.log(
    '\nOK means every patch stage.js makes to the VERSION-PINNED sources still' +
    '\nfinds its pattern at that release, so it is a candidate for a real build.' +
    '\nDIFF lists what differs; each line is one edit to generalise or to add.');
}

if (require.main === module) main();
