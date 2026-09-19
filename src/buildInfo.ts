/**
 * What this build actually contains.
 *
 * The login screen leads with it, because "which firmware and which library am
 * I running" is the first question worth answering on a device whose whole
 * point is that it carries someone else's C compiled for Android. A version
 * that is guessed is worse than none.
 *
 * `src/generated/firmware.json` is written by the staging step
 * (android/okemu/scripts/stage.js) and is NOT committed, so a checkout that has
 * never staged reports 'unknown' rather than somebody else's hash. The digest
 * covers the staged tree AFTER patching - that is the source the .so is built
 * from, and hashing the upstream checkouts instead would miss every fixup.
 */
const pkg = require('../package.json');
const lib = require('node-onlykey-lib/package.json');

type Staged = {
  digest?: string;
  files?: number;
  firmware?: string | null;
  libraries?: string | null;
  /** A released version name when OKEMU_VERSION was set; null for the tree. */
  version?: string | null;
  production?: boolean;
  edition?: string | null;
  /** 'duo' or 'classic' - which model the staged firmware reports as. */
  model?: string | null;
  stagedAt?: string;
  /** True when staged from an unpinned tree - see stage.js. */
  unreleased?: boolean;
};

/*
 * require() in a try/catch rather than a static import: the file genuinely may
 * not exist, and Metro turns a missing static import into a build failure
 * rather than a runtime one.
 */
let staged: Staged = {};
try {
  staged = require('./generated/firmware.json') as Staged;
} catch {
  staged = {};
}

export type BuildInfo = {
  app: string;
  library: string;
  /** Digest of the staged firmware sources, or 'unknown'. */
  firmware: string;
  /** Upstream checkouts the staging read, when they were git repos. */
  sources: string;
  /**
   * The released firmware version this was staged from, or null for the
   * working tree. Set by OKEMU_VERSION - see
   * android/okemu/scripts/versions/README.md.
   */
  version: string | null;
  /** True when the DEBUG gate was off, as the firmware ships. */
  production: boolean;
  /** model, version, build and edition in one line - see describeBuild(). */
  builtFor: string;
  /** 'standard' or 'travel'; null when the build predates the gate. */
  edition: string | null;
  /** 'duo' or 'classic'. A DUO is a different device, not a setting. */
  model: string;
  /**
   * Whether this firmware is AHEAD of every release rather than being one.
   *
   * Read from `staged` DIRECTLY, never from `version === null` above: that
   * field is coalesced with `?? null`, and `staged` is `{}` when the
   * generated file is missing - so "working tree" and "never staged" would
   * be indistinguishable. A build with no metadata must not claim to be an
   * unreleased tree and switch on features that may not be there.
   */
  unreleased: boolean;
};

export const buildInfo: BuildInfo = {
  app: String(pkg.version ?? '0.0.0'),
  library: String(lib.version ?? 'unknown'),
  firmware: staged.digest ?? 'unknown',
  sources:
    staged.firmware || staged.libraries
      ? `${staged.firmware ?? '?'} / ${staged.libraries ?? '?'}`
      : '',
  version: staged.version ?? null,
  production: staged.production === true,
  edition: staged.edition ?? null,
  model: staged.model === 'duo' ? 'duo' : 'classic',
  unreleased: staged.unreleased === true,
  builtFor: '',
};

/* Assigned after the object exists, because it reads four of its own fields. */
buildInfo.builtFor = describeBuild();

/**
 * What this firmware was BUILT FOR, in one line.
 *
 * The digest above says which bytes are running; this says what they were meant
 * to be. Four things can vary independently, and every one of them changes what
 * the device does:
 *
 *   model    a DUO has 24 slots across 4 profiles, three buttons and a PIN that
 *            travels in the message body. A classic has 12, six, and buttons.
 *   version  a pinned release from ok-versions.json, or the working tree
 *   build    DEBUG or production - a production build has no debug console and
 *            cannot be given a PIN at all
 *   edition  standard or IN TRVL, which compiles out the encrypted profile
 *
 * Written out rather than left to the digest because a digest answers "is this
 * the same build as before" and never "which build is this". The staging step
 * knows all four (android/okemu/scripts/stage.js) and records them in
 * src/generated/firmware.json.
 *
 * The ordinary case reads "classic · working tree · debug". Anything else is
 * worth seeing at a glance, which is the whole point of this screen.
 */
function describeBuild(): string {
  const parts = [
    buildInfo.model === 'duo' ? 'DUO' : 'classic',
    buildInfo.version ?? 'working tree',
    buildInfo.production ? 'production' : 'debug',
  ];
  /* Only when it is NOT the standard edition - saying "standard" every time
   * teaches people to stop reading the line. */
  if (buildInfo.edition && buildInfo.edition !== 'standard') {
    parts.push(buildInfo.edition);
  }
  return parts.join(' · ');
}

/**
 * WHICH DEVICE this build boots against.
 *
 * flash.bin and eeprom.bin are the device's entire persistent state, so a
 * firmware version reading another version's flash measures neither of them.
 * A pinned build therefore gets its own storage slot and finds what it left
 * there last time.
 *
 * The working tree keeps the unnamed slot it has always used. That is not
 * tidiness: moving it would strand the provisioned device on every phone that
 * already has one, and nothing re-provisions itself
 * (see the bench-state note in CLAUDE.md).
 *
 * Kept beside the version it comes from rather than computed at the call site,
 * because two callers computing it differently is a device that boots against
 * the wrong flash and looks perfectly healthy.
 */
export const storageSlot: string = (() => {
  /*
   * A DUO IS A DIFFERENT DEVICE, not a setting on this one. It has 24 slots
   * across 4 profiles where a classic has 12 across 2, and its PIN travels in
   * the message body rather than on the buttons - so the two cannot share a
   * flash image any more than two firmware versions can. Emulating one is a
   * build option (OKEMU_MODEL=duo), which makes it exactly the same hazard
   * this slot exists to prevent.
   */
  const base = buildInfo.version ?? '';
  if (buildInfo.model !== 'duo') return base;
  return base ? base + '-duo' : 'duo';
})();
