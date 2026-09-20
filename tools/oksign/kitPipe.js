/*
 * The join between two stacks that do not know about each other.
 *
 * onlykey-testing owns the PROCESS: spawning the device host, the named-pipe
 * IPC, boot detection, restart markers and generation tracking, and telling a
 * SIGKILL apart from a segfault. node-onlykey-lib owns the PROTOCOL: chunking
 * an RSA key across OKSETPRIV frames, retrying an ack, computing a challenge.
 * Each is good at its half and neither is going to grow the other - the kit's
 * process supervision is not protocol, and a platform-free library is never
 * going to spawn a child.
 *
 * So the library gets its byte pipe from the kit's transport, and this is the
 * whole of it. `node-onlykey-lib/test/helpers/fake-pipe.js` is the same
 * contract implemented against a JS fake; this is that file with a real device
 * behind it.
 *
 * ## start() and stop() do nothing, deliberately
 *
 * Rectify's app.start() makes the transport plugin call pipe.start(). But by
 * then the device is already up: the storage image has to be in place and the
 * firmware booted before there is anything to compose a library over. And
 * stop() must not tear the device down either - the signing helper lives
 * across many digests, and letting the library halt a device it did not create
 * is how it would kill itself between two signatures of the same APK.
 *
 * The tool owns the transport's lifecycle. This only speaks for it.
 *
 * ## The four shape differences, none of which are anybody's fault
 *
 *   kit                              library
 *   'hid' (iface, Buffer)         -> {iface, dir, bytes}
 *   'log' (text)                  -> the same, as SEREMU bytes
 *   writeHid(buffer, iface)       -> write(iface, bytes) returning a Promise
 *   get attached                  -> isRunning()
 *   EventEmitter.on -> emitter    -> on() must return an unsubscribe fn
 *
 * The log needs its own row because the kit's 'hid' event deliberately omits
 * outbound SEREMU and keyboard traffic - the peer suppresses those because
 * they already leave as 'log' and 'keyboard', and forwarding them twice would
 * double every console line. Reading 'hid' alone would lose the debug console
 * entirely, which is exactly what the library's DeviceConsole reads.
 */
'use strict';

const { IFACE, DIR } = require('node-onlykey-lib/transport');

/**
 * @param {object} transport an onlykey-testing EmulatedTransport, already started
 * @returns {object} a byte pipe satisfying src/transport/pipeTransport.js
 */
function kitPipe(transport) {
  return {
    /* See the header: the tool owns the lifecycle, not the library. */
    async start() {
      if (!transport.attached) {
        throw new Error(
          'kitPipe: the device host is not attached - start the transport '
          + 'before composing the library over it',
        );
      }
    },

    async stop() {},

    isRunning() {
      return transport.attached;
    },

    async write(iface, bytes) {
      /*
       * Arguments are reversed between the two, and the kit takes a Buffer.
       * It throws "device host is not attached" across a restart window,
       * which is correct and is why nothing may write across one.
       */
      transport.writeHid(Buffer.from(bytes), iface);
      return bytes.length;
    },

    on(event, listener) {
      if (event !== 'stream') {
        return () => {};
      }

      /*
       * dir is always OUT. The kit's 'hid' carries device->host only, and no
       * echo of our own writes reaches it at all - pipeTransport would turn
       * one into a 'write' event, but nothing in the library listens for that,
       * so there is nothing to synthesize.
       */
      const onHid = (iface, buf) => {
        listener({ iface, dir: DIR.OUT, bytes: new Uint8Array(buf) });
      };

      /*
       * latin1 both ways: the kit decoded the console bytes with it, and
       * pipeTransport re-decodes with toLatin1 after stripping padding. A
       * round trip through any other encoding would mangle the high bytes
       * that hidprint's buffer tail is full of.
       */
      const onLog = (text) => {
        listener({
          iface: IFACE.SEREMU,
          dir: DIR.OUT,
          bytes: new Uint8Array(Buffer.from(text, 'latin1')),
        });
      };

      /*
       * Forwarded although signing never needs it: if a stray press makes the
       * device type a slot out of the keyboard interface, that is something
       * worth being able to see rather than something to discard here.
       */
      const onKeyboard = (buf) => {
        listener({ iface: IFACE.KEYBOARD, dir: DIR.OUT, bytes: new Uint8Array(buf) });
      };

      transport.on('hid', onHid);
      transport.on('log', onLog);
      transport.on('keyboard', onKeyboard);

      return () => {
        transport.off('hid', onHid);
        transport.off('log', onLog);
        transport.off('keyboard', onKeyboard);
      };
    },
  };
}

module.exports = { kitPipe };
