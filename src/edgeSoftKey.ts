/**
 * The Edge tab's REAL key: the soft key built with the edge firmware plugin
 * (OKEMU_PLUGINS=edge; buildInfo.hasSoftKeyPlugin('edge')), read through the
 * library's device calls (node-onlykey-lib/plugins/edge). Same EdgeSource and
 * EdgeInbox shapes as the fake key, so the screen and the store do not care
 * which one they have.
 *
 * What the key knows and what it does not (the firmware is a notary, DESIGN.md
 * section 0): it keeps the chain's head, the last links for pickup, and which
 * budgets are live - not their reasons or scopes. Those are this phone's: when
 * the person approves a budget here, its request is kept in AsyncStorage,
 * keyed by the budget id the key gave it, and its spend is counted from the
 * chain's own self-press links.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {approve as approveLib, chain, codes, request as requestLib, receipts} from 'node-onlykey-lib/edge';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';
import {getOnlyKey} from './onlykey';
import OkEmu from './transport/OkEmu';
import {chainState, evaluate, loadMirror, type EdgeView} from './edgeStore';
import type {EdgeBudget, EdgeCopyCheck, EdgeCopyKey, EdgeEnded, EdgeInbox, EdgeKeyState, EdgeLinkRecord, EdgeRequest, EdgeSource} from './edgeFake';
import {edgeKey} from './net';

const {DECISION, OP} = codes;

/* how many of these uses have a receipt in the copy (a receipt link names the use it answers) */
function receipted(mirror: {links: {link: Uint8Array}[]}, uses: number[]): number {
  const answered = new Set(mirror.links.map(r => chain.decodeLink(r.link)).filter(f => f.op === OP.RECEIPT).map(f => (f as {refSeq?: number}).refSeq));
  return uses.filter(q => answered.has(q)).length;
}
const PICKUP_MAX = 8;
const REGISTRY = (): string => edgeKey('budgets.');
/* one budget's record on this phone - its own budgets, and (since 2026-10-09) your other devices' checked openings */
export const budgetRecordKey = (deviceIdHex: string, grantId: number): string => REGISTRY() + deviceIdHex.toLowerCase() + '.' + grantId;

/*
 * What this phone keeps of a budget it approved: the request, G, and the
 * checkpoint signature its press answered with - the opening R27 checks
 * (grants.verifyBudgetOpening). A budget kept without a signature (approved
 * before this was stored) cannot be checked, so a copy holding it does not
 * verify.
 */
type Kept = {
  /* 1 since the clean start (Brad, 2026-10-07; the old chain's records went with it, edgeV1.ts) */
  v?: number;
  reason: string; scopes: EdgeRequest['scopes']; uses: number; genesis: string; from: string; signature?: string;
  /* R15b: the lifetime it was opened with (minutes, 0 = the key's 12 h) and when (the phone's clock) - for Continue */
  lifetime?: number; opened?: number;
  /* Continue asked for once already: the card goes */
  continued?: boolean;
  /* budget history: when this phone first saw it no longer live (its clock) - the chain carries no times */
  endedAt?: number;
  /* 4.7a: an ended agent budget's card dismissed (nothing on the key changes) */
  dismissed?: boolean;
  /* opened for an EDGE_REQUEST from a paired computer: its pairing id - a continue must come from the same computer (no agent key since 2026-10-08) */
  computer?: string;
};
const DEFAULT_LIFETIME_MINUTES = 12 * 60;

type SameHead = {key: string; raw: any; checkpoint?: any};
/* per key: the answers the key gave for its current head, and its Edge public key - this session's memory only */
const sameHeads = new Map<string, SameHead>();
const publicKeys = new Map<string, Uint8Array>();
/*
 * THE BUDGET OPENINGS, IN MEMORY FOR THE SESSION (A13, 2026-10-07: copyKey without a
 * checkpoint still 125-699 ms - the storage key list and every budget record read,
 * and each reason hashed, on every sync). They are records THIS phone writes when it
 * approves a budget, so storage is read once a session and our own write adds to the
 * memory; nothing else changes them. A record edited in storage meanwhile is read at
 * the next start, and an opening that does not match the chain fails the check closed.
 */
const openingsKept = new Map<string, Map<number, unknown>>();
function openingOf(kept: Kept) {
  return {
    scopes: kept.scopes, reasonHash: receipts.messageHash(kept.reason), genesis: fromHex(kept.genesis),
    uses: kept.uses, lifetime: kept.lifetime ?? 0, signature: fromHex(kept.signature ?? ''),
  };
}

