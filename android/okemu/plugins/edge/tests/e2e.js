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
 * ok-rn): getOnlyKey, OkEmu, IFACE, protocol, PIN, pressDigits, lib (edge, hmacSha256).
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
    return app;
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
    const identity = sha256('okrn edge identity');
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
      if (h.seq !== null && (seq === null || h.seq > seq)) return h;
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

  it('edge: a pressed sign becomes a link the library verifies; it owes its ticket only on a covered slot (R16)', async ({log, assert}) => {
    const app = await ready(log);
    await clearDebts(app, log);

    /* no budget covers agent sign 222: the person pressed, the person saw it - nothing owed */
    const free = await pressedUse(app, 'uncovered', log);
    assert.equal(free.f.op, OP_SIGN);
    assert.equal(free.f.decision, APPROVE);
    assert.equal(free.f.flags & (PRESS_OBSERVED | OWES_TICKET | ARMED), PRESS_OBSERVED, 'the uncovered pressed use is not "pressed, owes nothing, not armed"');
    assert.equal(hex(free.f.subject), hex(sha256(free.signed.payload)), 'the subject is not SHA-256 of what was submitted');
    if (free.before.seq !== null) {
      const [prev] = await app.edge.pickup(free.before.seq, 1);
      const r = chain.verify([free.l], {fromSeq: free.after.seq, fromHead: prev.head, expectHead: {seq: free.after.seq, head: free.after.head}});
      assert.ok(r.ok, `the library rejects the link: ${JSON.stringify(r.failure)}`);
    }
    assert.equal(free.after.owed, 0, 'a direct press on a slot no budget covers owes a ticket');

    /* a held budget covers the slot (hold stops paying, not owing): the pressed use owes, bit 4 set, bit 5 clear */
    const g = await app.edge.grant({scopes: [{op: OP_SIGN, slot: 222, cap: 1}], reasonHash: sha256('okrn e2e: cover'), verifiedHead: (await app.edge.head()).head, onPress: pressSoon});
    assert.equal(await app.edge.hold(g.grantId), true);
    const owing = await pressedUse(app, 'covered', log);
    assert.equal(owing.f.flags & (PRESS_OBSERVED | OWES_TICKET | ARMED), PRESS_OBSERVED | OWES_TICKET, 'the covered pressed use is not "pressed, owes, not armed"');
    assert.equal(owing.after.owed, 1, 'the pressed use on a covered slot owes nothing');
    /* its ticket answers with the head after it */
    const t = await app.edge.ticket(owing.after.seq, 0x00, sha256('okrn e2e: pressed'));
    const now = await app.edge.head();
    assert.equal(t.seq, now.seq, 'the ticket reply is not the seq HEAD reports');
    assert.equal(now.owed, 0);
    assert.equal(await app.edge.revoke(g.grantId), true);
  });

  it('edge: a budget opened by a press pays ARMed uses, each ticketed, and is revoked', async ({log, assert}) => {
    const app = await ready(log);
    await clearDebts(app, log);
    const {publicKey, deviceId} = await app.edge.publicKey();
    const before = await app.edge.head();
    const scopes = [{op: OP_SIGN, slot: 222, cap: 2}];
    const reasonHash = sha256('okrn e2e: sign two agent messages');

    /* GRANT_CREATE waits for the PHYSICAL press - on the soft key, its own button */
    /* the raw call: this test is the host, and passes the head it read (R27; the tab goes through grants.create) */
    const g = await app.edge.grant({scopes, reasonHash, verifiedHead: (await app.edge.head()).head, onPress: pressSoon});
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
    const g = await app.edge.grant({scopes: [{op: OP_SIGN, slot: 222, cap: 1}], reasonHash: sha256('okrn e2e: hold'), verifiedHead: (await app.edge.head()).head, onPress: pressSoon});
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
};
