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
  /** 'standard' or 'travel'; null when the build predates the gate. */
  edition: string | null;
  /** 'duo' or 'classic'. A DUO is a different device, not a setting. */
  model: string;
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
};

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
