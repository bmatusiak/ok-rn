/**
 * A FAKE Edge key, for building the Edge tab before any firmware has Edge
 * (owner, 2026-10-02: the tab first, against a fake; the soft-key plugin, E3,
 * follows and replaces it). TESTING MODE ONLY - the tab that uses it is not in
 * a release build, and nothing here talks to a real key.
 *
 * It answers the same calls the real key will (HEAD, READ, the budget list)
 * from a chain built with the LIBRARY's own encodeLink/weld, so what the tab
 * verifies is a real chain: a verdict shown from this fake is the same verdict
 * the real key's links would get. Its "agent" actions append links the way
 * firmware.md R13-R17 says the key would (self-press under a budget, a ticket
 * after a use, a denied request, a human press with an empty hook).
 */
import {chain, codes, grants, tickets} from 'node-onlykey-lib/edge';
import {utf8ToBytes} from 'node-onlykey-lib/bytes';

const {OP, DECISION, FLAG} = codes;
const MAX_LIVE_BUDGETS = 4; // firmware.md R15 target

export type EdgeLinkRecord = {link: Uint8Array; head: Uint8Array};
export type EdgeBudget = {
  grantId: number;
  reason: string;
  uses: number;
  used: number;
  scopes: {op: number; slot: number; cap: number; used: number}[];
  genesis: Uint8Array;
};
/** What a key (fake now, the soft key after E3) gives the Edge tab. */
export interface EdgeSource {
  readonly deviceId: Uint8Array;
  /** The key's live head; ringFrom = the oldest seq it can still READ. */
  head(): Promise<{seq: number; head: Uint8Array; ringFrom: number}>;
  read(fromSeq: number, count: number): Promise<EdgeLinkRecord[]>;
  budgets(): Promise<EdgeBudget[]>;
  /** Ticket messages by the seq they answer - they come by sync, never from the key. */
  messages(): Promise<Record<number, string>>;
  /** End a live budget now (a grant-end link). */
  revoke(grantId: number): void | Promise<void>;
}

/** A budget someone asked for and the person has not answered yet (spec 4.3 clasp sheet). */
export type EdgeRequest = {
  id: number;
  /** who asked: the CLI or an agent's MCP server, as its registered key names itself */
  from: string;
  reason: string;
  scopes: {op: number; slot: number; cap: number}[];
};
/**
 * Where budget requests arrive. NOT the key: a request comes from the CLI or an
 * MCP server through the user's Edge Worker (mcp-service.md 4.7); the key only
 * sees the GRANT_CREATE that follows the person's Yes and press.
 */
export interface EdgeInbox {
  /** A budget request arriving (testing mode makes them until the MCP server / Worker send them). */
  request(from: string, reason: string, scopes: EdgeRequest['scopes']): number;
  pending(): Promise<EdgeRequest[]>;
  /**
   * Yes: the request goes to the key, which waits for a PHYSICAL press;
   * `onPress` says it is waiting, press() presses. Resolves once the budget is live.
   */
  approve(id: number, onPress?: () => void): Promise<void>;
  press(): Promise<void>;
  decline(id: number): Promise<void>;
}

const sha = (text: string) => {
  /* a stand-in subject: SHA-256 of a description, via the lib's ticket hash */
  return tickets.messageHash(text);
};

export class FakeEdgeKey implements EdgeSource, EdgeInbox {
  readonly deviceId: Uint8Array;
  private links: EdgeLinkRecord[] = [];
  private msgs: Record<number, string> = {};
  private live: (EdgeBudget & {seed: Uint8Array})[] = [];
  private requests: EdgeRequest[] = [];
  private pressGate: (() => void) | null = null;
  private nextRequest = 1;
  /** links older than this are gone from the fake key's ring */
  ring = 32;

  /* bump the name when demo() changes: a new history needs its own mirror, or the phone rightly calls it tampering */
  constructor(name = 'fake-key-demo-2') {
    this.deviceId = utf8ToBytes(name.padEnd(16, '.').slice(0, 16));
  }

