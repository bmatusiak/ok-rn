/**
 * What this build actually contains.
 *
 * The login screen leads with it, because "which firmware and which library am
 * I running" is the first question worth answering on a device whose whole
 * point is that it carries someone else's C compiled for Android. A version
 * that is guessed is worse than none.
 *
 * `firmware` is filled in by the staging step - see
 * android/okemu/scripts/stage.js - which is the only place that knows which
 * sources were actually compiled in. Until that lands it reads 'unknown'
 * rather than inventing something.
 */
const pkg = require('../package.json');
const lib = require('node-onlykey-lib/package.json');

export type BuildInfo = {
  app: string;
  library: string;
  /** Digest of the staged firmware sources, or 'unknown'. */
  firmware: string;
};

export const buildInfo: BuildInfo = {
  app: String(pkg.version ?? '0.0.0'),
  library: String(lib.version ?? 'unknown'),
  firmware: 'unknown',
};
