/*
 * PART T: THE PHONE'S SIDE OF BLUETOOTH PAIRING (onlykey-edge
 * features/BLUETOOTH-PAIRING-SPEC.md; proposal PROPOSAL-part-t-bluetooth-transit.md).
 *
 * ONLY THE VENDOR INTERFACE. This gate sits in vendorBridge, which only ever
 * sees writes on the vendor (API) service - the one onlykey-js --ble and Edge
 * requests use. FIDO/WebAuthn keeps its own transit, the Bluetooth keyboard is
 * a different link, and neither passes through here.
 *
 * WHY: Bluetooth's own encryption protects the link between two DEVICES. On a
 * bonded computer every account and every app can use that link, so any app
 * there could talk to the key through ok-rn. With this gate the phone answers
 * only a CLI user it has PAIRED with, and only over frames sealed with keys
 * made fresh for each connection.
 *
 * The crypto is all in the lib (node-onlykey-lib/btpair) - the same code the
 * CLI runs on the other side. What lives here is the phone's state:
 *
 *   - the phone's X-Wing identity and the paired computers, sealed in the
 *     Android Keystore box (NativeSecrets.boxSeal) and kept as ciphertext in
 *     AsyncStorage - a copy of the app's data is not a copy of the pairings;
 *   - the pairing window ("Pair a computer", about two minutes);
 *   - one session per computer address, in memory only;
 *   - the testing-mode switch that lets plaintext through (shown red).
 *
 * SILENCE IS THE ONLY REFUSAL. An unpaired computer, a switched-off pairing,
 * a bad frame, a plaintext report: no answer of any kind. An answer would tell
 * the sender a phone is there and which door is shut.
 *
 * Wire (lib cli/transport-ble.js): frame command 0x03 plaintext report (only
 * with transit off), 0x04 sealed frame, 0x05 pairing / handshake. The native
 * assembler strips the frame's high bit, so these arrive as 0x03/0x04/0x05 and
 * go out as 0x83/0x84/0x85. A sealed frame's plaintext starts with a kind byte:
 * 0x01 a 64-byte vendor report, 0x02 a control message (the weekly renewal).
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {bytes as okbytes} from 'node-onlykey-lib';
import * as bt from 'node-onlykey-lib/btpair';
import {sha256} from 'node-onlykey-lib/vendor/@noble/hashes/sha2.js';
import NativeSecrets from '../specs/NativeSecrets';
import NativeFidoGatt from '../specs/NativeFidoGatt';
import {testingModeOn} from './debugGuard';
import {postBluetoothAlarm} from './edgeAlerts';

export const CMD = {PLAIN: 0x83, SEALED: 0x84, PAIR: 0x85} as const;
export const KIND = {REPORT: 0x01, CONTROL: 0x02, REPORTS: 0x03} as const;
/*
 * SEVERAL REPORTS IN ONE WRITE (Brad, 2026-10-06; lib cli/transport-ble.js
 * KIND_REPORTS): each write the computer makes is acknowledged (~0.3 s), so it
 * may put whole 64-byte reports back to back in one sealed message. Told it may
 * by CTRL_BATCH, sent sealed right after the hello; a computer that never reads
 * it keeps sending one report per write. Each report is handed on on its own -
 * the bridge checks it exactly as if it had come alone.
 */
export const CTRL_BATCH = 0x30;
/* the computer is done for now (lib release()): this session ends and its link goes */
export const CTRL_BYE = 0x31;
const REPORT_BYTES = 64;

const STORE_KEY = 'okt.btpair.v1';
const BOX_ALIAS = 'btpair';
const TRANSIT_OFF_KEY = 'okt.btpair.transitOff';
const NOTICES_MAX = 20;

/** A paired computer as the lib makes it (phonePairApprove), secrets included. */
type PairRecord = {
  id: string;
  name: string;
  mac: string | null;
  cliPub: string;
  ps: string;
  epoch: number;
  renewedAt: number;
  on: boolean;
  lastUsed: number | null;
  oldPs: {epoch: number; ps: string}[];
  code: string;
};

/** What the UI may see of a pairing: never a secret. */
export type PairedComputer = {
  id: string;
  name: string;
  mac: string | null;
  code: string;
  on: boolean;
  lastUsed: number | null;
  renewedAt: number;
  epoch: number;
};

/** Things the person must hear about: a copied pairing, a revoke, an expiry. */
export type Notice = {
  kind: 'copy' | 'revoked-name' | 'revoked-mac' | 'expired';
  id: string;
  name: string;
  at: number;
};

