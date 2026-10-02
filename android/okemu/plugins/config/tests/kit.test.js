'use strict';
/*
 * config's emulator tests (the onlykey-testing kit), SIDE-LOADED from this
 * folder by 01-protocol/38-softkey-plugins.test.js when the emulator was built
 * with OKEMU_PLUGINS=config (the test there requires the EMULATED capability,
 * so these never reach a hard key - OKGETCONFIG never goes into one).
 *
 * The truth is what the key DOES with a value, not what it prints: each value
 * read back is one this test wrote through the firmware's own setting write,
 * and each resolved [input] mode is checked against a write that changes it.
 *
 * Everything from the kit comes through ctx: IFACE, okmsg, PINS, kit.
 */
const OKGETCONFIG = 0x80 | 0x79;
const OKSETCONFIG = 0x80 | 0x7a;
const OKSETSLOT_GLOBAL = 0; /* node-onlykey-lib src/device/slots.js GLOBAL_SLOT */

/* every key OKGETCONFIG v1 may print - anything else is a leak or a drift */
const KNOWN = {
  input: ['derived_keys', 'stored_keys', 'web_derive', 'hmac'],
  preferences: ['typeSpeed', 'keyboardLayout', 'ledBrightness', 'lockout', 'lockButton', 'touchSense', 'modKeyMode',
    'hmacChallengeMode', 'derivedChallengeMode', 'storedChallengeMode', 'webAgentDeriveMode', 'secProfileMode'],
  advanced: ['webcryptPolicy', 'wipeMode', 'backupKeyMode'],
};

