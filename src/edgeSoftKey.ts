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
import {toHex} from 'node-onlykey-lib/bytes';
import {getOnlyKey} from './onlykey';
import OkEmu from './transport/OkEmu';
import {loadMirror} from './edgeStore';
import type {EdgeBudget, EdgeInbox, EdgeLinkRecord, EdgeRequest, EdgeSource} from './edgeFake';

const {DECISION} = codes;
const PICKUP_MAX = 8;
const REGISTRY = 'okrn.edge.budgets.';

type Kept = {reason: string; scopes: EdgeRequest['scopes']; uses: number; genesis: string; from: string};

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
      for (const l of got) out.push({link: l.link, head: l.head});
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

  /**
   * Yes -> GRANT_CREATE -> the key waits for a PHYSICAL press (no press, no
   * budget). `onPress` says the key is waiting; press() presses it.
   */
  async approve(id: number, onPress?: () => void) {
    const r = this.requests.find(x => x.id === id);
    if (!r) throw new Error(`edge: no request ${id}`);
    const reasonHash = tickets.messageHash(r.reason);
    const g = await this.edge.grant({
      scopes: r.scopes,
      reasonHash,
      onPress: () => {
        this.pressWanted = () => undefined;
        onPress?.();
      },
    });
    this.pressWanted = null;
    const kept: Kept = {reason: r.reason, scopes: r.scopes, uses: g.uses, genesis: toHex(g.genesis), from: r.from};
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