/** What each notice says - the card and the phone notification use the same words. */
export const NOTICE_TEXT: Record<Notice['kind'], (name: string) => string> = {
  copy: name => `A copy of ${name}'s pairing was used after its weekly renewal. Only a copied pairing file could do that - ${name} was removed. Pair it again if it was you.`,
  'revoked-name': name => `${name}'s pairing was used under another computer name - revoked. Pair it again under its new name.`,
  'revoked-mac': name => `${name}'s pairing was used from another Bluetooth address - revoked.`,
  expired: name => `${name}'s pairing missed its weekly renewal and expired. Pair it again.`,
};

export type PairingView =
  | {stage: 'closed'}
  | {stage: 'waiting'; until: number}
  | {stage: 'code'; until: number; code: string; name: string; address: string}
  | {stage: 'approved'; until: number; code: string; name: string}
  | {stage: 'paired'; code: string; name: string}
  | {stage: 'failed'; reason: string};

type Stored = {
  identity: {secretKey: string; publicKey: string};
  records: PairRecord[];
  notices: Notice[];
};

type Session = ReturnType<typeof bt.cliOnHelloOk>;
type Sender = (cmd: number, bytes: Uint8Array) => void;
type Log = (level: 'info' | 'error' | 'rx', text: string) => void;

export type Deps = {
  storage?: {getItem(k: string): Promise<string | null>; setItem(k: string, v: string): Promise<void>; removeItem(k: string): Promise<void>};
  box?: {boxSeal(a: string, hex: string): Promise<string>; boxOpen(a: string, hex: string): Promise<string>};
  now?: () => number;
  isTestingMode?: () => boolean;
  log?: Log;
  /** How a notice reaches the person outside the app: a phone notification (T5). */
  alarm?: (id: number, text: string) => void;
  /** Let one computer's Bluetooth link go (NativeFidoGatt.disconnectCentral). */
  disconnect?: (address: string) => void;
};

const asHex = (s: string) => okbytes.toHex(okbytes.utf8ToBytes(s));
const fromHexText = (hex: string) => okbytes.bytesToUtf8(okbytes.fromHex(hex));
const cat = (a: Uint8Array, b: Uint8Array) => {
  const o = new Uint8Array(a.length + b.length);
  o.set(a);
  o.set(b, a.length);
  return o;
};

