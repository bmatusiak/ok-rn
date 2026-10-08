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
 * firmware.md R13-R17 says the key would (self-press under a budget, a receipt
 * after a use, a denied request, a human press with an empty hook).
 */
import {chain, codes, grants, receipts} from 'node-onlykey-lib/edge';
import {utf8ToBytes} from 'node-onlykey-lib/bytes';

const {OP, DECISION, FLAG} = codes;
const MAX_LIVE_BUDGETS = 4; // firmware.md R15 target

/** A link as a copy keeps it: the link, the head after it, and a self-press's reveal (R27 checks it against its budget's G). */
export type EdgeLinkRecord = {link: Uint8Array; head: Uint8Array; reveal?: Uint8Array | null};

/** R27: may a budget be asked for from this copy? The first thing that fails, in words. */
export type EdgeCopyCheck = {ok: true} | {ok: false; reason: string; seq?: number; to?: number};
export type EdgeBudget = {
  /* B7 stage 2: the registered key of the agent it was opened for (hex) - a note shows only from it */
  agentKey?: string;
  grantId: number;
  reason: string;
  uses: number;
  used: number;
  scopes: {op: number; slot: number; cap: number; used: number; identity?: string}[];
  /* R3: per-scope counts come from each spend's scope byte (else shared op+slot scopes are one count) */
  exact?: boolean;
  /* a past budget (budget history): how it ended */
  endedHow?: string;
  /* the audit log: when it opened and ended (the phone's clock), its lifetime (minutes), uses that got a receipt */
  openedAt?: number;
  endedAt?: number;
  lifetime?: number;
  receiptsFiled?: number;
  /* the links it spans, like a block: its opening to its last link (in this phone's copy) */
  firstSeq?: number;
  lastSeq?: number;
  genesis: Uint8Array;
  /** R15b: when its lifetime ends (the phone's clock), if this phone approved it */
  endsAt?: number;
  /* opened for an agent (4.7a): its name, shown on the card like the ended card does */
  agent?: string;
};
/** What a key (fake now, the soft key after E3) gives the Edge tab. */
export interface EdgeSource {
  readonly deviceId: Uint8Array;
  /** The key's live head; ringFrom = the oldest seq it can still READ. */
  head(): Promise<{seq: number; head: Uint8Array; ringFrom: number}>;
  read(fromSeq: number, count: number): Promise<EdgeLinkRecord[]>;
  /* useLastHead: the head the caller just read (a sync) may be reused */
  budgets(useLastHead?: boolean): Promise<EdgeBudget[]>;
  /** Receipt messages by the seq they answer - they come by sync, never from the key. */
  messages(): Promise<Record<number, string>>;
  /** End a live budget now (a grant-end link). */
  revoke(grantId: number): void | Promise<void>;

  /*
   * The spec change and R26 (firmware.md R15a-R18, R26). Optional: the fake key
   * predates them, and the tab shows each control only when the key has it.
   */
  /** What the key says about debts, holds and a restore, from HEAD. */
  state?(): Promise<EdgeKeyState>;
  /** R15a: pause a budget - no press. */
  hold?(grantId: number): Promise<void>;
  /** R15a: resume it - the copy check (R27), then a physical press. */
  resume?(grantId: number, onPress?: () => void): Promise<void>;
  /** R18: clear every owed receipt - a physical press. */
  waive?(onPress?: () => void): Promise<void>;
  /** R24: accept #from..#to as gone for good - a physical press; the key links a LOSS. */
  acceptLoss?(from: number, to: number, onPress?: () => void): Promise<void>;
  /** Budgets a lock or reboot ended, with uses and time left (Continue). */
  ended?(): Promise<EdgeEnded[]>;
  /** Continue: a new request for what is left of an ended budget - Yes and a press, like any budget. */
  continueBudget?(grantId: number): Promise<void>;
  /** 4.7a: hide an ended agent budget's card; the chain does not change. */
  dismissEnded?(grantId: number): Promise<void>;
  /**
   * R27 anchors: the key's own public key (read from the key, never from the
   * copy), the budget openings this phone kept, and the key's latest
   * checkpoint. A key that signs nothing (the fake) has none: then only the
   * genesis and HEAD anchor the copy.
   */
  /** checkpoint false: the public key and openings only - the key signs nothing (a sync in a burst) */
  copyKey?(opts?: {checkpoint?: boolean}): Promise<EdgeCopyKey>;
}

export type EdgeCopyKey = {
  publicKey: Uint8Array;
  openings: Record<number, unknown>;
  checkpoint: {seq: number; head: Uint8Array; signature: Uint8Array} | null;
};

/* refusedTx: B7 stage 2, HEAD byte 60 - TX starts the key refused since it started (0 on older firmware) */
export type EdgeKeyState = {owed: number; overflow: boolean; held: number[]; refusedTx?: number};

/** A budget someone asked for and the person has not answered yet (spec 4.3 clasp sheet). */
export type EdgeRequest = {
  id: number;
  /** who asked: the CLI or an agent's MCP server, as its registered key names itself */
  from: string;
  reason: string;
  scopes: {op: number; slot: number; cap: number}[];
  /** R15b: the lifetime asked for, in minutes (absent = the key's 12 h) */
  ttlMinutes?: number;
};

