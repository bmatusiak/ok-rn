/*
 * WHAT A RELEASE BUILD MAY PRINT (log audit, spec order 2026-10-04) - the JS side
 * of android/.../LogSafe.kt. A release React Native build still sends console.*
 * to logcat (tag ReactNativeJS), which adb or a crash reporter reads without
 * touching the phone. So a release logs the SHAPE (a state, a count, an error's
 * kind) and never raw error text or stacks (they can carry whatever they were
 * built from), Edge budget numbers, host names or MAC addresses.
 * Debug builds keep the detail: every helper is a pass-through when __DEV__.
 */
const MAC = /(?:[0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}/g;

/** Debug: the error's text. Release: only its kind (name), never its message. */
export function errText(e: unknown): string {
  if (__DEV__) return String((e as {message?: unknown})?.message ?? e);
  return (e as {name?: string})?.name || 'error';
}

/** Debug: the stack (first 400 chars, one line). Release: nothing. */
export function errStack(e: unknown): string | null {
  const st = (e as {stack?: string})?.stack;
  return __DEV__ && st ? st.replace(/\s*\n\s*/g, ' | ').slice(0, 400) : null;
}

/** Debug: the detail. Release: the stand-in. */
export function detail(d: string, standIn = '<hidden>'): string {
  return __DEV__ ? d : standIn;
}

/** Debug: unchanged. Release: MAC addresses replaced by "<device>". */
export function scrub(s: string): string {
  return __DEV__ ? s : s.replace(MAC, '<device>');
}
