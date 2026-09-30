#!/usr/bin/env node
/**
 * Package a signed release apk into dist/ for a pre-release.
 *
 *   node tools/release-dist.js              package android/app/build/outputs/apk/release/app-release.apk
 *   node tools/release-dist.js --fresh      ...and regenerate the notes, dropping edits
 *   node tools/release-dist.js --dist <dir> ...into another folder (a dry run)
 *
 * release.js calls makeDist() at the end of every signed release build, so
 * this normally runs by itself. Run it alone to re-package the build that is
 * already there.
 *
 * ## Why this is a tool and not a habit
 *
 * The owner publishes pre-releases himself, on the GitHub website, AFTER his own
 * manual testing - and he may change something before he submits. Every change
 * is a new commit, so the file names, the sha256 table and the notes' header go
 * stale at once. A packaging step done by hand from memory is the step that gets
 * a hash or a commit wrong on the second pass. So everything mechanical is done
 * here, every time, the same way:
 *
 *   dist/ok-rn-<version>-pre.<commit>.apk    the signed apk
 *   dist/ok-rn-<version>-pre.<commit>.zip    the apk in an archive, for
 *                                            downloads that refuse a bare apk
 *   dist/RELEASE-NOTES-<version>.md          header + sha256 table rewritten;
 *                                            the prose below it is KEPT
 *
 * The notes are GENERATED, then yours: a new version's notes get a draft
 * (the commit subjects since the last release, how it was signed, the known
 * key caveat) that can be published as it is or rewritten. Once rewritten, a
 * re-package after a late fix keeps the text and only refreshes the header;
 * --fresh starts a new draft. Publishing stays human.
 *
 * ## The two checks a pre-release lives or dies by
 *
 *   - the certificate must be the PREVIOUS release's, or the apk will not
 *     install over it and testers lose the soft key's data;
 *   - the versionCode must be HIGHER, or Android refuses the update.
 *
 * Both are read from the files (apksigner, the previous notes), never assumed.
 */
'use strict';
const {execSync, execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
let DIST = path.join(ROOT, 'dist');

function say(line) {
  console.log(line);
}

/** The stock apksigner's certificate SHA-256 and DN, or null. */
function certOf(apk) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const tools = fs.readdirSync(path.join(sdk, 'build-tools')).sort();
  const apksigner = path.join(sdk, 'build-tools', tools[tools.length - 1],
    process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
  const out = execSync(`${JSON.stringify(apksigner)} verify --print-certs ${JSON.stringify(apk)}`,
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const digest = /certificate SHA-256 digest: ([0-9a-f]+)/.exec(out);
  const dn = /certificate DN: (.+)/.exec(out);
  return digest ? {digest: digest[1], dn: dn ? dn[1].trim() : ''} : null;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Compare dotted versions numerically: 0.0.10 is newer than 0.0.9. */
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * The newest release BEFORE `version` that dist/ knows about: its version, the
 * versionCode its notes state, and its apk (if still there).
 */
function previousRelease(version) {
  if (!fs.existsSync(DIST)) return null;
  const versions = fs.readdirSync(DIST)
    .map(f => /^RELEASE-NOTES-(\d+(?:\.\d+)*)\.md$/.exec(f))
    .filter(Boolean)
    .map(m => m[1])
    .filter(v => cmpVersion(v, version) < 0)
    .sort(cmpVersion);
  const prev = versions[versions.length - 1];
  if (!prev) return null;
  const notes = fs.readFileSync(path.join(DIST, `RELEASE-NOTES-${prev}.md`), 'utf8');
  const code = /versionCode (\d+)/.exec(notes);
  const commit = /Commit `([0-9a-f]+)`/.exec(notes);
  const apk = fs.readdirSync(DIST).find(f => f.startsWith(`ok-rn-${prev}-pre.`) && f.endsWith('.apk'));
  return {version: prev, versionCode: code ? Number(code[1]) : null, commit: commit ? commit[1] : null,
    apk: apk ? path.join(DIST, apk) : null};
}

/** The apk in a zip on its own, as every earlier pre-release shipped it. */
function zipOne(file, zipPath) {
  if (fs.existsSync(zipPath)) fs.rmSync(zipPath);
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `Compress-Archive -LiteralPath '${file}' -DestinationPath '${zipPath}' -Force`], {stdio: 'ignore'});
  } else {
    execFileSync('zip', ['-j', '-q', zipPath, file]);
  }
}

