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
import {chain, codes, tickets} from 'node-onlykey-lib/edge';
import {fromHex, toHex} from 'node-onlykey-lib/bytes';
import {getOnlyKey} from './onlykey';
import OkEmu from './transport/OkEmu';
import {loadMirror} from './edgeStore';
import type {EdgeBudget, EdgeCopyCheck, EdgeEnded, EdgeInbox, EdgeKeyState, EdgeLinkRecord, EdgeReplay, EdgeRequest, EdgeSource} from './edgeFake';

const {DECISION} = codes;
const PICKUP_MAX = 8;
const REGISTRY = 'okrn.edge.budgets.';

/*
 * What this phone keeps of a budget it approved: the request, G, and the
 * checkpoint signature its press answered with - the opening R27 checks
 * (grants.verifyBudgetOpening). A budget kept without a signature (approved
 * before this was stored) cannot be checked, so a copy holding it does not
 * verify.
 */
type Kept = {
  reason: string; scopes: EdgeRequest['scopes']; uses: number; genesis: string; from: string; signature?: string;
  /* R15b: the lifetime it was opened with (minutes, 0 = the key's 12 h) and when (the phone's clock) - for Continue */
  lifetime?: number; opened?: number;
  /* Continue asked for once already: the card goes */
  continued?: boolean;
};
const DEFAULT_LIFETIME_MINUTES = 12 * 60;

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
  static async open(): Promise<SoftKeyEdge | null> {
    const app = await getOnlyKey('embedded');
    if ((await app.edge.probe({timeoutMs: 1500})) !== 'edge') return null;
    const {deviceId} = await app.edge.publicKey();
    return new SoftKeyEdge(app.edge, deviceId);
  }

  async head() {
    const h = await this.edge.head();
    /* no link yet: seq -1 against the genesis head verifies as "nothing recorded" */
    return {seq: h.seq === null ? -1 : h.seq, head: h.head, ringFrom: h.oldest === null ? 0 : h.oldest};
  }

  async read(fromSeq: number, count: number): Promise<EdgeLinkRecord[]> {
    const h = await this.edge.head();
    if (h.seq === null) return [];
    const from = Math.max(fromSeq, h.oldest ?? 0); /* older links are gone from the key: a gap, not an error */
    const last = Math.min(h.seq, fromSeq + count - 1);
    const out: EdgeLinkRecord[] = [];
    for (let s = from; s <= last; s += PICKUP_MAX) {
      const got = await this.edge.pickup(s, Math.min(PICKUP_MAX, last - s + 1));
      for (const l of got) out.push({link: l.link, head: l.head, reveal: l.reveal});
    }
    return out;
  }

  /* live budgets: the ids from the key, the details this phone kept, the spend from the chain */
  async budgets(): Promise<EdgeBudget[]> {
    const h = await this.edge.head();
    const mirror = await loadMirror(this.deviceId);
    const out: EdgeBudget[] = [];
    for (const id of h.live as number[]) {
      const raw = await AsyncStorage.getItem(REGISTRY + toHex(this.deviceId) + '.' + id);
      const kept: Kept | null = raw ? JSON.parse(raw) : null;
      const spent = mirror.links
        .map(r => chain.decodeLink(r.link))
        .filter(f => f.grantId === id && f.decision === DECISION.SELF_PRESS);
      const scopes = (kept?.scopes ?? []).map(sc => ({
        ...sc,
        used: spent.filter(f => f.op === sc.op && f.slot === sc.slot).length,
      }));
      out.push({
        grantId: id,
        reason: kept ? kept.reason : `Budget ${id} (opened elsewhere)`,
        uses: kept ? kept.uses : spent.length,
        used: spent.length,
        scopes,
        genesis: new Uint8Array(0),
      });
    }
    return out;
  }

  async messages() {
    return {}; /* ticket messages arrive by sync (the Worker, E5); none from the key */
  }

  async revoke(grantId: number) {
    await this.edge.revoke(grantId);
  }

  async state(): Promise<EdgeKeyState> {
    const h = await this.edge.head();
    return {owed: h.owed, overflow: h.overflow, held: h.held, restoring: h.restoring};
  }

  async hold(grantId: number) {
    await this.edge.hold(grantId);
  }

  /* R15a + R27: like Approve, only from a copy that verifies, then the press */
  async resume(grantId: number, onPress?: () => void) {
    await this.edge.grants.resume(grantId, {copy: await this.copy(), onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  async waive(onPress?: () => void) {
    await this.edge.waive({onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  /*
   * R26: hand the restoring key this phone's copy, from the link after its
   * restored head, in order, each with the head the copy stored after it. The
   * key takes a link only if it welds there; the first one it refuses is the
   * fork (or, if the copy itself skips a seq, a gap) - stop and say so, never
   * smooth it over. The Edge Worker's copy comes next, once it exists.
   */
  async replayCopy(): Promise<EdgeReplay> {
    const mirror = await loadMirror(this.deviceId);
    const h = await this.edge.head();
    const keyWas = h.seq === null ? -1 : h.seq;
    const newest = mirror.links.length ? chain.decodeLink(mirror.links[mirror.links.length - 1].link).seq : -1;
    let at = keyWas;
    for (const r of mirror.links) {
      const seq = chain.decodeLink(r.link).seq;
      if (seq <= at) continue;
      if (seq !== at + 1) return {keyWas, replayedTo: at, newest, stop: {why: 'gap', at: at + 1}};
      try {
        await this.edge.replay(r.link, r.head);
      } catch (e: any) {
        if (e && e.status === 'replay-mismatch') {
          const kh = (await this.edge.head()).head;
          const mine = mirror.links.find(x => chain.decodeLink(x.link).seq === at);
          return {keyWas, replayedTo: at, newest, stop: {why: 'fork', at, keyHead: toHex(kh), copyHead: mine ? toHex(mine.head) : ''}};
        }
        throw e;
      }
      at = seq;
    }
    return {keyWas, replayedTo: at, newest, stop: {why: 'end'}};
  }

  async finishRestore(newestSeq: number, onPress?: () => void) {
    await this.edge.replayDone({newestSeq: Math.max(0, newestSeq), onPress: this.pressing(onPress)});
    this.pressWanted = null;
  }

  /*
   * TESTING MODE: what an agent does through ssh/gpg - an agent-derived P-256
   * sign (OKSIGN 222), pressed on the soft key's own button the way the e2e
   * does it, and no ticket after it. It leaves a debt on the key (R16), so the
   * tab's owed banner and Waive can be seen without a CLI or an MCP server.
   */
  async agentSign(text: string) {
    const app = await getOnlyKey('embedded');
    const message = tickets.messageHash(`okrn testing ${text} ${Date.now()}`);
    const identity = tickets.messageHash('okrn testing identity');
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
    const h = await this.edge.head();
    const mirror = await loadMirror(this.deviceId);
    const fields = mirror.links.map(r => chain.decodeLink(r.link));
    const prefix = REGISTRY + toHex(this.deviceId) + '.';
    const out: EdgeEnded[] = [];
    for (const k of await AsyncStorage.getAllKeys()) {
      if (!k.startsWith(prefix)) continue;
      const grantId = Number(k.slice(prefix.length));
      const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
      if (!kept || kept.continued || !kept.opened || (h.live as number[]).includes(grantId)) continue;
      if (fields.some(f => f.op === codes.OP.GRANT_END && f.grantId === grantId)) continue;
      const spent = fields.filter(f => f.grantId === grantId && f.decision === DECISION.SELF_PRESS);
      const scopes = kept.scopes
        .map(sc => ({...sc, cap: sc.cap - spent.filter(f => f.op === sc.op && f.slot === sc.slot).length}))
        .filter(sc => sc.cap > 0);
      const lifetime = kept.lifetime || DEFAULT_LIFETIME_MINUTES;
      const minutesLeft = Math.floor(lifetime - (Date.now() - kept.opened) / 60000);
      if (!scopes.length || minutesLeft < 1) continue;
      out.push({grantId, reason: kept.reason, scopes, usesLeft: scopes.reduce((n, sc) => n + sc.cap, 0), minutesLeft});
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
    const k = REGISTRY + toHex(this.deviceId) + '.' + grantId;
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
   */
  private async copy() {
    const mirror = await loadMirror(this.deviceId);
    const openings: Record<number, unknown> = {};
    const prefix = REGISTRY + toHex(this.deviceId) + '.';
    for (const k of await AsyncStorage.getAllKeys()) {
      if (!k.startsWith(prefix)) continue;
      const kept: Kept | null = JSON.parse((await AsyncStorage.getItem(k)) || 'null');
      if (!kept || !kept.signature) continue;
      openings[Number(k.slice(prefix.length))] = {
        scopes: kept.scopes, reasonHash: tickets.messageHash(kept.reason), genesis: fromHex(kept.genesis),
        uses: kept.uses, lifetime: kept.lifetime ?? 0, signature: fromHex(kept.signature),
      };
    }
    return {links: mirror.links, openings};
  }

  /** R27: the library's verdict on this phone's copy, against the key's live head. */
  async check(): Promise<EdgeCopyCheck> {
    const v = await this.edge.grants.check(await this.copy());
    return v.ok ? {ok: true} : {ok: false, reason: v.reason, seq: v.seq ?? undefined};
  }

  /**
   * Yes -> the copy check (R27) -> GRANT_CREATE with the head it verified -> the
   * key waits for a PHYSICAL press (no press, no budget). A copy that does not
   * verify sends nothing. `onPress` says the key is waiting; press() presses it.
   */
  async approve(id: number, onPress?: () => void) {
    const r = this.requests.find(x => x.id === id);
    if (!r) throw new Error(`edge: no request ${id}`);
    const reasonHash = tickets.messageHash(r.reason);
    const g = await this.edge.grants.create({
      copy: await this.copy(),
      scopes: r.scopes,
      reasonHash,
      ttlMinutes: r.ttlMinutes ?? 0,
      onPress: () => {
        this.pressWanted = () => undefined;
        onPress?.();
      },
    });
    this.pressWanted = null;
    const kept: Kept = {
      reason: r.reason, scopes: r.scopes, uses: g.uses, genesis: toHex(g.genesis), from: r.from, signature: toHex(g.checkpoint.signature),
      lifetime: r.ttlMinutes ?? 0, opened: Date.now(),
    };
    await AsyncStorage.setItem(REGISTRY + toHex(this.deviceId) + '.' + g.grantId, JSON.stringify(kept));
    this.requests = this.requests.filter(x => x.id !== id);
  }

  /** The press, on the soft key's own buttons - the phone is also the key, so it proves less than a hard key's. */
  async press() {
    await OkEmu.pressQueue('1');
  }

  async decline(id: number) {
    this.requests = this.requests.filter(x => x.id !== id); /* nothing reaches the key */
  }
}