export class SoftKeyEdge implements EdgeSource, EdgeInbox {
  readonly deviceId: Uint8Array;
  private edge: any;
  private requests: EdgeRequest[] = [];
  private nextRequest = 1;
  private pressWanted: (() => void) | null = null;

  private constructor(edge: any, deviceId: Uint8Array) {
    this.edge = edge;
    this.deviceId = deviceId;
  }

  /** null when the soft key does not answer Edge (no plugin, or locked). */
  /* this session's memory, per key (device id hex) - never stored */
  static forgetSession() {
    sameHeads.clear();
    publicKeys.clear();
  }

  static async open(): Promise<SoftKeyEdge | null> {
    const app = await getOnlyKey('embedded');
    /* 4 s: right after start the background sync's chain reads go first (lib client.js deviceIdentity, 2026-10-04) */
    if ((await app.edge.probe({timeoutMs: 4000})) !== 'edge') return null;
    const {deviceId} = await app.edge.publicKey();
    const soft = new SoftKeyEdge(app.edge, deviceId);
    /*
     * THE DEFAULT NAMETAG, MADE EARLY (Brad, 2026-10-08: "i still had to click change name tag"):
     * the first time the app reaches the key after login (the background sync does, within
     * seconds), a phone with no nametag signs its device name - so it is there before anyone
     * opens Edge Management. Once per phone; a nametag set by hand is never replaced.
     */
    void require('./edgeDevices').ensureNametag(soft).catch(() => undefined);
    return soft;
  }

  /*
   * THE KEY'S ANSWERS FOR ONE HEAD (Brad, 2026-10-06): its checkpoint (a signature
   * the key makes, ~0.6 s) is reused only while the head the
   * key last gave is unchanged. Every sync still reads the head from the key
   * first; a new head drops them. Memory only - a restart clears them.
   */
  /* shared by every SoftKeyEdge for this key (the tab, the background sync, the agent sheet each open one) */
  private get sameHead(): SameHead | null {
    return sameHeads.get(toHex(this.deviceId)) ?? null;
  }
  private noteHead(h: any) {
    const key = `${h.seq}:${h.head ? toHex(h.head) : ''}:${h.owed ?? ''}`;
    const id = toHex(this.deviceId);
    const was = sameHeads.get(id);
    if (!was || was.key !== key) sameHeads.set(id, {key, raw: h});
    else was.raw = h;
  }

  async head() {
    const h = await this.edge.head();
    this.noteHead(h);
    /*
     * no link yet: seq -1 against the genesis head verifies as "nothing recorded".
     * No oldest with a seq: the ring is EMPTY (right after a restore the key holds
     * none of its links), so it starts past the head - asking for #0 was refused
     * (EDGE:09) and the tab showed only "the key no longer holds that link".
     */
    const seq = h.seq === null ? -1 : h.seq;
    return {seq, head: h.head, ringFrom: h.oldest === null ? seq + 1 : h.oldest};
  }

  async read(fromSeq: number, count: number): Promise<EdgeLinkRecord[]> {
    const h = await this.edge.head();
    if (h.seq === null || h.oldest === null) return []; /* nothing recorded, or nothing held (after a restore) */
    const from = Math.max(fromSeq, h.oldest); /* older links are gone from the key: a gap, not an error */
    const last = Math.min(h.seq, fromSeq + count - 1);
    const out: EdgeLinkRecord[] = [];
    for (let s = from; s <= last; s += PICKUP_MAX) {
      const got = await this.edge.pickup(s, Math.min(PICKUP_MAX, last - s + 1));
      for (const l of got) out.push({link: l.link, head: l.head, reveal: l.reveal});
    }
    return out;
  }

  /* live budgets: the ids from the key, the details this phone kept, the spend from the chain */
  /*
   * One budget, as the cards show it: what this phone kept when it opened it
   * (reason, scopes, agent, when) and what the chain says it spent. Live and past
   * budgets alike (Brad, 2026-10-04: "what about budget history?").
   */
  /* the live budget ids at the last budgets() - to stamp when one goes */
  private lastLive: number[] = [];

