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
const GRANT_CREATE = 0x10;
const GRANT_REVOKE = 0x12;
const GRANT_HOLD = 0x13;
const GRANT_RESUME = 0x14;
const TICKET = 0x20;
const WAIVE = 0x21;
const ARM = 0x22;
const SEQ_NONE = 0xffffffff;
/* lib codes.js */
const OP_SIGN = 1;
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
      live: ids.filter(Boolean), held: ids.filter((id, i) => id && (r[56] >> i) & 1), owed: r[57], overflow: r[58],
    };
  }

  /* TICKET and WAIVE answer seq . head - what the next ARM passes (R13a) */
  const seqHead = (r) => ({ seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)) });

  async function ticket(device, ref, msg, opts) {
    const [r] = await edge(device, TICKET, Buffer.concat([u32(ref), Buffer.from([0x00]), sha256(Buffer.from(msg))]), opts);
    return seqHead(r);
  }

  const arm = (device, headBytes, opts) => edge(device, ARM, Buffer.from(headBytes), { ...opts, text: true });

  /* clear whatever earlier tests left owed: a pressed WAIVE (R18) */
  async function clearDebts(device, { signal, log }) {
    const h = await head(device, { signal });
    if (!h.owed && !h.overflow) return;
    await edge(device, WAIVE, null, { signal, press: true });
    if (log) log(`waived ${h.owed} owed${h.overflow ? ' + overflow' : ''} left by earlier tests`);
  }

  /* GRANT_CREATE (one scope: agent P-256 sign 222, `cap` uses) with its press -> {grantId, uses, G, chainSeq, ckpt, sig} */
  async function openBudget(device, cap, reason, { signal }) {
    const reasonHash = sha256(Buffer.from(reason));
    const req = Buffer.alloc(50);
    req[0] = 1;
    req[1] = OP_SIGN; req[2] = 222; req.writeUInt16LE(cap, 3);
    reasonHash.copy(req, 17);
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

  /* an agent-derived P-256 sign (OKSIGN code 222): message || identity hash, in 57-byte chunks */
  function sendAgentSign(device, message) {
    const payload = Buffer.concat([message, sha256(Buffer.from('okt edge identity'))]);
    for (let i = 0; i < payload.length; i += 57) {
      const chunk = payload.subarray(i, i + 57);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSIGN, slot: 222, field: chunk.length < 57 ? chunk.length : 0xff, payload: chunk });
    }
    return payload;
  }

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
    const h = await headPast(device, before, { signal });
    return { payload, seq: h.seq };
  }

  /* a sign an ARMed budget pays for: no press - the signature comes back and the link is there */
  async function selfPressedSign(device, text, { signal }) {
    const before = (await head(device, { signal })).seq;
    const since = device.mark(ctx.IFACE.VENDOR);
    const payload = sendAgentSign(device, sha256(Buffer.from(text)));
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const h = await headPast(device, before, { signal });
    return { payload, seq: h.seq };
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

  it('edge: a budget signed at a press pays only ARMed uses; ARM refuses a stale head and anything while a ticket is owed (R10, R13, R13a, R18)',
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
       *   SHA256("OKEDGE-GRANT-v1" || scopes || reason_hash || G)
       */
      assert.equal(b.ckpt.readUInt32LE(0), b.chainSeq, 'the checkpoint is not over the grant-create link');
      assert.ok(checkpointVerifies(pub, b.chainSeq, b.ckpt.subarray(4, 36), b.sig), 'the opening checkpoint does not verify');
      const [opened] = await pickup(device, b.chainSeq, 1, { signal });
      assert.bytes(Buffer.from(chain.weld(before.head, opened.link)), b.ckpt.subarray(4, 36), 'the signed head is not this link welded on');
      const scopesEnc = Buffer.from([1, OP_SIGN, 222, 2, 0]);
      const wantSubject = sha256(Buffer.concat([Buffer.from('OKEDGE-GRANT-v1'), scopesEnc, b.reasonHash, Buffer.from(b.G)]));
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject), wantSubject, 'the grant-create link does not commit to G');

      /* a request that skips ARM is pressed, even with a live budget (R13a) - and owes */
      const p0 = await pressedSign(device, 'okt budget message 0', { signal });
      const t0 = await ticket(device, p0.seq, 'okt: 0', { signal });

      /* grant -> arm -> use -> ticket -> arm -> use -> ticket */
      assert.equal(await arm(device, t0.head, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, 'okt budget message 1', { signal });
      assert.equal(await arm(device, (await head(device, { signal })).head, { signal }), 'EDGE:0C', 'ARM went through while a ticket was owed (R18)');
      assert.equal(await edge(device, GRANT_CREATE, Buffer.alloc(50, 0).fill(1, 0, 1), { signal, text: true }), 'EDGE:0C', 'a budget opened while a ticket was owed (R10)');
      const t1 = await ticket(device, s1.seq, 'okt: 1', { signal });
      assert.equal(await arm(device, t0.head, { signal }), 'EDGE:0B', 'ARM took a stale head');
      assert.equal(await arm(device, t1.head, { signal }), 'EDGE:00');
      const s2 = await selfPressedSign(device, 'okt budget message 2', { signal });
      const t2 = await ticket(device, s2.seq, 'okt: 2', { signal });
      assert.equal(await arm(device, t2.head, { signal }), 'EDGE:0D', 'ARM went through under a used-up budget');

      const { links, fields: f } = await verifyFrom(device, b.chainSeq, before.head, { signal, assert, log });
      log(trail(f));
      const at = (seq) => f[seq - b.chainSeq];
      assert.equal(at(b.chainSeq).op, OP_GRANT_CREATE);
      assert.equal(at(b.chainSeq).grantId, b.grantId);
      assert.equal(at(p0.seq).decision, APPROVE, 'an unarmed use under a live budget was not pressed');
      assert.equal(JSON.stringify([at(s1.seq).decision, at(s1.seq).grantId, at(s1.seq).grantStep]), JSON.stringify([SELF_PRESS, b.grantId, 1]));
      assert.equal(JSON.stringify([at(s2.seq).decision, at(s2.seq).grantStep]), JSON.stringify([SELF_PRESS, 2]));

      /* each reveal belongs to G and to what was signed (the MAC is the host's to compute) */
      const spends = [s1, s2].map((s, i) => {
        const value = links[s.seq - b.chainSeq].reveal;
        const subject = new Uint8Array(sha256(s.payload));
        const mac = new Uint8Array(crypto.createHmac('sha256', value).update(subject).digest());
        return { step: i + 1, value, mac, subject };
      });
      assert.equal(JSON.stringify(grants.checkSpends(b.G, b.uses, spends)), '{"ok":true,"spent":2}');
      const paired = tickets.pairTickets(links);
      for (const s of [p0, s1, s2]) assert.equal(paired.uses.find((u) => u.seq === s.seq).status, 'ticketed', `use #${s.seq}`);

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
      assert.equal(await arm(device, h.head, { signal }), 'EDGE:0D', 'ARM went through under a held budget');

      /* while a use owes, resume is refused (R18) */
      const p = await pressedSign(device, 'okt held: pressed', { signal });
      assert.equal(await edge(device, GRANT_RESUME, u32(b.grantId), { signal, text: true }), 'EDGE:0C', 'resume went through while a ticket was owed');
      await ticket(device, p.seq, 'okt: held pressed', { signal });

      assert.equal(await edge(device, GRANT_RESUME, u32(b.grantId), { signal, text: true, press: true }), 'EDGE:00');
      h = await head(device, { signal });
      assert.equal(JSON.stringify(h.held), JSON.stringify([]), 'still on hold after the resume');
      assert.equal(await arm(device, h.head, { signal }), 'EDGE:00');

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
   * The plugin backup section (DESIGN.md 6; the loader's 0xFB section): Edge
   * keeps version, seq, head and the owed uses. A backup taken at head S, a link
   * made after it, then the restore: the key comes back at S, owing what it owed
   * then, and links a LOSS first - the history after the backup is gone, and the
   * chain says so.
   */
  it('edge: a backup keeps the chain\'s head and its debts; a restore brings them back and links a LOSS',
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

      /* a link the backup does not have */
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await pressedSign(device, 'okt edge after the backup', { signal });
      const lost = await head(device, { signal });
      assert.equal(lost.seq, atBackup.seq + 1);

      /* the restore - OKRESTORE is taken in config mode (as 10-backup-restore sends it) */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      const before = device.generation;
      for (const payload of backup.toRestorePackets(parsed.data)) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKRESTORE, payload });
        await device.sleep(50, { signal });
      }
      await device.waitForReboot({ from: before, timeoutMs: 90000, signal });
      await device.waitReady({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });

      /* back at the backup's head, plus one LOSS link welded onto it, owing what it owed then */
      const after = await head(device, { signal });
      log(`after the restore: head #${after.seq} owed ${after.owed} (backup at #${atBackup.seq}, the lost link was #${lost.seq})`);
      assert.equal(after.seq, atBackup.seq + 1, 'the chain did not come back to the backup\'s head plus the LOSS link');
      assert.equal(after.owed, atBackup.owed, 'the restore changed what is owed');
      const [l] = await pickup(device, after.seq, 1, { signal });
      assert.equal(chain.decodeLink(l.link).op, 11, 'the first link after a restore is a LOSS');
      assert.bytes(Buffer.from(chain.weld(atBackup.head, l.link)), Buffer.from(after.head), 'the LOSS link does not weld onto the backup\'s head');
      assert.ok(!Buffer.from(after.head).equals(Buffer.from(lost.head)), 'the restored chain still carries the lost link');
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
