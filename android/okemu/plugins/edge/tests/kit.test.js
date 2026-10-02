'use strict';
/*
 * edge's emulator tests (the onlykey-testing kit), SIDE-LOADED from this folder
 * by 01-protocol/38-softkey-plugins.test.js when the emulator was built with
 * OKEMU_PLUGINS=edge.
 *
 * The firmware is a notary (DESIGN.md section 0); the truth is the LIBRARY's
 * reading of what it writes (node-onlykey-lib/edge, through ctx.requireLib -
 * the kit's own pinned lib): every link, weld, budget signature, reveal,
 * ticket and checkpoint must check out there.
 *
 * Everything from the kit comes through ctx: IFACE, okmsg, PINS, requireLib.
 */
const crypto = require('crypto');

const OKEDGE = 0x80 | 0x78;
const HEAD = 0x01;
const PICKUP = 0x02;
const CHECKPOINT = 0x03;
const PUBKEY = 0x04;
const GRANT_CREATE = 0x10;
const GRANT_REVOKE = 0x12;
const TICKET = 0x20;
const SEQ_NONE = 0xffffffff;
/* lib codes.js */
const OP_SIGN = 1;
const OP_GRANT_CREATE = 6;
const OP_GRANT_END = 7;
const OP_TICKET = 8;
const APPROVE = 1;
const TIMEOUT = 3;
const SELF_PRESS = 4;
const PRESS_OBSERVED = 0x01;
const PREV_NO_TICKET = 0x04;
/* the console line that says a confirmation is primed (14-stored-keys uses it too) */
const PRIMED = /Encrypted Buffer/g;
const P256_SPKI = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

