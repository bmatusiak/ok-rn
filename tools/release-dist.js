#!/usr/bin/env node
/**
 * Package a signed release apk into dist/ for a pre-release.
 *
 *   node tools/release-dist.js              package android/app/build/outputs/apk/release/app-release.apk
 *   node tools/release-dist.js --fresh      ...and regenerate the notes, dropping edits
 *   node tools/release-dist.js --dist <dir> ...into another folder (a dry run)
 *   node tools/release-dist.js --commit <sha>  the ok-rn commit the apk was built from
 *   node tools/release-dist.js --signed-by <text>  how it was signed, when no record says
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
 *   dist/RELEASE-NOTES-<version>.md          header + sha256 table + "built
 *                                            from" rewritten; the text below
 *                                            it is KEPT once edited
 *
 * The notes are GENERATED, then rewritten: a new version's notes get a draft -
 * the commits since the last release in the app, in node-onlykey-lib and in
 * the firmware, how it was signed, the known key caveat. The draft is the
 * index for the rewrite: every commit in it is read (its diff, not its
 * subject) before a line of the final notes is written about it. Once
 * rewritten, a re-package after a late fix keeps the text and only refreshes
 * the header; --fresh starts a new draft. Publishing stays human.
 *
 * ## Why the lib and the firmware are in the notes
 *
 * The app CONTAINS them: node-onlykey-lib is bundled into its JavaScript and
 * the firmware is compiled into the soft key. A user sees neither repository,
 * so a change there that they will notice is a change to this app. The header
 * records which commits went in ("Built from"), and the next release reads
 * that table back to know where its lists start. 0.0.4 recorded no lib commit
 * (it built from `file:../node-onlykey-lib`); for such a release the lib's
 * last commit before its tag is used, and the draft says it is an estimate.
 *
 * ## The two checks a pre-release lives or dies by
 *
 *   - the certificate must be the PREVIOUS release's, or the apk will not
 *     install over it and testers lose the soft key's data;
 *   - the versionCode must be HIGHER, or Android refuses the update.
 *
 * Both are read from the files (apksigner, aapt2, the previous notes), never
 * assumed.
 */
'use strict';
const {execSync, execFileSync} = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
/* The sibling checkouts: the lib, and the firmware stage.js compiles from. */
const CHECKOUTS = path.resolve(ROOT, '..');
const PARTS = {
  lib: path.join(CHECKOUTS, 'node-onlykey-lib'),
  libraries: path.join(CHECKOUTS, 'libraries'),
  firmware: path.join(CHECKOUTS, 'OnlyKey-Firmware'),
};
const BUILT_FROM_FILE = 'built-from.json';
let DIST = path.join(ROOT, 'dist');

function say(line) {
  console.log(line);
}

function git(cwd, args) {
  return execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim();
}

function buildTool(name) {
  const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
  const tools = fs.readdirSync(path.join(sdk, 'build-tools')).sort();
  const ext = process.platform === 'win32' ? (name === 'apksigner' ? '.bat' : '.exe') : '';
  return path.join(sdk, 'build-tools', tools[tools.length - 1], name + ext);
}

