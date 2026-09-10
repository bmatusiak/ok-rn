/**
 * THE HARD KEY: a physical OnlyKey over USB OTG.
 *
 * Hard key and soft key, which is the app's own vocabulary - the Log tab has
 * kept a buffer for each since before either could do this. They are two
 * devices answering the same protocol, and everything above the byte pipe is
 * the same code for both. That is the whole claim of the port, and this suite
 * is where it stops being an assertion.
 *
 * This is the measurement FINDING #40 was written without. That finding says the
 * device exposes four HID interfaces, that three of them are identical in class,
 * subclass, protocol and endpoint width, and that the app claimed one of them by
 * a scoring tie broken by descriptor order. Every word of it was read out of the
 * firmware's descriptors; none of it had been seen on a wire.
 *
 * ## It SKIPS when there is no key, and that is the normal case
 *
 * The suite runs against the soft key on every ordinary run, where no USB device
 * is attached at all. A skip with its reason is the honest outcome there - not a
 * pass, because nothing was checked.
 *
 * ## Runs LAST, and hands the key back
 *
 * Claiming the interfaces detaches them from the kernel, including the keyboard,
 * so while this suite holds them the key cannot type into any other app on the
 * phone. It disconnects in the last test rather than leaving that state behind.
 *
 * ## What a failure here means
 *
 * `identifiedBy` is the field that matters. Anything other than `usagePage` says
 * the transport guessed, and a guess routes the vendor protocol to the
 * security-key interface, where every request times out and the message blames
 * the device.
 */
'use strict';

const {transport: oktransport} = require('node-onlykey-lib');

const UsbPipeModule = require('../src/transport/UsbPipe');
const UsbPipe = UsbPipeModule.default || UsbPipeModule.UsbPipe;
const {getOnlyKey, resetOnlyKey} = require('../src/onlykey');

const {usb, IFACE} = oktransport;

let shared = null;

