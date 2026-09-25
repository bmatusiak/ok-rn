/*
 * A USB OnlyKey through node-hid, as the byte pipe node-onlykey-lib wants.
 *
 * The same contract kitPipe.js implements for the emulated key (see
 * node-onlykey-lib/src/transport/pipeTransport.js): write(iface, bytes),
 * on('stream') delivering {iface, dir, bytes}, start/stop/isRunning. That is
 * the point - sign.js and provision.js do not change when the key moves from
 * a process to a cable.
 *
 * ## What Windows lets us open, measured 2026-09-25
 *
 * Against both a physical key and the Raspberry Pi presenting the emulator as
 * a USB device, node-hid on Windows lists and opens exactly two interfaces:
 * the VENDOR interface (usage page 0xffab) and the keyboard. FIDO belongs to
 * Windows, and the SEREMU debug console is not listed and refuses a direct
 * open ("Access is denied"). The vendor interface is all signing needs -
 * OKSETPRIV, OKSIGN and OKCONNECT all travel on it - so the others are
 * reported as absent rather than worked around.
 *
 * ## Selection is by VID/PID and interface number, never by sysfs
 *
 * onlykey-testing's HardwareTransport tells a physical key from the
 * emulator's gadget through Linux sysfs. There is no such thing here, and a
 * Pi presenting the emulator over a cable is byte-for-byte a real key - by
 * design. So exactly one OnlyKey may be attached; two is refused, because
 * nothing on the wire says which one a signature would come from.
 */
'use strict';

const {IFACE, DIR} = require('node-onlykey-lib/transport');

const ONLYKEY = {vendorId: 0x1d50, productId: 0x60fc};

function loadHid() {
  try {
    return require('node-hid');
  } catch (e) {
    throw new Error('apk-signer: node-hid is not installed - run `npm install` in apk-signer/');
  }
}

/** The OnlyKey's HID interfaces node-hid can see, keyed by interface number. */
function discover(HID = loadHid()) {
  const found = HID.devices().filter(
    (d) => d.vendorId === ONLYKEY.vendorId && d.productId === ONLYKEY.productId,
  );
  const serials = new Set(found.map((d) => d.serialNumber));
  if (serials.size > 1 || found.filter((d) => d.interface === IFACE.VENDOR).length > 1) {
    throw new Error(
      'apk-signer: more than one OnlyKey is attached - unplug all but the one '
      + 'that should sign (a real key and an emulated one are indistinguishable)',
    );
  }
  const byIface = {};
  for (const d of found) byIface[d.interface] = d;
  return byIface;
}

/**
 * @param {object} [opts]
 * @param {object} [opts.HID] node-hid, injectable for tests
 * @returns {object} a byte pipe satisfying pipeTransport.js
 */
function hidPipe({HID = loadHid()} = {}) {
  const found = discover(HID);
  if (!found[IFACE.VENDOR]) {
    throw new Error('apk-signer: no OnlyKey vendor interface on USB - is a key plugged in?');
  }
  const handles = {};
  const listeners = new Set();
  let running = false;

  const emit = (iface, data) => {
    const bytes = new Uint8Array(data);
    for (const l of listeners) l({iface, dir: DIR.OUT, bytes});
  };

  return {
    async start() {
      for (const iface of [IFACE.VENDOR, IFACE.KEYBOARD]) {
        if (!found[iface]) continue;
        const h = new HID.HID(found[iface].path);
        h.on('data', (data) => emit(iface, data));
        h.on('error', () => { running = false; });
        handles[iface] = h;
      }
      running = true;
    },
    async stop() {
      running = false;
      for (const h of Object.values(handles)) {
        try { h.close(); } catch { /* already gone */ }
      }
    },
    isRunning() {
      return running;
    },
    async write(iface, bytes) {
      const h = handles[iface];
      if (!h) {
        throw new Error(
          `apk-signer: interface ${iface} is not reachable from this host `
          + '(Windows keeps FIDO, and does not open the debug console)',
        );
      }
      /* hidapi on Windows takes the report ID as the first byte; the
       * OnlyKey's reports have none, so it is 0 - as windows-serial did. */
      h.write([0x00, ...bytes]);
      return bytes.length;
    },
    on(event, listener) {
      if (event !== 'stream') return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

module.exports = {hidPipe, discover, ONLYKEY};