/** The stock apksigner's certificate SHA-256 and DN, or null. */
function certOf(apk) {
  const out = execSync(`${JSON.stringify(buildTool('apksigner'))} verify --print-certs ${JSON.stringify(apk)}`,
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']});
  const digest = /certificate SHA-256 digest: ([0-9a-f]+)/.exec(out);
  const dn = /certificate DN: (.+)/.exec(out);
  return digest ? {digest: digest[1], dn: dn ? dn[1].trim() : ''} : null;
}

/** versionCode as the apk itself declares it - what Android compares. */
function versionCodeOf(apk) {
  const out = execFileSync(buildTool('aapt2'), ['dump', 'badging', apk],
    {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']});
  const m = /versionCode='(\d+)'/.exec(out);
  return m ? Number(m[1]) : null;
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
 * What went into a build: the app commit, the lib commit its package.json
 * pins, and the firmware checkouts' commits - "+ changes" when a tracked file
 * in one differed from its commit, because then the commit is not all of it.
 * release.js reads this BEFORE the build, when it is still true, and it is
 * saved beside the apk; read later, the checkouts may have moved.
 */
function readBuiltFrom(commit) {
  const built = {app: commit, lib: null, libraries: null, firmware: null};
  try {
    const pkg = git(ROOT, ['show', `${commit}:package.json`]);
    const pin = /node-onlykey-lib"\s*:\s*"[^"]*#([0-9a-f]{7,40})"/.exec(pkg);
    built.lib = pin ? pin[1].slice(0, 7) : null;
  } catch (err) { /* commit not in this clone */ }
  for (const part of ['libraries', 'firmware']) {
    try {
      const head = git(PARTS[part], ['rev-parse', '--short=7', 'HEAD']);
      const changed = git(PARTS[part], ['status', '--short', '--untracked-files=no']);
      built[part] = changed ? `${head} + changes` : head;
    } catch (err) { /* no checkout */ }
  }
  return built;
}

/**
 * The newest release BEFORE `version` that dist/ knows about: its version, the
 * versionCode and "built from" commits its notes state, and its apk.
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
  const grab = (...res) => {
    for (const re of res) {
      const m = re.exec(notes);
      if (m) return m[1].slice(0, 7);
    }
    return null;
  };
  const code = /versionCode (\d+)/.exec(notes);
  const apk = fs.readdirSync(DIST).find(f => f.startsWith(`ok-rn-${prev}-pre.`) && f.endsWith('.apk'));
  /*
   * The "Built from" table first; then the prose older notes used
   * ("`libraries` `b412e78`, `OnlyKey-Firmware` `1f7e726`").
   */
  const built = {
    app: grab(/^\| ok-rn \| `([0-9a-f]+)`/m, /Commit `([0-9a-f]+)`/),
    lib: grab(/^\| node-onlykey-lib \| `([0-9a-f]+)`/m),
    libraries: grab(/^\| libraries[^|]*\| `([0-9a-f]+)`/m, /`libraries`\s+`([0-9a-f]+)`/),
    firmware: grab(/^\| OnlyKey-Firmware \| `([0-9a-f]+)`/m, /`OnlyKey-Firmware`\s+`([0-9a-f]+)`/),
  };
  let libEstimated = false;
  if (!built.lib) {
    /* NOT RECORDED (0.0.4): the lib's last commit before that release's tag. */
    try {
      const when = git(ROOT, ['log', '-1', '--format=%cI', `v${prev}`]);
      built.lib = git(PARTS.lib, ['rev-list', '-1', '--first-parent', `--before=${when}`, 'HEAD']).slice(0, 7);
      libEstimated = true;
    } catch (err) { /* no tag or no lib checkout */ }
  }
  return {version: prev, versionCode: code ? Number(code[1]) : null, built, libEstimated,
    apk: apk ? path.join(DIST, apk) : null};
}

/** Subjects of the commits in from..to, oldest first; null when the range cannot be read. */
function commitsBetween(cwd, from, to) {
  if (!from || !to) return null;
  try {
    return git(cwd, ['log', '--no-merges', '--reverse', '--format=%h%x20%s', `${from}..${to}`])
      .split(/\r?\n/).filter(Boolean);
  } catch (err) {
    return null;
  }
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

/** The header every notes file starts with; the text after it is the writer's. */
function headerFor({version, commit, versionCode, apkName, apkSha, zipName, zipSha, prev, sameCert, built}) {
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
  const cell = (v) => (v ? `\`${v.replace(/ \+ changes$/, '')}\`${/ \+ changes$/.test(v) ? ' + uncommitted changes' : ''}` : 'unknown');
  lines.push(
    '| built from | commit |',
    '|---|---|',
    `| ok-rn | ${cell(built.app)} |`,
    `| node-onlykey-lib | ${cell(built.lib)} |`,
    `| libraries (firmware) | ${cell(built.libraries)} |`,
    `| OnlyKey-Firmware | ${cell(built.firmware)} |`,
    '',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * A GENERATED DRAFT of the notes, below the header: the index for the
 * rewrite, readable as-is. Once edited, a re-package keeps the edit (see
 * makeDist), and --fresh throws it away for a new draft.
 */
function draftBody({prev, signer, signedBy, built}) {
  const pb = prev ? prev.built : {};
  const clean = (v) => (v ? v.replace(/ \+ changes$/, '') : v);
  const list = (commits) => (commits === null
    ? ['(the range could not be read from the checkout)']
    : commits.length ? commits.map(c => `- ${c.replace(/^([0-9a-f]+) /, '$1 - ')}`) : ['(none)']);
  const range = (a, b) => `\`${a || '?'}..${clean(b) || '?'}\``;

  const body = [
    '## What is new',
    '',
    `Generated from the commits since ${prev ? prev.version : 'the start'} in the app, the library and`,
    'the firmware; rewrite this for the people installing it.',
    '',
    `### ok-rn ${range(pb.app, built.app)}`,
    '',
    ...list(commitsBetween(ROOT, prev ? `v${prev.version}` : null, built.app)
      ?? commitsBetween(ROOT, pb.app, built.app)),
    '',
    `### node-onlykey-lib ${range(pb.lib, built.lib)}`,
    '',
  ];
  if (prev && prev.libEstimated) {
    body.push(`${prev.version} recorded no lib commit; \`${pb.lib}\` is the lib's last commit before its tag.`, '');
  }
  body.push(...list(commitsBetween(PARTS.lib, pb.lib, clean(built.lib))), '',
    'The lib\'s CHANGELOG.md describes these.', '',
    `### Firmware: libraries ${range(pb.libraries, built.libraries)}`, '',
    ...list(commitsBetween(PARTS.libraries, pb.libraries, clean(built.libraries))), '',
    `### Firmware: OnlyKey-Firmware ${range(pb.firmware, built.firmware)}`, '',
    ...list(commitsBetween(PARTS.firmware, pb.firmware, clean(built.firmware))), '',
    '## How it is signed',
    '',
    `Signed by ${signedBy}. Certificate \`${signer ? signer.digest.slice(0, 8) : '?'}…\`${signer && signer.dn ? ` (${signer.dn})` : ''}.`,
    '',
  );
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
 * @param {object} [o.built]    readBuiltFrom() taken before the build; else
 *                              built-from.json beside the apk; else read now
 * @param {string} [o.dist]     another folder than dist/ (a dry run)
 * @param {boolean} [o.fresh]   regenerate the whole notes file, edits and all
 */
function makeDist({apk, version, commit, versionCode, signedBy, built, dist, fresh}) {
  if (dist) DIST = path.resolve(dist);
  fs.mkdirSync(DIST, {recursive: true});
  const base = `ok-rn-${version}-pre.${commit}`;
  const apkOut = path.join(DIST, `${base}.apk`);
  const zipOut = path.join(DIST, `${base}.zip`);

  const record = path.join(path.dirname(apk), BUILT_FROM_FILE);
  if (built) {
    fs.writeFileSync(record, `${JSON.stringify({...built, signedBy}, null, 2)}\n`);
  } else if (fs.existsSync(record)) {
    built = JSON.parse(fs.readFileSync(record, 'utf8'));
    signedBy = signedBy || built.signedBy;
  } else {
    built = readBuiltFrom(commit);
    say('release: dist       NOTE - no built-from record beside the apk: the firmware commits are');
    say('release:            the checkouts\' commits NOW, which is only right if they have not moved');
  }

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

  if (path.resolve(apk) !== path.resolve(apkOut)) fs.copyFileSync(apk, apkOut);
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

  signedBy = signedBy || 'the release build (how it was signed was not recorded)';
  const header = headerFor({version, commit, versionCode, apkName: `${base}.apk`, apkSha,
    zipName: `${base}.zip`, zipSha, prev, sameCert, built});
  const notesPath = path.join(DIST, `RELEASE-NOTES-${version}.md`);
  /*
   * KEEP THE WRITING: everything from the first "## " section down belongs to
   * whoever edited it. Only the header - names, hashes, commits, versionCode -
   * is the tool's, and it is rewritten every time, so it can never go stale.
   */
  let body = null;
  if (fs.existsSync(notesPath) && !fresh) {
    const old = fs.readFileSync(notesPath, 'utf8');
    const at = old.search(/^## /m);
    if (at >= 0) body = old.slice(at);
  }
  const kept = body != null;
  if (!kept) body = draftBody({prev, signer, signedBy, built});
  fs.writeFileSync(notesPath, `${header}${body}`);

  say(`release: dist       ${path.relative(ROOT, apkOut)}  ${apkSha}`);
  say(`release: dist       ${path.relative(ROOT, zipOut)}  ${zipSha}`);
  say(`release: dist       ${path.relative(ROOT, notesPath)} (${kept ? 'header rewritten, your text kept' : 'generated draft - rewrite it as you like'})`);
  /*
   * A TITLE, because GitHub does not take one from the notes: 0.0.4 went out
   * with none, and 0.0.5's was typed by hand afterwards ("ok-rn 0.0.5-pre:
   * firmware 3.1.0"). That is the version plus the notes' own reason for the
   * release, so it is read from there - rewrite the heading, the title follows.
   */
  const reason = /^## The reason for this release: (.+)$/m.exec(body);
  say(`release: title      ok-rn ${version}-pre${reason ? `: ${reason[1].trim()}` : ''}`);
  say(`release: built from ok-rn ${built.app}, lib ${built.lib}, libraries ${built.libraries}, OnlyKey-Firmware ${built.firmware}`);
  if (/\+ changes/.test(`${built.libraries} ${built.firmware}`)) {
    say('release: WARNING - a firmware checkout had uncommitted changes: its commit is not all of it');
  }
  if (prev) {
    say(`release: previous   ${prev.version} (versionCode ${prev.versionCode ?? '?'})`);
    if (prev.versionCode != null && !(versionCode > prev.versionCode)) {
      say(`release: WARNING - versionCode ${versionCode} is not above ${prev.versionCode}: Android will refuse the update`);
    }
    if (sameCert === true) say(`release: cert       same as ${prev.version} - installs over it`);
    else if (sameCert === false) say(`release: WARNING - the certificate differs from ${prev.version}: it will NOT install over it`);
    else say(`release: cert       not compared (no ${prev.version} apk in dist/)`);
  }
  return {apk: apkOut, zip: zipOut, notes: notesPath, apkSha, zipSha, sameCert, prev, built};
}

module.exports = {makeDist, previousRelease, certOf, readBuiltFrom};

/* Standalone: re-package the build that is already there. */
if (require.main === module) {
  const arg = (name) => {
    const at = process.argv.indexOf(name);
    return at > 0 ? process.argv[at + 1] : null;
  };
  const apk = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
  if (!fs.existsSync(apk)) {
    console.error(`release-dist: no release apk at ${path.relative(ROOT, apk)} - run tools/release.js first`);
    process.exit(1);
  }
  const version = require(path.join(ROOT, 'package.json')).version;
  /*
   * WHICH COMMIT BUILT IT is not HEAD once anything was committed after the
   * build. So: --commit; else the name dist/ already gave these same bytes;
   * else HEAD, said out loud.
   */
  let commit = arg('--commit');
  if (!commit) {
    const dir = arg('--dist') ? path.resolve(arg('--dist')) : DIST;
    const sha = sha256(apk);
    const same = fs.existsSync(dir) && fs.readdirSync(dir)
      .find(f => f.startsWith(`ok-rn-${version}-pre.`) && f.endsWith('.apk') && sha256(path.join(dir, f)) === sha);
    commit = same ? same.slice(`ok-rn-${version}-pre.`.length, -'.apk'.length) : null;
  }
  if (!commit) {
    commit = git(ROOT, ['rev-parse', '--short', 'HEAD']);
    say(`release: dist       NOTE - commit taken from HEAD (${commit}); pass --commit if the build was earlier`);
  }
  makeDist({apk, version, commit, versionCode: versionCodeOf(apk),
    signedBy: arg('--signed-by'),
    dist: arg('--dist'), fresh: process.argv.includes('--fresh')});
}
