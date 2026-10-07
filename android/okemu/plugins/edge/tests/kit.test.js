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
 * Only budget uses owe a ticket (R16, 2026-10-06: an ordinary press is not Edge and
 * writes no link) and nothing automatic happens while
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
const LOSS = 0x34;
const AGENT_ADD = 0x15; /* mcp-service 4.7a: {agent key 32}, press */
const PEER_ADD = 0x30;    /* R20: {P-256 key, compressed 33}, press */
const PEER_REMOVE = 0x31; /* R20: {index}, press */
const PEER_LIST = 0x32;   /* R20: count . k . max, then one report per slot */
const SIBLING_ADD = 0x35;    /* R29: {0, X} staged, then {1, Y, device id} and a press */
const SIBLING_REMOVE = 0x36; /* R29: {index}, press */
const SIBLING_LIST = 0x37;   /* R29: count . max, then one report per slot */
const ANCHOR = 0x38;         /* R30: {0, index, seq, head}, {1, sig r}, {2, sig s}, then a press */
const SYNC = 0x39;        /* sync phase 2: {subject 32}, press; a sync link (op 20), no ticket (number CHOSEN) */
const GRANT_CREATE = 0x10;
const GRANT_LABEL = 0x11; /* R11a: {scope index, label 32}, no press - a derived code's identity */
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
const OWES_TICKET = 0x10; /* R16: set by the key at decision time - this use owes a ticket */
const ARMED = 0x20;       /* R16: an arm was waiting when the request was primed */
/* the console line that says a confirmation is primed (14-stored-keys uses it too) */
const PRIMED = /Encrypted Buffer/g;
const P256_SPKI = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

