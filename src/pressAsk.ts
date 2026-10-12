/**
 * WHAT A PRESS IS FOR - the facts the press sheet (ui/PressSheet) presents beside its button
 * (Brad, 2026-10-10: "blind presses is a blocker, without it, it voids all security"; "the
 * firmware needs to PRESENT this info because the firmware is the thing that is signing").
 *
 * Two sources, and nothing from the computer that asks (Brad, 2026-10-10: "the confirm sheet
 * should only get the data from firmware, the cli should not be aware that we are checking the
 * press"):
 *
 * 1. THE FIRMWARE'S PRESS RECORD (vendor presses: ssh, gpg, decrypt, Edge). The soft key's
 *    key_chain plugin reports, the moment a sign or decrypt starts waiting, what it was handed:
 *    the opcode, the slot, the SHA-256 of the exact bytes, and on a derived code the 32-byte
 *    label that picks the key. It sees the request AFTER the Bluetooth transit is decrypted - the
 *    app never can. The identity is named by matching that label against the Key Chain list
 *    (keychain derive.labelHashOf): app -> firmware -> app. A label nobody listed stays unnamed.
 *
 * 2. THE FIDO2 REQUEST (passkeys): the site and the user come in the CTAP request itself, which
 *    the app hands the key byte for byte (transport/FidoGatt notes it here).
 */
import NativeOkEmu from '../specs/NativeOkEmu';
import type {KeyWaiting} from './transport/OkEmu';
import {readKeyChainList} from './keyChainRecorder';

const {press: kcPress} = require('node-onlykey-lib/keychain');
const {okconnect} = require('node-onlykey-lib/crypto');

/* ------------------------------------------------------------ 1. the firmware's press record */

export type FirmwarePress = {
  transport: 'vendor' | 'webauthn';
  opcode: number;
  slot: number;
  subject: string; /* hex, SHA-256 of the bytes to sign */
  label: string | null; /* hex, the derived identity's label */
  mode: 'press' | 'code' | null; /* a derive's record: the confirmation it waits for; null on a sign's */
  at: number;
};

/* the key_chain plugin's "press" record - read by the lib (keychain/press.js), the same for the CLI's hard key */
export function decodePress(hex: string, at = Date.now()): FirmwarePress | null {
  const p = kcPress.decodePress(hex);
  return p ? {...p, at} : null;
}

let lastPress: FirmwarePress | null = null;
let listening = false;
const listeners = new Set<() => void>();
const changed = () => { for (const l of listeners) l(); };

/** Listen for the firmware's press records for the life of the app (idempotent). */
export function startPressRecords(): void {
  if (listening) return;
  listening = true;
  try {
    NativeOkEmu.onPluginEvent(ev => {
      if (ev.name === 'press_end') {
        if (deriveWait) { deriveWait = null; changed(); }
        return;
      }
      if (ev.name !== 'press') return;
      const p = decodePress(ev.hex);
      /* a derive's wait is its own sheet (deriveWaitNow), not a sign's record */
      if (p && p.opcode === kcPress.DERIVE_OPCODE && p.slot === kcPress.DERIVE_SLOT && p.label) {
        const mode: 'press' | 'code' = p.mode === 'code' ? 'code' : 'press';
        deriveWait = {since: Date.now(), mode, code: mode === 'code' ? kcPress.codeOf(p.subject) : null, label: p.label};
        changed();
        if (__DEV__) console.log(`[press] firmware record: a derive, ${mode}, label ${p.label.slice(0, 8)}`);
        return;
      }
      if (p) { lastPress = p; changed(); }
      if (__DEV__) console.log(`[press] firmware record: op 0x${p ? p.opcode.toString(16) : "?"} slot ${p?.slot} label ${p?.label ? p.label.slice(0, 8) : "none"}`);
    });
  } catch {
    /* no native side (jest, an old build): the sheet says only what the wait itself says */
  }
}

/* when the firmware last handed over a sign or decrypt (0: never) - each one is a new wait */
/*
 * A DERIVE WAITING FOR ITS CONFIRMATION (the key_chain plugin's derive record, hooks 10/11): the
 * soft key's derive gate asks a press or a 3-digit code (field 30) and nothing else tells the app
 * - without this the press had no sheet at all (the live Pixel key, 2026-10-11: "no sheet for
 * press confirm"). The code is computed from the record, as the gate computes it. The record's
 * end (press_end) closes it; DERIVE_WAIT_MS is the gate's own 19 s with room, in case the end
 * never comes.
 */
export type DeriveWait = {since: number; mode: 'press' | 'code'; code: number[] | null; label: string};
let deriveWait: DeriveWait | null = null;
const DERIVE_WAIT_MS = 25_000;
export function deriveWaitNow(now = Date.now()): DeriveWait | null {
  return deriveWait && now - deriveWait.since < DERIVE_WAIT_MS ? deriveWait : null;
}

/*
 * What a derive is FOR, named by the feature that asks it: label text -> words for the sheet. The
 * firmware gives only the label's hash; a feature registers the labels it derives (the Password
 * Manager: its store, each wallet phrase), so the sheet can say "Passwords: open your store"
 * instead of a hash. A label nobody registered stays a hash.
 */
const deriveNames = new Map<string, string>();
const hashOf = (label: string) => Array.from(okconnect.derivationHash(label) as Uint8Array, b => b.toString(16).padStart(2, '0')).join('');
export function nameDerive(label: string, what: string): void {
  deriveNames.set(hashOf(label), what);
}
export function deriveNameOf(labelHash: string): string | null {
  return deriveNames.get(labelHash.toLowerCase()) ?? null;
}

export function latestPressAt(): number {
  return lastPress ? lastPress.at : 0;
}

/* the record of THIS wait: same opcode and slot, made just before the wait was seen */
const RECORD_SLACK_MS = 3000;
export function firmwarePressFor(w: KeyWaiting, since: number): FirmwarePress | null {
  const p = lastPress;
  if (!p || p.opcode !== w.opcode || p.slot !== w.slot) return null;
  return p.at >= since - RECORD_SLACK_MS ? p : null;
}

/* the firmware's label, named from this phone's Key Chain list (the lib's match, keychain/press.js) */
export async function nameOfLabel(label: string): Promise<{listed: boolean; name: string | null}> {
  return kcPress.nameOfLabel(await readKeyChainList().catch(() => [] as any[]), label);
}

/* ------------------------------------------------------------ 2. the FIDO2 request */

export type FidoAsk = {command: string; rpId: string; user: string | null; at: number};
let lastFido: FidoAsk | null = null;
/** transport/FidoGatt: a CTAP request on its way to the key */
export function noteFidoAsk(command: string, rpId: string, user: string | null) {
  lastFido = {command, rpId, user, at: Date.now()};
  changed();
}
/* the request a presence wait belongs to: the latest, within the ceremony's own time */
export function fidoAskNow(now = Date.now()): FidoAsk | null {
  return lastFido && now - lastFido.at < 60_000 ? lastFido : null;
}

export function onPressAsk(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/* tests */
export function _resetPressAsk() {
  lastPress = null;
  lastFido = null;
  deriveWait = null;
}
export function _setDeriveWait(w: DeriveWait | null) {
  deriveWait = w;
}
export function _setPress(p: FirmwarePress | null) {
  lastPress = p;
}