module.exports = function register({ it }, ctx) {
  const { chain, grants, tickets } = ctx.requireLib('node-onlykey-lib/edge');
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

  /* send an OKEDGE sub-op and collect EVERY report since (several come back to back) */
  async function edge(device, sub, args, { signal, reports = 1, text = false }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKEDGE, slot: sub, payload: args || Buffer.alloc(0) });
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const deadline = Date.now() + 6000;
    let got = device.reportsSince(ctx.IFACE.VENDOR, since);
    while (got.length < reports && Date.now() < deadline) {
      await device.sleep(50, { signal });
      got = device.reportsSince(ctx.IFACE.VENDOR, since);
    }
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

  /* HEAD: seq . head . oldest pickable seq . the live budget ids */
  async function head(device, opts) {
    const [r] = await edge(device, HEAD, null, opts);
    const live = [0, 1, 2, 3].map((i) => r.readUInt32LE(40 + 4 * i)).filter(Boolean);
    return { seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)), oldest: r.readUInt32LE(36), live };
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

  /* an agent-derived P-256 sign (OKSIGN code 222): message || identity hash, in 57-byte chunks */
  function sendAgentSign(device, message) {
    const payload = Buffer.concat([message, sha256(Buffer.from('okt edge identity'))]);
    for (let i = 0; i < payload.length; i += 57) {
      const chunk = payload.subarray(i, i + 57);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSIGN, slot: 222, field: chunk.length < 57 ? chunk.length : 0xff, payload: chunk });
    }
    return payload;
  }

  /* a sign that will wait for a press: press it */
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
  async function pressedSign(device, text, { signal }) {
    const before = (await head(device, { signal })).seq;
    const primed = device.log.count(PRIMED);
    const payload = sendAgentSign(device, sha256(Buffer.from(text)));
    await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
    await device.sleep(500, { signal });
    device.press(1);
    await headPast(device, before, { signal });
    return payload;
  }

  /* a sign a live budget pays for: no press - the signature comes back and the link is there */
  async function selfPressedSign(device, text, { signal }) {
    const before = (await head(device, { signal })).seq;
    const since = device.mark(ctx.IFACE.VENDOR);
    const payload = sendAgentSign(device, sha256(Buffer.from(text)));
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    await headPast(device, before, { signal });
    return payload;
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

  it('edge: HEAD and the Edge key on a fresh key; the chain starts at the lib\'s genesis',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const deviceId = deviceIdOf(pub);
      log(`seq ${h.seq === SEQ_NONE ? 'none' : h.seq}, device ${Buffer.from(deviceId).toString('hex')}, live ${JSON.stringify(h.live)}`);
      assert.ok(crypto.createPublicKey({ key: Buffer.concat([P256_SPKI, Buffer.from([4]), pub]), format: 'der', type: 'spki' }), 'not a P-256 point');
      if (h.seq === SEQ_NONE) assert.bytes(Buffer.from(h.head), Buffer.from(chain.genesis(deviceId)), 'an empty chain\'s head is not the genesis');
    });

  it('edge: a pressed sign and an unanswered one become links the library verifies',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = await head(device, { signal });
      const startHead = before.head;
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;

      const signed = await pressedSign(device, 'okt edge message 1', { signal });
      const primed = device.log.count(PRIMED);
      sendAgentSign(device, sha256(Buffer.from('okt edge message 2')));
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      await device.sleep(23000, { signal }); /* never pressed: the 20 s fade */

      const { fields: f } = await verifyFrom(device, first, startHead, { signal, assert, log });
      log(f.map((x) => `#${x.seq} op ${x.op} dec ${x.decision} flags ${x.flags}`).join('; '));
      assert.equal(f[0].op, OP_SIGN);
      assert.equal(f[0].decision, APPROVE);
      assert.ok(f[0].flags & PRESS_OBSERVED, 'a pressed approve carries the press flag');
      assert.bytes(Buffer.from(f[0].subject), sha256(signed), 'the subject is not SHA-256 of what was submitted');
      assert.equal(f[1].decision, TIMEOUT);
      assert.ok(f[1].flags & PREV_NO_TICKET, 'the use after an unticketed one carries the empty hook (R17)');
    });

  it('edge: a budget opened by a press is signed by the key, spends without a press, is ticketed, then needs a press again',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = await head(device, { signal });
      const pub = await pubkey(device, { signal });

      /* GRANT_CREATE: agent P-256 sign (222), cap 2, a reason */
      const reasonHash = sha256(Buffer.from('okt: sign two test messages'));
      const req = Buffer.alloc(50);
      req[0] = 1;
      req[1] = OP_SIGN; req[2] = 222; req.writeUInt16LE(2, 3);
      reasonHash.copy(req, 17);
      const since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: OKEDGE, slot: GRANT_CREATE, payload: req });
      await device.sleep(800, { signal });
      device.press(1); /* the physical press that opens it */
      await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
      const deadline = Date.now() + 6000;
      let rs = device.reportsSince(ctx.IFACE.VENDOR, since);
      while (rs.length < 3 && Date.now() < deadline) { await device.sleep(50, { signal }); rs = device.reportsSince(ctx.IFACE.VENDOR, since); }
      assert.ok(!/^EDGE:/.test(ctx.okmsg.text(rs[0])), `the key refused the budget: ${ctx.okmsg.text(rs[0]).trim()}`);
      const g = Buffer.from(rs[0]);
      const grantId = g.readUInt32LE(0);
      const uses = g.readUInt16LE(4);
      const G = new Uint8Array(g.subarray(6, 38));
      const chainSeq = g.readUInt32LE(38);
      const ckpt = Buffer.from(rs[1]);
      const sig = new Uint8Array(Buffer.from(rs[2]).subarray(0, 64));
      log(`budget ${grantId}: ${uses} uses, opened at chain #${chainSeq}`);
      assert.ok((await head(device, { signal })).live.includes(grantId), 'HEAD does not list the new budget as live');

      /*
       * The budget's genesis is signed THROUGH the chain: the press answers with a
       * checkpoint over the grant-create link, and that link's subject commits to G
       *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G)
       */
      assert.equal(ckpt.readUInt32LE(0), chainSeq, 'the checkpoint is not over the grant-create link');
      assert.ok(checkpointVerifies(pub, chainSeq, ckpt.subarray(4, 36), sig), 'the opening checkpoint does not verify');
      const [opened] = await pickup(device, chainSeq, 1, { signal });
      assert.bytes(Buffer.from(chain.weld(before.head, opened.link)), ckpt.subarray(4, 36), 'the signed head is not this link welded on');
      const scopesEnc = Buffer.from([1, OP_SIGN, 222, 2, 0]);
      const wantSubject = sha256(Buffer.concat([Buffer.from('OKEDGE-GRANT-v1'), scopesEnc, reasonHash, Buffer.from(G)]));
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject), wantSubject, 'the grant-create link does not commit to G');

      /* two signs inside it: no press; the second after the first's ticket */
      const p1 = await selfPressedSign(device, 'okt budget message 1', { signal });
      const [l1] = await pickup(device, chainSeq + 1, 1, { signal });
      const msg = 'okt: signed budget message 1 as asked';
      const said = await edge(device, TICKET, Buffer.concat([u32(chainSeq + 1), Buffer.from([0x00]), sha256(Buffer.from(msg))]), { signal, text: true });
      assert.equal(said, 'EDGE:00');
      const p2 = await selfPressedSign(device, 'okt budget message 2', { signal });

      /* the budget is used up: the next sign waits for a press again */
      await pressedSign(device, 'okt budget message 3', { signal });

      const { links, fields: f } = await verifyFrom(device, chainSeq, before.head, { signal, assert, log });
      log(f.map((x) => `#${x.seq} op ${x.op} dec ${x.decision} grant ${x.grantId} step ${x.grantStep}`).join('; '));
      assert.equal(f[0].op, OP_GRANT_CREATE);
      assert.equal(f[0].grantId, grantId);
      assert.equal(JSON.stringify([f[1].decision, f[1].grantId, f[1].grantStep]), JSON.stringify([SELF_PRESS, grantId, 1]));
      assert.equal(f[2].op, OP_TICKET);
      assert.equal(JSON.stringify([f[3].decision, f[3].grantStep]), JSON.stringify([SELF_PRESS, 2]));
      assert.equal(f[4].decision, APPROVE, 'past the cap the sign is pressed');

      /* each reveal belongs to G and to what was signed (the MAC is the host's to compute) */
      const spends = [[links[1], p1], [links[3], p2]].map(([l, payload], i) => {
        const value = l.reveal;
        const subject = new Uint8Array(sha256(payload));
        const mac = new Uint8Array(crypto.createHmac('sha256', value).update(subject).digest());
        return { step: i + 1, value, mac, subject };
      });
      assert.bytes(Buffer.from(l1.reveal), Buffer.from(spends[0].value), 'PICKUP gave two different reveals for one link');
      assert.equal(JSON.stringify(grants.checkSpends(G, uses, spends)), '{"ok":true,"spent":2}');

      /* the ticket: its subject recomputes from the message, and pairTickets shows it */
      const paired = tickets.pairTickets(links, { [chainSeq + 1]: msg });
      const use1 = paired.uses.find((u) => u.seq === chainSeq + 1);
      assert.equal(use1.status, 'ticketed');
      assert.equal(use1.message, msg, 'the ticket\'s message does not match its link');

      const said2 = await edge(device, GRANT_REVOKE, u32(grantId), { signal, text: true });
      log(`revoke: ${said2}`);
      assert.ok(!(await head(device, { signal })).live.includes(grantId), 'a revoked budget is still listed as live');
    });

  it('edge: under a ticket-required budget, an unticketed use sends the next one back to a press (R18)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const req = Buffer.alloc(50);
      req[0] = 1;
      req[1] = OP_SIGN; req[2] = 222; req.writeUInt16LE(3, 3);
      sha256(Buffer.from('okt: ticket required')).copy(req, 17);
      req[49] = 0x01; /* ticket_required */
      const since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: OKEDGE, slot: GRANT_CREATE, payload: req });
      await device.sleep(800, { signal });
      device.press(1);
      await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
      await device.sleep(500, { signal });
      const grantId = Buffer.from(device.reportsSince(ctx.IFACE.VENDOR, since)[0]).readUInt32LE(0);

      const before = await head(device, { signal });
      await selfPressedSign(device, 'okt tr 1', { signal });     /* self-press, owes its ticket */
      await pressedSign(device, 'okt tr 2', { signal });         /* no ticket: back to a press */
      const { fields: f } = await verifyFrom(device, before.seq + 1, before.head, { signal, assert });
      assert.equal(f[0].decision, SELF_PRESS);
      assert.equal(f[1].decision, APPROVE, 'without the ticket the next use must be pressed');
      assert.ok(f[1].flags & PRESS_OBSERVED);
      await edge(device, GRANT_REVOKE, u32(grantId), { signal, text: true });
    });

  it('edge: a checkpoint is the Edge key\'s signature over the head, and a revoke ends the budget in the chain',
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
      /* the previous test's revoke is the latest link */
      const [last] = await pickup(device, h.seq, 1, { signal });
      assert.equal(chain.decodeLink(last.link).op, OP_GRANT_END);
    });
};