module.exports = function register({ it }, ctx) {
  /* the INI, read whole: reports until the NUL */
  async function readConfig(device, { signal }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: OKGETCONFIG, payload: Buffer.alloc(0) });
    await device.waitHid(ctx.IFACE.VENDOR, { since, timeoutMs: 8000, signal });
    const deadline = Date.now() + 6000;
    for (;;) {
      const bytes = Buffer.concat(device.reportsSince(ctx.IFACE.VENDOR, since).map((r) => Buffer.from(r)));
      const nul = bytes.indexOf(0);
      if (nul >= 0) return { text: bytes.subarray(0, nul).toString('utf8'), bytes };
      if (Date.now() > deadline) throw new Error(`OKGETCONFIG: no NUL after ${bytes.length} bytes`);
      await device.sleep(50, { signal });
    }
  }

  /* [section] -> {key: value}; comments and blank lines dropped */
  function parse(text) {
    const out = {};
    let sec = null;
    for (const raw of text.split('\n')) {
      const l = raw.trim();
      if (!l || l.startsWith(';')) continue;
      const m = l.match(/^\[(\w+)\]$/);
      if (m) { sec = m[1]; out[sec] = {}; continue; }
      const kv = l.match(/^(\w+)=(.*)$/);
      if (!kv || !sec) throw new Error(`not INI: ${JSON.stringify(l)}`);
      out[sec][kv[1]] = kv[2];
    }
    return out;
  }

  async function setGlobal(device, field, value, { signal }) {
    const since = device.mark(ctx.IFACE.VENDOR);
    device.sendVendor({ msg: ctx.okmsg.MSG.OKSETSLOT, slot: OKSETSLOT_GLOBAL, field, payload: Buffer.from([value]) });
    const ack = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /Success|Error/, timeoutMs: 8000, signal });
    return ctx.okmsg.text(ack).trim();
  }

  it('config: OKGETCONFIG prints the key\'s settings as INI - known keys only, whole reports, NUL-ended',
    async ({ device, assert, signal, log }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const { text, bytes } = await readConfig(device, { signal });
      log(text.split('\n').slice(0, 7).join(' | '));
      assert.match(text, /^; OnlyKey soft key config - OKGETCONFIG v1\n/);
      assert.equal(bytes.length % 64, 0, 'the reply is not whole reports');
      const ini = parse(text);
      assert.equal(JSON.stringify(Object.keys(ini)), JSON.stringify(['input', 'preferences', 'advanced']));
      for (const [sec, keys] of Object.entries(ini)) {
        for (const k of Object.keys(keys)) assert.ok(KNOWN[sec].includes(k), `[${sec}] ${k} is not a known OKGETCONFIG key`);
      }
      for (const k of KNOWN.input) assert.match(ini.input[k], /^(code|press|none)$/, `[input] ${k}=${ini.input[k]}`);
      for (const v of Object.values(ini.preferences)) assert.match(v, /^\d{1,3}$/);
    });

  it('config: a setting written is read back exactly as written (lockout, LED, type speed, lock button)',
    async ({ device, assert, signal }) => {
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = parse((await readConfig(device, { signal })).text).preferences;
      const want = { lockout: [11, 17], ledBrightness: [24, 5], typeSpeed: [13, 7], lockButton: [25, 3] };
      try {
        for (const [, [field, v]] of Object.entries(want)) assert.match(await setGlobal(device, field, v, { signal }), /^Success/);
        const after = parse((await readConfig(device, { signal })).text).preferences;
        for (const [k, [, v]] of Object.entries(want)) assert.equal(after[k], String(v), `${k}: wrote ${v}, read ${after[k]}`);
      } finally {
        /* put the key back as it was, for the tests after this one */
        for (const [k, [field]] of Object.entries(want)) if (/^\d+$/.test(before[k] || '')) await setGlobal(device, field, Number(before[k]), { signal });
      }
    });

  it('config: [input] is what the key will ask - field 21 press reads "press", challenge reads "code"',
    async ({ device, assert, signal }) => {
      const { pqc } = ctx.kit;
      const was = parse((await (async () => { await device.ensureUnlocked(ctx.PINS.primary, { signal }); return readConfig(device, { signal }); })()).text).preferences.derivedChallengeMode;
      try {
        for (const [mode, word] of [[1, 'press'], [0, 'code']]) {
          await pqc.readyForKeygen(device, { signal }); /* field 21 is written in config mode */
          assert.match(await setGlobal(device, 21, mode, { signal }), /^Success/);
          /* ...and read out of it: config mode lets only its own allow-list through (okcore.cpp:338) */
          await device.restart({ signal });
          await device.ensureUnlocked(ctx.PINS.primary, { signal });
          const ini = parse((await readConfig(device, { signal })).text);
          assert.equal(ini.preferences.derivedChallengeMode, String(mode));
          assert.equal(ini.input.derived_keys, word, `field 21 = ${mode} resolved as ${ini.input.derived_keys}`);
        }
      } finally {
        if (/^\d+$/.test(was || '')) {
          await pqc.readyForKeygen(device, { signal });
          await setGlobal(device, 21, Number(was), { signal });
          await device.restart({ signal });
        }
      }
    });

  it('config: refused through the WebAuthn tunnel (CTAP) - vendor API only',
    async ({ device, assert, signal }) => {
      const { Ctap2 } = ctx.kit.ctap2;
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const ctap = new Ctap2(device, { signal });
      await ctap.init();
      const r = await ctx.kit.tunnel.send(ctap, { cmd: OKGETCONFIG, data: Buffer.alloc(0) }, { signal }).catch((e) => ({ error: String(e.message || e) }));
      const seen = r.data ? r.data.toString('latin1') : JSON.stringify(r);
      assert.ok(!/\[input\]|OKGETCONFIG v1/.test(seen), `the INI came back over CTAP: ${seen.slice(0, 80)}`);
    });

  /* OKSETCONFIG: the INI in chunks - byte 5 = 0xFF for more, else the last chunk's length; the text from byte 6 */
  async function importConfig(device, text, { signal }) {
    const bytes = Buffer.from(text, 'latin1');
    const since = device.mark(ctx.IFACE.VENDOR);
    for (let i = 0; i < bytes.length; i += 58) {
      const chunk = bytes.subarray(i, i + 58);
      const last = i + 58 >= bytes.length;
      device.sendVendor({ msg: OKSETCONFIG, slot: last ? chunk.length : 0xFF, payload: chunk });
      await device.sleep(60, { signal });
    }
    const r = await device.waitHid(ctx.IFACE.VENDOR, { since, match: /OKSETCONFIG|Error/, timeoutMs: 8000, signal });
    return ctx.okmsg.text(r).trim();
  }

  /* OKSETCONFIG is built into DEBUG builds only (owner, 2026-10-02) - the kit's 38 says which this is */
  const debugBuild = !!(ctx.build && ctx.build.debug);

  it('config: a release build has no OKSETCONFIG - the import is answered by nothing',
    async ({ device, assert, signal, skip }) => {
      if (debugBuild) return skip('this emulator is a DEBUG build, which has the import');
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const since = device.mark(ctx.IFACE.VENDOR);
      device.sendVendor({ msg: OKSETCONFIG, slot: 14, payload: Buffer.from('[preferences]\nlockout=9\n', 'latin1') });
      await device.sleep(2000, { signal });
      const said = device.reportsSince(ctx.IFACE.VENDOR, since).map((r) => ctx.okmsg.text(r)).filter((t) => /OKSETCONFIG/.test(t));
      assert.equal(JSON.stringify(said), '[]', `a release build answered OKSETCONFIG: ${said.join(' | ')}`);
    });

  it('config: OKSETCONFIG is refused out of config mode - nothing changes',
    async ({ device, assert, signal, skip }) => {
      if (!debugBuild) return skip('a release build: OKSETCONFIG is built into DEBUG builds only');
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = parse((await readConfig(device, { signal })).text).preferences.lockout;
      const said = await importConfig(device, `[preferences]\nlockout=${Number(before) === 9 ? 8 : 9}\n`, { signal });
      assert.equal(said, 'Error OKSETCONFIG needs config mode');
      assert.equal(parse((await readConfig(device, { signal })).text).preferences.lockout, before);
    });

  it('config: OKSETCONFIG imports an INI in config mode through the firmware\'s own writes; [input] is ignored, unknown keys counted',
    async ({ device, assert, signal, skip }) => {
      if (!debugBuild) return skip('a release build: OKSETCONFIG is built into DEBUG builds only');
      const { pqc } = ctx.kit;
      await device.ensureUnlocked(ctx.PINS.primary, { signal });
      const before = parse((await readConfig(device, { signal })).text);
      const file = [
        '; OnlyKey soft key config - OKGETCONFIG v1',
        '[input]', 'derived_keys=none',
        '[preferences]', 'lockout=23', 'ledBrightness=6', 'derivedChallengeMode=1', 'notASetting=4',
        ''].join('\n');
      try {
        await pqc.readyForKeygen(device, { signal }); /* config mode */
        assert.equal(await importConfig(device, file, { signal }), 'OKSETCONFIG applied 3 unknown 1');
        /* read back in config mode - OKGETCONFIG is allowed there for exactly this */
        const after = parse((await readConfig(device, { signal })).text);
        assert.equal(JSON.stringify([after.preferences.lockout, after.preferences.ledBrightness, after.preferences.derivedChallengeMode]), JSON.stringify(['23', '6', '1']));
        assert.equal(after.input.derived_keys, 'press', '[input] was imported');
      } finally {
        /* put it back, in config mode, the same way */
        const back = Object.entries(before.preferences).filter(([k]) => ['lockout', 'ledBrightness', 'derivedChallengeMode'].includes(k)).map(([k, v]) => `${k}=${v}`);
        if (back.length) {
          await pqc.readyForKeygen(device, { signal });
          await importConfig(device, ['[preferences]', ...back, ''].join('\n'), { signal });
        }
        await device.restart({ signal });
      }
    });
};