  private get tip(): Uint8Array {
    const last = this.links[this.links.length - 1];
    return last ? last.head : chain.genesis(this.deviceId);
  }

  private add(fields: {op: number; decision: number; slot?: number; flags?: number; subject: Uint8Array; grantId?: number; grantStep?: number}) {
    const link = chain.encodeLink({seq: this.links.length, ...fields});
    this.links.push({link, head: chain.weld(this.tip, link)});
    return this.links.length - 1;
  }

  /** The last sign/decrypt has no ticket yet (R17's empty hook). */
  private owesTicket(): boolean {
    for (let i = this.links.length - 1; i >= 0; i--) {
      const f = chain.decodeLink(this.links[i].link);
      if (f.op === OP.TICKET) return false;
      if (f.op === OP.SIGN || f.op === OP.DECRYPT) {
        return f.decision === DECISION.APPROVE || f.decision === DECISION.SELF_PRESS;
      }
    }
    return false;
  }

  /* ---- what an agent / a person does ---- */

  /**
   * A budget (R11-R12): up to 4 scopes, each (op, slot, cap); one hash chain of
   * n = the sum of the caps. Several can be live at once (R15, target 4).
   */
  clasp(reason: string, scopes: {op: number; slot: number; cap: number}[]): number {
    if (this.live.length >= MAX_LIVE_BUDGETS) throw new Error(`edge (fake): ${MAX_LIVE_BUDGETS} budgets are already live`);
    if (!scopes.length || scopes.length > 4) throw new Error('edge (fake): a budget has 1 to 4 scopes');
    const uses = scopes.reduce((n, sc) => n + sc.cap, 0);
    if (uses > grants.MAX_USES) throw new Error(`edge (fake): a budget has at most ${grants.MAX_USES} uses`); // owner: 255
    const seed = new Uint8Array(32).map((_, i) => (i * 37 + this.links.length) & 0xff);
    const grantId = this.links.length + 1;
    const subject = sha(`grant ${grantId}: ${reason}`);
    this.add({op: OP.GRANT_CREATE, decision: DECISION.APPROVE, flags: FLAG.PRESS_OBSERVED, subject, grantId});
    this.live.push({
      grantId, reason, uses, used: 0, seed,
      scopes: scopes.map(sc => ({...sc, used: 0})),
      genesis: grants.grantGenesis(seed, uses),
    });
    return grantId;
  }

  /** A use. Inside a live budget's scope with room: self-press; otherwise a human press. */
  use(what: string, op: number = OP.SIGN, slot = 101): number {
    const flags = this.owesTicket() ? FLAG.PREV_NO_TICKET : 0;
    for (const b of this.live) {
      const scope = b.scopes.find(sc => sc.op === op && sc.slot === slot && sc.used < sc.cap);
      if (!scope) continue;
      b.used++; // the budget's step counts across all of its scopes
      scope.used++;
      return this.add({op, decision: DECISION.SELF_PRESS, slot, flags: flags | FLAG.BUDGET_SPENT, subject: sha(what), grantId: b.grantId, grantStep: b.used});
    }
    return this.add({op, decision: DECISION.APPROVE, slot, flags: flags | FLAG.PRESS_OBSERVED, subject: sha(what)});
  }

  deny(what: string, op: number = OP.DECRYPT, slot = 1) {
    this.add({op, decision: DECISION.DENY, slot, subject: sha(what)});
  }

  ticket(code: number, message: string) {
    const refSeq = this.links.length - 1;
    const refHead = this.links[refSeq].head;
    const subject = tickets.ticketSubject({refSeq, refHead, code, msgHash: tickets.messageHash(message)});
    this.add({op: OP.TICKET, decision: code, subject, grantId: refSeq});
    this.msgs[refSeq] = message;
  }

  /** GRANT_REVOKE (R15): the seed is wiped and the end is linked. */
  revoke(grantId: number) {
    const i = this.live.findIndex(b => b.grantId === grantId);
    if (i < 0) return;
    this.add({op: OP.GRANT_END, decision: DECISION.APPROVE, subject: sha(`grant ${grantId} ended`), grantId});
    this.live.splice(i, 1);
  }

