#!/usr/bin/env node
/**
 * apk-signer - sign ok-rn's apk with an OnlyKey.
 *
 *   apk-signer build                              compile the JCA provider (javac)
 *   apk-signer provision                          load the signing key into the emulated key
 *   apk-signer sign <apk> [--backend emulated|software]
 *   apk-signer verify <apk>                       print the signer apksigner finds
 *   apk-signer probe                              connect to a key on USB and print its status
 *
 * NOT PART OF THE APP. Nothing under ok-rn's src/, App.tsx, android/app or
 * __e2e_tests__ uses this; its one caller is ok-rn's tools/release.js, at
 * signing time. Delete this folder and ok-rn still builds and releases - the
 * apk keeps Gradle's debug-keystore signature, as with `release.js --no-sign`.
 *
 * Every command here wraps what already existed in tools/oksign, with the
 * same arguments release.js used, so moving it changed nothing it does.
 */
'use strict';

const {execFileSync, execSync} = require('child_process');
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const SIGNER_CERT = path.join(HERE, '.local', 'signer.crt.pem');

/*
 * A backend is a program speaking the line protocol - a hex SHA-256 digest
 * per line in, a hex signature (or `ERR ...`) per line out - and
 * OnlyKeyBackend.java runs whichever OKSIGN_CMD names.
 */
const BACKENDS = {
  emulated: path.join(HERE, 'backend-device.cmd'),
  software: path.join(HERE, 'backend-software.cmd'),
  /* A key on USB; who presses is OKSIGN_PRESSER (pi / human), see presser.js. */
  usb: path.join(HERE, 'backend-usb.cmd'),
};

const die = (msg) => {
  console.error(`apk-signer: ${msg}`);
  process.exit(1);
};

/* apksign.cmd is its own program (see its header), so it is run through the
 * shell with its path quoted, exactly as release.js did. */
function apksign(args, env) {
  return execSync([JSON.stringify(path.join(HERE, 'apksign.cmd')), ...args].join(' '), {
    cwd: HERE,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: {...process.env, ...env},
  });
}

function sign(apk, backend) {
  const cmd = BACKENDS[backend];
  if (!cmd) die(`unknown backend "${backend}" - one of ${Object.keys(BACKENDS).join(', ')}`);
  if (!fs.existsSync(apk)) die(`no such apk: ${apk}`);
  apksign([
    'sign', '--ks', 'NONE', '--ks-type', 'ONLYKEY',
    '--ks-provider-class', 'com.okrn.signer.OnlyKeyProvider',
    '--ks-provider-arg', JSON.stringify(SIGNER_CERT),
    '--ks-pass', 'pass:onlykey',
    '--min-sdk-version', '24', '--max-sdk-version', '36',
    JSON.stringify(path.resolve(apk)),
  ], {OKSIGN_CMD: cmd});
}

function verify(apk) {
  const out = apksign(['verify', '--print-certs', JSON.stringify(path.resolve(apk))]);
  const dn = /certificate DN: (.+)/.exec(out);
  const digest = /certificate SHA-256 digest: ([0-9a-f]+)/.exec(out);
  return digest ? `${digest[1]}  ${dn ? dn[1].trim() : ''}`.trim() : '(no signer found)';
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = (name, fallback) => {
    const at = rest.indexOf(name);
    return at === -1 ? fallback : rest[at + 1];
  };
  const positional = rest.filter((a, i) => !a.startsWith('--') && !(i && rest[i - 1].startsWith('--')));

  switch (cmd) {
    case 'build':
      execFileSync('cmd', ['/c', path.join(HERE, 'build.cmd')], {stdio: 'inherit'});
      return;
    case 'provision':
      execFileSync(process.execPath, [path.join(HERE, 'provision.js')], {stdio: 'inherit'});
      return;
    case 'sign': {
      if (!positional[0]) die('sign needs an apk');
      sign(positional[0], flag('--backend', 'emulated'));
      console.log(`signer: ${verify(positional[0])}`);
      return;
    }
    case 'verify':
      if (!positional[0]) die('verify needs an apk');
      console.log(verify(positional[0]));
      return;
    case 'probe':
      /* One OKCONNECT over USB - what every GUI sends on connect - and the
       * status line the key answers with. Nothing else is written. */
      return (async () => {
        const {openUsb} = require('./session');
        const s = await openUsb();
        try {
          const r = await s.device.connect();
          console.log(`status:   ${String(r.status).trim()}`);
          console.log(`identity: ${JSON.stringify(r.identity)}`);
        } finally {
          await s.stop();
        }
      })().catch((e) => die(e.message));
    default:
      console.error(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 8).join('\n'));
      process.exit(cmd ? 1 : 0);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {sign, verify, BACKENDS, SIGNER_CERT};