module.exports = function hardKey({describe, it}) {
  describe(hardKey.name, () => {
    it('a real key is attached, or there is nothing to measure', async ({log, assert, skip}) => {

      const devices = await UsbPipe.listDevices();
      log(`usb devices visible: ${devices.length}`);
      for (const d of devices) {
        log(`  vid=0x${d.vendorId.toString(16)} pid=0x${d.productId.toString(16)}`
          + ` "${d.productName}" interfaces=${d.interfaceCount}`
          + ` permission=${d.hasPermission}`);
      }

      const key = devices.find(
        d => d.vendorId === UsbPipeModule.VENDOR_ID && d.productId === UsbPipeModule.PRODUCT_ID);

      if (!key) {
        skip(
          'no OnlyKey on the USB bus. Attach one over OTG to measure what it ' +
            'enumerates; the soft key cannot answer this.',
        );
      }

      if (!key.hasPermission) {
        /*
         * Asked for rather than skipped over: the grant is remembered, so one
         * tap makes every later run work. It cannot be granted from here.
         */
        skip(
          'the key is attached but this app has no USB permission for it. ' +
            'Android asks on attach; accept it and run again.',
        );
      }

      /*
       * THREE INTERFACES OR FOUR, and both are correct. The debug console is
       * compiled out of a production build, so the count says which build this
       * is before anything has been asked of it.
       */
      log(`this key enumerates ${key.interfaceCount} interfaces`
        + ` (3 = production, 4 = developer)`);
      assert.ok(
        key.interfaceCount === 3 || key.interfaceCount === 4,
        `expected 3 or 4 HID interfaces, got ${key.interfaceCount}`,
      );

      shared = {key};
    });

    it('every interface is identified BY ITS USAGE PAGE, not by luck', async ({log, assert}) => {
      assert.ok(shared, 'no key was found');

      /*
       * THE PIPE, not the byte-level debug facade. This is the object the
       * library is handed, so opening it here is opening it the way a real
       * session does - and the session below then reuses it rather than
       * racing a second open against the same device.
       */
      const result = await UsbPipe.start();
      shared.result = result;

      log(`transport=${result.transport} packetSize=${result.packetSize}`);
      for (const info of result.interfaces || []) {
        const spec = usb.describe(info.iface);
        log(`  iface ${info.iface} (${spec ? spec.name : '?'})`
          + ` bInterfaceNumber=${info.interfaceNumber}`
          + ` usagePage=0x${info.usagePage.toString(16)}`
          + ` usage=0x${info.usage.toString(16)}`
          + ` in=${info.packetSizeIn} out=${info.packetSizeOut}`
          + ` by=${info.identifiedBy}`);
      }

      const found = result.interfaces || [];
      assert.ok(found.length > 0, 'connected but reported no interfaces at all');

      /*
       * The library's own check, rather than a second copy of the rules here.
       * It knows which are required, that a duplicate is fatal, and that
       * anything not identified by its usage page is a guess.
       */
      const problems = usb.problems(found);
      log(`problems: ${problems.length ? JSON.stringify(problems) : 'none'}`);
      assert.equal(problems.length, 0, problems.join('; '));
    });

    it('the vendor interface is there, which is the whole point', async ({log, assert}) => {
      assert.ok(shared && shared.result, 'the connect test did not run');
      const found = shared.result.interfaces || [];

      const vendor = found.find(i => i.iface === IFACE.VENDOR);
      assert.ok(
        vendor,
        'no vendor interface - this is exactly what FINDING #40 describes, and ' +
          'without it a real key can speak the security-key protocol and nothing else',
      );
      log(`vendor is bInterfaceNumber ${vendor.interfaceNumber},`
        + ` usage page 0x${vendor.usagePage.toString(16)}`);

      /*
       * The two that a scoring function cannot tell apart. Proving they were
       * separated correctly is proving the tie was broken by evidence.
       */
      const fido = found.find(i => i.iface === IFACE.FIDO);
      assert.ok(fido, 'no security-key interface');
      assert.notEqual(
        vendor.interfaceNumber, fido.interfaceNumber,
        'vendor and security key resolved to the same interface',
      );
      assert.equal(vendor.usagePage, usb.describe(IFACE.VENDOR).usagePage);
      assert.equal(fido.usagePage, usb.describe(IFACE.FIDO).usagePage);
    });

    it('the VENDOR interface answers - a real device session', async ({log, assert}) => {
      assert.ok(shared && shared.result, 'the connect test did not run');

      /*
       * The first time this app has spoken the vendor protocol to a physical
       * key. Everything below the call is the same code the soft key uses -
       * same session, same device plugin, same parser - which is the whole
       * claim of the port, tested rather than asserted.
       */
      const {device} = await getOnlyKey('usb');
      const state = await device.connect();
      const status = String(state.status || '').trim();
      log(`status: ${JSON.stringify(status)}`);

      assert.ok(
        status.length > 0,
        'the vendor interface was claimed but the device said nothing - ' +
          'OKCONNECT went out and no reply came back',
      );

      /*
       * A LOCKED key answers with no version at all, which is not a failure -
       * it is the same thing the soft key does, and the reason capabilities()
       * cannot report a build until the PIN is in.
       */
      const caps = device.capabilities;
      log(`model=${device.deviceType} console=${caps ? caps.debugConsole : 'unknown'}`);
      if (/UNLOCKED/i.test(status)) {
        log(`identity: ${JSON.stringify(device.identity)}`);
      } else {
        log('locked, so no version in the status - expected');
      }
    });
    it('and the key is handed back to the phone', async ({log, assert}) => {
      assert.ok(shared, 'no key was found');
      await resetOnlyKey('usb');
      await UsbPipe.stop();
      log('interfaces released; the key can type into other apps again');
      assert.equal(UsbPipe.isRunning(), false);
    });
  });
};
