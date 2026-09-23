#!/usr/bin/env node
/**
 * bump.js - set the app's version everywhere it is written down.
 *
 *     node tools/bump.js patch     0.0.3 -> 0.0.4
 *     node tools/bump.js minor     0.0.3 -> 0.1.0
 *     node tools/bump.js major     0.0.3 -> 1.0.0
 *     node tools/bump.js 0.2.0     exactly that
 *     node tools/bump.js --check   say where it is and whether they agree
 *
 * ## Why this exists
 *
 * The version lives in THREE files and they must agree:
 *
 *   package.json         what buildInfo reports, so what the splash panel and
 *                        every FINDING and log line says the app is
 *   package-lock.json    twice - the root, and packages[""] - and npm rewrites
 *                        it on the next install if it disagrees
 *   android/app/build.gradle  versionName, which is what Android actually ships
 *                        and what a maintainer sees in Settings > Apps
 *
 * Bumped by hand on 2026-09-23 and the lock file was missed, which is the
 * quiet failure: nothing breaks, `npm install` later reverts the lock to the
 * old number, and the app reports one version while its manifest says another.
 * Neither is wrong enough to notice and the pair cannot both be right.
 *
 * ## What it does NOT touch
 *
 * versionCode. That is the BUILD, derived from the git commit count in
 * build.gradle, and Android refuses an equal or lower one - so it moves on its
 * own and must not be pinned here (see the comment above it there).
 *
 * node-onlykey-lib has its own version and its own repository. This is ok-rn's
 * tool; bumping the library is a separate decision, deliberately.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..');
const PKG = path.join(ROOT, 'package.json');
const LOCK = path.join(ROOT, 'package-lock.json');
const GRADLE = path.join(ROOT, 'android', 'app', 'build.gradle');

const chr10 = String.fromCharCode(10);
const SEMVER = /^\d+\.\d+\.\d+$/;

/** Every place the version is written, and how to read it back. */
function readAll() {
  const pkg = JSON.parse(fs.readFileSync(PKG, 'utf8'));
  const lock = JSON.parse(fs.readFileSync(LOCK, 'utf8'));
  const gradle = fs.readFileSync(GRADLE, 'utf8');
  const m = /versionName\s+"([^"]+)"/.exec(gradle);
  return {
    'package.json': pkg.version,
    'package-lock.json': lock.version,
    'package-lock.json (packages[""])': lock.packages && lock.packages['']
      ? lock.packages[''].version : null,
    'build.gradle versionName': m ? m[1] : null,
  };
}

function report(where) {
  const values = Object.values(where).filter(v => v !== null);
  const agreed = values.every(v => v === values[0]);
  for (const [name, value] of Object.entries(where)) {
    console.log(`  ${String(value ?? '(absent)').padEnd(10)} ${name}`);
  }
  return {agreed, version: values[0]};
}

function next(current, how) {
  if (SEMVER.test(how)) return how;
  const [maj, min, pat] = current.split('.').map(Number);
  if (how === 'major') return `${maj + 1}.0.0`;
  if (how === 'minor') return `${maj}.${min + 1}.0`;
  if (how === 'patch') return `${maj}.${min}.${pat + 1}`;
  throw new Error(
    `bump: "${how}" is not major, minor, patch or an exact x.y.z version`);
}

function main() {
  const how = process.argv[2];

  const before = readAll();
  if (!how || how === '--check') {
    const {agreed, version} = report(before);
    if (!agreed) {
      console.error(
        '\nbump: THESE DO NOT AGREE. The app reports one version and its '
        + 'manifest ships another, and neither is wrong enough to notice. '
        + `Run \`node tools/bump.js ${version}\` to settle them.`);
      process.exit(1);
    }
    console.log(`\nagreed: ${version}`);
    return;
  }

  /*
   * A RELATIVE BUMP NEEDS AGREEMENT; AN EXACT ONE IS HOW YOU FIX A
   * DISAGREEMENT.
   *
   * 'patch' from a tree whose files say different things has no answer -
   * patch of WHICH one - and choosing silently would write a new number
   * over two different old ones, hiding the drift instead of fixing it.
   *
   * An exact version has no such ambiguity: it is the caller saying what
   * every file should read, which IS the repair. The first version of this
   * check refused both, so its advice was to run the command you had just
   * run - caught by using it on the very disagreement it was written for.
   */
  const {agreed, version: current} = report(before);
  if (!agreed && !SEMVER.test(String(how))) {
    console.error(
      [
        '',
        'bump: ' + how + ' of WHICH version? The files disagree, so a',
        'relative bump has no starting point. Name the exact version you',
        'want them all to read, and that settles them:',
        '',
        '    node tools/bump.js ' + current,
      ].join(chr10));
    process.exit(1);
  }
  if (!agreed) {
    console.log('(settling a disagreement: one number, every file)' + chr10);
  }

  const target = next(current, how);
  console.log(`\n${current} -> ${target}\n`);

  /*
   * npm owns package.json AND package-lock.json, and writing the lock by hand
   * is how it gets missed: it carries the version TWICE and npm rewrites it on
   * the next install. --no-git-tag-version because tagging is the release
   * step's business, not this one's.
   */
  /*
   * --allow-same-version because SETTLING is the case where package.json
   * already reads the target and the lock does not. npm treats that as
   * "Version not changed" and exits non-zero, which would make the repair
   * impossible by the only command that can perform it.
   */
  execFileSync('npm',
    ['version', target, '--no-git-tag-version', '--allow-same-version'], {
    cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });

  /*
   * ASK WHETHER THE PATTERN IS THERE, not whether the text changed.
   *
   * "did the string change?" is the obvious check and it is wrong for the
   * SETTLING case: when build.gradle already reads the target, the replace is
   * a no-op and an unchanged string looks identical to a missing versionName.
   * The first version threw exactly there - the third time in this one tool
   * that "nothing to do" was mistaken for "it failed".
   */
  const gradle = fs.readFileSync(GRADLE, 'utf8');
  const NAME = /versionName\s+"[^"]+"/;
  const patched = gradle.replace(NAME, `versionName "${target}"`);
  if (!NAME.test(gradle)) {
    throw new Error(
      'bump: build.gradle has no versionName to replace - package.json and the '
      + 'lock have MOVED and the manifest has not. Put it back by hand.');
  }
  fs.writeFileSync(GRADLE, patched);

  /* Say it out loud: the whole point is that all of them moved together. */
  console.log('\nafter:');
  const {agreed: ok, version: now} = report(readAll());
  if (!ok || now !== target) {
    console.error('\nbump: they still do not agree after writing. Look above.');
    process.exit(1);
  }
  console.log(`\nbumped to ${now}. versionCode is the git commit count and `
    + 'moves on its own.');
}

main();
