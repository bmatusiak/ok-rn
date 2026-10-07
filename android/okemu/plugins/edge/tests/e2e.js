/**
 * edge's on-device tests (ok-rn e2e, the Pixel soft key), SIDE-LOADED: ok-rn's
 * stager copies this file into src/generated/plugins/ when the build staged
 * OKEMU_PLUGINS=edge, and the softKeyPlugins suite registers it.
 *
 * The same story as tests/kit.test.js, on the phone, through the app's own
 * library stack (app.edge = node-onlykey-lib/plugins/edge): every link, the
 * budget's opening, the reveals and the chain are checked by the library.
 *
 * A use owes a ticket when it was ARMed, or when a live budget covers its op
 * and slot (onlykey-edge firmware.md R16; the key sets bits 4/5 of the link at
 * decision time). Nothing automatic happens while one is owed (R18): a test
 * that opens a budget first clears what earlier ones left owed, with a pressed
 * WAIVE.
 *
 * Everything from the app comes in through `ctx` (no relative imports into
 * ok-rn): getOnlyKey, OkEmu, IFACE, protocol, PIN, pressDigits, lib (edge,
 * hmacSha256), edgeCopy.
 *
 * THE TAB'S COPY STAYS CURRENT (Brad, 2026-10-03). This suite runs on the
 * phone's own soft key, so the links it makes are links of THAT chain: left
 * out of the Edge tab's copy, they pass the key's ring of 8 and the copy can
 * never verify again (a gap #0-#87 had to be accepted as lost). So app.edge
 * here is wrapped (tracked): every call that writes a link syncs the copy
 * after it, every budget opened is kept like one the tab approved, the first
 * test refuses to start on a copy that does not verify, and the last test
 * fails if the run left it unverifiable.
 */
'use strict';

const OKSIGN = 0x80 | 0x6d;
const OP_SIGN = 1;
const APPROVE = 1;
const SELF_PRESS = 4;
const PRESS_OBSERVED = 0x01;
const OWES_TICKET = 0x10; /* R16: the key decided this use owes a ticket */
const ARMED = 0x20;       /* R16: an arm was waiting when the request was primed */
const OP_GRANT_CREATE = 6;