  /*
   * ONE READ PER ACTION (Brad, 2026-10-06: every press re-read the key and the
   * copy five times over). Between beginRun() and endRun() - after an action's
   * own work, while the tab refreshes - the key's head, this phone's copy and
   * the storage keys are read once and shared. Outside a run, each call reads
   * fresh, as before. Memory only, for the length of one refresh.
   */
  private snap: {head?: any; mirror?: Awaited<ReturnType<typeof loadMirror>>; keys?: readonly string[]; checkpoint?: any} | null = null;
  beginRun() {
    this.snap = {};
  }
  endRun() {
    this.snap = null;
  }
  private async keyHead(): Promise<any> {
    /*
     * The snapshot is held in a local across the await: runs overlap (a sync
     * queued behind a computer's hold, then another), and one run's endRun()
     * cleared it while this one waited for the key - "Cannot read property
     * 'head' of null" on the tab (Pixel, 2026-10-06). A cleared snapshot
     * only means this read is a fresh one.
     */
    const snap = this.snap;
    if (!snap) { const h = await this.edge.head(); this.noteHead(h); return h; }
    if (!snap.head) { snap.head = await this.edge.head(); this.noteHead(snap.head); }
    return snap.head;
  }
  private async mirrorNow() {
    if (!this.snap) return loadMirror(this.deviceId);
    return (this.snap.mirror ??= await loadMirror(this.deviceId));
  }
  private async storageKeys(): Promise<readonly string[]> {
    if (!this.snap) return AsyncStorage.getAllKeys();
    return (this.snap.keys ??= await AsyncStorage.getAllKeys());
  }

  /* other: another device's budget - its opening's from names who asked (no pairing id travels) */
  private budgetFrom(id: number, kept: Kept | null, mirror: Awaited<ReturnType<typeof loadMirror>>, other = false): EdgeBudget {
    const spentRows = mirror.links
      .map(r => ({f: chain.decodeLink(r.link), scope: (r.link as Uint8Array)[46] || 0}))
      .filter(x => x.f.grantId === id && x.f.decision === DECISION.SELF_PRESS);
    const spent = spentRows.map(x => x.f);
    /* R3 (2026-10-03): byte 46 names the scope that paid - each identity its own count, from the chain */
    const exact = spentRows.length > 0 && spentRows.every(x => x.scope > 0);
    /*
     * A spend names its budget and its step (grantId, grantStep), not its scope:
     * the link's subject is a hash of the bytes signed. So the total comes from
     * the steps, and a scope's count is exact only when no other scope of the
     * budget shares its op and slot - two agent identities on slot 221 share one
     * count, and the card draws them as one line (spec session, 2026-10-03: the
     * gpg use showed under the ssh scope too).
     */
    const scopes = (kept?.scopes ?? []).map((sc, j) => ({
      ...sc,
      used: exact
        ? spentRows.filter(x => x.scope === j + 1).length
        : spent.filter(f => f.op === sc.op && f.slot === sc.slot).length,
    }));
    const stepsSpent = spent.reduce((m, f) => Math.max(m, f.grantStep), 0);
    return {
      grantId: id,
      reason: kept ? kept.reason : `Budget ${id} (opened elsewhere)`,
      computerId: kept?.computer,
      uses: kept ? kept.uses : spent.length,
      used: Math.max(stepsSpent, spent.length),
      scopes,
      /* every spend named its scope (R3): the per-scope counts are exact; else an older chain - shared slots stay one line */
      exact: exact || spent.length === 0,
      genesis: new Uint8Array(0),
      endsAt: kept?.opened ? kept.opened + (kept.lifetime || DEFAULT_LIFETIME_MINUTES) * 60000 : undefined,
      /* the audit log (budget history): when it opened, its lifetime, and how many uses got their receipt */
      ...(kept?.opened ? {openedAt: kept.opened} : {}),
      lifetime: kept?.lifetime || DEFAULT_LIFETIME_MINUTES,
      receiptsFiled: receipted(mirror, spent.map(f => f.seq)),
      ...(kept?.endedAt ? {endedAt: kept.endedAt} : {}),
      ...(kept?.computer || (other && kept?.from) ? {agent: kept!.from} : {}),
    };
  }

  /* useLastHead: the head this sync just read from the key (edgeStore.syncNow's alarms) - not a second read */
  async budgets(useLastHead = false): Promise<EdgeBudget[]> {
    const h = useLastHead && this.sameHead ? this.sameHead.raw : await this.keyHead();
    const mirror = await this.mirrorNow();
    const out: EdgeBudget[] = [];
    /* a budget that was live at the last look and is not now: stamp when it was seen gone (the log's 'lasted') */
    for (const gone of this.lastLive.filter(id => !(h.live as number[]).includes(id))) {
      const key = REGISTRY() + toHex(this.deviceId) + '.' + gone;
      const raw = await AsyncStorage.getItem(key);
      if (raw) {
        const kept = JSON.parse(raw) as Kept;
        if (!kept.endedAt) await AsyncStorage.setItem(key, JSON.stringify({...kept, endedAt: Date.now()}));
      }
    }
    this.lastLive = [...(h.live as number[])];
    for (const id of h.live as number[]) {
      const raw = await AsyncStorage.getItem(REGISTRY() + toHex(this.deviceId) + '.' + id);
      out.push(this.budgetFrom(id, raw ? JSON.parse(raw) : null, mirror));
    }
    return out;
  }

