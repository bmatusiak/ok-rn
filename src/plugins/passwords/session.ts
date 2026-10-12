/*
 * THE SESSION IN WORDS (PASSWORD-MANAGER-SPEC.md "Unlock and session policy"; UI: "the policy it
 * will open under", "time left in the session"). The policy strings are the lib's
 * (src/crypto/vault.js parsePolicy): session:Nm / session:Nh (an hour or less slides with use,
 * longer is absolute), startup (until the app closes), always (no cache: every use asks the key).
 */

/** How long a store opened under `policy` stays open, for the locked view. */
export function policyWords(policy: string | null | undefined): string {
  const m = /^session:(\d+)(m|h)$/.exec(String(policy ?? ''));
  if (m) {
    const n = Number(m[1]);
    const ms = m[2] === 'h' ? n * 3600000 : n * 60000;
    const span = m[2] === 'h' ? `${n} hour${n === 1 ? '' : 's'}` : `${n} minute${n === 1 ? '' : 's'}`;
    return ms <= 3600000 ? `${span} of use (each use restarts it)` : span;
  }
  if (policy === 'startup') return 'until the app closes';
  return 'one use: every open asks the key';
}

/** The time left, for the open list's header. Infinity = until the app closes. */
export function timeLeftWords(remainingMs: number): string {
  if (remainingMs === Infinity) return 'open until the app closes';
  const min = Math.ceil(remainingMs / 60000);
  return min <= 1 ? 'open, under a minute left' : `open, ${min} min left`;
}
