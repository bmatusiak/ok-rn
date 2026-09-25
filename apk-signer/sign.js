#!/usr/bin/env node
/*
 * The signing helper: one boot, many digests.
 *
 * Speaks the protocol OnlyKeyBackend.java expects - a hex digest per line in,
 * a hex signature per line out, ERR for anything it could not do. stdout is
 * the wire and stderr is for humans, so nothing here may print progress to
 * stdout.
 *
 * ## Why it stays up
 *
 * apksigner asks for one signature per scheme - two for this app, v2 and v3 -
 * and a boot plus an unlock costs far more than the RSA maths does. Measured:
 * the whole 19-rsa-keys file is 7 tests in 104 seconds, and most of that is
 * restart-and-unlock cycles. So the device is brought up once and kept for as
 * long as the JVM on the other end wants signatures.
 *
 * ## Every signature needs a button press, and the press has to be timed
 *
 * stored_key_challenge_mode = 1 collapses the three-digit challenge into ONE
 * press of any button - but it does not remove it. And the library does not
 * wait before asking for it: deviceOperation sends the payload and then calls
 * confirm() immediately, with no pause for the firmware to finish priming. A
 * press that lands inside that window is silently discarded and the operation
 * then times out looking like a device that never answered.
 *
 * So the press is gated on the console, exactly as 19-rsa-keys.test.js does
 * it: count the "Encrypted Buffer" lines before asking, and wait for one more
 * before pressing. Press once and stop - on an unlocked device a spare press
 * runs gen_press() and types a slot out of the keyboard interface.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execFileSync } = require('child_process');

const { open, lock, requireKit, LOCAL } = require('./session');

const STORAGE = path.join(LOCAL, 'storage');
const CERT = path.join(LOCAL, 'signer.crt.pem');

/** The firmware prints this once the confirmation is primed and waiting. */
const PRIMED = /Encrypted Buffer/g;

/** RSA slot 2, matching provision.js. */
const SLOT = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.error('[oksign]', ...a);

/**
 * Has this storage directory been provisioned?
 *
 * A blank flash is the specific failure worth naming: it is what a silently
 * rejected write looks like, and it would otherwise show up much later as a
 * device that will not sign for no stated reason.
 */
function provisioned() {
  const flash = path.join(STORAGE, 'flash.bin');
  if (!fs.existsSync(flash) || !fs.existsSync(CERT)) return false;
  const bytes = fs.readFileSync(flash);
  return !bytes.every((b) => b === 0xFF || b === 0x00);
}

async function main() {
  if (!provisioned()) {
    /*
     * Provisioning has to happen in its own process: it enters config mode,
     * which ends only at a restart, and a restart means a new device host.
     */
    say('no provisioned image - running provision.js');
    execFileSync(process.execPath, [path.join(__dirname, 'provision.js')],
      { stdio: ['ignore', 'ignore', 'inherit'] });
  }

  const release = lock();
  const { PINS } = requireKit();

  say('booting the emulated key');
  const s = await open(STORAGE);

  try {
    await s.kit.ensureUnlocked(PINS.primary);
    say('unlocked; ready for digests');

    const rl = readline.createInterface({ input: process.stdin, terminal: false });

    /*
     * Serialised on purpose. The device does one operation at a time, and
     * apksigner asks sequentially anyway - but a queue makes that a property
     * of this file rather than an assumption about the caller.
     */
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

          const primed = s.kit.log.count(PRIMED);

          const sig = await s.okcrypto.sign(SLOT, digest, {
            /*
             * Without this the library resolves on the FIRST 64-byte report
             * and returns a quarter of a 256-byte signature - silently.
             */
            expectBytes: 256,
            timeoutMs: 30000,
            confirm: async ({ isAnswered }) => {
              await s.kit.log.waitForCount(PRIMED, primed + 1, { timeoutMs: 20000 });
              s.kit.press(1);
              for (let i = 0; i < 60 && !isAnswered(); i++) {
                await sleep(100);   /* poll; never press a second time */
              }
            },
          });

          const out = Buffer.from(sig);
          if (out.length !== 256) {
            throw new Error(`expected 256 signature bytes, got ${out.length}`);
          }
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
    release();
  }
}

main().catch((err) => {
  console.error(`[oksign] ${err && (err.stack || err.message)}`);
  process.exit(1);
});
