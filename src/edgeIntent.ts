/*
 * R13b (Brad, 2026-10-06): the press prompt says what the agent says the use is
 * for - "the agent says: <text>" - ONLY when the text hashes to the intent the
 * agent armed the key with; otherwise "intent unknown". It is the agent's
 * claim, not something the key checked, and the label says so.
 *
 * The 16 bytes come from the agent's ARM as it passes through the bridge to the
 * key (vendorBridge); the text from the agent's signed note, sent just before
 * the sign (edgeAgents). Memory only, nothing stored, nothing secret.
 */
import {grants} from 'node-onlykey-lib/edge';
import {bytes as okbytes} from 'node-onlykey-lib';

const ARM_LIVES_MS = 60_000;
let armed: {hex: string; at: number} | null = null;
/* intent hex -> the text a verified note carried (the newest few) */
const texts = new Map<string, string>();

/** the bridge saw an ARM go to the key: its intent bytes (null = an ARM without one) */
export function armedIntent(intent: Uint8Array | null): void {
  armed = intent && intent.some(x => x !== 0) ? {hex: okbytes.toHex(intent), at: Date.now()} : null;
}

/** a verified note's text: remembered under its intent hash */
export function noteIntentText(text: string | undefined | null): void {
  if (!text) return;
  texts.set(okbytes.toHex(grants.intentOf(String(text))), String(text));
  while (texts.size > 32) texts.delete(texts.keys().next().value as string);
}

/** what the press prompt shows: nothing (no armed intent), the agent's text, or unknown */
export function intentForPrompt(now = Date.now()): {kind: 'none'} | {kind: 'says'; text: string} | {kind: 'unknown'} {
  if (!armed || now - armed.at > ARM_LIVES_MS) return {kind: 'none'};
  const text = texts.get(armed.hex);
  return text ? {kind: 'says', text} : {kind: 'unknown'};
}

/** for tests */
export function resetIntents(): void {
  armed = null;
  texts.clear();
}
