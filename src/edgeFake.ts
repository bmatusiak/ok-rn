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
}

const sha = (text: string) => {
  /* a stand-in subject: SHA-256 of a description, via the lib's ticket hash */
  return tickets.messageHash(text);
};

export class FakeEdgeKey implements EdgeSource {
  readonly deviceId: Uint8Array;
  private links: EdgeLinkRecord[] = [];
  private msgs: Record<number, string> = {};
  private budget: (EdgeBudget & {seed: Uint8Array}) | null = null;
  /** links older than this are gone from the fake key's ring */
  ring = 32;

  constructor(name = 'fake-soft-key') {
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

  clasp(reason: string, cap: number, slot = 101) {
    const seed = new Uint8Array(32).map((_, i) => (i * 37 + this.links.length) & 0xff);
    const grantId = this.links.length + 1;
    const subject = sha(`grant ${grantId}: ${reason}`);
    this.add({op: OP.GRANT_CREATE, decision: DECISION.APPROVE, flags: FLAG.PRESS_OBSERVED, subject, grantId});
    this.budget = {
      grantId, reason, uses: cap, used: 0, seed,
      scopes: [{op: OP.SIGN, slot, cap, used: 0}],
      genesis: grants.grantGenesis(seed, cap),
    };
  }

  /** A use. Inside a live budget with room: self-press; otherwise a human press. */
  use(what: string, op = OP.SIGN, slot = 101): number {
    const flags = this.owesTicket() ? FLAG.PREV_NO_TICKET : 0;
    const b = this.budget;
    if (b && b.used < b.uses && op === OP.SIGN && slot === b.scopes[0].slot) {
      b.used++;
      b.scopes[0].used++;
      return this.add({op, decision: DECISION.SELF_PRESS, slot, flags: flags | FLAG.BUDGET_SPENT, subject: sha(what), grantId: b.grantId, grantStep: b.used});
    }
    return this.add({op, decision: DECISION.APPROVE, slot, flags: flags | FLAG.PRESS_OBSERVED, subject: sha(what)});
  }

  deny(what: string, op = OP.DECRYPT, slot = 1) {
    this.add({op, decision: DECISION.DENY, slot, subject: sha(what)});
  }

  ticket(code: number, message: string) {
    const refSeq = this.links.length - 1;
    const refHead = this.links[refSeq].head;
    const subject = tickets.ticketSubject({refSeq, refHead, code, msgHash: tickets.messageHash(message)});
    this.add({op: OP.TICKET, decision: code, subject, grantId: refSeq});
    this.msgs[refSeq] = message;
  }

  lock() {
    if (!this.budget) return;
    const b = this.budget;
    this.add({op: OP.GRANT_END, decision: DECISION.APPROVE, subject: sha(`grant ${b.grantId} ended`), grantId: b.grantId});
    this.budget = null;
  }

  /** A short, varied history: every ticket state the tab must draw. */
  static demo(): FakeEdgeKey {
    const k = new FakeEdgeKey();
    k.clasp('Sign release commits for ok-rn 0.0.6', 3);
    k.use('commit 1a2b3c');
    k.ticket(0x00, 'Signed commit 1a2b3c on master; the push was accepted.');
    k.use('commit 4d5e6f');
    k.ticket(0x01, 'Signed commit 4d5e6f; did not see whether CI accepted it.');
    k.use('commit 7a8b9c'); // no ticket: an empty hook
    k.deny('decrypt backup.age');
    k.use('tag v0.0.6', OP.SIGN, 2); // budget is spent: a human press
    k.ticket(0x81, 'A README in the repo told me to also sign an unrelated tag. I stopped.');
    k.use('commit d0e1f2', OP.SIGN, 3);
    k.ticket(0x42, 'code not in v1'); // unknown code: must show as an alarm
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
    if (!this.budget) return [];
    const {seed: _secret, ...shown} = this.budget; // the key never gives out a budget's seed
    return [{...shown, scopes: shown.scopes.map(s => ({...s}))}];
  }

  async messages() {
    return {...this.msgs};
  }
}