  /*
   * BUDGET HISTORY: every budget this phone opened that is not live now, newest
   * first, with how it ended - from the chain where it can say (a grant-end link:
   * revoked or ended; every use spent), else from the clock (past its lifetime),
   * else the key lost it with a lock or restart (budgets live in RAM).
   */
  async pastBudgets(): Promise<EdgeBudget[]> {
    const h = await this.keyHead();
    return this.historyOf(toHex(this.deviceId), await this.mirrorNow(), new Set(h.live as number[]));
  }

  /*
   * YOUR OTHER DEVICES' BUDGETS (Brad, 2026-10-09: "full cards, i want to see them in the budget
   * history list"): the same cards, built the same way from that device's merged log and the
   * opening words it sent - kept only after they checked against the log (edgeDevices
   * approveHeld). Its live budgets are not known here: one not ended in the log shows as it
   * stood at the last merge. device: its nametag, for the card's corner.
   */
  async deviceBudgets(deviceIdHex: string, device: string): Promise<EdgeBudget[]> {
    const out = await this.historyOf(deviceIdHex, await loadMirror(fromHex(deviceIdHex)), new Set(), true);
    return out.map(b => ({...b, device, deviceId: deviceIdHex.toLowerCase()}));
  }

  /**
   * ANOTHER DEVICE'S CHAIN VIEW (Brad, 2026-10-09: "all the data i see on the a13 should be just
   * like on the pixel"): its merged log, checked under its own key against the last checkpoint
   * merged, with its openings and notes - the same rows (receipts paired, intents checked) its
   * own phone draws.
   */
  async deviceView(deviceIdHex: string): Promise<EdgeView> {
    const mirror = await loadMirror(fromHex(deviceIdHex));
    const last = (mirror.merged ?? [])[(mirror.merged ?? []).length - 1];
    if (!last || !mirror.publicKey) return evaluate(mirror, null);
    const prefix = REGISTRY() + deviceIdHex.toLowerCase() + '.';
    const keys = (await this.storageKeys()).filter(key => key.startsWith(prefix));
    const openings: Record<number, unknown> = {};
    for (const [key, raw] of Object.entries(await AsyncStorage.getMany([...keys]))) {
      const rec: Kept | null = JSON.parse(raw || 'null');
      if (rec && rec.signature) openings[Number(key.slice(prefix.length))] = openingOf(rec);
    }
    return evaluate(mirror, {seq: last.seq, head: last.head, ringFrom: last.seq + 1}, [], {publicKey: mirror.publicKey, openings, checkpoint: {seq: last.seq, head: last.head, signature: last.signature}});
  }

  /* every budget with a record on this phone for that device and not live now, newest first */
  private async historyOf(deviceIdHex: string, mirror: Awaited<ReturnType<typeof loadMirror>>, live: Set<number>, other = false): Promise<EdgeBudget[]> {
    const prefix = REGISTRY() + deviceIdHex.toLowerCase() + '.';
    const keys = (await this.storageKeys()).filter(k => k.startsWith(prefix));
    const ends = new Set(mirror.links.map(r => chain.decodeLink(r.link)).filter(f => f.op === OP.GRANT_END).map(f => f.grantId));
    const out: EdgeBudget[] = [];
    for (const k of keys) {
      const id = Number(k.slice(prefix.length));
      if (!Number.isInteger(id) || live.has(id)) continue;
      const raw = await AsyncStorage.getItem(k);
      const b = this.budgetFrom(id, raw ? JSON.parse(raw) : null, mirror, other);
      b.endedHow = ends.has(id) ? 'ended' : b.used >= b.uses ? 'used up' : b.endsAt && Date.now() > b.endsAt ? 'expired' : 'lost when the key locked or restarted';
      /* like a block: the links it spans - its opening to the last link that names it (a use, its end) or answers one of its uses (a receipt) */
      const decoded = mirror.links.map(r => chain.decodeLink(r.link));
      const useSeqs = new Set(decoded.filter(f => f.grantId === id && f.op !== OP.RECEIPT).map(f => f.seq));
      const mine = decoded.filter(f => (f.op !== OP.RECEIPT && f.grantId === id) || (f.op === OP.RECEIPT && useSeqs.has((f as {refSeq?: number}).refSeq as number)));
      if (mine.length) {
        b.firstSeq = mine[0].seq;
        b.lastSeq = mine[mine.length - 1].seq;
      }
      /*
       * WHEN IT ENDED (spec 2026-10-04: "lasted 10 min of 5 min" - count to its end):
       * its grant-end link, when this phone saw it; else the stamp from when it was
       * seen gone - but never past its lifetime, which no budget outlives (the phone
       * may have looked long after it expired).
       */
      const endLink = decoded.find(f => f.op === OP.GRANT_END && f.grantId === id);
      const endSeen = endLink ? mirror.seen[endLink.seq] : undefined;
      if (endSeen) b.endedAt = endSeen;
      if (b.endsAt && (!b.endedAt || b.endedAt > b.endsAt)) b.endedAt = b.endsAt;
      out.push(b);
    }
    return out.sort((a, b2) => b2.grantId - a.grantId);
  }

