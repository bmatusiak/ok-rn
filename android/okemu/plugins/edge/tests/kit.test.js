'use strict';
/*
 * edge's emulator tests (the onlykey-testing kit), SIDE-LOADED from this folder
 * by 01-protocol/38-softkey-plugins.test.js when the emulator was built with
 * OKEMU_PLUGINS=edge.
 *
 * The firmware is a notary (DESIGN.md section 0); the truth is the LIBRARY's
 * reading of what it writes (node-onlykey-lib/edge, through ctx.requireLib -
 * the kit's own pinned lib): every link, weld, budget signature, reveal,
 * ticket, waive and checkpoint must check out there. The rules are
 * onlykey-edge/build/firmware.md's; verification row 5 lists what these prove.
 *
 * Every approved use owes a ticket (R16) and nothing automatic happens while
 * one is owed (R18), so a test that opens a budget first clears what earlier
 * tests left owed - with a pressed WAIVE, the same way out a person has.
 *
 * Everything from the kit comes through ctx: IFACE, okmsg, PINS, requireLib.
 */
const crypto = require('crypto');

const OKEDGE = 0x80 | 0x78;
const HEAD = 0x01;
const PICKUP = 0x02;
const CHECKPOINT = 0x03;
const PUBKEY = 0x04;
const VOUCH = 0x05;
const GRANT_CREATE = 0x10;
const GRANT_REVOKE = 0x12;
const GRANT_HOLD = 0x13;
const GRANT_RESUME = 0x14;
const TICKET = 0x20;
const WAIVE = 0x21;
const ARM = 0x22;
const REPLAY = 0x23;
const REPLAY_DONE = 0x24;
const SEQ_NONE = 0xffffffff;
/* lib codes.js */
const OP_SIGN = 1;
const OP_DECRYPT = 2;
const OP_GRANT_CREATE = 6;
const OP_TICKET = 8;
const OP_GRANT_HOLD = 13;
const OP_GRANT_RESUME = 14;
const APPROVE = 1;
const TIMEOUT = 3;
const SELF_PRESS = 4;
const NEEDS_REVIEW = 0x8f;
const PRESS_OBSERVED = 0x01;
const PREV_NO_TICKET = 0x04;
/* the console line that says a confirmation is primed (14-stored-keys uses it too) */
const PRIMED = /Encrypted Buffer/g;
const P256_SPKI = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