module.exports = function register({ it }, ctx) {
  /* R28: the backup the R26 test kept in the PREVIOUS run - read now, before this run's R26 test replaces it */
  const keptAtLoad = (() => { try { return JSON.parse(require('fs').readFileSync(require('path').join(require('os').tmpdir(), 'okt-plugin-backup.json'), 'utf8')); } catch { return null; } })();
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
      refusedArms: r[60], /* B7 stage 2: ARMs refused since power-up (RAM only) */
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
  /*
   * R11a: agent sign 222 is a DERIVED code, shared by every P-256 identity, so
   * a scope on it names one: the 32-byte label of the test identity every
   * agent request here carries ("okt edge identity") - never a real one.
   */
  const OKT_LABEL = sha256(Buffer.from('okt edge identity'));
  const derived = (slot) => (slot >= 201 && slot <= 203) || (slot >= 221 && slot <= 223);
  const scopesOf = (scopes) => (typeof scopes === 'number' ? [{ op: OP_SIGN, slot: 222, cap: scopes, label: OKT_LABEL }] : scopes);
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
    /* R11a: each derived-code scope's label is staged first (no press); GRANT_CREATE consumes them */
    const list = scopesOf(scopes);
    for (let j = 0; j < list.length; j++) {
      if (!derived(list[j].slot)) continue;
      const staged = await edge(device, GRANT_LABEL, Buffer.concat([Buffer.from([j]), list[j].label || OKT_LABEL]), { signal, text: true });
      if (staged !== 'EDGE:00') throw new Error(`GRANT_LABEL ${j} answered ${staged}`);
    }
    const req = grantRequest(scopes, reasonHash, (await head(device, { signal })).head, lifetime);
    const [g, ckpt, s] = await edge(device, GRANT_CREATE, req, { signal, press: true, reports: 3 });
    return {
      grantId: g.readUInt32LE(0), uses: g.readUInt16LE(4), G: new Uint8Array(g.subarray(6, 38)),
      chainSeq: g.readUInt32LE(38), ckpt, sig: new Uint8Array(s.subarray(0, 64)), reasonHash,
    };
  }

  /*
   * A chain at least n links long, built from Edge's own records (a budget opened
   * and revoked = 2 links). Ordinary presses wrote links before 2026-10-06; tests
   * that need a story build it now, and a test run alone starts on an empty chain.
   */
  async function ensureChain(device, n, { signal, log }) {
    await clearDebts(device, { signal, log });
    for (;;) {
      const h = await head(device, { signal });
      if (h.seq !== SEQ_NONE && h.seq + 1 >= n) return h;
      const b = await openBudget(device, 1, 'okt: a link for the story', { signal });
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    }
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

  /* an ordinary pressed sign (no ARM): it signs and is not Edge - no link, nothing owed (2026-10-06) */
  async function ordinaryPress(device, text, { signal }) {
    const primed = device.log.count(PRIMED);
    const since = device.mark(ctx.IFACE.VENDOR);
    sendAgentSign(device, sha256(Buffer.from(text)));
    await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
    await device.sleep(500, { signal });
    device.press(1);
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
  }

  /* a sign the key refuses before it runs (R13a, 2026-10-06): no prompt, no link - its answer, e.g. "EDGE:1C" */
  async function refusedSign(device, payload, { signal }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
    const got = await collect(device, since, 1, { signal });
    return ctx.okmsg.text(got[0]).trim();
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

  it('edge: an ordinary press writes no link and owes nothing, budget or not; a budget use owes its ticket - a timeout does not clear it, a late ticket pays it, a second is refused (R16, 2026-10-06)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;

      /* no budget: an ordinary press signs and writes nothing (the chain holds only Edge's own records) */
      await ordinaryPress(device, 'okt edge ordinary', { signal });
      const h0 = await head(device, { signal });
      assert.equal(h0.seq, before.seq, 'an ordinary press wrote a link');
      assert.equal(h0.owed, 0, 'an ordinary press owes a ticket');

      /* a budget use: self-pressed, owes its ticket */
      const b = await openBudget(device, 2, 'okt: one paid use', { signal });
      const payload = agentPayload('okt edge paid 1');
      assert.equal(await armFor(device, (await head(device, { signal })).head, payload, { signal }), 'EDGE:00');
      const paid = await selfPressedSign(device, Buffer.concat([payload]), { signal });
      const hp = await head(device, { signal });
      assert.equal(hp.owed, 1, 'the budget use does not owe its ticket');

      /* under the live budget: an ordinary press, and one left to time out - no link, the debt stays */
      await ordinaryPress(device, 'okt edge ordinary under a budget', { signal });
      const primed = device.log.count(PRIMED);
      sendAgentSign(device, sha256(Buffer.from('okt edge never pressed')));
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      await device.sleep(23000, { signal }); /* never pressed: the 20 s fade */
      const afterTimeout = await head(device, { signal });
      assert.equal(afterTimeout.seq, hp.seq, 'an ordinary press or its timeout wrote a link');
      assert.equal(afterTimeout.owed, 1, 'the timeout cleared the debt');

      const msg = 'okt: paid use 1';
      const t = await ticket(device, paid.seq, msg, { signal });
      assert.equal(t.seq, afterTimeout.seq + 1, 'the ticket reply is not the ticket link\'s seq');
      const again = await edge(device, TICKET, Buffer.concat([u32(paid.seq), Buffer.from([0]), sha256(Buffer.from(msg))]), { signal, text: true });
      assert.equal(again, 'EDGE:08', 'a second ticket for one use was taken');

      const { h, fields: f, links } = await verifyFrom(device, first, before.head, { signal, assert, log });
      log(trail(f));
      assert.bytes(Buffer.from(t.head), Buffer.from(h.head), 'the ticket reply is not the key\'s head');
      assert.equal(h.owed, 0);
      assert.ok(f.every((x) => x.op !== OP_SIGN || x.decision === SELF_PRESS), `a sign link that is not a budget use: ${trail(f)}`);
      const use = tickets.pairTickets(links, { [paid.seq]: msg }).uses.find((u) => u.seq === paid.seq);
      assert.equal(use.status, 'ticketed');
      assert.equal(use.message, msg, 'the ticket\'s message does not match its link');
      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:00');
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
      /* ... and (R11a) ends with the derived scope's full label: the identity the person approved */
      const wantSubject = sha256(Buffer.concat([Buffer.from('OKEDGE-GRANT-v1'), scopesEnc, b.reasonHash, Buffer.from(b.G), Buffer.from([0, 0]), OKT_LABEL]));
      assert.bytes(Buffer.from(chain.decodeLink(opened.link).subject), wantSubject, 'the grant-create link does not commit to G and the lifetime');

      /* a request that skips ARM is an ordinary press, even with a live budget - not Edge: no link, nothing owed (2026-10-06) */
      const kept = [];
      const h0 = await head(device, { signal });
      await ordinaryPress(device, 'okt budget message 0', { signal });
      const h0b = await head(device, { signal });
      assert.equal(JSON.stringify([h0b.seq, h0b.owed]), JSON.stringify([h0.seq, 0]), 'an unarmed use under a live budget wrote a link or owes');

      /* grant -> arm -> use -> ticket -> arm -> use -> ticket */
      const pl1 = agentPayload('okt budget message 1');
      assert.equal(await armFor(device, h0b.head, pl1, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, pl1, { signal });
      assert.equal(await armFor(device, (await head(device, { signal })).head, pl1, { signal }), 'EDGE:0C', 'ARM went through while a ticket was owed (R18)');
      assert.equal(await edge(device, GRANT_CREATE, Buffer.alloc(58, 0).fill(1, 0, 1), { signal, text: true }), 'EDGE:0C', 'a budget opened while a ticket was owed (R10)');
      const t1 = await ticket(device, s1.seq, 'okt: 1', { signal });
      await catchUp(device, kept, b.chainSeq, { signal });

      /*
       * R13a (spec session, 2026-10-06): an ARM pays for ITS request after ITS head,
       * nothing else - and anything else is REFUSED, not pressed: no prompt, no
       * link, the arm used up, counted in HEAD byte 60. A stale head shows at the
       * sign; so does another program's request slipped in after a good ARM. The
       * agent's own request then has no arm left: an ordinary press (no link) until
       * it ARMs again.
       */
      const r0 = (await head(device, { signal })).refusedArms;
      const plStale = agentPayload('okt budget: armed on a stale head');
      assert.equal(await armFor(device, h0b.head, plStale, { signal }), 'EDGE:00');
      assert.equal(await refusedSign(device, plStale, { signal }), 'EDGE:1C', 'a sign ARMed on a stale head was not refused');
      const plMine = agentPayload('okt budget: the request the agent armed for');
      const plOther = agentPayload('okt budget: another program slipped in');
      assert.equal(await armFor(device, t1.head, plMine, { signal }), 'EDGE:00');
      assert.equal(await refusedSign(device, plOther, { signal }), 'EDGE:1C', 'another request after the ARM was not refused');
      const hr = await head(device, { signal });
      assert.equal(hr.seq, t1.seq, 'a refused sign wrote a link');
      assert.equal(hr.refusedArms - r0, 2, 'the two refused signs were not both counted');
      await ordinaryPress(device, 'okt budget: the agent\'s own, its arm used up', { signal });
      assert.equal((await head(device, { signal })).seq, hr.seq, 'the refusals or the ordinary press wrote a link');

      const pl2 = agentPayload('okt budget message 2');
      assert.equal(await armFor(device, hr.head, pl2, { signal }), 'EDGE:00');
      const s2 = await selfPressedSign(device, pl2, { signal });
      const t2 = await ticket(device, s2.seq, 'okt: 2', { signal });
      assert.equal(await armFor(device, t2.head, agentPayload('okt budget message 3'), { signal }), 'EDGE:0D', 'ARM went through under a used-up budget');
      const kh = await catchUp(device, kept, b.chainSeq, { signal });

      const links = kept;
      const verdict = chain.verify(links, { fromSeq: b.chainSeq, fromHead: before.head, expectHead: { seq: kh.seq, head: kh.head } });
      assert.ok(verdict.ok, `the library rejects the key's chain: ${JSON.stringify(verdict.failure)}`);
      const f = links.map((l) => chain.decodeLink(l.link));
      log(trail(f));
      const at = (seq) => f[seq - b.chainSeq];
      assert.equal(at(b.chainSeq).op, OP_GRANT_CREATE);
      assert.equal(at(b.chainSeq).grantId, b.grantId);
      assert.equal(JSON.stringify([at(s1.seq).decision, at(s1.seq).grantId, at(s1.seq).grantStep]), JSON.stringify([SELF_PRESS, b.grantId, 1]));
      assert.equal(JSON.stringify([at(s2.seq).decision, at(s2.seq).grantStep]), JSON.stringify([SELF_PRESS, 2]));
      /* the chain holds only Edge's own records: every sign link is a budget use (2026-10-06) */
      assert.ok(f.every((x) => x.op !== OP_SIGN || x.decision === SELF_PRESS), `a sign link that is not a budget use: ${trail(f)}`);
      /* R16 bits: a self-press is ARMED and OWES */
      const bits = (p) => at(p.seq).flags & (OWES_TICKET | ARMED);
      for (const p of [s1, s2]) assert.equal(bits(p), OWES_TICKET | ARMED, `#${p.seq}: a self-press does not carry bits 4 and 5`);

      /* each reveal belongs to G and to what was signed (the MAC is the host's to compute) */
      const spends = [s1, s2].map((s, i) => {
        const value = links[s.seq - b.chainSeq].reveal;
        const subject = new Uint8Array(sha256(s.payload));
        const mac = new Uint8Array(crypto.createHmac('sha256', value).update(subject).digest());
        return { step: i + 1, value, mac, subject };
      });
      assert.equal(JSON.stringify(grants.checkSpends(b.G, b.uses, spends)), '{"ok":true,"spent":2}');
      const paired = tickets.pairTickets(links);
      for (const s of [s1, s2]) assert.equal(paired.uses.find((u) => u.seq === s.seq).status, 'ticketed', `use #${s.seq}`);

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
      /* B7 stage 2: a refused ARM writes no link, but HEAD byte 60 counts it */
      assert.equal((await head(device, { signal })).refusedArms, Math.min(255, h.refusedArms + 1), 'HEAD byte 60 did not count the refused ARM');
      assert.equal((await head(device, { signal })).seq, h.seq, 'a refused ARM wrote a link');

      /* while a use owes, resume is refused (R18) - the debt from another budget's paid use (only budget uses owe, 2026-10-06) */
      const b2 = await openBudget(device, 1, 'okt: a debt while held', { signal });
      const pl2 = agentPayload('okt held: paid by the other budget');
      assert.equal(await armFor(device, (await head(device, { signal })).head, pl2, { signal }), 'EDGE:00');
      const p = await selfPressedSign(device, pl2, { signal });
      const resumeReq = (headBytes) => Buffer.concat([u32(b.grantId), Buffer.from(headBytes)]);
      assert.equal(await edge(device, GRANT_RESUME, resumeReq((await head(device, { signal })).head), { signal, text: true }), 'EDGE:0C', 'resume went through while a ticket was owed');
      const t = await ticket(device, p.seq, 'okt: paid while held', { signal });

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
      /* the debt was the other budget's paid use: ARMED and OWES */
      const pl = ops.find((x) => x.seq === p.seq);
      assert.equal(JSON.stringify([pl.decision, pl.grantId, pl.flags & (OWES_TICKET | ARMED)]), JSON.stringify([SELF_PRESS, b2.grantId, OWES_TICKET | ARMED]), 'the debt is not the other budget\'s paid use');
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
      await edge(device, GRANT_REVOKE, u32(b2.grantId), { signal, text: true }).catch(() => {}); /* used up: it may have ended at its ticket */
    });

  /*
   * Only budget uses owe (spec session, 2026-10-06) and nothing ARMs while one is
   * owed (R18), so the key owes at most one ticket at a time: the old "past 4 owed,
   * the overflow" case cannot arise any more. One owed budget use is waived.
   */
  it('edge: WAIVE takes a press; a restart keeps the debt; an unpressed waive does nothing (R16, R18)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const before = await head(device, { signal });
      await openBudget(device, 1, 'okt: one use, to be waived', { signal }); /* the restart ends it; the debt stays */
      const plw = agentPayload('okt waive 0');
      assert.equal(await armFor(device, (await head(device, { signal })).head, plw, { signal }), 'EDGE:00');
      const uses = [await selfPressedSign(device, plw, { signal })];
      let h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.overflow]), '[1,0]', 'the budget use does not owe its ticket');
      /* picked up now: a restart keeps only the latest link in RAM, as a host's copy would */
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;
      const kept = await pickup(device, first, h.seq - first + 1, { signal });

      /* a restart (lock) does not clear a debt */
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      h = await head(device, { signal });
      assert.equal(JSON.stringify([h.owed, h.overflow]), '[1,0]', 'the restart cleared the debt');

      /* unpressed, the waive does nothing */
      const primed = device.log.count(PRIMED);
      device.sendVendor({ msg: OKEDGE, slot: WAIVE, payload: Buffer.alloc(0) });
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal }).catch(() => {});
      await device.sleep(23000, { signal });
      h = await head(device, { signal });
      assert.equal(h.owed, 1, 'a waive nobody pressed cleared the debt');

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
      assert.equal(JSON.stringify([wl.op, wl.decision, wl.flags & PRESS_OBSERVED, wl.grantId]), JSON.stringify([OP_TICKET, NEEDS_REVIEW, PRESS_OBSERVED, uses[0].seq]));
      assert.bytes(Buffer.from(wl.subject), Buffer.from(tickets.waiveSubject(uses.map((u) => u.seq), false)), 'the waive subject does not list what it waived');
      const paired = tickets.pairTickets(links);
      assert.equal(paired.uses.find((u) => u.seq === uses[0].seq).status, 'waived', `use #${uses[0].seq}`);
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

      /* a backup key, which takes config mode - first, as its restart would end the covering budget */
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

      /*
       * Only Edge's own records are links and only budget uses owe (2026-10-06): the
       * debt at the backup is a budget's paid use; the links after it are that use's
       * ticket and a new budget's opening; the key's own link while restoring is the
       * real ticket for the owed use (TICKET is taken while restoring and closes replay).
       */
      await openBudget(device, 2, 'okt: a debt before the backup', { signal });
      const plb = agentPayload('okt edge before the backup');
      assert.equal(await armFor(device, (await head(device, { signal })).head, plb, { signal }), 'EDGE:00');
      const owedAtBackup = await selfPressedSign(device, plb, { signal });
      const atBackup = await head(device, { signal });
      const backupDeviceId = deviceIdOf(await pubkey(device, { signal }));
      assert.equal(atBackup.owed, 1);

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
      require('fs').writeFileSync(keep, JSON.stringify({
        passphrase: PASSPHRASE, slot: 2, label: 'edgebkup', data: Buffer.from(parsed.data).toString('hex'),
        /* R28: the chain this backup came from - the next run restores it onto "another device" */
        edge: { deviceId: Buffer.from(backupDeviceId).toString('hex'), seq: atBackup.seq, head: Buffer.from(atBackup.head).toString('hex'), owed: [owedAtBackup.seq] },
      }));
      log(`kept for the older-firmware restore: ${keep}`);

      /* two links the backup does not have - the host's copy holds them, each with the key's vouch tag */
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const vouchOf = (r) => ({ seq: r.readUInt32LE(0), head: new Uint8Array(r.subarray(4, 36)), tag: Buffer.from(r.subarray(36, 52)) });
      const l1 = { seq: (await ticket(device, owedAtBackup.seq, 'okt: paid after the backup', { signal })).seq };
      const v1 = vouchOf((await edge(device, VOUCH, null, { signal }))[0]);
      const l2 = { seq: (await openBudget(device, 1, 'okt: opened after the backup', { signal })).chainSeq };
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
      /* REPLAY: 47 link bytes (R3: through byte 46, the scope) + the first 8 of the head the copy stored after it */
      /* R3 (2026-10-06): the version byte (link byte 63) follows the head's 8 bytes - as the lib's replay() sends it */
      const replayReq = (link, headBytes) => Buffer.concat([Buffer.from(link).subarray(0, 47), Buffer.from(headBytes).subarray(0, 8), Buffer.from(link).subarray(63, 64)]);
      const replay = (link, headBytes) => edge(device, REPLAY, replayReq(link, headBytes), { signal, text: true });
      const replayDone = (seq, tag, newest, opts = {}) =>
        edge(device, REPLAY_DONE, Buffer.concat([u32(seq), Buffer.from(tag), u32(newest)]), { signal, press: true, ...opts });

      /* ---- 1. invented links ---- */
      let after = await restore('restore 1');
      assert.equal(await edge(device, VOUCH, null, { signal, text: true }), 'EDGE:0E', 'the key vouched while restoring');
      assert.equal(await edge(device, CHECKPOINT, null, { signal, text: true }), 'EDGE:0E', 'the key signed a checkpoint while restoring');
      assert.equal(await edge(device, LOSS, Buffer.concat([u32(0), u32(0)]), { signal, text: true }), 'EDGE:0E', 'a standalone LOSS went through while restoring');
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
      /* a link of the key's own (the real ticket for the owed use) writes onto the backup's head, throws the tentative replay away and closes replay */
      const own = { seq: (await ticket(device, owedSeq, 'okt: paid while restoring', { signal })).seq };
      assert.equal(own.seq, atBackup.seq + 1, 'the key\'s own link is not on the backup\'s head');
      assert.equal(await replay(c1.link, c1.head), 'EDGE:10', 'replay stayed open after the key wrote its own link');
      /* and a forged tag commits nothing: EDGE:11, LOSS since the backup */
      assert.equal(await replayDone(atBackup.seq + 2, Buffer.alloc(16, 7), lost.seq, { text: true }), 'EDGE:11', 'a forged vouch was taken');
      h = await head(device, { signal });
      assert.equal(h.restoring, 0, 'still restoring after REPLAY_DONE');
      assert.equal(h.owed, atBackup.owed - 1, 'the real ticket written while restoring did not pay its debt (the invented ones were checked above)');
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
      assert.equal(h.owed, atBackup.owed - 1, 'the vouched link (the ticket) did not pay its debt');
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
        { op: OP_SIGN, slot: 222, cap: 1, label: OKT_LABEL },
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

  /*
   * R19 NOT BUILT (spec session, 2026-10-03: the agent's commit key is a
   * derived classic key - D2 - so R19 waits; prove today's behaviour). A
   * composite PQC-PGP signature is TWO OKSIGNs to the RSA slot holding the
   * key: [0x00 | digest] -> Ed25519 (64 B), [0x01 | digest] -> ML-DSA-65
   * (3309 B). Under a budget covering that slot the first half is ARMed and
   * self-pressed, and OWES its ticket (R16); so the second half cannot be
   * ARMed (R18: nothing automatic while a ticket is owed) and goes through
   * only with a physical press - a pressed link, not paid by the budget.
   */
  it('edge: a composite signature under a budget today - the first half is paid and owes its ticket, so the second half needs an ordinary press, no link (R19 not built)',
    async ({ device, assert, signal, log }) => {
      const { pqc } = ctx.kit;
      const RSA_SLOT = 1;
      const PQC_PGP_KEYTYPE_BYTE = 0x67; /* KEYTYPE_PQC_PGP | DECRYPT | SIGN */
      const blob = crypto.randomBytes(160);
      await pqc.readyForKeygen(device, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: RSA_SLOT, field: 22, payload: Buffer.from([1]) }); /* a single press, not a code */
      await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 8000, signal });
      since = device.mark(ctx.IFACE.VENDOR);
      for (let i = 0; i < blob.length; i += 57) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKSETPRIV, slot: RSA_SLOT, field: PQC_PGP_KEYTYPE_BYTE, payload: blob.subarray(i, i + 57) });
        await device.sleep(150, { signal });
      }
      const ack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 15000, signal });
      assert.ok(!/^Error/.test(ctx.okmsg.text(ack).trim()), `loading the composite key failed: ${ctx.okmsg.text(ack)}`);
      await device.sleep(500, { signal });
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });

      const b = await openBudget(device, [{ op: OP_SIGN, slot: RSA_SLOT, cap: 2 }], 'okt: a composite signature', { signal });
      const digest = sha256(Buffer.from('okt edge composite commit'));
      const collect = async (sent, want, ms) => {
        const deadline = Date.now() + ms;
        let out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        while (out.length < want && Date.now() < deadline) {
          await device.sleep(100, { signal });
          out = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent));
        }
        return out.subarray(0, want);
      };

      /* half 1, Ed25519: ARMed, the budget pays, and it owes its ticket */
      const half1 = Buffer.concat([Buffer.from([0x00]), digest]);
      let h = await head(device, { signal });
      assert.equal(await armFor(device, h.head, half1, { signal }), 'EDGE:00', 'half 1: ARM refused');
      let sent = device.mark(ctx.IFACE.VENDOR);
      sendChunked(device, ctx.okmsg.MSG.OKSIGN, RSA_SLOT, half1);
      assert.equal((await collect(sent, 64, 10000)).length, 64, 'half 1: no Ed25519 signature');
      let after = await headPast(device, h.seq, { signal });
      const f1 = chain.decodeLink((await pickup(device, after.seq, 1, { signal }))[0].link);
      log(`half 1: #${f1.seq} decision ${f1.decision} flags ${f1.flags} grant ${f1.grantId}`);
      assert.equal(JSON.stringify([f1.decision, f1.grantId, f1.flags & OWES_TICKET]), JSON.stringify([SELF_PRESS, b.grantId, OWES_TICKET]), 'half 1: not a self-press that owes its ticket');

      /* half 2, ML-DSA-65: the ARM is refused while half 1's ticket is owed (R18) ... */
      const half2 = Buffer.concat([Buffer.from([0x01]), digest]);
      h = await head(device, { signal });
      const arm2 = await armFor(device, h.head, half2, { signal });
      assert.notEqual(arm2, 'EDGE:00', 'half 2 was ARMed while half 1 owed its ticket');
      log(`half 2: ARM refused ${arm2}`);
      /*
       * ... so it waits for a physical press - an ORDINARY press (2026-10-06): not
       * the budget's, not Edge, no link, nothing owed; half 1 is still the only debt
       */
      sent = device.mark(ctx.IFACE.VENDOR);
      sendChunked(device, ctx.okmsg.MSG.OKSIGN, RSA_SLOT, half2);
      await device.sleep(1500, { signal });
      assert.equal(Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, sent)).length >= 3309, false, 'half 2 was signed without a press');
      device.press(1);
      assert.equal((await collect(sent, 3309, 20000)).length, 3309, 'half 2: no ML-DSA-65 signature after the press');
      const h2 = await head(device, { signal });
      log(`half 2: head #${h2.seq} owed ${h2.owed}`);
      assert.equal(h2.seq, h.seq, 'half 2 (an ordinary press) wrote a link');
      assert.equal(h2.owed, 1, 'half 2 owes, or half 1\'s debt went');

      /* half 1's ticket, then the budget ends */
      await ticket(device, f1.seq, 'okt: composite half 1', { signal });
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

  /* R11 (Brad, 2026-10-02: back to 1024): a budget of 1024 uses opens - G is 1,024 hashes - and 1025 is refused */
  it('edge: a budget of 1024 uses opens at a press; 1025 is refused (R11)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      let h = await head(device, { signal });
      /* encoded by hand: the library already refuses 1025 on the host - this is the firmware's own check */
      const raw = (caps) => {
        const req = Buffer.alloc(58);
        req[0] = caps.length;
        caps.forEach(([slot, cap], i) => { req[1 + 4 * i] = OP_SIGN; req[2 + 4 * i] = slot; req.writeUInt16LE(cap, 3 + 4 * i); });
        sha256(Buffer.from('okt: too many')).copy(req, 17);
        Buffer.from(h.head).copy(req, 52, 0, 6);
        return req;
      };
      /* on stored slots (RSA2, ECC1): this is the use cap, not R11a's identity rule */
      assert.equal(await edge(device, GRANT_CREATE, raw([[2, 1025]]), { signal, text: true }), 'EDGE:04', 'a 1025-use budget was taken');
      assert.equal(await edge(device, GRANT_CREATE, raw([[2, 1000], [101, 25]]), { signal, text: true }), 'EDGE:04', 'two scopes summing to 1025 were taken');
      const b = await openBudget(device, 1024, 'okt: 1024 uses', { signal });
      log(`budget ${b.grantId}: ${b.uses} uses`);
      assert.equal(b.uses, 1024);
      /* G really is H^1024 of the seed: the first reveal hashes back to it in 1024 steps - checked on the first self-press */
      h = await head(device, { signal });
      const pl = agentPayload('okt: the first of 1024');
      assert.equal(await armFor(device, h.head, pl, { signal }), 'EDGE:00');
      const s1 = await selfPressedSign(device, pl, { signal });
      const [l] = await pickup(device, s1.seq, 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.decision, f.grantStep]), JSON.stringify([SELF_PRESS, 1]));
      const spend = { step: 1, value: l.reveal, subject: new Uint8Array(sha256(pl)), mac: new Uint8Array(crypto.createHmac('sha256', l.reveal).update(sha256(pl)).digest()) };
      assert.equal(JSON.stringify(grants.checkSpends(b.G, 1024, [spend])), '{"ok":true,"spent":1}', 'the first reveal of a 1024-use budget does not hash back to G');
      await ticket(device, s1.seq, 'okt: 1 of 1024', { signal });
      await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true });
    });

  /* R24: the person accepts a range as lost - a pressed link with the spec layout (the tab's red banner) */
  it('edge: LOSS {from, to} takes a press and links the accepted range; a range past the head is refused (R24)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      let h = await ensureChain(device, 12, { signal }); /* #2 must be out of the ring (8) */
      assert.equal(await edge(device, LOSS, Buffer.concat([u32(0), u32(h.seq + 5)]), { signal, text: true }), 'EDGE:12', 'a loss past the head was taken');
      assert.equal(await edge(device, LOSS, Buffer.concat([u32(2), u32(1)]), { signal, text: true }), 'EDGE:12', 'a backwards range was taken');
      const [r] = await edge(device, LOSS, Buffer.concat([u32(0), u32(1)]), { signal, press: true });
      const seq = r.readUInt32LE(0);
      h = await head(device, { signal });
      assert.equal(seq, h.seq);
      const [l] = await pickup(device, seq, 1, { signal });
      const f = chain.decodeLink(l.link);
      /* #2 is long out of the key's ring (8) by now, so the LOSS names no next link: zeros */
      assert.ok(seq - 1 - 2 >= 8, `the story is too short for #2 to be out of the ring (head #${seq - 1})`);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId, f.grantStep, Buffer.from(f.subject).readUInt32LE(0), Buffer.from(f.subject).subarray(4).every((x) => x === 0)]),
        JSON.stringify([11, APPROVE, 0, PRESS_OBSERVED, 0, 0, 1, true]), 'the LOSS link is not the spec layout');

      /*
       * R24 (Brad, 2026-10-02): when the key holds link to+1 - its latest, or one
       * in the ring - the subject carries the first 28 bytes of SHA-256 of it,
       * from the key's own memory.
       */
      const named = async (to) => {
        const [want] = await pickup(device, to + 1, 1, { signal });
        const [rr] = await edge(device, LOSS, Buffer.concat([u32(to), u32(to)]), { signal, press: true });
        const [ll] = await pickup(device, rr.readUInt32LE(0), 1, { signal });
        const sub = Buffer.from(chain.decodeLink(ll.link).subject);
        assert.equal(sub.readUInt32LE(0), to);
        assert.bytes(sub.subarray(4), sha256(Buffer.from(want.link)).subarray(0, 28));
      };
      h = await head(device, { signal });
      await named(h.seq - 1); /* to+1 = the latest link */
      h = await head(device, { signal });
      await named(h.seq - 3); /* to+1 = a link in the ring */
    });

  /*
   * mcp-service.md 4.7a (2026-10-03): an agent's key is registered once, WITH A
   * PRESS - like a known peer (R20). The key links it: op agent-add (15), the
   * press flag, subject = SHA256("OKEDGE-AGENT-v1" || key). No press, no link.
   */
  it('edge: AGENT_ADD takes a press and links the agent key; no press, no link (4.7a)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const key = crypto.randomBytes(32);
      const before = await head(device, { signal });
      /* nobody presses: whatever the key answers (a timeout, or nothing), past its 25 s wait nothing is linked */
      await edge(device, AGENT_ADD, key, { signal, text: true }).catch(() => null);
      await device.sleep(26000, { signal });
      assert.equal((await head(device, { signal })).seq, before.seq, 'an unpressed AGENT_ADD wrote a link');
      const [r] = await edge(device, AGENT_ADD, key, { signal, press: true });
      const seq = r.readUInt32LE(0);
      const [l] = await pickup(device, seq, 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId]), JSON.stringify([15, APPROVE, 0, PRESS_OBSERVED, 0]), 'the agent-add link is not the spec layout');
      assert.bytes(Buffer.from(f.subject), Buffer.from(grants.agentSubject(key)));
    });

  /*
   * R20 (okedge sync phase 2, P2a, Brad 2026-10-05): the places a sync may send
   * copies to are the KEY's list, added and removed only with a press, each a
   * link. The subject is checked against Node's own SHA-256 of X || Y, not the
   * lib's, so the two sides are not checking themselves.
   */
  /*
   * Sync phase 2 (spec, 2026-10-05): every approved sync writes a sync link -
   * op 20, the press flag, no ticket owed - and the KEY computes its subject
   * from three parts: SHA256("OKEDGE-SYNC-v1" || SHA256(peer pubkey) || first
   * || last || the copy's head after the merge || SHA256(Key Chain list) or
   * zeros), checking the peer is on its own list. THE SAME VECTOR the lib pins
   * (node-onlykey-lib test/edge-sync-phase2.test.js): peer = the P-256
   * generator, #268..#269, head 0xab x 32, no Key Chain list ->
   * b3966f6a90ea2c6ed3ba38af8614de19e54c322bbbbd30dbfa161dcbc3cb2470.
   */
  it('edge: SYNC computes the spec subject from its three parts (the shared vector), takes a press, owes no ticket; a stranger or a part out of order is refused',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const G = Buffer.from('6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5', 'hex');
      const sha = (b) => crypto.createHash('sha256').update(b).digest();
      const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
      const part = (n, bytes, opts) => edge(device, SYNC, Buffer.concat([Buffer.of(n), bytes]), { signal, ...opts });
      const list = async () => { const [h, ...slots] = await edge(device, PEER_LIST, null, { signal, reports: 5 }); return slots.slice(0, h[0]).map((r) => Buffer.from(r.subarray(0, 64)).toString('hex')); };
      /* the vector's place on the list (removed again at the end) */
      if (!(await list()).includes(G.toString('hex'))) {
        assert.equal(await edge(device, PEER_ADD, Buffer.concat([Buffer.of(0), G.subarray(0, 32)]), { signal, text: true }), 'EDGE:00');
        await edge(device, PEER_ADD, Buffer.concat([Buffer.of(1), G.subarray(32)]), { signal, press: true });
      }
      /* a place NOT on the list, a part out of order, first > last: refused, nothing staged */
      assert.equal(await part(0, Buffer.concat([sha(Buffer.alloc(64, 7)), u32(268), u32(269)]), { text: true }), 'EDGE:16', 'a stranger was not refused');
      assert.equal(await part(1, Buffer.alloc(32, 0xab), { text: true }), 'EDGE:17', 'a part out of order was not refused');
      assert.equal(await part(0, Buffer.concat([sha(G), u32(269), u32(268)]), { text: true }), 'EDGE:12', 'first > last was not refused');
      const before = await head(device, { signal });
      /* unpressed: nothing linked */
      assert.equal(await part(0, Buffer.concat([sha(G), u32(268), u32(269)]), { text: true }), 'EDGE:00');
      assert.equal(await part(1, Buffer.alloc(32, 0xab), { text: true }), 'EDGE:00');
      await part(2, Buffer.alloc(32), { text: true }).catch(() => null);
      await device.sleep(26000, { signal });
      assert.equal((await head(device, { signal })).seq, before.seq, 'an unpressed SYNC wrote a link');
      /* pressed: the link carries the vector */
      assert.equal(await part(0, Buffer.concat([sha(G), u32(268), u32(269)]), { text: true }), 'EDGE:00');
      assert.equal(await part(1, Buffer.alloc(32, 0xab), { text: true }), 'EDGE:00');
      const [r] = await part(2, Buffer.alloc(32), { press: true });
      const [l] = await pickup(device, r.readUInt32LE(0), 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId]), JSON.stringify([20, APPROVE, 0, PRESS_OBSERVED, 0]), 'the sync link is not the spec layout');
      assert.equal(Buffer.from(f.subject).toString('hex'), 'b3966f6a90ea2c6ed3ba38af8614de19e54c322bbbbd30dbfa161dcbc3cb2470', 'the key subject is not the shared vector');
      assert.equal((await head(device, { signal })).owed, before.owed, 'a sync link made the key owe a ticket');
      const at = (await list()).indexOf(G.toString('hex'));
      await edge(device, PEER_REMOVE, Buffer.of(at), { signal, press: true });
    });

  /*
   * R29 (P2b): another key that is yours, paired with a press. Subject =
   * SHA256("OKEDGE-SIBLING-v1" || key X || Y || device id), computed here with
   * node:crypto, not the lib. The key refuses itself, an id that is not the
   * key's own, a known sibling; no press, no link; removal is a press too.
   */
  it('edge: SIBLING_ADD / SIBLING_REMOVE take a press and link the sibling (R29); itself, a wrong id, a known key are refused',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const sha = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
      const idOf = (key) => sha(Buffer.from('OKEDGE-DEVICE-v1'), key).subarray(0, 16);
      const part = (n, bytes, opts) => edge(device, SIBLING_ADD, Buffer.concat([Buffer.of(n), bytes]), { signal, ...opts });
      const add = async (key, id, opts) => {
        assert.equal(await part(0, key.subarray(0, 32), { text: true }), 'EDGE:00', 'part 0 (X) was not staged');
        return part(1, Buffer.concat([key.subarray(32), id]), opts);
      };
      const list = async () => {
        const [h, ...slots] = await edge(device, SIBLING_LIST, null, { signal, reports: 5 });
        return slots.slice(0, h[0]).map((r) => Buffer.from(r.subarray(0, 64)).toString('hex'));
      };
      for (let l = await list(); l.length; l = await list()) await edge(device, SIBLING_REMOVE, Buffer.of(0), { signal, press: true });
      const e = crypto.createECDH('prime256v1'); e.generateKeys();
      const key = e.getPublicKey().subarray(1);
      const [own] = await edge(device, PUBKEY, null, { signal });
      const self = Buffer.from(own.subarray(0, 64));
      assert.equal(await add(self, idOf(self), { text: true }), 'EDGE:15', 'the key took itself as a sibling');
      assert.equal(await add(key, Buffer.alloc(16, 9), { text: true }), 'EDGE:15', 'an id that is not the key\'s own was taken');
      const before = await head(device, { signal });
      await add(key, idOf(key), { text: true }).catch(() => null);
      await device.sleep(26000, { signal });
      assert.equal((await head(device, { signal })).seq, before.seq, 'an unpressed SIBLING_ADD wrote a link');
      const [r] = await add(key, idOf(key), { press: true });
      const [l] = await pickup(device, r.readUInt32LE(0), 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId]), JSON.stringify([17, APPROVE, 0, PRESS_OBSERVED, 0]), 'the sibling link is not the R29 layout');
      assert.bytes(Buffer.from(f.subject), sha(Buffer.from('OKEDGE-SIBLING-v1'), key, idOf(key)));
      assert.equal(JSON.stringify(await list()), JSON.stringify([key.toString('hex')]));
      assert.equal(await add(key, idOf(key), { text: true }), 'EDGE:18', 'a known sibling was not refused');
      const [rr] = await edge(device, SIBLING_REMOVE, Buffer.of(0), { signal, press: true });
      const [lr] = await pickup(device, rr.readUInt32LE(0), 1, { signal });
      const fr = chain.decodeLink(lr.link);
      assert.equal(JSON.stringify([fr.op, fr.flags & PRESS_OBSERVED]), JSON.stringify([18, PRESS_OBSERVED]), 'the sibling-remove link is not the R29 layout');
      assert.bytes(Buffer.from(fr.subject), sha(Buffer.from('OKEDGE-SIBLING-v1'), key, idOf(key)));
      assert.equal((await list()).length, 0);
      assert.equal(await edge(device, SIBLING_REMOVE, Buffer.of(0), { signal, text: true }), 'EDGE:1A');
    });

  /*
   * R30 (P2c): an ANCHOR commits to a sibling's SIGNED checkpoint. The sibling
   * here is a node:crypto P-256 key, paired with a press; its checkpoint is
   * signed with node:crypto over SHA256("OKEDGE-CKPT-v1" || its id || seq ||
   * head) - the same message the key signs its own. The key checks it (a bad
   * one is EDGE:1B, nothing waits), then a press writes op 19, slot = the
   * sibling's index, grant_id = its seq, subject = SHA256("OKEDGE-ANCHOR-v1" ||
   * id || seq || head || signature). No sibling there is EDGE:1A, parts out of
   * order EDGE:17.
   */
  it('edge: ANCHOR checks the sibling\'s signed checkpoint, takes a press and links op 19 (R30); a bad signature, no sibling, a part out of order are refused',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const sha = (...b) => crypto.createHash('sha256').update(Buffer.concat(b)).digest();
      const idOf = (key) => sha(Buffer.from('OKEDGE-DEVICE-v1'), key).subarray(0, 16);
      const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
      const list = async () => {
        const [h, ...slots] = await edge(device, SIBLING_LIST, null, { signal, reports: 5 });
        return slots.slice(0, h[0]).map((r) => Buffer.from(r.subarray(0, 64)).toString('hex'));
      };
      for (let l = await list(); l.length; l = await list()) await edge(device, SIBLING_REMOVE, Buffer.of(0), { signal, press: true });
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
      const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-64);
      const id = idOf(key);
      const add = (n, bytes, opts) => edge(device, SIBLING_ADD, Buffer.concat([Buffer.of(n), bytes]), { signal, ...opts });
      assert.equal(await add(0, key.subarray(0, 32), { text: true }), 'EDGE:00');
      await add(1, Buffer.concat([key.subarray(32), id]), { press: true });
      assert.equal((await list()).length, 1, 'the sibling was not paired');
      const seq = 41;
      const ckHead = crypto.randomBytes(32);
      const sig = crypto.sign('sha256', Buffer.concat([Buffer.from('OKEDGE-CKPT-v1'), id, u32(seq), ckHead]), { key: privateKey, dsaEncoding: 'ieee-p1363' });
      const part = (n, bytes, opts) => edge(device, ANCHOR, Buffer.concat([Buffer.of(n), bytes]), { signal, ...opts });
      const send = async (index, signature, opts) => {
        assert.equal(await part(0, Buffer.concat([Buffer.of(index), u32(seq), ckHead]), { text: true }), 'EDGE:00', 'part 0 was not staged');
        assert.equal(await part(1, signature.subarray(0, 32), { text: true }), 'EDGE:00', 'part 1 was not staged');
        return part(2, signature.subarray(32), opts);
      };
      assert.equal(await part(0, Buffer.concat([Buffer.of(1), u32(seq), ckHead]), { text: true }), 'EDGE:1A', 'an index with no sibling was taken');
      assert.equal(await part(2, sig.subarray(32), { text: true }), 'EDGE:17', 'a last part with nothing staged was taken');
      const bad = Buffer.from(sig); bad[5] ^= 1;
      const before = await head(device, { signal });
      assert.equal(await send(0, bad, { text: true }), 'EDGE:1B', 'a bad checkpoint signature was taken');
      assert.equal((await head(device, { signal })).seq, before.seq, 'a refused anchor wrote a link');
      const [r] = await send(0, sig, { press: true });
      const [l] = await pickup(device, r.readUInt32LE(0), 1, { signal });
      const fl = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([fl.op, fl.decision, fl.slot, fl.flags & PRESS_OBSERVED, fl.grantId]), JSON.stringify([19, APPROVE, 0, PRESS_OBSERVED, seq]), 'the anchor link is not the R30 layout');
      assert.bytes(Buffer.from(fl.subject), sha(Buffer.from('OKEDGE-ANCHOR-v1'), id, u32(seq), ckHead, sig));
      await edge(device, SIBLING_REMOVE, Buffer.of(0), { signal, press: true });
      assert.equal((await list()).length, 0);
    });

  it('edge: PEER_ADD / PEER_REMOVE take a press and link the peer; PEER_LIST survives a restart; no press, no peer (R20)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const list = async () => {
        const [h, ...slots] = await edge(device, PEER_LIST, null, { signal, reports: 5 });
        return { n: h[0], k: h[1], max: h[2], keys: slots.slice(0, h[0]).map((r) => Buffer.from(r.subarray(0, 64)).toString('hex')) };
      };
      /* start from no peers: a run before this one may have left some */
      for (let l = await list(); l.n > 0; l = await list()) await edge(device, PEER_REMOVE, Buffer.of(0), { signal, press: true });
      const ecdh = () => { const e = crypto.createECDH('prime256v1'); e.generateKeys(); return e; };
      const a = ecdh(), b = ecdh();
      const xy = (e) => e.getPublicKey().subarray(1);
      /* two parts: X staged (no press), then Y and the press */
      const part = (n, bytes, opts) => edge(device, PEER_ADD, Buffer.concat([Buffer.of(n), bytes]), { signal, ...opts });
      const add = async (e, opts) => {
        assert.equal(await part(0, xy(e).subarray(0, 32), { text: true }), 'EDGE:00', 'part 0 (X) was not staged');
        return part(1, xy(e).subarray(32), opts);
      };
      const before = await head(device, { signal });
      /* nobody presses: past the key's 25 s wait nothing is linked and nothing listed */
      await add(a, { text: true }).catch(() => null);
      await device.sleep(26000, { signal });
      assert.equal((await head(device, { signal })).seq, before.seq, 'an unpressed PEER_ADD wrote a link');
      assert.equal((await list()).n, 0, 'an unpressed PEER_ADD listed a peer');
      const [r] = await add(a, { press: true });
      const [l] = await pickup(device, r.readUInt32LE(0), 1, { signal });
      const f = chain.decodeLink(l.link);
      assert.equal(JSON.stringify([f.op, f.decision, f.slot, f.flags & PRESS_OBSERVED, f.grantId]), JSON.stringify([9, APPROVE, 0, PRESS_OBSERVED, 0]), 'the peer-add link is not the spec layout');
      assert.bytes(Buffer.from(f.subject), crypto.createHash('sha256').update(xy(a)).digest());
      assert.equal(await add(a, { text: true }), 'EDGE:14', 'the same peer twice was not refused');
      assert.equal(await part(0, Buffer.alloc(32, 0xee), { text: true }), 'EDGE:00');
      assert.equal(await part(1, Buffer.alloc(32, 0xee), { text: true }), 'EDGE:15', 'a point off the curve was not refused');
      assert.equal(await part(1, xy(b).subarray(32), { text: true }), 'EDGE:15', 'a Y without its X was not refused');
      /*
       * The spec (2026-10-05): the press binds the WHOLE key - a new X while
       * another key waits for its press resets it. Key c's X and Y go in, its
       * press is pending; b's X arrives, then b's Y and the press: the link is
       * b's, and c is never listed.
       */
      const c = ecdh();
      assert.equal(await part(0, xy(c).subarray(0, 32), { text: true }), 'EDGE:00');
      device.sendVendor({ msg: OKEDGE, slot: PEER_ADD, payload: Buffer.concat([Buffer.of(1), xy(c).subarray(32)]) });
      await device.sleep(800, { signal });
      const [rb] = await add(b, { press: true });
      const [lb] = await pickup(device, rb.readUInt32LE(0), 1, { signal });
      assert.bytes(Buffer.from(chain.decodeLink(lb.link).subject), crypto.createHash('sha256').update(xy(b)).digest());
      await device.restart({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const kept = await list();
      assert.equal(JSON.stringify([kept.n, kept.k, kept.max]), JSON.stringify([2, 0, 4]), 'the peer list did not survive a restart');
      assert.equal(JSON.stringify(kept.keys), JSON.stringify([xy(a), xy(b)].map((k) => k.toString('hex'))));
      const [rr] = await edge(device, PEER_REMOVE, Buffer.of(0), { signal, press: true });
      const [lr] = await pickup(device, rr.readUInt32LE(0), 1, { signal });
      const fr = chain.decodeLink(lr.link);
      assert.equal(JSON.stringify([fr.op, fr.slot, fr.flags & PRESS_OBSERVED]), JSON.stringify([10, 0, PRESS_OBSERVED]), 'the peer-remove link is not the spec layout');
      assert.bytes(Buffer.from(fr.subject), crypto.createHash('sha256').update(xy(a)).digest());
      assert.equal(JSON.stringify((await list()).keys), JSON.stringify([xy(b).toString('hex')]), 'the later peer did not move down');
      assert.equal(await edge(device, PEER_REMOVE, Buffer.of(3), { signal, text: true }), 'EDGE:16');
      await edge(device, PEER_REMOVE, Buffer.of(0), { signal, press: true });
    });

  /*
   * R11a (2026-10-02, found when Brad's GitHub login signed on slot 201): a
   * budget on a derived code covers ONE identity. A budget for the test
   * identity never pays for, or makes owe, a use of another identity on the
   * same code - Brad's own logins on 201 stay his.
   */
  it('edge: a budget on a derived code covers one identity - another identity on the same code is neither paid for nor made to owe (R11a)',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const other = sha256(Buffer.from('okt someone else'));
      const payloadAs = (text, label) => Buffer.concat([sha256(Buffer.from(text)), label]);
      /* read each link right after the use that made it: the key holds only its last 8 */
      const fieldsOf = async (seq) => chain.decodeLink((await pickup(device, seq, 1, { signal }))[0].link);

      /* no label staged: a derived-code scope is refused (EDGE:03); stored slots never needed one */
      const h0 = await head(device, { signal });
      assert.equal(await edge(device, GRANT_CREATE, grantRequest(2, sha256(Buffer.from('r')), h0.head), { signal, text: true }), 'EDGE:03',
        'a budget on a derived code without an identity was taken');

      /* a live budget for OKT_LABEL: direct presses by either identity are ordinary - no link, nothing owed (2026-10-06) */
      const b = await openBudget(device, 2, 'okt: the test identity, 2 signs', { signal });
      const hb = await head(device, { signal });
      const sendDirect = async (text, payload) => {
        const primed = device.log.count(PRIMED);
        const since = device.mark(ctx.IFACE.VENDOR);
        sendChunked(device, ctx.okmsg.MSG.OKSIGN, 222, payload);
        await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
        await device.sleep(500, { signal });
        device.press(1);
        await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
      };
      await sendDirect('theirs', payloadAs('okt other identity, direct', other));
      await sendDirect('ours', agentPayload('okt our identity, direct'));
      const hd = await head(device, { signal });
      assert.equal(JSON.stringify([hd.seq, hd.owed]), JSON.stringify([hb.seq, 0]), 'a direct press (either identity) wrote a link or owes');

      /* an ARM for another identity's request: the budget cannot pay for it - refused (R13a), never self-pressed or pressed */
      const plOther = payloadAs('okt other identity, armed', other);
      assert.equal(await armFor(device, hd.head, plOther, { signal }), 'EDGE:00');
      assert.equal(await refusedSign(device, plOther, { signal }), 'EDGE:0D', 'an ARM for another identity\'s request was not refused');
      assert.equal((await head(device, { signal })).seq, hd.seq, 'the refused sign wrote a link');
      const pl = agentPayload('okt our identity, armed');
      assert.equal(await armFor(device, (await head(device, { signal })).head, pl, { signal }), 'EDGE:00');
      const paid = await selfPressedSign(device, pl, { signal });
      const fp = await fieldsOf(paid.seq);
      log(trail([fp]));
      assert.equal(JSON.stringify([fp.decision, fp.grantId]), JSON.stringify([SELF_PRESS, b.grantId]), 'the budget did not pay for its own identity');
      await ticket(device, paid.seq, 'okt: ours, armed', { signal });
      assert.equal(await edge(device, GRANT_REVOKE, u32(b.grantId), { signal, text: true }), 'EDGE:00');
    });

  it('edge: a checkpoint is the Edge key\'s signature over the head',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const h = await ensureChain(device, 1, { signal }); /* an empty chain has no head to sign */
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

  /*
   * THE AGENT SERVICE ON THE REAL EDGE FIRMWARE (Edge Phase 2, build step 1 -
   * onlykey-edge daily-loop.md §5: "emulator first, no hardware"). The lib's
   * own edge-agent (cli/edge-agent.js) over the kit's emulator (the kit's
   * libstack), the phone's side in-process (approve.approveRequest), presses
   * by the emulator. A scratch repo: `git commit -S` inside `okedge exec`, an
   * ssh sign on the exec's endpoint bound to a pinned host - each a self-press
   * paid by the budget, each ticketed. And the must-fail-safely checks
   * (daily-loop §3): the shared endpoint is a press, a skipped ticket and a
   * stale head refuse the next exec before it runs, Hold refuses it too.
   */
  it('edge: the agent service on the emulator - a signed commit and an ssh sign paid by the budget and ticketed; the shared endpoint is a press; skipped ticket, stale head and Hold refuse the next exec',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      await clearDebts(device, { signal, log });
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const net = require('net');
      const { execFileSync } = require('child_process');
      const { request, approve, client, codes } = ctx.requireLib('node-onlykey-lib/edge');
      const { startEdgeAgent } = ctx.requireLib('node-onlykey-lib/cli/edge-agent');
      const okedge = ctx.requireLib('node-onlykey-lib/cli/okedge');
      const wire = ctx.requireLib('node-onlykey-lib/cli/ssh-wire');
      const bindLib = ctx.requireLib('node-onlykey-lib/cli/ssh-session-bind');
      const hexOf = (b) => Buffer.from(b).toString('hex');
      const pressSoon = () => { setTimeout(() => device.press(1), 900); };

      const lib = await ctx.kit.libstack.composeLib(device);
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'okt-edge-agent-'));
      const savedHome = process.env.OKEDGE_HOME;
      process.env.OKEDGE_HOME = home;
      let svc = null;
      try {
        const { okcrypto, transport } = lib.services;
        let edgeSvc = null;
        ctx.requireLib('node-onlykey-lib/plugins/edge')({ transport }, (err, s) => { if (err) throw err; edgeSvc = s.edge; });

        /* the phone, in-process: a registered agent key, Yes, and the press the key waits for */
        const agentKey = request.signerFromSecret(crypto.randomBytes(32));
        const seen = new Set();
        const channel = {
          async send(msg) {
            const r = await approve.approveRequest(msg, {
              edge: edgeSvc, registered: [hexOf(agentKey.publicKey)], seen, ask: async () => 'approve',
              verifyCopy: async () => ({ ok: true, head: (await edgeSvc.head()).head }), onPress: pressSoon, timeoutMs: 30000,
            });
            return r.dropped ? null : r;
          },
        };
        const c = client.createEdgeClient({ edge: edgeSvc, channel, signer: agentKey });

        /* a host key standing in for github.com, pinned */
        const hk = crypto.generateKeyPairSync('ed25519');
        const hostBlob = Buffer.concat([wire.string(Buffer.from('ssh-ed25519')), wire.string(hk.publicKey.export({ format: 'der', type: 'spki' }).subarray(12))]);
        const config = { ssh: 'ssh://claude@okt', gpgUid: 'Claude (okt agent) <claude@okt>', committer: { name: 'Claude (okt agent)', email: 'claude@okt' }, pins: [bindLib.fingerprint(hostBlob)] };
        svc = await startEdgeAgent({
          okcrypto, client: c, edge: edgeSvc, config, openpgp: ctx.requireLib('node-onlykey-lib/crypto/pgp'),
          shimCommand: path.join(path.dirname(ctx.resolveLib('node-onlykey-lib/package.json')), 'cli', 'edge-gpg-shim.js').split(path.sep).join('/'),
          log, confirm: pressSoon, /* the certificate's two signatures, and any plain sign: a press */
        });
        log(`ssh key: ${svc.sshLine}`);
        assert.ok(svc.fingerprint, 'the agent\'s PGP certificate was made');
        const lastLink = async () => { const h = await edgeSvc.head(); return chain.decodeLink((await edgeSvc.pickup(h.seq, 1))[0].link); };
        const run = async (args) => { const lines = []; const code = await okedge.main(args, { out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) }); log(lines.join(' | ')); return { code, lines }; };

        /* A1: one Yes + press for the work budget */
        let r = await run(['budget', '--reason', 'okt: commit and push', '--ssh', '3', '--gpg', '3', '--ttl', '30']);
        assert.equal(r.code, 0, r.lines.join('\n'));
        let head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* A4: a signed commit inside okedge exec - a self-press paid by the budget, then its ticket */
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'okt-edge-repo-'));
        execFileSync('git', ['-C', repo, 'init', '-q']);
        execFileSync('git', ['-C', repo, 'config', 'user.name', 'Claude (okt agent)']);
        execFileSync('git', ['-C', repo, 'config', 'user.email', 'claude@okt']);
        r = await run(['exec', '--head', head, '--reason', 'commit: okt edge', '--', 'git', '-C', repo, 'commit', '-q', '--allow-empty', '-S', '-m', 'okt: signed by the agent']);
        assert.equal(r.code, 0, r.lines.join('\n'));
        let f = await lastLink();
        assert.equal(JSON.stringify([f.decision, f.grantId !== 0]), JSON.stringify([codes.DECISION.SELF_PRESS, true]), 'the commit signature was not paid by the budget');
        assert.match(execFileSync('git', ['-C', repo, 'cat-file', 'commit', 'HEAD']).toString(), /\ngpgsig -----BEGIN PGP SIGNATURE-----/);
        let seq = Number(/link #(\d+)/.exec(r.lines.find((l) => l.startsWith('signed:')))[1]);
        r = await run(['ticket', String(seq), '--msg', 'committed okt: signed by the agent']);
        head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* A4: an ssh sign on the exec's endpoint, bound to the pinned host */
        const sshSign = async (sockPath, bound = true) => {
          const sid = crypto.randomBytes(32);
          const sig = crypto.sign(null, sid, hk.privateKey);
          const bind = Buffer.concat([Buffer.of(wire.MSG.EXTENSION), wire.string(Buffer.from(bindLib.SESSION_BIND)), wire.string(hostBlob), wire.string(sid),
            wire.string(Buffer.concat([wire.string(Buffer.from('ssh-ed25519')), wire.string(sig)])), Buffer.of(0)]);
          const data = Buffer.concat([wire.string(sid), Buffer.of(50), wire.string(Buffer.from('git')), wire.string(Buffer.from('ssh-connection'))]);
          const keyBlob = wire.publicKeyBlob('ed25519', Buffer.from(svc.sshLine.split(' ')[1], 'base64').subarray(19));
          const msgs = [...(bound ? [bind] : []), Buffer.concat([Buffer.of(wire.MSG.SIGN_REQUEST), wire.string(keyBlob), wire.string(data), wire.uint32(0)])];
          const sock = net.connect(sockPath);
          await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
          const replies = [];
          const feed = wire.createDeframer((m) => replies.push(m));
          sock.on('data', (d) => feed(d));
          for (const m of msgs) {
            const want = replies.length + 1;
            sock.write(wire.frame(m));
            const until = Date.now() + 30000;
            while (replies.length < want && Date.now() < until) await device.sleep(100, { signal });
          }
          sock.destroy();
          return replies[replies.length - 1];
        };
        const ex = await svc.agent.openExec({ head, reason: 'push okt to origin/master' });
        assert.equal((await sshSign(ex.sshPath))[0], wire.MSG.SIGN_RESPONSE);
        const [sshLink] = await ex.close();
        assert.equal(sshLink && sshLink.paid, true, 'the ssh sign was not paid by the budget');
        f = await lastLink();
        assert.equal(f.decision, codes.DECISION.SELF_PRESS);

        /* must fail safely: a skipped ticket refuses the next exec before it runs */
        r = await run(['exec', '--head', svc.agent.budget().head(), '--reason', 'skipped ticket', '--', 'git', '--version']);
        assert.equal(r.code, 1);
        assert.match(r.lines.join('\n'), /ticket owed for #/);
        r = await run(['ticket', String(sshLink.seq), '--msg', 'pushed okt']);
        head = r.lines.find((l) => l.startsWith('head = ')).slice(7);

        /* must fail safely: the shared endpoint is a press, never the budget - an ordinary press: no link, nothing owed (2026-10-06) */
        const before = await edgeSvc.head();
        assert.equal((await sshSign(svc.sharedPath))[0], wire.MSG.SIGN_RESPONSE);
        const after = await edgeSvc.head();
        assert.equal(after.seq, before.seq, 'the shared endpoint wrote a link (paid by the budget, or an ordinary press linked)');
        assert.equal(after.owed, 0, 'the press on the shared endpoint owes a ticket');

        /* must fail safely: a stale head; Hold from the phone */
        r = await run(['exec', '--head', '00'.repeat(32), '--reason', 'stale', '--', 'git', '--version']);
        assert.match(r.lines.join('\n'), /--head is not the budget's head/);
        await edgeSvc.hold(svc.agent.budget().grantId);
        r = await run(['exec', '--head', svc.agent.budget().head(), '--reason', 'held', '--', 'git', '--version']);
        assert.match(r.lines.join('\n'), /on hold/);

        r = await run(['end']);
        assert.match(r.lines.join('\n'), /ended/);
      } finally {
        if (svc) await svc.close();
        await lib.destroy();
        if (savedHome === undefined) delete process.env.OKEDGE_HOME; else process.env.OKEDGE_HOME = savedHome;
      }
    });

  /*
   * R28 (onlykey-edge firmware.md, decided 2026-10-04): one chain per physical
   * device. "Another device restored from the same backup" is exactly what this
   * file sees across two runs: every run starts from the kit's cached
   * 'initialized' snapshot (the same K132) but makes a NEW salt on its first Edge
   * request. So the backup the R26 test kept LAST run (read when this file loads), restored here, comes
   * from another device: the key must start its own chain with a continue link -
   * the next seq, on its own genesis, carrying the debts - and never write onto
   * the backup's chain (R26 replay is for a device's own chain only). LAST in the
   * file: the restore brings in that run's keys, which no later test expects.
   */
  it('edge: a backup from another device starts this device\'s own chain - a continue link first, the debts carried, never a second writer (R28)',
    async ({ device, assert, signal, log, skip }) => {
      /* read when this file was loaded: the R26 test above has since kept THIS run's backup */
      const kept = keptAtLoad;
      if (!kept) skip('no backup kept by an earlier run yet - the R26 test keeps one; run this file again');
      if (!kept.edge) skip('the kept backup predates R28 (it does not name its chain) - run this file again');
      const from = { deviceId: Buffer.from(kept.edge.deviceId, 'hex'), seq: kept.edge.seq, head: Buffer.from(kept.edge.head, 'hex'), owed: kept.edge.owed };

      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const mine = deviceIdOf(await pubkey(device, { signal }));
      assert.ok(!Buffer.from(mine).equals(from.deviceId), 'this run has the same Edge device id as the last one - the salt is not per device');

      /* the backup key the backup was made under, then the restore (config mode, as R26's) */
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      let since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({
        msg: ctx.okmsg.MSG.OKSETPRIV, slot: 131,
        payload: Buffer.concat([Buffer.from([161]), sha256(Buffer.from(kept.passphrase, 'utf8'))]),
      });
      const set = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Successfully|Error/, timeoutMs: 10000, signal });
      assert.match(ctx.okmsg.text(set), /Successfully set Backup Passphrase/);
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      await device.enterConfigMode(ctx.PINS.primary, { signal });
      const gen = device.generation;
      for (const payload of ctx.kit.backup.toRestorePackets(Buffer.from(kept.data, 'hex'))) {
        device.sendVendor({ msg: ctx.okmsg.MSG.OKRESTORE, payload });
        await device.sleep(50, { signal });
      }
      await device.waitForReboot({ from: gen, timeoutMs: 90000, signal });
      await device.waitReady({ signal });
      await device.ensureUnlocked(ctx.PINS.primary, { signal });

      const h = await head(device, { signal });
      const pub = await pubkey(device, { signal });
      const id = deviceIdOf(pub);
      log(`restored a backup of chain ${kept.edge.deviceId} at #${from.seq} (owed ${from.owed.join(',')}): now chain ${Buffer.from(id).toString('hex')} at #${h.seq}, owed ${h.owed}, restoring ${h.restoring}`);
      assert.ok(!Buffer.from(id).equals(from.deviceId), 'the restored key took the backup\'s chain id - it would be a second writer of that chain');
      /* not "the same id as before": a restore brings back the backup's K132, and the id is HKDF(this device's salt, K132) - what must hold is that it is never the backup's chain (checked above) */
      assert.equal(h.restoring, 0, 'another device\'s backup put the key into R26 restoring - replay is for its own chain only');
      assert.equal(h.seq, from.seq + 1, 'the continue link is not the next seq after the backup\'s head');
      assert.equal(h.owed, from.owed.length, 'the debts did not carry into the new chain');

      const [c] = await pickup(device, h.seq, 1, { signal });
      const f = chain.decodeLink(c.link);
      assert.equal(f.op, 16, 'the first link is not a continue');
      assert.equal(f.grantId, from.owed.length, 'grant_id is not the number of debts carried');
      assert.equal(f.flags, 0);
      const seqs = from.owed.map((n) => u32(n));
      const want = sha256(Buffer.concat([Buffer.from('OKEDGE-CONTINUE-v1'), from.deviceId, u32(from.seq), from.head, ...seqs]));
      assert.bytes(Buffer.from(f.subject), want, 'the continue subject does not commit to the backup\'s chain, head and debts');
      assert.bytes(Buffer.from(c.head), Buffer.from(chain.weld(chain.genesis(id), c.link)), 'the continue is not welded onto this device\'s own genesis');
      assert.bytes(Buffer.from(h.head), Buffer.from(c.head));
    });
};