  /**
   * THIS PHONE'S BUDGET OPENINGS, as they travel with its log (GIVE): the words and the press's
   * checkpoint signature - what lets your other devices show full cards after checking them
   * against this log (devices.checkOpenings). Only openings kept with their signature.
   */
  async openingWords(): Promise<Record<string, unknown>[]> {
    const prefix = REGISTRY() + toHex(this.deviceId) + '.';
    const keys = (await this.storageKeys()).filter(key => key.startsWith(prefix));
    const out: Record<string, unknown>[] = [];
    for (const [key, raw] of Object.entries(await AsyncStorage.getMany([...keys]))) {
      const kept: Kept | null = JSON.parse(raw || 'null');
      if (!kept || !kept.signature) continue;
      out.push({
        grantId: Number(key.slice(prefix.length)), reason: kept.reason, scopes: kept.scopes, uses: kept.uses, lifetime: kept.lifetime ?? 0,
        genesis: kept.genesis, signature: kept.signature, ...(kept.opened ? {opened: kept.opened} : {}), ...(kept.from ? {from: kept.from} : {}),
      });
    }
    return out;
  }

  async messages() {
    return {}; /* receipt messages arrive by sync (the Worker, E5); none from the key */
  }

  /* rule 8 (Brad, 2026-10-06): the person's Revoke and Hold go to the front of the key's lane (urgent) - never behind an agent */
  async revoke(grantId: number) {
    await this.edge.revoke(grantId, {urgent: true});
  }

  async state(): Promise<EdgeKeyState> {
    const h = await this.keyHead();
    return {owed: h.owed, overflow: h.overflow, held: h.held, refusedTx: h.refusedTx ?? 0};
  }

  async hold(grantId: number) {
    await this.edge.hold(grantId, {urgent: true});
  }