export function createBtTransit(deps: Deps = {}) {
  const storage = deps.storage ?? AsyncStorage;
  const box = deps.box ?? NativeSecrets;
  const now = deps.now ?? Date.now;
  const isTestingMode = deps.isTestingMode ?? testingModeOn;
  /* the app's log, given by the bridge (setLog); a gate with no log failed silently in production (2026-10-05) */
  let log: Log = deps.log ?? (() => {});
  const alarm = deps.alarm ?? postBluetoothAlarm;
  const disconnect = deps.disconnect ?? ((address: string) => {
    const f = (NativeFidoGatt as unknown as {disconnectCentral?: (a: string) => Promise<boolean>} | null)?.disconnectCentral;
    if (typeof f === 'function') void Promise.resolve(f.call(NativeFidoGatt, address)).catch(() => undefined);
  });
  let alarmIds = 0;

  let state: Stored | null = null;
  let loading: Promise<Stored> | null = null;
  let transitOffWanted = false;
  let sender: Sender | null = null;
  /* at: the session's last traffic, either way (a session whose computer went without a goodbye ends by it - linkGone) */
  const sessions = new Map<string, {session: Session; id: string; renew?: unknown; at: number}>();
  const listeners = new Set<() => void>();

  /* The pairing window: at most one pairing at a time, for one computer. */
  let pair: {until: number; address?: string; lib?: any; pending?: PairRecord; view: PairingView} = {
    until: 0,
    view: {stage: 'closed'},
  };

  const changed = () => listeners.forEach(fn => fn());

  async function load(): Promise<Stored> {
    if (state) return state;
    if (loading) return loading;
    loading = (async () => {
      transitOffWanted = (await storage.getItem(TRANSIT_OFF_KEY)) === '1';
      const sealed = await storage.getItem(STORE_KEY);
      if (sealed) {
        try {
          state = JSON.parse(fromHexText(await box.boxOpen(BOX_ALIAS, sealed))) as Stored;
          return state;
        } catch (e) {
          /*
           * The Keystore key is gone (a restore onto another phone, or a reset
           * of the Keystore): the sealed pairings cannot be read by anyone, so
           * start clean. Every computer re-pairs; nothing is guessed.
           */
          log('error', `[bt] the saved pairings could not be opened (${e instanceof Error ? e.name : 'error'}); starting with none`);
        }
      }
      const id = bt.generateIdentity();
      state = {identity: {secretKey: okbytes.toHex(id.secretKey), publicKey: okbytes.toHex(id.publicKey)}, records: [], notices: []};
      id.secretKey.fill(0);
      await save();
      return state;
    })();
    try {
      return await loading;
    } finally {
      loading = null;
    }
  }

  async function save() {
    if (!state) return;
    await storage.setItem(STORE_KEY, await box.boxSeal(BOX_ALIAS, asHex(JSON.stringify(state))));
  }

  const identity = (s: Stored) => ({secretKey: okbytes.fromHex(s.identity.secretKey), publicKey: okbytes.fromHex(s.identity.publicKey)});

  /** Plaintext is let through only in testing mode, with the switch on. */
  const transitOff = () => isTestingMode() && transitOffWanted;

  function send(cmd: number, bytes: Uint8Array) {
    if (!sender) {
      log('info', '[bt] nothing to send with (the bridge is not running)');
      return;
    }
    sender(cmd, bytes);
  }

  function notice(s: Stored, kind: Notice['kind'], rec: PairRecord) {
    s.notices = [{kind, id: rec.id, name: rec.name, at: now()}, ...s.notices].slice(0, NOTICES_MAX);
    /* the card shows it in red; this reaches the person when ok-rn is not on screen */
    try {
      alarm((alarmIds = (alarmIds + 1) & 0xffff), NOTICE_TEXT[kind](rec.name));
    } catch {
      /* an APK without the notification module: the card still shows it */
    }
  }

  /*
   * NO SESSION, NO LINK (Brad, 2026-10-06): whenever this phone stops holding a
   * computer's session, that computer's Bluetooth link goes too - the phone
   * advertises again and the computer's next request connects fresh, hello
   * first. On the A13 a link outlived its session (the app's screen
   * re-created): every sealed request was dropped in silence and nothing ever
   * dropped the link. Silence stays the answer - nothing goes out in the clear.
   */
  function dropSession(address: string, why: string) {
    sessions.delete(address);
    disconnect(address);
    log('info', `[bt] let a computer's link go: ${why}`);
    changed(); /* the status bar's ⚿: a session ended */
  }

  function drop(s: Stored, id: string) {
    s.records = s.records.filter(r => r.id !== id);
    for (const [addr, x] of [...sessions]) if (x.id === id) dropSession(addr, 'its pairing was dropped');
  }

  /* ------------------------------------------------------------ pairing */

  function pairWindowOpen() {
    return pair.view.stage !== 'closed' && pair.view.stage !== 'paired' && pair.view.stage !== 'failed' && now() < pair.until;
  }

  async function onPairMessage(msg: Uint8Array, address: string): Promise<void> {
    const s = await load();
    const type = msg[0];
    if (type === bt.T.HELLO) return onHello(s, msg, address);

    /* everything else is pairing, and pairing exists only while the window is open */
    if (!pairWindowOpen()) {
      log('info', `[bt] a pairing message from ${address} - "Pair a computer" is not open: no answer`);
      return;
    }
    if (type === bt.T.COMMIT) {
      if (pair.address && pair.address !== address) return; /* one computer at a time */
      const r = bt.phonePairOnCommit({identity: identity(s), windowOpenUntil: pair.until, now: now()}, msg);
      if (!r) {
        log('info', `[bt] a pairing request from ${address} was not well formed: no answer`);
        return;
      }
      log('info', `[bt] pairing: ${address} committed, answering with this phone's keys`);
      pair = {...pair, address, lib: r.state, view: {stage: 'waiting', until: pair.until}};
      send(CMD.PAIR, r.msg);
      return;
    }
    if (pair.address !== address) return;
    if (type === bt.T.REVEAL && pair.lib) {
      const r = bt.phonePairOnReveal(pair.lib, msg, now());
      if (!r) {
        pair = {...pair, lib: undefined, view: {stage: 'failed', reason: 'the computer did not keep to what it committed to'}};
        changed();
        return;
      }
      pair = {...pair, lib: r.state, view: {stage: 'code', until: pair.until, code: r.code, name: r.state.name, address}};
      changed();
      return;
    }
    if (type === bt.T.CONFIRM && pair.pending) {
      if (!bt.phonePairOnConfirm(pair.pending, msg)) return;
      const rec = pair.pending;
      drop(s, rec.id); /* pairing again replaces the old pairing for this CLI user */
      s.records.push(rec);
      await save();
      send(CMD.PAIR, bt.phonePairAck(rec));
      pair = {until: 0, view: {stage: 'paired', code: rec.code, name: rec.name}};
      log('info', `[bt] paired with ${rec.name}`);
      changed();
    }
  }

  /* ------------------------------------------------------------ connections */

  async function onHello(s: Stored, msg: Uint8Array, address: string) {
    const r: any = bt.phoneOnHello(s.records, msg, now(), {peerAddress: address});
    if (r.alarm) {
      /*
       * THE COPY ALARM (Brad's acceptance test): a hello that proves an OLD
       * pairing secret, after the weekly renewal replaced it. Only a copy of the
       * CLI's file could still hold it. The pairing is dropped; the computer
       * re-pairs with the person's approval.
       */
      const rec = s.records.find(x => x.id === r.alarm)!;
      notice(s, 'copy', rec);
      drop(s, rec.id);
      await save();
      log('error', `[bt] a copy of ${rec.name}'s pairing was used - the pairing is dropped`);
      changed();
      return;
    }
    if (r.revoke) {
      const rec = s.records.find(x => x.id === r.revoke)!;
      notice(s, r.reason === 'name' ? 'revoked-name' : 'revoked-mac', rec);
      drop(s, rec.id);
      await save();
      log('error', `[bt] ${rec.name}'s pairing was used from another ${r.reason === 'name' ? 'computer name' : 'Bluetooth address'} - revoked`);
      changed();
      return;
    }
    if (r.expired) {
      const rec = s.records.find(x => x.id === r.expired)!;
      notice(s, 'expired', rec);
      drop(s, rec.id);
      await save();
      log('info', `[bt] ${rec.name}'s pairing expired (missed its weekly renewal) - pair it again`);
      changed();
      return;
    }
    if (!r.session) return; /* silence */
    s.records = s.records.map(x => (x.id === r.record.id ? r.record : x));
    await save();
    sessions.set(address, {session: r.session, id: r.record.id, at: now()});
    changed(); /* the status bar's ⚿: a session opened */
    send(CMD.PAIR, r.msg);
    /* this phone reads several reports per write (KIND.REPORTS), version 1 */
    send(CMD.SEALED, bt.seal(r.session, cat(Uint8Array.of(KIND.CONTROL), Uint8Array.of(CTRL_BATCH, 1))));
    log('info', `[bt] ${r.record.name} connected (encrypted)`);
    changed();
    /* day 6 of 7: the renewal rides inside this session */
    if (bt.renewDue(r.record, now())) offerRenewal(address);
  }

  function offerRenewal(address: string) {
    const x = sessions.get(address);
    if (!x) return;
    const o = bt.phoneRenewOffer();
    x.renew = o.state;
    send(CMD.SEALED, bt.seal(x.session, cat(Uint8Array.of(KIND.CONTROL), o.payload)));
  }

  async function onControl(address: string, payload: Uint8Array) {
    const x = sessions.get(address);
    if (x && payload[0] === CTRL_BYE) {
      dropSession(address, 'the computer said goodbye');
      return;
    }
    if (!x || !x.renew) return;
    const s = await load();
    const rec = s.records.find(r => r.id === x.id);
    if (!rec) return;
    const next = bt.phoneRenewFinish(rec, x.renew as any, payload, now());
    x.renew = undefined;
    if (!next) return;
    s.records = s.records.map(r => (r.id === rec.id ? (next as PairRecord) : r));
    await save();
    log('info', `[bt] ${rec.name}'s renewal agreed - it takes over when ${rec.name} next connects (two-phase)`);
    changed();
  }

  return {
    /**
     * This phone's id on the Edge wire (the envelope's dev): the first 16 bytes of
     * SHA-256 of its Part T identity - stable, short, nothing secret.
     */
    async deviceId(): Promise<string> {
      const s = await load();
      return okbytes.toHex(sha256(okbytes.fromHex(s.identity.publicKey)).slice(0, 16));
    },

    /** Read the sealed store (makes the phone's identity on first use). */
    load: async () => {
      await load();
    },

    /**
     * One vendor message from a computer. Returns the 64-byte report to hand
     * to the key, or null - handled here (pairing, handshake, control) or
     * silence. `command` is the frame command, high bit stripped or not.
     */
    async handle(command: number, bytes: Uint8Array, address: string): Promise<Uint8Array | Uint8Array[] | null> {
      const cmd = command | 0x80;
      try {
        if (cmd === CMD.PAIR) {
          await onPairMessage(bytes, address);
          return null;
        }
        if (cmd === CMD.SEALED) {
          const x = sessions.get(address);
          if (!x) {
            /* a sealed request with no session here (lost, or never made): no answer, and the link goes */
            dropSession(address, 'a sealed request with no session');
            return null;
          }
          x.at = now();
          const pt = bt.open(x.session, bytes);
          if (pt[0] === KIND.REPORT) return pt.slice(1);
          if (pt[0] === KIND.REPORTS) {
            /* whole reports only, at least two: anything else is not a message this phone sends on */
            const body = pt.slice(1);
            if (body.length < 2 * REPORT_BYTES || body.length % REPORT_BYTES) {
              log('info', `[bt] a packed message of ${body.length} bytes from ${address} - not whole reports, dropped`);
              return null;
            }
            const out: Uint8Array[] = [];
            for (let i = 0; i < body.length; i += REPORT_BYTES) out.push(body.slice(i, i + REPORT_BYTES));
            return out;
          }
          if (pt[0] === KIND.CONTROL) await onControl(address, pt.slice(1));
          return null;
        }
        if (cmd === CMD.PLAIN) {
          await load();
          if (transitOff()) return bytes;
          log('info', `[bt] a plaintext report from ${address} - no answer (transit is on)`);
          if (!sessions.has(address)) dropSession(address, 'a plaintext request with no session');
          return null;
        }
      } catch (e) {
        /* a replayed, reordered or forged frame: refused, and refused silently - but never invisibly */
        const what = (e as any)?.code ?? (e instanceof Error ? e.name : 'error');
        log('info', `[bt] a frame (command 0x${(command | 0x80).toString(16)}) was refused (${what})`);
        /* the error CLASS only - no bytes, no address - so a release build shows why too (2026-10-05) */
        console.warn(`[bt] gate: command 0x${(command | 0x80).toString(16)} failed: ${what}${e instanceof Error && !(e as any).code ? ' ' + e.message.slice(0, 80) : ''}`);
      }
      return null;
    },

    /**
     * A report from the key for `address`: sealed for its session, plaintext
     * only with transit off, otherwise nothing goes out.
     */
    outgoing(address: string | null, report: Uint8Array): {cmd: number; bytes: Uint8Array} | null {
      if (!address) return null;
      const x = sessions.get(address);
      if (x) {
        x.at = now();
        return {cmd: CMD.SEALED, bytes: bt.seal(x.session, cat(Uint8Array.of(KIND.REPORT), report))};
      }
      if (transitOff()) return {cmd: CMD.PLAIN, bytes: report};
      return null;
    },

    /** How replies leave (vendorBridge's serialised send chain). */
    setSender(fn: Sender) {
      sender = fn;
    },
    /*
     * ...and let go of it ONLY IF IT IS STILL YOURS. Found in a production build
     * on the Pixel (2026-10-05): the app starts two React roots, the second App
     * mounted its bridge before the first one unmounted, and the first one's
     * cleanup set the shared sender to null - every pairing and hello was then
     * accepted and its answer went nowhere (diagnosed: "sender false").
     */
    releaseSender(fn: Sender) {
      if (sender === fn) sender = null;
    },

    /** Where the gate logs (the bridge's log - the app's Log tab); released the same way. */
    setLog(fn: Log) {
      log = fn;
    },
    releaseLog(fn: Log) {
      if (log === fn) log = deps.log ?? (() => {});
    },

    /** Forget every live session (the bridge stopped, Bluetooth went off). */
    endSessions() {
      for (const addr of [...sessions.keys()]) dropSession(addr, 'the bridge stopped');
    },

    /* ---- for the Bluetooth tab ---- */

    openPairWindow(): number {
      pair = {until: now() + bt.PAIR_WINDOW, view: {stage: 'waiting', until: now() + bt.PAIR_WINDOW}};
      changed();
      return pair.until;
    },

    closePairWindow() {
      pair = {until: 0, view: {stage: 'closed'}};
      changed();
    },

    pairing(): PairingView {
      if (!pairWindowOpen() && (pair.view.stage === 'waiting' || pair.view.stage === 'code' || pair.view.stage === 'approved')) {
        return {stage: 'failed', reason: 'the pairing window closed'};
      }
      return pair.view;
    },

    /** The person checked the code on both screens and confirmed: answer the CLI. */
    approvePairing(): boolean {
      if (!pairWindowOpen() || pair.view.stage !== 'code' || !pair.lib) return false;
      const a = bt.phonePairApprove(pair.lib, now(), {peerAddress: pair.address});
      pair = {...pair, lib: undefined, pending: a.pending as PairRecord, view: {stage: 'approved', until: pair.until, code: pair.view.code, name: pair.view.name}};
      send(CMD.PAIR, a.msg);
      changed();
      return true;
    },

    /**
     * The paired computer's name for a link's address - the one approved at pairing
     * (Brad, 2026-10-07: the Edge sheet says which computer asks, not only the agent).
     * By the link's session first (a computer can show a new random address), else a
     * record with that address; null when neither knows it.
     */
    async computerName(address: string): Promise<string | null> {
      const s = await load();
      const x = sessions.get(address);
      const rec = (x && s.records.find(r => r.id === x.id)) || s.records.find(r => r.mac !== null && r.mac.toLowerCase() === address.toLowerCase());
      return rec ? rec.name : null;
    },

    /**
     * Sessions open now: a paired computer between its hello and its goodbye (the
     * status bar's ⚿ green). activeWithinMs: only those with traffic that recently -
     * Brad's fallback (2026-10-07) for a command killed without its goodbye, whose
     * link Windows keeps: live ones are never quiet long (watch polls, the agent
     * service says goodbye when it idles).
     */
    openSessions(activeWithinMs?: number): number {
      if (activeWithinMs === undefined) return sessions.size;
      const t = now();
      return [...sessions.values()].filter(x => t - x.at < activeWithinMs).length;
    },

    /*
     * THE RADIO SAYS NO LINK IS LEFT: end the sessions that went quiet (Brad,
     * 2026-10-07 - ⚿ stayed green after a command was killed without its goodbye).
     * The radio's "nothing connected" races: the next command's link and the last
     * one's lingering link share an address, and the old one dropping reads as
     * none left while the new one talks. So only a session QUIET for quietMs ends -
     * a killed command's has been silent since it died, and Windows drops its link
     * ~3.6 s later; a live one has just said hello. Ended here without touching the
     * link: if a new one is up, it is not cut.
     */
    linkGone(quietMs = 3000) {
      const t = now();
      let ended = 0;
      for (const [addr, x] of [...sessions]) {
        if (t - x.at < quietMs) continue;
        sessions.delete(addr);
        ended++;
        log('info', `[bt] a computer's session ended without its goodbye (its link is gone, quiet ${Math.round((t - x.at) / 1000)} s)`);
      }
      if (ended) changed();
    },

    async list(): Promise<PairedComputer[]> {
      const s = await load();
      return s.records.map(({id, name, mac, code, on, lastUsed, renewedAt, epoch}) => ({id, name, mac, code, on, lastUsed, renewedAt, epoch}));
    },

    async notices(): Promise<Notice[]> {
      return (await load()).notices;
    },

    async clearNotices() {
      const s = await load();
      s.notices = [];
      await save();
      changed();
    },

    /** Off = no answer, pairing kept. */
    async setOn(id: string, on: boolean) {
      const s = await load();
      s.records = s.records.map(r => (r.id === id ? {...r, on} : r));
      if (!on) for (const [addr, x] of [...sessions]) if (x.id === id) dropSession(addr, 'switched off');
      await save();
      changed();
    },

    async revoke(id: string) {
      const s = await load();
      drop(s, id);
      await save();
      changed();
    },

    /** Testing mode only: let plaintext through (the app shows it red). */
    transitOff,
    async setTransitOff(off: boolean) {
      transitOffWanted = off;
      await storage.setItem(TRANSIT_OFF_KEY, off ? '1' : '0');
      changed();
    },

    /** Testing mode only (T6): make a pairing due for renewal on its next connection. */
    async ageForTest(id: string, ms: number) {
      if (!isTestingMode()) return false;
      const s = await load();
      s.records = s.records.map(r => (r.id === id ? {...r, renewedAt: r.renewedAt - ms} : r));
      await save();
      return true;
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

export type BtTransit = ReturnType<typeof createBtTransit>;

/** The app's one gate. */
export const btTransit = createBtTransit();
