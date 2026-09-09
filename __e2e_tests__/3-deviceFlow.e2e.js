/**
 * The device-management flow, against the real firmware.
 *
 * Everything in `node-onlykey-lib`'s device layer — the PIN bracket, the label
 * reader's priming discard and token table, the per-field slot encodings, the
 * awaited slot writes — was written from OnlyKey-App's sources and checked
 * against unit tests and a fake. None of it had ever run against firmware until
 * this file.
 *
 * That gap already cost one bug: LabelReader discarded the first response as
 * its priming message before checking it for an error, so a locked device's
 * "Error device locked" was thrown away and the read timed out saying nothing.
 * The fake only found it once it was taught to be locked.
 *
 * The device on the bench is INITIALIZED, provisioned with the PIN below in an
 * earlier session, and its flash persists across app restarts.
 */
'use strict';

const OnlyKeyModule = require('../src/onlykey');
const {getOnlyKey, resetOnlyKey} = OnlyKeyModule;

const OkEmuModule = require('../src/transport/OkEmu');
const OkEmu = OkEmuModule.default || OkEmuModule.OkEmu;

/** Provisioned in an earlier session; digits are button numbers, so 1-6. */
const PIN = '1234561';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

module.exports = function deviceFlow({describe, it}) {
  describe(deviceFlow.name, () => {
    it('boots and reports its lock state', async ({log, assert}) => {
      if (!OkEmu.isRunning()) {
        await OkEmu.start();
        // setup() runs on its own thread; let it reach the main loop.
        await delay(1500);
      }

      const {device} = await getOnlyKey();
      const result = await device.connect();
      log(`status: ${result.status} (kind: ${result.kind})`);

      /*
       * Over the vendor interface OKCONNECT is set_time() plus a plaintext
       * status - there is no key exchange here, so `kind` must say so. A
       * session reporting itself established on this path would be one whose
       * transit key was derived from the ASCII of a status string.
       */
      assert.ok(/INITIALIZED|UNLOCKED/i.test(result.status), `unexpected status: ${result.status}`);
      assert.equal(result.kind, 'status', 'the vendor path is not a key exchange');
      assert.equal(result.sealed, false);
    });

    it('is silent to a label read while locked, and the error says as much', async ({log, assert}) => {
      /*
       * MEASURED, not assumed - and it contradicts the firmware source.
       *
       * okcore.cpp:392 has `else { hidprint("Error device locked"); }` for
       * exactly this case, so the obvious expectation is a refusal. It never
       * reaches the wire: a locked device answers OKGETLABELS with nothing at
       * all, and the only vendor traffic is its once-a-second INITIALIZED
       * broadcast. Probed directly - five status reports in four seconds, and
       * no refusal.
       *
       * So "locked" and "not listening" are indistinguishable here unless the
       * broadcasts are counted, which is what the reader now does.
       */
      const {device} = await getOnlyKey();
      if (device.connected && /UNLOCKED/i.test(String(device.status))) {
        log('already unlocked - skipping the locked-path check');
        return;
      }

      let failure = null;
      try {
        await device.readLabels({timeoutMs: 4000});
      } catch (error) {
        failure = error;
      }

      log(`failure: ${failure && failure.message}`);
      assert.ok(failure, 'a locked device answered a label read');
      assert.ok(
        /probably locked/i.test(failure.message),
        `the timeout should diagnose the lock, got: ${failure.message}`,
      );
    });

    it('unlocks with the PIN', async ({log, assert}) => {
      /*
       * No reboot, and no clear gesture either.
       *
       * The firmware cannot be restarted in this process - its thread never
       * returns - so a stop/start used to leave two of them racing one input
       * queue. And clearPinEntry() appends before it resets. Each e2e run gets
       * a fresh firmware because the tool force-stops the app, so the password
       * buffer is empty here by construction.
       */
      const {device} = await getOnlyKey();
      const status = await device.unlock(PIN, {timeoutMs: 20000});
      log(`unlocked: ${status}`);
      assert.ok(/UNLOCKED/i.test(status), `unexpected unlock status: ${status}`);
    });

    it('reads its labels now that it is unlocked', async ({log, assert}) => {
      /*
       * The first time the label reader meets real firmware: the priming
       * discard, the two-character token rule, and the 1a-1e table that is NOT
       * hex (0x1a is 26, and the device means 20).
       */
      const {device} = await getOnlyKey();
      const {labels, complete} = await device.readLabels({timeoutMs: 10000});

      log(`complete: ${complete}, slots: ${labels.length}`);
      log(`labels: ${JSON.stringify(labels)}`);

      assert.ok(labels.length > 0, 'no slots reported');
      assert.ok(complete, 'the label list never terminated');
    });

    it('writes a slot label and reads it back', async ({log, assert}) => {
      /*
       * The whole slot path end to end: the field id, the ASCII encoding, and
       * the awaited acknowledgement. The original client never waited for one -
       * its callback reported only whether the HID write succeeded - so a
       * device-side error was discarded and the user shown success.
       */
      const {device} = await getOnlyKey();
      const label = `e2e${Date.now() % 10000}`;

      /*
       * The bus, captured across the write, printed only if it fails.
       *
       * This write used to time out around 40% of the time: it lands about
       * 12ms after readLabels() resolves, while get_slot_labels() is still
       * inside its final delay(20) and not yet servicing HID, so the frame sat
       * unlooked-at and NOTHING came back on any interface - not the
       * acknowledgement, not the status broadcast, not even a "Received
       * packet" debug line. setSlot() now resends an unacknowledged frame,
       * which is what this test proves.
       *
       * The capture stays because that is how the cause was found. A bare
       * timeout cannot tell a frame the device never looked at from an
       * acknowledgement that arrived and was filtered.
       */
      const seen = [];
      const offBus = OkEmu.on('stream', e => {
        /* Everything, on every interface: the question is now what came
         * back rather than whether the write went out. */
        let text = '';
        for (const b of e.bytes) {
          if (b >= 0x20 && b <= 0x7e) text += String.fromCharCode(b);
        }
        const hex = Array.from(e.bytes).slice(0, 24).map(b => b.toString(16).padStart(2, '0')).join('');
        const tag = ['kbd', 'fido', 'vend', 'ser'][e.iface] || e.iface;
        const t = text.trim();
        seen.push(`+${Date.now() - t0}ms ${tag}${e.dir === 0 ? '<' : '>'} ${t ? JSON.stringify(t.slice(0, 40)) : hex}`);
      });

      const t0 = Date.now();
      let applied;
      try {
        applied = await device.setSlot('1a', {label}, {timeoutMs: 5000});
      } catch (e) {
        /*
         * Keep listening. Whether the device is silent forever or merely late
         * is the whole question, and the timeout alone cannot tell them apart.
         */
        await delay(3000);
        log(`bus during the failed write: ${JSON.stringify(seen)}`);
        throw e;
      } finally {
        offBus();
      }
      log(`device said: ${applied.map(a => a.response).join(' | ')} (+${Date.now() - t0}ms, ${applied[0].attempts} attempt(s))`);
      assert.equal(applied.length, 1);
      assert.ok(
        /^Success/i.test(applied[0].response),
        `unexpected acknowledgement: ${applied[0].response}`,
      );

      const {labels} = await device.readLabels({timeoutMs: 10000});
      log(`slot 1 now: ${JSON.stringify(labels[0])}`);
      assert.equal(labels[0], label, 'the label did not survive the round trip');
    });

    it('leaves the session unkeyed, because the vendor path has no exchange', async ({log, assert}) => {
      // Worth asserting after all the traffic above: nothing along the way
      // should have produced a transit key on this interface.
      const {device} = await getOnlyKey();
      log(`connected: ${device.connected}`);
      assert.equal(device.connected, false, 'a key appeared without an exchange');
    });
  });
};
