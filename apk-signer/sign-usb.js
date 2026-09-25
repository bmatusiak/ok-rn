#!/usr/bin/env node
/*
 * The signing helper for a key on USB - sign.js's twin.
 *
 * Speaks the protocol OnlyKeyBackend.java expects: a hex SHA-256 digest per
 * line in, a hex signature per line out, `ERR <reason>` for anything it could
 * not do. stdout is the wire and stderr is for humans.
 *
 * sign.js drives the EMULATED key and gates its press on the debug console.
 * This one drives a key on USB, where there is no console - so it presses the
 * non-debug way: OKSIGN_PRESSER=pi has press.js on the Raspberry Pi press
 * (while the Pi presents the emulator over USB), OKSIGN_PRESSER=human tells a
 * person on stderr and waits for the key's answer. stdin is the digest wire,
 * so a human is never asked to press Enter here.
 *
 * The key must already hold the signing key in RSA slot 2 with stored
 * challenge mode 1 - provision-usb.js does that - so each signature is ONE
 * press of any button.
 */
'use strict';

const readline = require('readline');

const {openUsb, requireKit} = require('./session');
const {presserFrom} = require('./presser');

const SLOT = 2;
const say = (...a) => console.error('[sign-usb]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const presser = presserFrom(process.env.OKSIGN_PRESSER || 'pi', {waitForEnter: false});
  const s = await openUsb();
  try {
    const r = await s.device.connect();
    const status = String(r.status).trim();
    say(`key says ${status}; buttons pressed by ${presser.name}`);

    if (!/^UNLOCKED/i.test(status)) {
      if (presser.name === 'you') {
        /* A person's PIN never passes through this program. */
        await presser.press(['your PIN']);
        for (let i = 0; i < 120; i++) {
          await sleep(1000);
          const now = String((await s.device.connect()).status).trim();
          if (/^UNLOCKED/i.test(now)) break;
          if (i === 119) throw new Error('the key was not unlocked within two minutes');
        }
      } else {
        const {PINS} = requireKit();
        await s.device.unlock(PINS.primary, {
          enterDigits: (d) => presser.press(String(d).split('')),
          timeoutMs: 60000,
        });
      }
    }
    say('unlocked; ready for digests');

    const rl = readline.createInterface({input: process.stdin, terminal: false});
    let chain = Promise.resolve();
    rl.on('line', (line) => {
      const hex = line.trim();
      if (!hex) return;
      chain = chain.then(async () => {
        try {
          const digest = Buffer.from(hex, 'hex');
          if (digest.length !== 32) {
            throw new Error(`expected a 32-byte SHA-256 digest, got ${digest.length}`);
          }
          const sig = await s.okcrypto.sign(SLOT, digest, {
            /* Without it the library resolves on the first 64-byte report. */
            expectBytes: 256,
            timeoutMs: 60000,
            confirm: async ({isAnswered}) => {
              /* Stored challenge mode 1: one press of any button. Pressed
               * once, never twice - a spare press on an unlocked key types a
               * slot at the keyboard. */
              await presser.press(['1']);
              for (let i = 0; i < 600 && !isAnswered(); i++) await sleep(100);
            },
          });
          const out = Buffer.from(sig);
          if (out.length !== 256) throw new Error(`expected 256 signature bytes, got ${out.length}`);
          process.stdout.write(`${out.toString('hex')}\n`);
        } catch (err) {
          process.stdout.write(`ERR ${err.message}\n`);
          say(err.stack || err.message);
        }
      });
    });
    await new Promise((resolve) => rl.on('close', resolve));
    await chain;
  } finally {
    await s.stop();
  }
}

main().catch((err) => {
  console.error(`[sign-usb] ${err && (err.stack || err.message)}`);
  process.exit(1);
});