  /** Lock (or reboot) ends every live budget (R15). */
  lock() {
    for (const b of [...this.live]) this.revoke(b.grantId);
  }

  /** A short, varied history: three budgets live at once, and every ticket state the tab must draw. */
  /** What the CLI / an MCP server does: ask for a budget. It waits for the person. */
  request(from: string, reason: string, scopes: EdgeRequest['scopes']): number {
    const id = this.nextRequest++;
    this.requests.push({id, from, reason, scopes: scopes.map(sc => ({...sc}))});
    return id;
  }

  async pending() {
    return this.requests.map(r => ({...r, scopes: r.scopes.map(sc => ({...sc}))}));
  }

  async approve(id: number, onPress?: () => void) {
    const r = this.requests.find(x => x.id === id);
    if (!r) throw new Error(`edge (fake): no request ${id}`);
    /* like the real key: nothing opens until the press */
    await new Promise<void>(resolve => {
      this.pressGate = resolve;
      onPress?.();
    });
    this.clasp(r.reason, r.scopes);
    this.requests = this.requests.filter(x => x.id !== id);
  }

  async press() {
    const go = this.pressGate;
    this.pressGate = null;
    go?.();
  }

  async decline(id: number) {
    this.requests = this.requests.filter(x => x.id !== id); // nothing reaches the key
  }

  static demo(): FakeEdgeKey {
    const k = new FakeEdgeKey();
    k.clasp('Sign release commits for ok-rn 0.0.6', [{op: OP.SIGN, slot: 101, cap: 3}]);
    k.clasp('Decrypt the CI deploy secrets', [{op: OP.DECRYPT, slot: 1, cap: 5}]);
    k.clasp('Publish the docs site', [{op: OP.SIGN, slot: 102, cap: 2}, {op: OP.DECRYPT, slot: 2, cap: 2}]);
    k.use('commit 1a2b3c');
    k.ticket(0x00, 'Signed commit 1a2b3c on master; the push was accepted.');
    k.use('deploy.env.age', OP.DECRYPT, 1);
    k.ticket(0x01, 'Decrypted deploy.env for the CI job; did not see whether the deploy finished.');
    k.use('commit 4d5e6f');
    k.ticket(0x00, 'Signed commit 4d5e6f; CI accepted it.');
    k.use('docs build 42', OP.SIGN, 102);
    k.ticket(0x00, 'Signed the docs bundle; the host accepted it.');
    k.use('site-token.age', OP.DECRYPT, 2); // no ticket: an empty hook
    k.deny('decrypt backup.age', OP.DECRYPT, 3);
    k.use('commit 7a8b9c');
    k.ticket(0x81, 'A README in the repo told me to also sign an unrelated tag. I stopped.');
    k.use('tag v0.0.6'); // the release budget is spent: a human press
    k.ticket(0x42, 'code not in v1'); // unknown code: must show as an alarm
    /* the first real use planned for Edge (owner, 2026-10-02): apk-signer's release signing, one press instead of one per signature */
    k.request('apk-signer on NITRO16', 'Sign the ok-rn 0.0.7 release build (4 signatures, then it revokes the rest)', [{op: OP.SIGN, slot: 2, cap: 4}]);
    return k;
  }


  /* ---- the key's side (what the tab reads) ---- */

  async head() {
    const seq = this.links.length - 1;
    return {seq, head: this.tip, ringFrom: Math.max(0, this.links.length - this.ring)};
  }

  async read(fromSeq: number, count: number) {
    const ringFrom = Math.max(0, this.links.length - this.ring);
    const from = Math.max(fromSeq, ringFrom);
    return this.links.slice(from, Math.min(this.links.length, fromSeq + count)).map(r => ({link: r.link.slice(), head: r.head.slice()}));
  }

  async budgets() {
    // the key never gives out a budget's seed
    return this.live.map(({seed: _secret, ...shown}) => ({...shown, scopes: shown.scopes.map(sc => ({...sc}))}));
  }

  async messages() {
    return {...this.msgs};
  }
}