  /* R15a + R27: like Approve, only from a copy that verifies, then the press */
  async resume(grantId: number, onPress?: () => void) {
    await this.edge.resume(grantId, {verifiedHead: await this.verifiedHead(), onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  async waive(onPress?: () => void) {
    await this.edge.waive({onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  async acceptLoss(from: number, to: number, onPress?: () => void) {
    await this.edge.loss({from, to, onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  /**
   * The owner statement (Brad, 2026-10-08): the key signs its own fingerprint and this
   * phone's NAMETAG with its owner key - no press, no link. Another device of yours checks
   * it with its own owner key (lib devices.classify); so does this phone, against the
   * statements that arrive with offered logs.
   */
  async statement(nametag: string) {
    return this.edge.statement(nametag);
  }

  /*
   * TESTING MODE: what an agent does through ssh/gpg - an agent-derived P-256
   * sign (OKSIGN 222), pressed on the soft key's own button the way the e2e
   * does it, and no receipt after it. It leaves a debt on the key (R16), so the
   * tab's owed banner and Waive can be seen without a CLI or an MCP server.
   */
  async agentSign(text: string) {
    const app = await getOnlyKey('embedded');
    const message = receipts.messageHash(`okrn testing ${text} ${Date.now()}`);
    const identity = receipts.messageHash('okrn testing identity');
    const timer = setTimeout(() => { void OkEmu.pressQueue('1'); }, 1500);
    try {
      await app.okcrypto.agent.sign(identity, message, {keyType: 2, version: 2});
    } finally {
      clearTimeout(timer);
    }
  }

  /*
   * Continue (spec okrn-edge-tab.md; Brad, 2026-10-02: "a continue budget when
   * I get back"): a budget this phone approved that the key no longer lists,
   * with no grant-end link (a revoke ends it for good), and with uses and time
   * left. Uses left come from the chain's own self-press links; time left is
   * the original lifetime minus what the phone's clock says has passed -
   * stepping away never extends the day.
   */
  async ended(): Promise<EdgeEnded[]> {
    const h = await this.keyHead();
    const mirror = await this.mirrorNow();
    const fields = mirror.links.map(r => chain.decodeLink(r.link));
    const prefix = REGISTRY() + toHex(this.deviceId) + '.';
    const out: EdgeEnded[] = [];
    for (const k of await this.storageKeys()) {
      if (!k.startsWith(prefix)) continue;
      const grantId = Number(k.slice(prefix.length));
      const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
      if (!kept || kept.continued || kept.dismissed || !kept.opened || (h.live as number[]).includes(grantId)) continue;
      if (fields.some(f => f.op === codes.OP.GRANT_END && f.grantId === grantId)) continue;
      const spent = fields.filter(f => f.grantId === grantId && f.decision === DECISION.SELF_PRESS);
      const scopes = kept.scopes
        .map(sc => ({...sc, cap: sc.cap - spent.filter(f => f.op === sc.op && f.slot === sc.slot).length}))
        .filter(sc => sc.cap > 0);
      const lifetime = kept.lifetime || DEFAULT_LIFETIME_MINUTES;
      const minutesLeft = Math.floor(lifetime - (Date.now() - kept.opened) / 60000);
      if (!scopes.length || minutesLeft < 1) continue;
      out.push({grantId, reason: kept.reason, scopes, usesLeft: scopes.reduce((n, sc) => n + sc.cap, 0), minutesLeft, ...(kept.computer ? {agent: kept.from} : {})});
    }
    return out;
  }

  async dismissEnded(grantId: number) {
    const k = REGISTRY() + toHex(this.deviceId) + '.' + grantId;
    const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
    if (kept) await AsyncStorage.setItem(k, JSON.stringify({...kept, dismissed: true}));
  }

  /**
   * 4.7a: the LIVE budgets that already cover what a request names - same op,
   * slot and identity - with uses left and when each ends ("this agent already
   * has N uses left on <identity> until <time>"). sameComputer: opened for the
   * paired computer that asks.
   */
  async coverOf(msg: any, computer: string | null = null) {
    const live = await this.budgets();
    const out: {identity?: string; slot: number; usesLeft: number; endsAt?: number; grantId: number; sameComputer: boolean}[] = [];
    for (const b of live) {
      const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(REGISTRY() + toHex(this.deviceId) + '.' + b.grantId)) || 'null');
      for (const want of msg.scopes as any[]) {
        const op = want.op === 'sign' ? codes.OP.SIGN : want.op === 'decrypt' ? codes.OP.DECRYPT : want.op;
        const sc: any = b.scopes.find((x: any) => x.op === op && x.slot === want.slot && (x.identity || '') === (want.identity || ''));
        if (!sc) continue;
        out.push({
          ...(want.identity ? {identity: want.identity} : {}), slot: want.slot, usesLeft: Math.max(0, sc.cap - sc.used),
          endsAt: b.endsAt, grantId: b.grantId, sameComputer: !!kept?.computer && kept.computer === computer,
        });
      }
    }
    return out;
  }

  async continueBudget(grantId: number) {
    const e = (await this.ended()).find(x => x.grantId === grantId);
    if (!e) throw new Error(`edge: budget ${grantId} cannot be continued`);
    this.requests.push({
      id: this.nextRequest++, from: 'this phone (Continue)', reason: `continues #${grantId}: ${e.reason}`,
      scopes: e.scopes, ttlMinutes: e.minutesLeft,
    });
    const k = REGISTRY() + toHex(this.deviceId) + '.' + grantId;
    const kept: Kept = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
    await AsyncStorage.setItem(k, JSON.stringify({...kept, continued: true}));
  }

  /* the soft key's own buttons press for every request that waits on one */
  private pressing(onPress?: () => void) {
    return () => {
      this.pressWanted = () => undefined;
      onPress?.();
    };
  }

  /* ---- the inbox: requests waiting for the person ---- */

  /** A budget request (testing mode makes them here until the MCP server / Worker send them). */
  request(from: string, reason: string, scopes: EdgeRequest['scopes']): number {
    const id = this.nextRequest++;
    this.requests.push({id, from, reason, scopes: scopes.map(sc => ({...sc}))});
    return id;
  }

  async pending() {
    return this.requests.map(r => ({...r, scopes: r.scopes.map(sc => ({...sc}))}));
  }

  /*
   * The copy R27 checks: every link this phone holds (with reveals) and the
   * opening of every budget it approved. A budget opened elsewhere has no
   * opening here, so a copy with its grant-create link does not verify -
   * fail closed, and the reason says which budget.
   *
   * ONE STORAGE READ (Pixel, 2026-10-07): this read every budget ever opened one
   * at a time (44 on the A13, growing) and loaded the whole copy again only to
   * hand back links nobody used - on every sync. Now one getMany, openings only.
   */
  private async openings() {
    const id = toHex(this.deviceId);
    let kept = openingsKept.get(id);
    if (!kept) {
      kept = new Map();
      const prefix = REGISTRY() + id + '.';
      const keys = (await this.storageKeys()).filter(k => k.startsWith(prefix));
      for (const [k, raw] of Object.entries(await AsyncStorage.getMany([...keys]))) {
        const rec: Kept | null = JSON.parse(raw || 'null');
        if (rec && rec.signature) kept.set(Number(k.slice(prefix.length)), openingOf(rec));
      }
      openingsKept.set(id, kept);
    }
    return Object.fromEntries(kept) as Record<number, unknown>;
  }

  /* R27 anchors for the banner: the KEY's public key (PUBKEY this session) and its checkpoints */
  async copyKey(opts: {checkpoint?: boolean} = {}): Promise<EdgeCopyKey> {
    const want = opts.checkpoint !== false;
    /* the key's Edge public key never changes for this device: read once a session */
    const id = toHex(this.deviceId);
    const publicKey = publicKeys.get(id) ?? (await this.edge.publicKey()).publicKey;
    publicKeys.set(id, publicKey);
    /* the key's latest checkpoint - once per action */
    const cached = this.sameHead && 'checkpoint' in this.sameHead ? this.sameHead.checkpoint : undefined;
    const checkpoint = this.snap && 'checkpoint' in this.snap ? this.snap.checkpoint : cached !== undefined ? cached : want ? await this.edge.checkpoint().catch(() => null) : null;
    if (want && this.snap) this.snap.checkpoint = checkpoint;
    if (want && this.sameHead && checkpoint) this.sameHead.checkpoint = checkpoint;
    return {publicKey, openings: await this.openings(), checkpoint};
  }

  /**
   * R27: the library's verdict on this phone's copy, against the key's live head.
   * A DISPLAY: keyTail lets the key's newest links (an agent's receipt written
   * after the last sync) be checked from the key in memory instead of read as a
   * gap - on the A13 that gap sent every check to the full 13-16 s one. The
   * approval (answerAgent verifyCopy) and the library's create/resume stay strict.
   */
  async check(): Promise<EdgeCopyCheck> {
    /* the one chain state (okrn-edge-tab.md S3a): not a check of its own */
    const a = await chainState.validity(this);
    if (a.ok) return {ok: true};
    const v = a.view.verdict as {kind: string; seq?: number; from?: number; to?: number};
    return {ok: false, reason: v.kind, seq: v.seq ?? v.from, to: v.to};
  }

  /* R27 for Approve and resume: the head the one chain state verified, or a refusal */
  private async verifiedHead(): Promise<Uint8Array> {
    const a = await chainState.validity(this);
    if (!a.ok || !a.head) throw new Error(`edge: this phone's copy of the chain does not verify (${a.view.verdict.kind}) - sync or settle it first`);
    return a.head.head;
  }

  /**
   * Yes -> the copy check (R27) -> GRANT_CREATE with the head it verified -> the
   * key waits for a PHYSICAL press (no press, no budget). A copy that does not
   * verify sends nothing. `onPress` says the key is waiting; press() presses it.
   */
  async approve(id: number, onPress?: () => void) {
    const r = this.requests.find(x => x.id === id);
    if (!r) throw new Error(`edge: no request ${id}`);
    const reasonHash = receipts.messageHash(r.reason);
    const g = await this.edge.grant({
      verifiedHead: await this.verifiedHead(),
      scopes: r.scopes,
      reasonHash,
      ttlMinutes: r.ttlMinutes ?? 0,
      onPress: () => {
        this.pressWanted = () => undefined;
        onPress?.();
      },
    });
    this.pressWanted = null;
    await this.keepOpening(g, {reason: r.reason, scopes: r.scopes, from: r.from, lifetime: r.ttlMinutes ?? 0});
    this.requests = this.requests.filter(x => x.id !== id);
  }

  /**
   * Keep a budget's opening on this phone - what R27 checks the copy against
   * (copy()). Every budget opened on this key must pass through here, or the
   * copy stops verifying at its grant-create link: the tab's Approve, an
   * agent's request, and the e2e suite (ctx.edgeCopy).
   */
  async keepOpening(g: any, o: {reason: string; scopes: any[]; from: string; lifetime: number; computer?: string}) {
    const kept: Kept = {
      v: 1,
      reason: o.reason, scopes: o.scopes, uses: g.uses, genesis: typeof g.genesis === 'string' ? g.genesis : toHex(g.genesis), from: o.from,
      signature: typeof g.checkpoint.signature === 'string' ? g.checkpoint.signature : toHex(g.checkpoint.signature),
      lifetime: o.lifetime, opened: Date.now(), ...(o.computer ? {computer: o.computer} : {}),
    };
    await AsyncStorage.setItem(REGISTRY() + toHex(this.deviceId) + '.' + g.grantId, JSON.stringify(kept));
    openingsKept.get(toHex(this.deviceId))?.set(g.grantId, openingOf(kept)); /* the memory follows our own write */
  }

  /**
   * An EDGE_REQUEST from a paired computer (mcp-service.md 4.7a), from the vendor
   * bridge: the library's one implementation decides (approve.approveRequest - drop the
   * malformed and replayed, check caps and lifetime, ask the person, labels
   * and the reason hash made HERE from the names and the text, R27 on this
   * phone's copy, GRANT_LABEL + GRANT_CREATE, the press). An opened budget is
   * kept like one approved on the tab, so the copy keeps verifying and the
   * tab lists it.
   */
  async answerAgent(msg: any, o: {seen: Set<string>; from: string; computer: string | null; ask: (view: any) => Promise<'approve' | 'decline' | 'timeout' | 'copy_unverified'>; onPress?: () => void}) {
    const r: any = await approveLib.approveRequest(msg, {
      edge: this.edge,
      from: o.computer,
      seen: o.seen,
      ask: o.ask,
      /* the one chain state, strict: only a verified copy gives a head (okrn-edge-tab.md S3a) */
      verifyCopy: async () => {
        const a = await chainState.validity(this);
        /* a refusal: approveRequest looks at ok first, so the empty head is never used */
        return a.ok && a.head ? {ok: true, head: a.head.head} : {ok: false, head: new Uint8Array(0)};
      },
      budgetOf: (id: number) => this.keptSync.get(id) ?? null,
      coverOf: (m: any) => this.coverOf(m, o.computer),
      onPress: () => {
        this.pressWanted = () => undefined;
        o.onPress?.();
      },
      timeoutMs: 30000,
    });
    this.pressWanted = null;
    if (r.ok) {
      await this.keepOpening(r.budget, {
        reason: msg.reason, scopes: requestLib.grantScopes(msg), from: o.from, lifetime: msg.lifetime, ...(o.computer ? {computer: o.computer} : {}),
      });
    }
    return r;
  }

  /* the budgets this phone opened for a paired computer, for a continue: {from, scopes} by id (loaded by loadAgentBudgets) */
  private keptSync = new Map<number, {from: string; scopes: any[]}>();
  async loadAgentBudgets() {
    const prefix = REGISTRY() + toHex(this.deviceId) + '.';
    this.keptSync.clear();
    for (const k of await AsyncStorage.getAllKeys()) {
      if (!k.startsWith(prefix)) continue;
      const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
      if (kept?.computer) {
        /* the request's own words for the ops: a continue's scopes are compared with them */
        const scopes = kept.scopes.map((sc: any) => ({...sc, op: sc.op === codes.OP.SIGN ? 'sign' : sc.op === codes.OP.DECRYPT ? 'decrypt' : sc.op}));
        this.keptSync.set(Number(k.slice(prefix.length)), {from: kept.computer, scopes});
      }
    }
  }

  /** The press, on the soft key's own buttons - the phone is also the key, so it proves less than a hard key's. */
  async press() {
    await OkEmu.pressQueue('1');
  }

  async decline(id: number) {
    this.requests = this.requests.filter(x => x.id !== id); /* nothing reaches the key */
  }
}

