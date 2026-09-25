/*
 * Who presses the key's buttons, for a key on USB.
 *
 * There is no debug console on this path (Windows does not open it, and a
 * production key has none), so every press, hold and restart is a person's -
 * or, while the Raspberry Pi presents the emulator as a USB device,
 * emulator/bin/press.js on the Pi standing in for that person.
 *
 *   pi      press.js over ssh (OKSIGN_PI, default 192.168.51.162)
 *   human   printed on stderr; `waitForEnter` decides whether to wait for
 *           Enter (provisioning) or just say it (signing, where stdin is the
 *           digest wire and the answer from the key is the signal)
 */
'use strict';

const readline = require('readline');
const {execFileSync} = require('child_process');

const PI = process.env.OKSIGN_PI || '192.168.51.162';
const PI_EMULATOR = '~/projects/ok-firmware/node-onlykey-emulator';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function piPresser() {
  const ssh = (cmd) => execFileSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', PI, cmd],
    {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']});
  return {
    name: 'press.js on the Pi',
    async press(buttons) {
      ssh(`cd ${PI_EMULATOR} && ./emulator/bin/press.js ${buttons.join(' ')}`);
    },
    async hold(button, ticks) {
      ssh(`cd ${PI_EMULATOR} && ./emulator/bin/press.js ${button}#${ticks}`);
    },
    /* A power cycle: stop the daemon; its supervisor loop starts it again. */
    async restart() {
      ssh("pkill -f '^node emulator/bin/daemon.js' || true");
      await sleep(3000);
    },
  };
}

function humanPresser({waitForEnter = true} = {}) {
  const tell = (q) => {
    if (!waitForEnter) {
      process.stderr.write(`[apk-signer] ${q}\n`);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const rl = readline.createInterface({input: process.stdin, output: process.stderr});
      rl.question(`[apk-signer] ${q} - then press Enter `, () => { rl.close(); resolve(); });
    });
  };
  return {
    name: 'you',
    press: (buttons) => tell(`press ${buttons.join(' ')} on the key`),
    hold: (button) => tell(`hold button ${button} for about five seconds, until the key locks`),
    restart: () => tell('unplug the key and plug it back in'),
  };
}

function presserFrom(name, opts) {
  if (name === 'pi') return piPresser();
  if (name === 'human') return humanPresser(opts);
  throw new Error(`unknown presser "${name}" - pi or human`);
}

module.exports = {presserFrom, piPresser, humanPresser};