/**
 * A budget a lock or reboot ended before it was used up or ran out of time
 * (spec okrn-edge-tab.md, Continue): what is left of it, by the phone's clock.
 */
export type EdgeEnded = {
  grantId: number;
  reason: string;
  scopes: {op: number; slot: number; cap: number}[];
  usesLeft: number;
  minutesLeft: number;
  /* opened for an agent (4.7a): the AGENT continues it, so the tab offers only Dismiss - by this name */
  agent?: string;
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
  /** R27: does this phone's copy verify up to the key's live head? Yes stays off until it does. */
  check(): Promise<EdgeCopyCheck>;
}

const sha = (text: string) => {
  /* a stand-in subject: SHA-256 of a description, via the lib's receipt hash */
  return receipts.messageHash(text);
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
  constructor(name = 'fake-key-demo-3') {
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

  /** The last sign/decrypt owes and has no receipt yet (R17's empty hook; R16: it owes only with bit 4). */
  private owesReceipt(): boolean {
    for (let i = this.links.length - 1; i >= 0; i--) {
      const f = chain.decodeLink(this.links[i].link);
      if (f.op === OP.RECEIPT) return false;
      if (f.op === OP.SIGN || f.op === OP.DECRYPT) {
        return (f.decision === DECISION.APPROVE || f.decision === DECISION.SELF_PRESS) && !!(f.flags & FLAG.OWES_RECEIPT);
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
    if (uses > grants.MAX_USES) throw new Error(`edge (fake): a budget has at most ${grants.MAX_USES} uses`); // R11: 1024
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

  /** A use. Inside a live budget's scope with room: self-press; otherwise an ordinary press, which writes no link (v1) -> its seq, or -1. */
  use(what: string, op: number = OP.SIGN, slot = 101): number {
    for (const b of this.live) {
      const scope = b.scopes.find(sc => sc.op === op && sc.slot === slot && sc.used < sc.cap);
      if (!scope) continue;
      b.used++; // the budget's step counts across all of its scopes
      scope.used++;
      return this.add({op, decision: DECISION.SELF_PRESS, slot, flags: FLAG.BUDGET_SPENT | FLAG.OWES_RECEIPT, subject: sha(what), grantId: b.grantId, grantStep: b.used});
    }
    return -1;
  }

  receipt(code: number, message: string) {
    const refSeq = this.links.length - 1;
    const refHead = this.links[refSeq].head;
    const subject = receipts.receiptSubject({refSeq, refHead, code, msgHash: receipts.messageHash(message)});
    this.add({op: OP.RECEIPT, decision: code, subject, grantId: refSeq});
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
  /* a lock ends every budget silently - they live in RAM, and no unattended link is written (R15, Brad 2026-10-08) */
  lock() {
    this.live.length = 0;
  }

  /** A short, varied history: three budgets live at once, and every receipt state the tab must draw. */
  /** What the CLI / an MCP server does: ask for a budget. It waits for the person. */
  request(from: string, reason: string, scopes: EdgeRequest['scopes']): number {
    const id = this.nextRequest++;
    this.requests.push({id, from, reason, scopes: scopes.map(sc => ({...sc}))});
    return id;
  }

  async pending() {
    return this.requests.map(r => ({...r, scopes: r.scopes.map(sc => ({...sc}))}));
  }

  /* the fake key has no copy check of its own: its chain is built in memory by the library */
  async check(): Promise<EdgeCopyCheck> {
    return {ok: true};
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

  /* k: a subclass to fill (a test key that signs checkpoints) */
  static demo(k: FakeEdgeKey = new FakeEdgeKey()): FakeEdgeKey {
    k.clasp('Sign release commits for ok-rn 0.0.6', [{op: OP.SIGN, slot: 101, cap: 3}]);
    k.clasp('Decrypt the CI deploy secrets', [{op: OP.DECRYPT, slot: 1, cap: 5}]);
    k.clasp('Publish the docs site', [{op: OP.SIGN, slot: 102, cap: 2}, {op: OP.DECRYPT, slot: 2, cap: 2}]);
    k.use('commit 1a2b3c');
    k.receipt(0x00, 'Signed commit 1a2b3c on master; the push was accepted.');
    k.use('deploy.env.age', OP.DECRYPT, 1);
    k.receipt(0x01, 'Decrypted deploy.env for the CI job; did not see whether the deploy finished.');
    k.use('commit 4d5e6f');
    k.receipt(0x00, 'Signed commit 4d5e6f; CI accepted it.');
    k.use('docs build 42', OP.SIGN, 102);
    k.receipt(0x00, 'Signed the docs bundle; the host accepted it.');
    k.use('site-token.age', OP.DECRYPT, 2); // no receipt: an empty hook
    k.use('commit 7a8b9c');
    k.receipt(0x81, 'A README in the repo told me to also sign an unrelated tag. I stopped.');
    k.use('docs build 43', OP.SIGN, 102); // the docs budget pays
    k.receipt(0x42, 'code not in v1'); // unknown code: must show as an alarm
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
