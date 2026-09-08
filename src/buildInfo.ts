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
};

export const buildInfo: BuildInfo = {
  app: String(pkg.version ?? '0.0.0'),
  library: String(lib.version ?? 'unknown'),
  firmware: staged.digest ?? 'unknown',
  sources:
    staged.firmware || staged.libraries
      ? `${staged.firmware ?? '?'} / ${staged.libraries ?? '?'}`
      : '',
};