module.exports = function register({ it }, ctx) {
  const { chain, grants, tickets } = ctx.requireLib('node-onlykey-lib/edge');
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

  /* collect every report since `since` until there are `reports` of them */
  async function collect(device, since, reports, { signal }) {
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const deadline = Date.now() + 6000;
    let got = device.reportsSince(ctx.IFACE.VENDOR, since);
    while (got.length < reports && Date.now() < deadline) {
      await device.sleep(50, { signal });
      got = device.reportsSince(ctx.IFACE.VENDOR, since);
    }
    return got;
  }

  /* send an OKEDGE sub-op and collect EVERY report since (several come back to back) */
  async function edge(device, sub, args, { signal, reports = 1, text = false, press = false }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKEDGE, slot: sub, payload: args || Buffer.alloc(0) });
    if (press) {
      /* the physical press a grant, resume or waive waits for */
      await device.sleep(800, { signal });
      device.press(1);
    }
    const got = await collect(device, since, reports, { signal });
    if (text) return ctx.okmsg.text(got[0]).trim();
    for (const r of got) {
      const t = ctx.okmsg.text(r);
      if (/^EDGE:(?!00)/.test(t)) throw new Error(`the key refused OKEDGE ${sub}: ${t.trim()}`);
    }
    if (got.length < reports) throw new Error(`OKEDGE ${sub}: ${got.length} of ${reports} reports`);
    return got.slice(0, reports).map((r) => Buffer.from(r));
  }

  /* the device id is edge JS's to compute: SHA256("OKEDGE-DEVICE-v1" || the Edge public key)[0..16] */
  const deviceIdOf = (pub) => new Uint8Array(sha256(Buffer.concat([Buffer.from('OKEDGE-DEVICE-v1'), Buffer.from(pub)])).subarray(0, 16));

  /* HEAD: seq . head . oldest pickable seq . the live budget ids . held mask . owed . overflow */
  async function head(device, opts) {
    const [r] = await edge(device, HEAD, null, opts);
    const ids = [0, 1, 2, 3].map((i) => r.readUInt32LE(40 + 4 * i));
    return {
      seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)), oldest: r.readUInt32LE(36),
      live: ids.filter(Boolean), held: ids.filter((id, i) => id && (r[56] >> i) & 1), owed: r[57], overflow: r[58], restoring: r[59],
    };
  }

  /* TICKET and WAIVE answer seq . head - what the next ARM passes (R13a) */
  const seqHead = (r) => ({ seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)) });

  async function ticket(device, ref, msg, opts) {
    const [r] = await edge(device, TICKET, Buffer.concat([u32(ref), Buffer.from([0x00]), sha256(Buffer.from(msg))]), opts);
    return seqHead(r);
  }

  /*
   * R13a: ARM carries the token SHA256("OKEDGE-ARM-v1" || head || subject),
   * subject = the LIBRARY's requestSubject of exactly the bytes the request
   * will submit. Whether the firmware agrees - its pend.subject, hashed from
   * what it primes - is what the per-op test below proves.
   */
  const armFor = (device, headBytes, payload, opts) =>
    edge(device, ARM, Buffer.from(grants.armToken({ head: headBytes, subject: grants.requestSubject(new Uint8Array(payload)) })), { ...opts, text: true });

  /* clear whatever earlier tests left owed: a pressed WAIVE (R18) */
  async function clearDebts(device, { signal, log }) {
    const h = await head(device, { signal });
    if (!h.owed && !h.overflow) return;
    await edge(device, WAIVE, null, { signal, press: true });
    if (log) log(`waived ${h.owed} owed${h.overflow ? ' + overflow' : ''} left by earlier tests`);
  }

  /*
   * GRANT_CREATE (firmware.md R27 layout): [0] scope count, [1..16] scopes,
   * [17..48] reason hash, [49] flags, [50..51] lifetime (u16 LE minutes, R15b;
   * 0 = the key's 12 h), [52..57] the first 6 bytes of the head the host
   * verified. `verified` is the key's current head - this test is the host,
   * and checks the chain itself. `scopes`: a cap (agent P-256 sign 222) or a list.
   */
  const scopesOf = (scopes) => (typeof scopes === 'number' ? [{ op: OP_SIGN, slot: 222, cap: scopes }] : scopes);
  function grantRequest(scopes, reasonHash, verified, lifetime = 0) {
    const req = Buffer.alloc(58);
    Buffer.from(grants.encodeScopes(scopesOf(scopes))).copy(req, 0);
    reasonHash.copy(req, 17);
    req.writeUInt16LE(lifetime, 50);
    Buffer.from(verified).copy(req, 52, 0, 6);
    return req;
  }

  /* ... with its press -> {grantId, uses, G, chainSeq, ckpt, sig} */
  async function openBudget(device, scopes, reason, { signal, lifetime = 0 }) {
    const reasonHash = sha256(Buffer.from(reason));
    const req = grantRequest(scopes, reasonHash, (await head(device, { signal })).head, lifetime);
    const [g, ckpt, s] = await edge(device, GRANT_CREATE, req, { signal, press: true, reports: 3 });
    return {
      grantId: g.readUInt32LE(0), uses: g.readUInt16LE(4), G: new Uint8Array(g.subarray(6, 38)),
      chainSeq: g.readUInt32LE(38), ckpt, sig: new Uint8Array(s.subarray(0, 64)), reasonHash,
    };
  }

  /* a checkpoint (seq, head) is the Edge key's signature (lib chain checkpoint digest, R7) */
  function checkpointVerifies(pub, seq, headBytes, sig) {
    const message = Buffer.concat([Buffer.from('OKEDGE-CKPT-v1'), Buffer.from(deviceIdOf(pub)), u32(seq), Buffer.from(headBytes)]);
    const key = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), Buffer.from(pub)]), format: 'der', type: 'spki' });
    return crypto.verify('sha256', message, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig).subarray(0, 64));
  }

  /* PICKUP: per link the link, then its head and (for a self-press) the reveal */
  async function pickup(device, from, count, opts) {
    const rs = await edge(device, PICKUP, Buffer.concat([u32(from), Buffer.from([count])]), { ...opts, reports: count * 2 });
    const out = [];
    for (let i = 0; i < rs.length; i += 2) {
      out.push({ link: new Uint8Array(rs[i]), head: new Uint8Array(rs[i + 1].subarray(0, 32)), reveal: new Uint8Array(rs[i + 1].subarray(32, 64)) });
    }
    return out;
  }

  async function pubkey(device, opts) {
    const [r] = await edge(device, PUBKEY, null, opts);
    return new Uint8Array(r.subarray(0, 64));
  }

  /* an agent-derived P-256 sign's bytes (OKSIGN code 222): message || identity hash */
  const agentPayload = (text) => Buffer.concat([sha256(Buffer.from(text)), sha256(Buffer.from('okt edge identity'))]);

  /* any request, in 57-byte chunks: 0xFF while more follows, the last chunk's length on the last */
  function sendChunked(device, msg, slot, payload) {
    for (let i = 0; i < payload.length; i += 57) {
      const chunk = payload.subarray(i, i + 57);
      device.sendVendor({ msg, slot, field: chunk.length < 57 ? chunk.length : 0xff, payload: chunk });
    }
    return payload;
  }
  const sendAgentSign = (device, message) =>
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, Buffer.concat([message, sha256(Buffer.from('okt edge identity'))]));

  /*
   * Wait for the key's head to move past `seq` - the decision is linked. Polled
   * on HEAD rather than slept: a slower host (the Linux VM) takes longer, and a
   * fixed sleep that suits Windows was too short there.
   */
  async function headPast(device, seq, { signal, timeoutMs = 10000 }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const h = await head(device, { signal });
      if (h.seq !== SEQ_NONE && (seq === SEQ_NONE || h.seq > seq)) return h;
      if (Date.now() > deadline) throw new Error(`the key did not link the decision (head still #${h.seq})`);
      await device.sleep(250, { signal });
    }
  }

  /*
   * A sign that waits for a press: press it, once the key is ready for it. The
   * primed console line comes a moment BEFORE the key takes presses (a press
   * that lands first is discarded silently), so wait a little after it.
   */
  async function pressedSign(device, text, { signal, payload: given }) {
    const before = (await head(device, { signal })).seq;
    const primed = device.log.count(PRIMED);
    const payload = given ? sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, given) : sendAgentSign(device, sha256(Buffer.from(text)));
    await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
    await device.sleep(500, { signal });
    device.press(1);
    const h = await headPast(device, before, { signal });
    return { payload, seq: h.seq };
  }

  /* a sign an ARMed budget pays for: no press - the signature comes back and the link is there */
  async function selfPressedSign(device, payload, { signal }) {
    const before = (await head(device, { signal })).seq;
    const since = device.mark(ctx.IFACE.VENDOR);
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const h = await headPast(device, before, { signal });
    return { payload, seq: h.seq };
  }

  /*
   * Pick up every link from `kept`'s end to the key's head. The key holds only
   * its last 8 for pickup, so a long test calls this before 8 new ones pile up.
   */
  async function catchUp(device, kept, from, { signal }) {
    const h = await head(device, { signal });
    let next = kept.length ? chain.decodeLink(kept[kept.length - 1].link).seq + 1 : from;
    while (next <= h.seq) {
      const n = Math.min(8, h.seq - next + 1);
      kept.push(...await pickup(device, next, n, { signal }));
      next += n;
    }
    return h;
  }

  /* everything from `from` to the key's head, verified by the library */
  async function verifyFrom(device, from, fromHead, { signal, assert, log }) {
    const h = await head(device, { signal });
    const links = await pickup(device, from, h.seq - from + 1, { signal });
    const result = chain.verify(links, { fromSeq: from, fromHead, expectHead: { seq: h.seq, head: h.head } });
    if (log) log(`library verdict: ${JSON.stringify({ ok: result.ok, through: result.verifiedThrough, failure: result.failure })}`);
    assert.ok(result.ok, `the library rejects the key's chain: ${JSON.stringify(result.failure)}`);
    return { h, links, fields: links.map((l) => chain.decodeLink(l.link)) };
  }

  const trail = (f) => f.map((x) => `#${x.seq} op ${x.op} dec ${x.decision} flags ${x.flags} grant ${x.grantId} step ${x.grantStep}`).join('; ');

  it('edge: HEAD and the Edge key on a fresh key; the chain starts at the lib\'s genesis',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const deviceId = deviceIdOf(pub);
      log(`seq ${h.seq === SEQ_NONE ? 'none' : h.seq}, device ${Buffer.from(deviceId).toString('hex')}, live ${JSON.stringify(h.live)}, owed ${h.owed}`);
      assert.ok(crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), pub]), format: 'der', type: 'spki' }), 'not a P-256 point');
      if (h.seq === SEQ_NONE) assert.bytes(Buffer.from(h.head), Buffer.from(chain.genesis(deviceId)), 'an empty chain\'s head is not the genesis');
    });

  it('edge: a pressed sign owes a ticket that a timeout does not clear; a late ticket pays it, a second is refused (R16, R17)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;

      const signed = await pressedSign(device, 'okt edge message 1', { signal });
      assert.equal((await head(device, { signal })).owed, 1, 'a human-pressed use owes its ticket too (R16)');
      const primed = device.log.count(PRIMED);
      sendAgentSign(device, sha256(Buffer.from('okt edge message 2')));
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      await device.sleep(23000, { signal }); /* never pressed: the 20 s fade */
      const afterTimeout = await head(device, { signal });
      assert.equal(afterTimeout.owed, 1, 'the timeout cleared the debt');

      /* the ticket is no longer the very next link: any owed use takes it */
      const msg = 'okt: signed message 1';
      const t = await ticket(device, signed.seq, msg, { signal });
      assert.equal(t.seq, afterTimeout.seq + 1, 'the ticket reply is not the ticket link\'s seq');
      const again = await edge(device, TICKET, Buffer.concat([u32(signed.seq), Buffer.from([0]), sha256(Buffer.from(msg))]), { signal, text: true });
      assert.equal(again, 'EDGE:08', 'a second ticket for one use was taken');

      const { h, fields: f, links } = await verifyFrom(device, first, before.head, { signal, assert, log });
      log(trail(f));
      assert.bytes(Buffer.from(t.head), Buffer.from(h.head), 'the ticket reply is not the key\'s head');
      assert.equal(h.owed, 0);
      assert.equal(f[0].op, OP_SIGN);
      assert.equal(f[0].decision, APPROVE);
      assert.ok(f[0].flags & PRESS_OBSERVED, 'a pressed approve carries the press flag');
      assert.bytes(Buffer.from(f[0].subject), sha256(signed.payload), 'the subject is not SHA-256 of what was submitted');
      assert.equal(f[1].decision, TIMEOUT);
      assert.ok(f[1].flags & PREV_NO_TICKET, 'the use after an unticketed one carries the empty hook (R17)');
      assert.equal(f[2].op, OP_TICKET);
      const use = tickets.pairTickets(links, { [signed.seq]: msg }).uses.find((u) => u.seq === signed.seq);
      assert.equal(use.status, 'ticketed');
      assert.equal(use.message, msg, 'the ticket\'s message does not match its link');
    });

  it('edge: a budget signed at a press pays only ARMed uses; an ARM pays for its own request only, and nothing arms while a ticket is owed (R10, R13, R13a, R18)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const pub = await pubkey(device, { signal });

      const b = await openBudget(device, 2, 'okt: sign two test messages', { signal });
      log(`budget ${b.grantId}: ${b.uses} uses, opened at chain #${b.chainSeq}`);
      assert.ok((await head(device, { signal })).live.includes(b.grantId), 'HEAD does not list the new budget as live');

      /*
       * The budget's genesis is signed THROUGH the chain: the press answers with a
       * checkpoint over the grant-create link, and that link's subject commits to G
       *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G || lifetime)
       */
      assert.equal(b.ckpt.readUInt32LE(0), b.chainSeq, 'the checkpoint is not over the grant-create link');
      assert.ok(checkpointVerifies(pub, b.chainSeq, b.ckpt.subarray(4, 36), b.sig), 'the opening checkpoint does not verify');
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      assert.bytes(Buffer.from(chain.weld(before.head, opened.link)), b.ckpt.subarray(4, 36), 'the signed head is not this link welded on');
      const scopesEnc = Buffer.from([1, OP_SIGN, 222, 2, 0]);
      const wantSubject = sha256(Buffer.concat([Buffer.from('OKEDGE-GRANT-v1'), scopesEnc, b.reasonHash, Buffer.from(b.G), Buffer.from([0, 0])]));
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject), wantSubject, 'the grant-create link does not commit to G and the lifetime');

      /* a request that skips ARM is pressed, even with a live budget (R13a) - and owes */
      const kept = [];
      const p0 = await pressedSign(device, 'okt budget message 0', { signal });
      const t0 = await ticket(device, p0.seq, 'okt: 0', { signal });

      /* grant -> arm -> use -> ticket -> arm -> use -> ticket */
      const pl1 = agentPayload('okt budget message 1');
      assert.equal(await armFor(device, t0.head, pl1, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, pl1, { signal });
      assert.equal(await armFor(device, (await head(device, { signal })).head, pl1, { signal }), 'EDGE:0C', 'ARM went through while a ticket was owed (R18)');
      assert.equal(await edge(device, GRANT_CREATE, Buffer.alloc(58, 0).fill(1, 0, 1), { signal, text: true }), 'EDGE:0C', 'a budget opened while a ticket was owed (R10)');
      const t1 = await ticket(device, s1.seq, 'okt: 1', { signal });
      await catchUp(device, kept, b.chainSeq, { signal });

      /*
       * R13a: an ARM pays for ITS request after ITS head, nothing else. A stale
       * head is no longer refused at ARM - the key cannot see it there - it
       * shows at the sign, as a press. Another request after a good ARM is
       * pressed too, and uses the arm up: the agent's own request is then
       * pressed as well. Never a free signature.
       */
      const plStale = agentPayload('okt budget: armed on a stale head');
      assert.equal(await armFor(device, t0.head, plStale, { signal }), 'EDGE:00');
      const stale = await pressedSign(device, null, { signal, payload: plStale });
      const ts = await ticket(device, stale.seq, 'okt: stale', { signal });
      const plMine = agentPayload('okt budget: the request the agent armed for');
      const plOther = agentPayload('okt budget: another program slipped in');
      assert.equal(await armFor(device, ts.head, plMine, { signal }), 'EDGE:00');
      const other = await pressedSign(device, null, { signal, payload: plOther });
      const to = await ticket(device, other.seq, 'okt: other', { signal });
      const mine = await pressedSign(device, null, { signal, payload: plMine });
      const tm = await ticket(device, mine.seq, 'okt: mine, pressed', { signal });
      await catchUp(device, kept, b.chainSeq, { signal });

      const pl2 = agentPayload('okt budget message 2');
      assert.equal(await armFor(device, tm.head, pl2, { signal }), 'EDGE:00');
      const s2 = await selfPressedSign(device, pl2, { signal });
      const t2 = await ticket(device, s2.seq, 'okt: 2', { signal });
      assert.equal(await armFor(device, t2.head, agentPayload('okt budget message 3'), { signal }), 'EDGE:0D', 'ARM went through under a used-up budget');
      void to;
      const kh = await catchUp(device, kept, b.chainSeq, { signal });

      const links = kept;
      const verdict = chain.verify(links, { fromSeq: b.chainSeq, fromHead: before.head, expectHead: { seq: kh.seq, head: kh.head } });
      assert.ok(verdict.ok, `the library rejects the key's chain: ${JSON.stringify(verdict.failure)}`);
      const f = links.map((l) => chain.decodeLink(l.link));
      log(trail(f));
      const at = (seq) => f[seq - b.chainSeq];
      assert.equal(at(b.chainSeq).op, OP_GRANT_CREATE);
      assert.equal(at(b.chainSeq).grantId, b.grantId);
      assert.equal(at(p0.seq).decision, APPROVE, 'an unarmed use under a live budget was not pressed');
      assert.equal(JSON.stringify([at(s1.seq).decision, at(s1.seq).grantId, at(s1.seq).grantStep]), JSON.stringify([SELF_PRESS, b.grantId, 1]));
      assert.equal(JSON.stringify([at(s2.seq).decision, at(s2.seq).grantStep]), JSON.stringify([SELF_PRESS, 2]));
      for (const p of [stale, other, mine]) {
        assert.equal(at(p.seq).decision, APPROVE, `#${p.seq}: a request the arm was not for was not pressed`);
        assert.ok(at(p.seq).flags & PRESS_OBSERVED);
      }

      /* each reveal belongs to G and to what was signed (the MAC is the host's to compute) */
      const spends = [s1, s2].map((s, i) => {
        const value = links[s.seq - b.chainSeq].reveal;
        const subject = new Uint8Array(sha256(s.payload));
        const mac = new Uint8Array(crypto.createHmac('sha256', value).update(subject).digest());
        return { step: i + 1, value, mac, subject };
      });
      assert.equal(JSON.stringify(grants.checkSpends(b.G, b.uses, spends)), '{"ok":true,"spent":2}');
      const paired = tickets.pairTickets(links);
      for (const s of [p0, s1, stale, other, mine, s2]) assert.equal(paired.uses.find((u) => u.seq === s.seq).status, 'ticketed', `use #${s.seq}`);

      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:00');
      assert.ok(!(await head(device, { signal })).live.includes(b.grantId), 'a revoked budget is still listed as live');
    });

  it('edge: a held budget pays for nothing; resume takes a press and waits for owed tickets (R15a)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const b = await openBudget(device, 2, 'okt: hold me', { signal });
      assert.equal(await edge(device, GRANT_HOLD, u32(b.grantId), { signal, text: true }), 'EDGE:00');
      let h = await head(device, { signal });
      assert.equal(JSON.stringify(h.held), JSON.stringify([b.grantId]), 'HEAD does not report the budget on hold');
      assert.equal(await armFor(device, h.head, agentPayload('okt held'), { signal }), 'EDGE:0D', 'ARM went through under a held budget');

      /* while a use owes, resume is refused (R18) */
      const p = await pressedSign(device, 'okt held: pressed', { signal });
      const resumeReq = (headBytes) => Buffer.concat([u32(b.grantId), Buffer.from(headBytes)]);
      assert.equal(await edge(device, GRANT_RESUME, resumeReq((await head(device, { signal })).head), { signal, text: true }), 'EDGE:0C', 'resume went through while a ticket was owed');
      const t = await ticket(device, p.seq, 'okt: held pressed', { signal });

      /* R27: only on the head the host verified */
      assert.equal(await edge(device, GRANT_RESUME, resumeReq(new Uint8Array(32).fill(1)), { signal, text: true }), 'EDGE:0B', 'resume went through on a head the host never verified');
      assert.equal(await edge(device, GRANT_CREATE, grantRequest(1, sha256(Buffer.from('stale')), new Uint8Array(32).fill(1)), { signal, text: true }), 'EDGE:0B', 'a budget opened on a head the host never verified');
      assert.equal(await edge(device, GRANT_RESUME, resumeReq(t.head), { signal, text: true, press: true }), 'EDGE:00');
      h = await head(device, { signal });
      assert.equal(JSON.stringify(h.held), JSON.stringify([]), 'still on hold after the resume');
      assert.equal(await armFor(device, h.head, agentPayload('okt resumed'), { signal }), 'EDGE:00');

      /* from the grant-create link on, welded and checked by the library */
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      const { fields } = await verifyFrom(device, b.chainSeq + 1, opened.head, { signal, assert });
      const ops = fields;
      log(trail(ops));
      const hold = ops.find((x) => x.op === OP_GRANT_HOLD);
      const resume = ops.find((x) => x.op === OP_GRANT_RESUME);
      assert.ok(hold && hold.grantId === b.grantId && !(hold.flags & PRESS_OBSERVED), 'no grant-hold link (or it claims a press)');
      assert.ok(resume && resume.grantId === b.grantId && (resume.flags & PRESS_OBSERVED), 'no pressed grant-resume link');
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  it('edge: WAIVE takes a press; a restart keeps the debts; past 4 owed the waive covers the overflow (R16, R18)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const uses = [];
      for (let i = 0; i < 5; i++) uses.push(await pressedSign(device, `okt waive ${i}`, { signal }));
      let h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.overflow]), '[4,1]', 'five owed uses: the key keeps 4 and the overflow');
      /* picked up now: a restart keeps only the latest link in RAM, as a host's copy would */
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;
      const kept = await pickup(device, first, h.seq - first + 1, { signal });

      /* a restart (lock) does not clear a debt */
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.overflow]), '[4,1]', 'the restart cleared debts');

      /* unpressed, the waive does nothing */
      const primed = device.log.count(PRIMED);
      device.sendVendor({ msg: OKEDGE, slot: WAIVE, payload: Buffer.alloc(0) });
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal }).catch(() => {});
      await device.sleep(23000, { signal });
      h = await head(device, { signal });
      assert.equal(h.owed, 4, 'a waive nobody pressed cleared the debts');

      const [w] = await edge(device, WAIVE, null, { signal, press: true });
      const ws = seqHead(w);
      h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.overflow]), '[0,0]');
      assert.equal(ws.seq, h.seq);

      const links = kept.concat(await pickup(device, ws.seq, 1, { signal }));
      const result = chain.verify(links, { fromSeq: first, fromHead: before.head, expectHead: { seq: h.seq, head: h.head } });
      assert.ok(result.ok, `the library rejects the key's chain: ${JSON.stringify(result.failure)}`);
      const wl = chain.decodeLink(links[links.length - 1].link);
      log(trail([wl]));
      assert.equal(JSON.stringify([wl.op, wl.decision, wl.flags & PRESS_OBSERVED, wl.grantId]), JSON.stringify([OP_TICKET, NEEDS_REVIEW, PRESS_OBSERVED, uses[1].seq]));
      assert.bytes(Buffer.from(wl.subject), Buffer.from(tickets.waiveSubject(uses.slice(1).map((u) => u.seq), true)), 'the waive subject does not list what it waived');
      const paired = tickets.pairTickets(links);
      const st = (s) => paired.uses.find((u) => u.seq === s).status;
      assert.equal(st(uses[0].seq), 'waived-unlisted');
      for (const u of uses.slice(1)) assert.equal(st(u.seq), 'waived', `use #${u.seq}`);
    });

  /*
   * The plugin backup section (DESIGN.md 6; the loader's 0xFB section) and R26,
   * firmware.md verification row 5b. Edge keeps version, seq, head and the owed
   * uses. One backup at head S, two real links after it (the host's copy holds
   * them, each with the key's vouch tag), then three restores from that backup:
   *   1. INVENTED links - a made-up ticket paying the backup's debt and a
   *      made-up "pressed" waive - replay only TENTATIVELY (HEAD does not move);
   *      VOUCH, CHECKPOINT and ARM are refused while restoring; a human press
   *      writes onto the backup's head and closes replay; a forged tag commits
   *      nothing (EDGE:11) and the LOSS covers everything since the backup - the
   *      debt is still owed;
   *   2. a power cut mid-replay leaves the backup's state and restoring; an
   *      OLDER real vouch commits only up to its own point, the LOSS covers the
   *      rest;
   *   3. the whole copy with the newest real vouch commits it all: the newer
   *      links' heads and debts come back, no LOSS.
   */
  it('edge: a restore commits only replayed history the key vouched for - invented links, a power cut, an older vouch, the whole copy (R26)',
    async ({ device, assert, signal, log }) => {
      const { backup } = ctx.kit;
      const PASSPHRASE = 'okt edge backup passphrase 2026-10-02';
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      await pressedSign(device, 'okt edge before the backup', { signal });
      const atBackup = await head(device, { signal });
      assert.equal(atBackup.owed, 1);

      /* a backup key, which takes config mode */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({
        msg: ctx.okmsg.MSG.OKSETPRIV, slot: 131,
        payload: Buffer.concat([Buffer.from([161]), sha256(Buffer.from(PASSPHRASE, 'utf8'))]),
      });
      const set = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.match(ctx.okmsg.text(set), /Successfully set Backup Passphrase/);
      /* a slot label too: the proof on older firmware checks it comes back */
      since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: 2, field: 1, payload: 'edgebkup' });
      const labelled = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.ok(!/Error/.test(ctx.okmsg.text(labelled)), ctx.okmsg.text(labelled));
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });

      /* the backup: hold button 1, the key types it */
      let started = false;
      for (let attempt = 1; attempt <= 6 && !started; attempt++) {
        device.log.clear();
        device.keys.clear();
        device.pressLine([{ button: 1, hold: 'hold' }]);
        started = await Promise.any([
          device.log.waitFor(/Backing up Label Number/, { timeoutMs: 5000, signal }),
          device.waitKeystrokes(/-----BEGIN ONLYKEY BACKUP-----/, { timeoutMs: 5000, signal }),
        ]).then(() => true, () => device.keystrokes.length > 0);
      }
      assert.ok(started, 'the device never started a backup');
      await device.waitKeystrokes(/-----END ONLYKEY BACKUP-----/, { timeoutMs: 180000, signal });
      const parsed = backup.parse(device.keystrokes);
      assert.ok(parsed && parsed.data.length, 'no backup data');
      log(`backup: ${parsed.data.length} bytes, taken at chain #${atBackup.seq}`);
      /*
       * Kept for the older-firmware proof (node-onlykey-emulator
       * test/restore-plugin-backup.js and its stored fixture): the same backup
       * restored onto a v3.0.4 emulator, which has no plugin code at all.
       */
      const keep = require('path').join(require('os').tmpdir(), 'okt-plugin-backup.json');
      require('fs').writeFileSync(keep, JSON.stringify({ passphrase: PASSPHRASE, slot: 2, label: 'edgebkup', data: Buffer.from(parsed.data).toString('hex') }));
      log(`kept for the older-firmware restore: ${keep}`);

      /* two links the backup does not have - the host's copy holds them, each with the key's vouch tag */
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const vouchOf = (r) => ({ seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)), tag: Buffer.from(r.subarray(36, 52)) });
      const l1 = await pressedSign(device, 'okt edge after the backup 1', { signal });
      const v1 = vouchOf((await edge(device, VOUCH, null, { signal }))[0]);
      const l2 = await pressedSign(device, 'okt edge after the backup 2', { signal });
      const v2 = vouchOf((await edge(device, VOUCH, null, { signal }))[0]);
      const lost = await head(device, { signal });
      assert.equal(JSON.stringify([l1.seq, l2.seq, v1.seq, v2.seq]), JSON.stringify([atBackup.seq + 1, atBackup.seq + 2, atBackup.seq + 1, atBackup.seq + 2]));
      const [c1, c2] = await pickup(device, l1.seq, 2, { signal });

      /* the restore - OKRESTORE is taken in config mode (as 10-backup-restore sends it) */
      const restore = async (label) => {
        await device.enterConfigMode(ctx.PINS.primary, { signal });
        const gen = device.generation;
        for (const payload of backup.toRestorePackets(parsed.data)) {
          device.sendVendor({ msg: ctx.okmsg.MSG.OKRESTORE, payload });
          await device.sleep(50, { signal });
        }
        await device.waitForReboot({ from: gen, timeoutMs: 90000, signal });
        await device.waitReady({ signal });
        await device.ensureUnlocked(ctx.PINS.primary, { signal });
        const h = await head(device, { signal });
        log(`${label}: head #${h.seq} owed ${h.owed} restoring ${h.restoring} (backup at #${atBackup.seq})`);
        assert.equal(h.seq, atBackup.seq, `${label}: not back at the backup's head`);
        assert.bytes(Buffer.from(h.head), Buffer.from(atBackup.head));
        assert.equal(h.owed, atBackup.owed, `${label}: the restore changed what is owed`);
        assert.equal(h.restoring, 1, `${label}: HEAD does not say the key is restoring`);
        return h;
      };
      /* REPLAY: 46 link bytes + the first 8 of the head the copy stored after it */
      const replayReq = (link, headBytes) => Buffer.concat([Buffer.from(link).subarray(0, 46), Buffer.from(headBytes).subarray(0, 8)]);
      const replay = (link, headBytes) => edge(device, REPLAY, replayReq(link, headBytes), { signal, text: true });
      const replayDone = (seq, tag, newest, opts = {}) =>
        edge(device, REPLAY_DONE, Buffer.concat([u32(seq), Buffer.from(tag), u32(newest)]), { signal, press: true, ...opts });

      /* ---- 1. invented links ---- */
      let after = await restore('restore 1');
      assert.equal(await edge(device, VOUCH, null, { signal, text: true }), 'EDGE:0E', 'the key vouched while restoring');
      assert.equal(await edge(device, CHECKPOINT, null, { signal, text: true }), 'EDGE:0E', 'the key signed a checkpoint while restoring');
      assert.equal(await armFor(device, after.head, agentPayload('okt restoring'), { signal }), 'EDGE:0E', 'ARM went through while restoring');
      assert.equal(await edge(device, GRANT_CREATE, grantRequest(1, sha256(Buffer.from('r')), after.head), { signal, text: true }), 'EDGE:0E', 'a budget opened while restoring');
      assert.equal(await replay(c2.link, c2.head), 'EDGE:0F', 'a link out of order was replayed');
      assert.equal(await replay(c1.link, new Uint8Array(32).fill(1)), 'EDGE:0F', 'a link that does not weld to the copy\'s head was replayed');
      /* a made-up ticket that pays the backup's debt, and a made-up waive "pressed" by nobody - they weld, as any 64 bytes do */
      const owedSeq = atBackup.seq;
      const fakeTicket = chain.encodeLink({ seq: atBackup.seq + 1, op: OP_TICKET, decision: 0x00, subject: new Uint8Array(32), grantId: owedSeq });
      const fh1 = chain.weld(atBackup.head, fakeTicket);
      const fakeWaive = chain.encodeLink({ seq: atBackup.seq + 2, op: OP_TICKET, decision: NEEDS_REVIEW, flags: PRESS_OBSERVED, grantId: owedSeq, subject: tickets.waiveSubject([owedSeq], false) });
      const fh2 = chain.weld(fh1, fakeWaive);
      assert.equal(await replay(fakeTicket, fh1), 'EDGE:00');
      assert.equal(await replay(fakeWaive, fh2), 'EDGE:00');
      let h = await head(device, { signal });
      assert.equal(JSON.stringify([h.seq, h.owed]), JSON.stringify([atBackup.seq, atBackup.owed]), 'a replay moved the real head or paid a debt before it was vouched');
      /* a human press writes onto the backup's head, throws the tentative replay away and closes replay */
      const own = await pressedSign(device, 'okt edge while restoring', { signal });
      assert.equal(own.seq, atBackup.seq + 1, 'the key\'s own link is not on the backup\'s head');
      assert.equal(await replay(c1.link, c1.head), 'EDGE:10', 'replay stayed open after the key wrote its own link');
      /* and a forged tag commits nothing: EDGE:11, LOSS since the backup */
      assert.equal(await replayDone(atBackup.seq + 2, Buffer.alloc(16, 7), lost.seq, { text: true }), 'EDGE:11', 'a forged vouch was taken');
      h = await head(device, { signal });
      assert.equal(h.restoring, 0, 'still restoring after REPLAY_DONE');
      assert.equal(h.owed, atBackup.owed + 1, 'the invented ticket or waive paid a debt');
      const [loss1] = await pickup(device, h.seq, 1, { signal });
      const fl1 = chain.decodeLink(loss1.link);
      assert.equal(JSON.stringify([fl1.op, fl1.grantId, fl1.flags & PRESS_OBSERVED]), JSON.stringify([11, own.seq + 1, PRESS_OBSERVED]), 'no pressed LOSS link after the unvouched replay');

      /* ---- 2. a power cut mid-replay, then an older real vouch ---- */
      await restore('restore 2');
      assert.equal(await replay(c1.link, c1.head), 'EDGE:00');
      await device.restart({ signal }); /* the power cut */
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      h = await head(device, { signal });
      assert.equal(JSON.stringify([h.seq, h.restoring]), JSON.stringify([atBackup.seq, 1]), 'a power cut mid-replay did not leave the backup\'s state and restoring');
      assert.equal(await replay(c1.link, c1.head), 'EDGE:00');
      const [d2] = await replayDone(v1.seq, v1.tag, lost.seq);
      const done2 = vouchOf(d2);
      h = await head(device, { signal });
      log(`restore 2: committed to #${l1.seq} on its older vouch; head #${h.seq} owed ${h.owed}`);
      assert.equal(done2.seq, l1.seq + 1, 'the older vouch did not commit up to its own point and LOSS the rest');
      assert.equal(h.owed, atBackup.owed + 1, 'the vouched link did not bring its debt back');
      const [k1, loss2] = await pickup(device, l1.seq, 2, { signal });
      assert.bytes(Buffer.from(k1.head), Buffer.from(c1.head), 'the committed link is not the real one');
      const fl2 = chain.decodeLink(loss2.link);
      assert.equal(JSON.stringify([fl2.op, fl2.grantId, Buffer.from(fl2.subject).readUInt32LE(0)]), JSON.stringify([11, l2.seq, lost.seq]), 'the LOSS does not name #first-lost..#newest');

      /* ---- 3. the whole copy, vouched by the newest tag ---- */
      await restore('restore 3');
      assert.equal(await replay(c1.link, c1.head), 'EDGE:00');
      assert.equal(await replay(c2.link, c2.head), 'EDGE:00');
      const [d3] = await replayDone(v2.seq, v2.tag, lost.seq);
      const done3 = vouchOf(d3);
      h = await head(device, { signal });
      assert.equal(JSON.stringify([done3.seq, h.seq, h.restoring, h.owed]), JSON.stringify([l2.seq, l2.seq, 0, lost.owed]), 'the vouched replay did not commit the whole copy');
      assert.bytes(Buffer.from(h.head), Buffer.from(lost.head), 'the restored head is not the real one');
    });

  /*
   * R13a, THE SUBJECT PROOF (Brad, 2026-10-02): the token only works if the
   * library's requestSubject of the bytes a host sends equals what the
   * firmware hashes into pend.subject - SHA-256 of what it hands
   * okcore_prime_user_confirmation. A mismatch would not fail safe so much as
   * fail useless: every ARM would end in a press. So, per op type, a
   * self-press must go through on a lib-computed token, and the link's
   * subject (written by the firmware) must equal the lib's subject.
   */
  it('edge: an ARM pays for exactly its request - RSA sign, ECC sign, RSA decrypt and a multi-packet sign each self-press, with the lib\'s subject in the link (R13a)',
    async ({ device, assert, signal, log }) => {
      const { pqc } = ctx.kit;
      const RSA_2048 = 2;
      const FEATURE_DECRYPT = 32;
      const FEATURE_SIGN = 64;
      const P256 = 2;
      const rsa = () => {
        const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
        const jwk = privateKey.export({ format: 'jwk' });
        return { publicKey, pq: Buffer.concat([Buffer.from(jwk.p, 'base64url'), Buffer.from(jwk.q, 'base64url')]) };
      };
      const rsaSign = rsa();
      const rsaDecrypt = rsa();
      const ecdh = crypto.createECDH('prime256v1');
      ecdh.generateKeys();
      const eccScalar = ecdh.getPrivateKey();
      const eccPub = crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, ecdh.getPublicKey()]), format: 'der', type: 'spki' });

      /* the keys, in one config-mode session (as 19-rsa-keys and 14-stored-keys load them) */
      await pqc.readyForKeygen(device, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: 1, field: 22, payload: Buffer.from([1]) });
      await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 8000, signal });
      for (const k of [{ slot: 2, type: RSA_2048 | FEATURE_SIGN, pq: rsaSign.pq }, { slot: 1, type: RSA_2048 | FEATURE_DECRYPT, pq: rsaDecrypt.pq }]) {
        since = device.mark(ctx.IFACE.VENDOR);
        for (let i = 0; i < k.pq.length; i += 57) {
          device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: k.slot, field: k.type, payload: k.pq.subarray(i, i + 57) });
          await device.sleep(150, { signal });
        }
        const ack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 20000, signal });
        assert.match(ctx.okmsg.text(ack), /Successfully set RSA Key/, `RSA slot ${k.slot}: ${ctx.okmsg.text(ack)}`);
      }
      since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: 101, field: P256 | FEATURE_SIGN, payload: eccScalar });
      const eack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 30000, signal });
      assert.ok(!/Error/.test(ctx.okmsg.text(eack)), `ECC slot 101: ${ctx.okmsg.text(eack)}`);
      await device.sleep(500, { signal });
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      const b = await openBudget(device, [
        { op: OP_SIGN, slot: 2, cap: 1 },
        { op: OP_SIGN, slot: 101, cap: 1 },
        { op: OP_DECRYPT, slot: 1, cap: 1 },
        { op: OP_SIGN, slot: 222, cap: 1 },
      ], 'okt: one of each op type', { signal });

      const rsaMessage = Buffer.from('okt edge RSA sign');
      const eccMessage = Buffer.from('okt edge ECC sign');
      const secret = crypto.randomBytes(32);
      const longMessage = Buffer.alloc(100, 0x5a); /* + the identity hash: 132 bytes, three packets */
      const cases = [
        { name: 'RSA sign (slot 2)', msg: ctx.okmsg.MSG.OKSIGN, slot: 2, op: OP_SIGN, payload: sha256(rsaMessage), want: 256,
          check: (out) => crypto.verify('sha256', rsaMessage, rsaSign.publicKey, out) },
        { name: 'ECC sign (slot 101)', msg: ctx.okmsg.MSG.OKSIGN, slot: 101, op: OP_SIGN, payload: sha256(eccMessage), want: 64,
          check: (out) => crypto.verify('sha256', eccMessage, { key: eccPub, dsaEncoding: 'ieee-p1363' }, out) },
        { name: 'RSA decrypt (slot 1, five packets)', msg: ctx.okmsg.MSG.OKDECRYPT, slot: 1, op: OP_DECRYPT,
          payload: crypto.publicEncrypt({ key: rsaDecrypt.publicKey, padding: crypto.constants.RSA_PKCS1_PADDING }, secret), want: 32,
          check: (out) => out.equals(secret) },
        { name: 'agent sign (code 222, three packets)', msg: ctx.okmsg.MSG.OKSIGN, slot: 222, op: OP_SIGN,
          payload: Buffer.concat([longMessage, sha256(Buffer.from('okt edge identity'))]), want: 64, check: (out) => out.length === 64 },
      ];
      for (const c of cases) {
        const h = await head(device, { signal });
        const subject = grants.requestSubject(new Uint8Array(c.payload));
        assert.equal(await armFor(device, h.head, c.payload, { signal }), 'EDGE:00', `${c.name}: ARM refused`);
        const sent = device.mark(ctx.IFACE.VENDOR);
        sendChunked(device, c.msg, c.slot, c.payload);
        /* no press: an armed budget pays */
        const deadline = Date.now() + 10000;
        let out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        while (out.length < c.want && Date.now() < deadline) {
          await device.sleep(100, { signal });
          out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        }
        out = out.subarray(0, c.want);
        const after = await headPast(device, h.seq, { signal });
        const [l] = await pickup(device, after.seq, 1, { signal });
        const f = chain.decodeLink(l.link);
        log(`${c.name}: #${f.seq} decision ${f.decision} slot ${f.slot} subject ${Buffer.from(f.subject).toString('hex').slice(0, 16)} lib ${Buffer.from(subject).toString('hex').slice(0, 16)}`);
        assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.grantId]), JSON.stringify([c.op, SELF_PRESS, c.slot, b.grantId]), `${c.name}: not a self-press under the budget`);
        assert.bytes(Buffer.from(f.subject), Buffer.from(subject), `${c.name}: the firmware's subject is not the library's requestSubject`);
        assert.ok(c.check(out), `${c.name}: the result does not check out`);
        await ticket(device, f.seq, `okt: ${c.name}`, { signal });
      }
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  /* R15b: a budget lives its lifetime from the press, and the lifetime is in its opening link */
  it('edge: a budget expires after its lifetime - nothing arms under it, HEAD drops it, and its opening link carries the lifetime (R15b)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const b = await openBudget(device, 2, 'okt: one minute', { signal, lifetime: 1 });
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject),
        Buffer.from(grants.grantSubject({ scopes: scopesOf(2), reasonHash: b.reasonHash, genesis: b.G, lifetime: 1 })),
        'the opening link does not carry the 1-minute lifetime');
      let h = await head(device, { signal });
      assert.ok(h.live.includes(b.grantId));
      assert.equal(await armFor(device, h.head, agentPayload('okt before expiry'), { signal }), 'EDGE:00');
      /* in 10 s steps, reading HEAD each time: the kit's watchdog wants progress every 30 s */
      const until = Date.now() + 62000;
      while (Date.now() < until) {
        await device.sleep(Math.min(10000, Math.max(0, until - Date.now())), { signal });
        h = await head(device, { signal });
      }
      log(`after 62 s: live ${JSON.stringify(h.live)}`);
      assert.ok(!h.live.includes(b.grantId), 'HEAD still lists an expired budget');
      assert.equal(await armFor(device, h.head, agentPayload('okt after expiry'), { signal }), 'EDGE:0D', 'ARM went through under an expired budget');
    });

  it('edge: a checkpoint is the Edge key\'s signature over the head',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const [c, s] = await edge(device, CHECKPOINT, null, { signal, reports: 2 });
      assert.ok(checkpointVerifies(pub, h.seq, h.head, s), 'the checkpoint signature does not verify');
      assert.equal(c.readUInt32LE(0), h.seq);
      assert.bytes(c.subarray(4, 36), Buffer.from(h.head));
      /* and over THIS head only */
      assert.ok(!checkpointVerifies(pub, h.seq, new Uint8Array(32).fill(1), s), 'a checkpoint verified over another head');
      /* the latest link is still held for pickup, and its weld is the signed head */
      const [last] = await pickup(device, h.seq, 1, { signal });
      assert.bytes(Buffer.from(last.head), Buffer.from(h.head));
    });
};
