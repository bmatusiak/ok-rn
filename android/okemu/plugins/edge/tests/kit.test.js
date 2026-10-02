'use strict';
/*
 * edge's emulator tests (the onlykey-testing kit), SIDE-LOADED from this folder
 * by 01-protocol/38-softkey-plugins.test.js when the emulator was built with
 * OKEMU_PLUGINS=edge. Step 1: the device chain.
 *
 * The truth is the LIBRARY's reading of the bytes (node-onlykey-lib/edge, via
 * ctx.requireLib - the kit's pinned lib): a chain the firmware writes must
 * verify there, link for link, up to the head the key reports.
 *
 * Everything from the kit comes through ctx: IFACE, okmsg, PINS, requireLib.
 */
const crypto = require('crypto');

const OKEDGE = 0x80 | 0x78;
const HEAD = 0x01;
const READ = 0x02;
const CKPT_PUBKEY = 0x04;
const SEQ_NONE = 0xffffffff;
/* lib codes.js */
const OP_SIGN = 1;
const APPROVE = 1;
const TIMEOUT = 3;
const PRESS_OBSERVED = 0x01;
/* the console line that says a confirmation is primed (14-stored-keys uses it too) */
const PRIMED = /Encrypted Buffer/g;

module.exports = function register({ it }, ctx) {
  const { chain } = ctx.requireLib('node-onlykey-lib/edge');
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest();

  async function edge(device, sub, args, { signal, reports = 1 }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKEDGE, slot: sub, payload: args || Buffer.alloc(0) });
    /*
     * Collect EVERY report since the request: READ answers with several back
     * to back, and a mark taken after the first would lose the rest.
     */
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 6000, signal });
    const deadline = Date.now() + 6000;
    let got = device.reportsSince(ctx.IFACE.VENDOR, since);
    while (got.length < reports && Date.now() < deadline) {
      await device.sleep(50, { signal });
      got = device.reportsSince(ctx.IFACE.VENDOR, since);
    }
    for (const r of got) {
      const text = ctx.okmsg.text(r);
      if (/^Error/.test(text)) throw new Error(`the key refused OKEDGE ${sub}: ${text.trim()}`);
    }
    if (got.length < reports) throw new Error(`OKEDGE ${sub}: ${got.length} of ${reports} reports`);
    return got.slice(0, reports).map((r) => Buffer.from(r));
  }

  async function head(device, opts) {
    const [r] = await edge(device, HEAD, null, opts);
    return { seq: r.readUInt32LE(0), head: r.subarray(4, 36), ringFrom: r.readUInt32LE(36), deviceId: r.subarray(40, 56) };
  }

  async function read(device, from, count, opts) {
    const args = Buffer.alloc(5);
    args.writeUInt32LE(from, 0);
    args[4] = count;
    const rs = await edge(device, READ, args, { ...opts, reports: count * 2 });
    const out = [];
    for (let i = 0; i < rs.length; i += 2) out.push({ link: new Uint8Array(rs[i]), head: new Uint8Array(rs[i + 1].subarray(0, 32)) });
    return out;
  }

  /* an agent-derived P-256 sign (OKSIGN slot code 222): message || identity hash, in 57-byte chunks */
  function sendAgentSign(device, message, identity) {
    const payload = Buffer.concat([message, identity]);
    for (let i = 0; i < payload.length; i += 57) {
      const chunk = payload.subarray(i, i + 57);
      device.sendVendor({ msg: ctx.okmsg.MSG.OKSIGN, slot: 222, field: chunk.length < 57 ? chunk.length : 0xff, payload: chunk });
    }
    return payload;
  }

  it('edge: HEAD, the Edge key and an empty chain on a fresh key',
    async ({ device, assert, signal, log }) => {
      await device.restart({ signal });
      await device.unlock(ctx.PINS.primary, { signal });
      const h = await head(device, { signal });
      const [pubReport] = await edge(device, CKPT_PUBKEY, null, { signal });
      const pub = pubReport.subarray(0, 64);
      log(`seq ${h.seq === SEQ_NONE ? 'none' : h.seq}, device ${h.deviceId.toString('hex')}`);
      /* device_id = SHA256("OKEDGE-DEVICE-v1" || pubkey)[0..16] (DESIGN.md 1) */
      const want = sha256(Buffer.concat([Buffer.from('OKEDGE-DEVICE-v1'), pub])).subarray(0, 16);
      assert.bytes(h.deviceId, want, 'the device id is not the hash of the Edge public key');
      assert.ok(crypto.createPublicKey({ key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), Buffer.from([4]), pub]), format: 'der', type: 'spki' }),
        'the Edge public key is not a P-256 point');
      if (h.seq === SEQ_NONE) {
        /* empty: the head is the genesis the lib computes */
        assert.bytes(h.head, Buffer.from(chain.genesis(new Uint8Array(h.deviceId))), 'an empty chain\'s head is not the genesis');
      }
    });

  it('edge: a pressed sign and an unanswered one become links the library verifies up to the key\'s head',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = await head(device, { signal });
      const identity = sha256(Buffer.from('okt edge identity'));

      /* 1 - pressed: an APPROVE link with the press flag, whose subject is what was submitted */
      let primed = device.log.count(PRIMED);
      const signed = sendAgentSign(device, sha256(Buffer.from('okt edge message 1')), identity);
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      device.press(1);
      await device.sleep(1500, { signal });

      /* 2 - never answered: a TIMEOUT link after the 20 s fade */
      primed = device.log.count(PRIMED);
      sendAgentSign(device, sha256(Buffer.from('okt edge message 2')), identity);
      await device.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000, signal });
      await device.sleep(23000, { signal });

      const after = await head(device, { signal });
      const first = before.seq === SEQ_NONE ? 0 : before.seq + 1;
      assert.equal(after.seq, first + 1, `two decisions should add two links (head went ${before.seq} -> ${after.seq})`);

      const links = await read(device, first, 2, { signal });
      const f1 = chain.decodeLink(links[0].link);
      const f2 = chain.decodeLink(links[1].link);
      log(`#${f1.seq} op ${f1.op} decision ${f1.decision} flags ${f1.flags} slot ${f1.slot}; #${f2.seq} op ${f2.op} decision ${f2.decision}`);
      assert.equal(f1.op, OP_SIGN);
      assert.equal(f1.decision, APPROVE);
      assert.ok(f1.flags & PRESS_OBSERVED, 'a pressed approve must carry the press flag');
      assert.equal(f1.slot, 222);
      assert.bytes(Buffer.from(f1.subject), sha256(signed), 'the subject is not SHA-256 of what was submitted');
      assert.equal(f2.decision, TIMEOUT, 'an unanswered sign must be linked as a timeout');

      /*
       * The last links up to the key's head, verified by the library. From
       * genesis when the chain is that short; otherwise from the head stored
       * with the link before them - not trusted on its own, but if it were
       * wrong the recomputed welds could not reach the head the key reports.
       */
      const start = Math.max(after.ringFrom, after.seq - 7);
      const all = await read(device, start, after.seq - start + 1, { signal });
      const startFrom = start === 0
        ? { deviceId: new Uint8Array(after.deviceId) }
        : { fromSeq: start, fromHead: (await read(device, start - 1, 1, { signal }))[0].head };
      const result = chain.verify(all, { ...startFrom, expectHead: { seq: after.seq, head: new Uint8Array(after.head) } });
      log(`library verdict: ${JSON.stringify({ ok: result.ok, through: result.verifiedThrough, gaps: result.gaps, failure: result.failure })}`);
      assert.ok(result.ok, `the library rejects the key's chain: ${JSON.stringify(result.failure)}`);
    });
};