/** The header every notes file starts with; the prose after it is the writer's. */
function headerFor({version, commit, versionCode, apkName, apkSha, zipName, zipSha, prev, sameCert}) {
  const lines = [
    `# ok-rn ${version}-pre`,
    '',
    `Pre-release. Commit \`${commit}\`, versionCode ${versionCode}.`,
    '',
    '| file | sha256 |',
    '|---|---|',
    `| \`${apkName}\` | \`${apkSha}\` |`,
    `| \`${zipName}\` | \`${zipSha}\` |`,
    '',
  ];
  if (prev && sameCert) {
    lines.push(`Signed with the same key as ${prev.version}, so it installs over it as an update and keeps the`,
      'soft key\'s data. The `.zip` is the `.apk` in an archive, for downloads that refuse a',
      'bare apk.', '');
  } else {
    lines.push('The `.zip` is the `.apk` in an archive, for downloads that refuse a bare apk.', '');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The commits since the previous release, oldest first: the tag v<prev> when
 * git has it, else the commit the previous notes name.
 */
function commitsSince(prev) {
  const ranges = [];
  if (prev) ranges.push(`v${prev.version}..HEAD`);
  if (prev && prev.commit) ranges.push(`${prev.commit}..HEAD`);
  for (const range of ranges) {
    try {
      return execSync(`git log --no-merges --reverse --format=%h%x20%s ${range}`,
        {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']})
        .split(/\r?\n/).filter(Boolean);
    } catch (err) { /* that ref is not in this clone: try the next */ }
  }
  return [];
}

/**
 * A GENERATED DRAFT of the notes, below the header. It reads as-is - the
 * commit subjects as a list - so a pre-release can go out with it, and it is
 * meant to be rewritten: once edited, a re-package keeps the edit (see
 * makeDist), and --fresh throws it away for a new draft.
 */
function draftBody({prev, signer, signedBy}) {
  const commits = commitsSince(prev);
  const body = [
    '## What is new',
    '',
    `Generated from the commits since ${prev ? prev.version : 'the start'}${commits.length ? '' : ' (none found)'};`,
    'rewrite this section for the people installing it.',
    '',
    ...commits.map(c => `- ${c.replace(/^([0-9a-f]+) /, '$1 - ')}`),
    '',
    '## How it is signed',
    '',
    `Signed by ${signedBy}. Certificate \`${signer ? signer.digest.slice(0, 8) : '?'}…\`${signer && signer.dn ? ` (${signer.dn})` : ''}.`,
    '',
  ];
  if (signer && signer.digest.startsWith('fac61745')) {
    body.push('## Known', '',
      '- **Signed with the repository\'s debug keystore.** Fine for a pre-release, but its',
      '  private half is public, so anyone can sign an update to this apk. A real release',
      '  needs its own key, kept outside the repo, and every later update must then use it.', '');
  }
  return body.join('\n');
}

/**
 * Put a signed apk into dist/ with its zip and notes. Returns the paths and hashes.
 *
 * @param {object} o
 * @param {string} o.apk        the signed release apk
 * @param {string} o.version    versionName (package.json version)
 * @param {string} o.commit     short commit hash of the build
 * @param {number} o.versionCode
 * @param {string} o.signedBy   who signed it, for a new notes file
 * @param {string} [o.dist]     another folder than dist/ (a dry run)
 * @param {boolean} [o.fresh]   regenerate the whole notes file, edits and all
 */
function makeDist({apk, version, commit, versionCode, signedBy, dist, fresh}) {
  if (dist) DIST = path.resolve(dist);
  fs.mkdirSync(DIST, {recursive: true});
  const base = `ok-rn-${version}-pre.${commit}`;
  const apkOut = path.join(DIST, `${base}.apk`);
  const zipOut = path.join(DIST, `${base}.zip`);

  /*
   * STALE FILES FROM AN EARLIER BUILD OF THIS VERSION go first: after a late
   * fix, dist/ holding two 0.0.5 apks with different commits is exactly the
   * mix-up this tool exists to prevent.
   */
  for (const f of fs.readdirSync(DIST)) {
    if (f.startsWith(`ok-rn-${version}-pre.`) && !f.startsWith(base)) {
      fs.rmSync(path.join(DIST, f));
      say(`release: dist       removed stale ${f}`);
    }
  }

  fs.copyFileSync(apk, apkOut);
  /*
   * THE BUILD'S TIME, NOT THE COPY'S: the zip stores the file's mtime, so
   * re-packaging the same build gives the same zip, byte for byte, and the
   * same sha256 in the notes.
   */
  const st = fs.statSync(apk);
  fs.utimesSync(apkOut, st.atime, st.mtime);
  zipOne(apkOut, zipOut);
  const apkSha = sha256(apkOut);
  const zipSha = sha256(zipOut);

  const signer = certOf(apkOut);
  const prev = previousRelease(version);
  let sameCert = null;
  if (prev && prev.apk && signer) {
    const prevCert = certOf(prev.apk);
    sameCert = prevCert ? prevCert.digest === signer.digest : null;
  }

  const header = headerFor({version, commit, versionCode, apkName: `${base}.apk`, apkSha,
    zipName: `${base}.zip`, zipSha, prev, sameCert});
  const notesPath = path.join(DIST, `RELEASE-NOTES-${version}.md`);
  /*
   * KEEP THE WRITING: everything from the first "## " section down belongs to
   * whoever edited it. Only the header - names, hashes, commit, versionCode -
   * is the tool's, and it is rewritten every time, so it can never go stale.
   */
  const existed = fs.existsSync(notesPath) && !fresh;
  let body = null;
  if (existed) {
    const old = fs.readFileSync(notesPath, 'utf8');
    const at = old.search(/^## /m);
    if (at >= 0) body = old.slice(at);
  }
  const kept = body != null;
  if (!kept) body = draftBody({prev, signer, signedBy});
  fs.writeFileSync(notesPath, `${header}${body}`);

  say(`release: dist       ${path.relative(ROOT, apkOut)}  ${apkSha}`);
  say(`release: dist       ${path.relative(ROOT, zipOut)}  ${zipSha}`);
  say(`release: dist       ${path.relative(ROOT, notesPath)} (${kept ? 'header rewritten, your text kept' : 'generated draft - rewrite it as you like'})`);
  if (prev) {
    say(`release: previous   ${prev.version} (versionCode ${prev.versionCode ?? '?'})`);
    if (prev.versionCode != null && !(versionCode > prev.versionCode)) {
      say(`release: WARNING - versionCode ${versionCode} is not above ${prev.versionCode}: Android will refuse the update`);
    }
    if (sameCert === true) say(`release: cert       same as ${prev.version} - installs over it`);
    else if (sameCert === false) say(`release: WARNING - the certificate differs from ${prev.version}: it will NOT install over it`);
    else say(`release: cert       not compared (no ${prev.version} apk in dist/)`);
  }
  return {apk: apkOut, zip: zipOut, notes: notesPath, apkSha, zipSha, sameCert, prev};
}

module.exports = {makeDist, previousRelease, certOf};

/* Standalone: re-package the build that is already there. */
if (require.main === module) {
  const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!fs.existsSync(apk)) {
    console.error(`release-dist: no release apk at ${path.relative(ROOT, apk)} - run tools/release.js first`);
    process.exit(1);
  }
  const version = require(path.join(ROOT, 'package.json')).version;
  const commit = execSync('git rev-parse --short HEAD', {cwd: ROOT, encoding: 'utf8'}).trim();
  const versionCode = Number(execSync('git rev-list --count HEAD', {cwd: ROOT, encoding: 'utf8'}).trim());
  const at = process.argv.indexOf('--dist');
  makeDist({apk, version, commit, versionCode,
    signedBy: 'the release build (re-packaged by release-dist.js)',
    dist: at > 0 ? process.argv[at + 1] : null, fresh: process.argv.includes('--fresh')});
}
