/*
 * Bring up a device and put the library on top of it.
 *
 * Shared by provision.js and sign.js, because the bring-up is identical and
 * the only difference is what happens afterwards.
 *
 * ## The ownership rule, which this file exists to make hard to break
 *
 * THE KIT OWNS STATE. Every transition - unlock, config mode, restart - goes
 * through the kit's Device. Its restart targets generation + 1, waits for the
 * console to be draining before it sends, and retries; that is what makes a
 * reboot reliable, and it is what 19-rsa-keys uses.
 *
 * THE LIBRARY OWNS MESSAGES. setPreference, loadKey, getPublicKey and sign are
 * pure protocol over the vendor interface and touch no session state.
 *
 * Never cross the two:
 *
 *   - The library's restart() is `session.configMode = false; press('8')` and
 *     returns immediately; it waits for nothing. And the kit's waitForBoot()
 *     resolves at once if the current generation is already up, so
 *     "press 8 then waitForBoot" is a race that usually loses.
 *   - The library's enterConfigMode() needs a host-supplied hold, does not
 *     re-unlock afterwards, and sets an internal session.configMode flag that
 *     nothing here can ever clear again - `session` is not in app.services and
 *     only the library's own restart()/wipe() reset it.
 *
 * Followed, that flag stays false for the whole life of the tool, which is
 * exactly what we want: the library's two config-mode guards then never
 * engage, and neither is on our path anyway (one is inside deriveOnce, the
 * other inside the library's own unlock).
 *
 * `requires: 'configMode'` on a preference is documentation of what the
 * FIRMWARE enforces, not a client-side gate - setPreference sends regardless
 * and turns a device refusal into a thrown Error. So a kit-driven config mode
 * satisfies it, and getting the sequencing wrong fails loudly at the step
 * rather than silently later.
 *
 * ## Sequence, do not overlap
 *
 * Both stacks write to the same transport - the kit on SEREMU for presses and
 * PIN digits, the library on VENDOR. The firmware serialises, but a kit unlock
 * in flight while a library loadKey is chunking is a state nobody has tested.
 * Await one before starting the other.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const Rectify = require('@bmatusiak/rectify');
const hostPlugin = require('node-onlykey-lib/plugins/host');
const embeddedTransport = require('node-onlykey-lib/plugins/transport/embedded');
const sessionPlugin = require('node-onlykey-lib/plugins/session');
const devicePlugin = require('node-onlykey-lib/plugins/device');
const okcryptoPlugin = require('node-onlykey-lib/plugins/okcrypto');

const { kitPipe } = require('./kitPipe');

/** tools/oksign/.local - everything this tool generates, gitignored. */
const LOCAL = path.join(__dirname, '.local');

/**
 * The test kit, a sibling checkout.
 *
 * Same shape the kit itself uses for the emulator (lib/paths.js): an env
 * override over a default computed from a known root, never from the current
 * directory - this is invoked from wherever release.js happens to run.
 */
function kitRoot() {
  if (process.env.OKT_ROOT) return path.resolve(process.env.OKT_ROOT);
  /* tools/oksign -> ok-rn -> the workspace holding all the checkouts. */
  return path.resolve(__dirname, '..', '..', '..', 'onlykey-testing');
}

function requireKit() {
  const root = kitRoot();
  if (!fs.existsSync(path.join(root, 'lib', 'device', 'emulated.js'))) {
    throw new Error(
      `onlykey-testing is not at ${root}. It is a sibling checkout; set `
      + 'OKT_ROOT if it lives somewhere else.',
    );
  }
  /*
   * Reaching for internals on purpose. The kit is private:true and its main
   * is the test runner, so there is no public entry point - but lib/device and
   * lib/fixtures are how the kit's own non-test code (lib/fixtures/index.js)
   * uses them, so this is the same door, not a back one.
   */
  return {
    Device: require(path.join(root, 'lib', 'device')).Device,
    EmulatedTransport: require(path.join(root, 'lib', 'device', 'emulated')).EmulatedTransport,
    fixtures: require(path.join(root, 'lib', 'fixtures')),
    PINS: require(path.join(root, 'lib', 'config')).PINS,
  };
}

/** Fail with the command to run rather than a module-not-found three frames down. */
function assertEmulatorBuilt() {
  const root = process.env.OKEMU_ROOT
    ? path.resolve(process.env.OKEMU_ROOT)
    : path.resolve(__dirname, '..', '..', '..', 'node-onlykey-emulator', 'emulator');
  const addon = path.join(root, 'build', 'Release', 'onlykey_emulator.node');
  if (!fs.existsSync(addon)) {
    throw new Error(
      `the emulator is not built: ${addon} is missing.\n`
      + `  cd ${root} && npm run rebuild`,
    );
  }
}

/**
 * One build at a time.
 *
 * Two concurrent signs would share the storage image and both ask for the same
 * fixed flash mapping. Failing clearly beats corrupting an image that then
 * fails much later and much less obviously.
 */
function lock() {
  fs.mkdirSync(LOCAL, { recursive: true });
  const file = path.join(LOCAL, 'lock');
  let fd;
  try {
    fd = fs.openSync(file, 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') {
      throw new Error(
        `another oksign run holds ${file}. If nothing is running, delete it.`,
      );
    }
    throw err;
  }
  fs.writeSync(fd, String(process.pid));
  fs.closeSync(fd);
  const release = () => { try { fs.rmSync(file, { force: true }); } catch (_) {} };
  process.on('exit', release);
  return release;
}

/**
 * Boot a device over `storageDir` and compose the library on top.
 *
 * @returns {Promise<{device, okcrypto, kit, transport, stop}>}
 *          `device`/`okcrypto` are the LIBRARY's services; `kit` is the kit's
 *          Device, for state transitions. The names are deliberately different
 *          so a call site says which stack it is using.
 */
async function open(storageDir, { runDir = path.join(LOCAL, 'run') } = {}) {
  assertEmulatorBuilt();
  const { Device, EmulatedTransport } = requireKit();

  fs.mkdirSync(runDir, { recursive: true });
  fs.mkdirSync(storageDir, { recursive: true });

  const transport = new EmulatedTransport({ runDir, storageDir, runId: 'oksign' });
  const kit = new Device(transport);
  await transport.start();

  const plugins = [
    hostPlugin,
    embeddedTransport,
    sessionPlugin,
    devicePlugin,
    okcryptoPlugin,
  ];
  plugins.config = {
    transport: { pipe: kitPipe(transport) },
    /* Only the vault needs a store, and nothing here touches the vault. */
    host: { store: null },
  };

  const started = await new Promise((resolve, reject) => {
    const app = Rectify.build(plugins, (err, ready) => (err ? reject(err) : resolve(ready)));
    app.start();   /* build() composes; start() runs. Both are required. */
  });

  return {
    kit,
    transport,
    device: started.services.device,
    okcrypto: started.services.okcrypto,
    async stop() {
      await transport.stop();
    },
  };
}

module.exports = { open, lock, requireKit, kitRoot, LOCAL };