module.exports = function register({it}, ctx) {
  const {chain, grants, tickets} = ctx.lib.edge;
  /*
   * R11a: agent sign 222 is a DERIVED code, shared by every P-256 identity, so
   * a budget on it names one. These tests use their own TEST identity: its
   * label is what every agent request here carries, and no real identity
   * (Brad's own logins) is ever covered by a test budget.
   */
  const E2E_IDENTITY = 'ssh://okrn-e2e@test';
  const hex = (b) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  /* SHA-256 of bytes, or of text as UTF-8 (tickets.messageHash hashes TEXT only) */
  const sha256 = (x) => (typeof x === 'string' ? tickets.messageHash(x) : ctx.lib.sha256(x));
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  async function ready(log) {
    if (!ctx.OkEmu.isRunning()) await ctx.OkEmu.start();
    const app = await ctx.getOnlyKey();
    const state = await app.device.connect();
    if (!/UNLOCKED/i.test(String(state.status))) {
      await app.device.unlock(ctx.PIN, {timeoutMs: 20000, enterDigits: ctx.pressDigits({log})});
      await app.device.connect();
    }
    return tracked(app);
  }

  /*
   * The app, with an edge whose link-writing calls keep the tab's copy current
   * (the header). The app's own edge service is not touched: the wrapper is a
   * view over it. grant() takes the reason TEXT (reason), as the tab keeps it.
   */
  function tracked(app) {
    const edge = Object.create(app.edge);
    const after = (name) => async (...args) => {
      const r = await app.edge[name](...args);
      await ctx.edgeCopy.sync();
      return r;
    };
    for (const name of ['ticket', 'revoke', 'waive', 'hold', 'resume', 'agentAdd', 'loss']) edge[name] = after(name);
    edge.grant = async ({reason, ...o}) => {
      const g = await app.edge.grant({...o, reasonHash: sha256(reason)});
      await ctx.edgeCopy.keep(g, {reason, scopes: o.scopes, lifetime: o.ttlMinutes ?? 0});
      await ctx.edgeCopy.sync();
      return g;
    };
    const view = Object.create(app);
    view.edge = edge;
    return view;
  }

  /*
   * An agent-derived P-256 sign (OKSIGN code 222), through the library's own
   * okcrypto.agent.sign - which reads the key's whole reply. A hand-rolled
   * write left reports on the bus that the next request took as its answer
   * (a HEAD once named link 0xB1790C02). `press`: the soft key's own button,
   * once the confirmation is primed.
   */
  /* the bytes of an agent sign (message || identity hash): what the firmware primes, so what an ARM is for (R13a) */
  const agentRequest = (text) => {
    const message = sha256(`okrn edge ${text} ${Date.now()}`);
    const identity = grants.identityLabel(E2E_IDENTITY); /* R11a: the test identity's label - never a real one */
    return {message, identity, payload: new Uint8Array([...message, ...identity])};
  };
  /* R13a: ARM with the token over this head and the library's requestSubject of these bytes */
  const armFor = (app, head, req) => app.edge.arm(head, grants.requestSubject(req.payload));

  async function agentSign(app, text, {press = false, req = agentRequest(text)} = {}) {
    const {message, identity} = req;
    const timer = press ? setTimeout(() => { ctx.OkEmu.pressQueue('1'); }, 1500) : null;
    try {
      await app.okcrypto.agent.sign(identity, message, {keyType: 2, version: 2});
    } finally {
      if (timer) clearTimeout(timer);
    }
    return {payload: new Uint8Array([...message, ...identity]), message, identity};
  }

  /* the soft key's own button, a moment after the key starts waiting for it */
  const pressSoon = () => { setTimeout(() => { ctx.OkEmu.pressQueue('1'); }, 1200); };

  /* the name of the EdgeError a call ends in (null when it succeeds) - the harness has no assert.rejects */
  const refusal = (p) => p.then(() => null, (e) => e.status || String(e.message || e));

  /* clear whatever is owed: a pressed WAIVE (R18) */
  async function clearDebts(app, log) {
    const h = await app.edge.head();
    if (!h.owed && !h.overflow) return;
    await app.edge.waive({onPress: pressSoon});
    log(`waived ${h.owed} owed${h.overflow ? ' + overflow' : ''}`);
  }

  /* the decision is linked: the head moves past `seq` (polled, not slept) */
  async function headPast(app, seq, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const h = await app.edge.head();
      if (h.seq !== null && (seq === null || h.seq > seq)) {
        await ctx.edgeCopy.sync(); /* the sign's link, into the tab's copy */
        return h;
      }
      if (Date.now() > deadline) throw new Error(`the key did not link the decision (head still #${h.seq})`);
      await sleep(300);
    }
  }

  it('edge: the soft key answers Edge; its chain starts at the library\'s genesis', async ({log, assert}) => {
    const app = await ready(log);
    assert.equal(await app.edge.probe(), 'edge');
    const {deviceId} = await app.edge.publicKey();
    const h = await app.edge.head();
    log(`device ${Array.from(deviceId, b => b.toString(16).padStart(2, '0')).join('')}, head #${h.seq}, live ${JSON.stringify(h.live)}`);
    /*
     * A key restored from a backup refuses budgets and forgets the links
     * after the backup until the restore is finished (R26). Seen 2026-10-03
     * after restoring the A13's backup on the Pixel: three tests failed with
     * "finish the restore in the app first" and "no longer holds that link".
     * One clear line instead.
     */
    assert.ok(!h.restoring, 'the key is restoring from a backup - finish it on the phone first (Edge tab -> Restore card -> Finish the restore), then run again');
    await ctx.edgeCopy.sync();
    const copy = await ctx.edgeCopy.check();
    assert.ok(copy.ok, `the Edge tab's copy does not verify before the run (${copy.reason}${copy.seq !== undefined ? ` at #${copy.seq}` : ''}) - settle it on the Edge tab first; this suite would only add to it`);
    if (h.seq === null) {
      assert.equal(chain.verify([], {deviceId, expectHead: {seq: -1, head: h.head}}).ok, true, 'an empty chain\'s head is not the genesis');
    }
  });

  /* one pressed agent sign, linked and picked up: {signed, after, f, l} */
  async function pressedUse(app, text, log) {
    const before = await app.edge.head();
    const signed = await agentSign(app, text, {press: true});
    const after = await headPast(app, before.seq);
    const [l] = await app.edge.pickup(after.seq, 1);
    const f = chain.decodeLink(l.link);
    log(`#${f.seq} op ${f.op} decision ${f.decision} flags ${f.flags} slot ${f.slot}`);
    return {before, signed, after, f, l};
  }

  /*
   * BUDGET OR NO GO (spec session, 2026-10-06): an ordinary press is not Edge -
   * no link, nothing owed, budget or not. A sign that is not the announced one
   * (R13a) or whose budget was held in between is REFUSED, never prompted.
   */
  it('edge: an ordinary press writes no link and owes nothing; a sign that is not the announced one, or whose budget went on hold, is refused (R13a)', async ({log, assert}) => {
    const app = await ready(log);
    await clearDebts(app, log);

    const h0 = await app.edge.head();
    await agentSign(app, 'ordinary', {press: true});
    const h1 = await app.edge.head();
    assert.equal(h1.seq, h0.seq, 'an ordinary press wrote a link');
    assert.equal(h1.owed, 0, 'an ordinary press owes a ticket');

    /* a live budget covering the slot changes nothing for an ordinary press */
    const g = await app.edge.grant({scopes: [{op: OP_SIGN, slot: 222, cap: 2, identity: E2E_IDENTITY}], reason: 'okrn e2e: budget or no go', verifiedHead: h1.head, onPress: pressSoon});
    const h2 = await app.edge.head();
    await agentSign(app, 'ordinary under a budget', {press: true});
    const h3 = await app.edge.head();
    assert.equal(h3.seq, h2.seq, 'a press under a live budget wrote a link');
    assert.equal(h3.owed, 0, 'a press under a live budget owes a ticket');

    /* announced one request, sent another: refused (EDGE:1C), no link, counted */
    await armFor(app, h3.head, agentRequest('the announced one'));
    const other = await refusal(agentSign(app, 'not the announced one'));
    log(`not the announced one: ${other}`);
    assert.ok(/EDGE:1C/i.test(String(other)), `the sign that was not announced was not refused (${other})`);
    const h4 = await app.edge.head();
    assert.equal(h4.seq, h3.seq, 'the refused sign wrote a link');
    assert.equal(h4.refusedArms, h3.refusedArms + 1, 'the refused sign was not counted');

    /* announced, then the budget held before the sign: refused (EDGE:0D), never a press prompt */
    const req = agentRequest('held in between');
    await armFor(app, h4.head, req);
    assert.equal(await app.edge.hold(g.grantId), true);
    const h5 = await app.edge.head(); /* the hold is a link */
    const held = await refusal(agentSign(app, 'held in between', {req}));
    log(`held in between: ${held}`);
    assert.ok(/EDGE:0D/i.test(String(held)), `the sign after a hold was not refused (${held})`);
    assert.equal((await app.edge.head()).seq, h5.seq, 'the refused sign wrote a link');
    assert.equal(await app.edge.revoke(g.grantId), true);
  });

  it('edge: a budget opened by a press pays ARMed uses, each ticketed, and is revoked', async ({log, assert}) => {
    const app = await ready(log);
    await clearDebts(app, log);
    const {publicKey, deviceId} = await app.edge.publicKey();
    const before = await app.edge.head();
    const scopes = [{op: OP_SIGN, slot: 222, cap: 2, identity: E2E_IDENTITY}];
    const reason = 'okrn e2e: sign two agent messages';
    const reasonHash = sha256(reason);

    /* GRANT_CREATE waits for the PHYSICAL press - on the soft key, its own button */
    /* the raw call: this test is the host, and passes the head it read (R27; the tab goes through grants.create) */
    const g = await app.edge.grant({scopes, reason, verifiedHead: (await app.edge.head()).head, onPress: pressSoon});
    log(`budget ${g.grantId}: ${g.uses} uses, opened at #${g.seq}`);
    const [opened] = await app.edge.pickup(g.seq, 1);
    const prevHead = before.seq === null ? chain.genesis(deviceId) : (await app.edge.pickup(before.seq, 1))[0].head;
    const opening = grants.verifyBudgetOpening({
      deviceId, publicKey, link: opened.link, prevHead, head: g.checkpoint.head, signature: g.checkpoint.signature,
      scopes, reasonHash, genesis: g.genesis, uses: g.uses,
    });
    assert.ok(opening.ok, `the budget's opening does not verify: ${opening.reason}`);
    assert.equal(chain.decodeLink(opened.link).op, OP_GRANT_CREATE);
    assert.ok((await app.edge.head()).live.includes(g.grantId), 'HEAD does not list the budget as live');

    /* grant -> arm -> use -> ticket -> arm -> use -> ticket: no press, self-press links with their reveals */
    const spends = [];
    let armHead = g.checkpoint.head;
    for (let i = 1; i <= 2; i++) {
      const seq0 = (await app.edge.head()).seq;
      const req = agentRequest(`budget ${i}`);
      assert.equal(await armFor(app, armHead, req), true);
      const sent = await agentSign(app, `budget ${i}`, {req}); /* no press: the budget pays */
      const payload = sent.payload;
      const h = await headPast(app, seq0);
      const [l] = await app.edge.pickup(h.seq, 1);
      const f = chain.decodeLink(l.link);
      assert.equal(f.decision, SELF_PRESS, `use ${i} should be a self-press`);
      assert.equal(f.grantStep, i);
      const subject = sha256(payload);
      assert.equal(hex(f.subject), hex(grants.requestSubject(payload)), `use ${i}: the firmware's subject is not the library's requestSubject`);
      spends.push({step: i, value: l.reveal, subject, mac: null});
      armHead = (await app.edge.ticket(h.seq, 0x00, sha256(`okrn e2e: did as asked ${i}`))).head;
    }
    /* used up: nothing left to arm */
    assert.equal(await refusal(armFor(app, armHead, agentRequest('used up'))), 'nothing-to-arm');
    assert.ok(spends.every(s => s.value), 'a self-press came back without its reveal');
    for (const s of spends) {
      const r = grants.checkSelfPress({genesis: g.genesis, uses: g.uses, step: s.step, value: s.value, subject: s.subject,
        mac: ctx.lib.hmacSha256(s.value, s.subject)});
      assert.ok(r.ok, `step ${s.step}: ${r.reason}`);
    }

    assert.equal(await app.edge.revoke(g.grantId), true);
    assert.ok(!(await app.edge.head()).live.includes(g.grantId), 'a revoked budget is still live');
  });

  it('edge: a held budget arms nothing until a pressed resume', async ({log, assert}) => {
    const app = await ready(log);
    await clearDebts(app, log);
    const g = await app.edge.grant({scopes: [{op: OP_SIGN, slot: 222, cap: 1, identity: E2E_IDENTITY}], reason: 'okrn e2e: hold', verifiedHead: (await app.edge.head()).head, onPress: pressSoon});
    assert.equal(await app.edge.hold(g.grantId), true);
    let h = await app.edge.head();
    assert.equal(JSON.stringify(h.held), JSON.stringify([g.grantId]), 'HEAD does not report the hold');
    assert.equal(await refusal(armFor(app, h.head, agentRequest('held'))), 'nothing-to-arm');
    assert.equal(await app.edge.resume(g.grantId, {verifiedHead: (await app.edge.head()).head, onPress: pressSoon}), true);
    h = await app.edge.head();
    assert.equal(JSON.stringify(h.held), JSON.stringify([]));
    assert.equal(await armFor(app, h.head, agentRequest('resumed')), true);
    assert.equal(await app.edge.revoke(g.grantId), true);
  });

  /*
   * Last: the suite leaves no budget open on the real soft key (owner,
   * 2026-10-03 - these tests open budgets on agent slot 222, and a budget
   * there covers every derived P-256 identity while it lives).
   */
  it('edge: no budget is left live when the suite ends', async ({log, assert}) => {
    const app = await ready(log);
    const h = await app.edge.head();
    log(`head #${h.seq}, live ${JSON.stringify(h.live)}, held ${JSON.stringify(h.held)}, owed ${h.owed}`);
    assert.equal(JSON.stringify(h.live), '[]', 'a test budget is still live');
  });

  it('edge: the Edge tab\'s copy still verifies after the run - every link the suite made is in it', async ({log, assert}) => {
    await ready(log);
    const view = await ctx.edgeCopy.sync();
    const copy = await ctx.edgeCopy.check();
    log(`copy: ${JSON.stringify(view.verdict)}`);
    assert.ok(copy.ok, `the run left the tab's copy unverifiable (${copy.reason}${copy.seq !== undefined ? ` at #${copy.seq}` : ''})`);
    assert.equal(view.verdict.kind, 'verified', `the tab shows ${view.verdict.kind}, not verified`);
  });
};
