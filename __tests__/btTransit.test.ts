/*
 * Part T, T3: the phone's pairing gate (src/btTransit.ts), driven by the lib's
 * own CLI side of btpair - the same code onlykey-js --ble runs - as the
 * computer. Vendor interface only: nothing here touches FIDO or the keyboard.
 */
import * as bt from 'node-onlykey-lib/btpair';
import {createBtTransit, CMD, KIND} from '../src/btTransit';

const PC = 'AA:BB:CC:00:11:22';
const DAY = 24 * 60 * 60 * 1000;

function memory() {
  const m = new Map<string, string>();
  return {
    m,
    getItem: async (k: string) => m.get(k) ?? null,
    setItem: async (k: string, v: string) => void m.set(k, v),
    removeItem: async (k: string) => void m.delete(k),
  };
}

/* a box that hides its input (xor + marker), so a plaintext secret in storage would show */
const box = {
  boxSeal: async (_a: string, hex: string) => 'bx' + hex.replace(/[0-9a-f]/g, c => ((parseInt(c, 16) ^ 0xa).toString(16))),
  boxOpen: async (_a: string, hex: string) => {
    if (!hex.startsWith('bx')) throw new Error('not sealed by this box');
    return hex.slice(2).replace(/[0-9a-f]/g, c => ((parseInt(c, 16) ^ 0xa).toString(16)));
  },
};

function phone(opts: {testing?: boolean; storage?: ReturnType<typeof memory>} = {}) {
  let t = 1_000_000;
  const storage = opts.storage ?? memory();
  const sent: {cmd: number; bytes: Uint8Array}[] = [];
  const alarms: string[] = [];
  const gate = createBtTransit({storage, box, now: () => t, isTestingMode: () => !!opts.testing, alarm: (_id, text) => alarms.push(text)});
  gate.setSender((cmd, bytes) => sent.push({cmd, bytes}));
  return {
    gate,
    sent,
    alarms,
    storage,
    tick: (ms: number) => {
      t += ms;
    },
    /* the next frame the phone sent, removed */
    take: () => sent.shift() ?? null,
  };
}

const report = (b: number) => {
  const r = new Uint8Array(64);
  r.set([0xff, 0xff, 0xff, 0xff, b]);
  return r;
};

/* the whole pairing, as `onlykey-js pair` does it; returns the CLI's record */
async function pair(p: ReturnType<typeof phone>, name = 'NITRO16', address = PC) {
  const cli = bt.generateIdentity();
  p.gate.openPairWindow();
  const s1 = bt.cliPairStart({identity: cli, name});
  expect(await p.gate.handle(0x05, s1.msg, address)).toBeNull();
  const keys = p.take()!;
  expect(keys.cmd).toBe(CMD.PAIR);
  const s2 = bt.cliPairOnKeys(s1.state, keys.bytes);
  await p.gate.handle(0x05, s2.msg, address);
  const view = p.gate.pairing();
  expect(view.stage).toBe('code');
  expect(view.stage === 'code' && view.code).toBe(s2.code); /* the same 6 digits on both screens */
  expect(p.take()).toBeNull(); /* nothing goes back until the person approves */
  expect(p.gate.approvePairing()).toBe(true);
  const done = p.take()!;
  const s3 = bt.cliPairOnDone(s2.state, done.bytes, Date.now());
  await p.gate.handle(0x05, s3.msg, address);
  const ack = p.take()!;
  expect(bt.cliPairOnAck(s3.record, ack.bytes)).toBe(true);
  expect(p.gate.pairing().stage).toBe('paired');
  return {cli, record: s3.record, name};
}

/* connect as the CLI does; returns its session, or null on silence */
async function connect(p: ReturnType<typeof phone>, record: any, name = 'NITRO16', address = PC) {
  const h = bt.cliHello(record, {name});
  await p.gate.handle(0x05, h.msg, address);
  const ok = p.sent.find(f => f.cmd === CMD.PAIR);
  if (!ok) return null;
  p.sent.splice(p.sent.indexOf(ok), 1);
  return bt.cliOnHelloOk(h.state, ok.bytes);
}

const sealedReport = (session: any, r: Uint8Array) => {
  const pt = new Uint8Array(65);
  pt[0] = KIND.REPORT;
  pt.set(r, 1);
  return bt.seal(session, pt);
};

test('a pairing request outside "Pair a computer" gets silence', async () => {
  const p = phone();
  const s1 = bt.cliPairStart({identity: bt.generateIdentity(), name: 'NITRO16'});
  expect(await p.gate.handle(0x05, s1.msg, PC)).toBeNull();
  expect(p.sent).toHaveLength(0);
});

test('the window closes after about two minutes', async () => {
  const p = phone();
  p.gate.openPairWindow();
  p.tick(bt.PAIR_WINDOW + 1);
  const s1 = bt.cliPairStart({identity: bt.generateIdentity(), name: 'NITRO16'});
  await p.gate.handle(0x05, s1.msg, PC);
  expect(p.sent).toHaveLength(0);
  expect(p.gate.pairing().stage).toBe('failed');
});

test('pair, then reports travel sealed both ways; the list shows no secret', async () => {
  const p = phone();
  const {record} = await pair(p);
  const list = await p.gate.list();
  expect(list).toHaveLength(1);
  expect(list[0]).toMatchObject({name: 'NITRO16', mac: 'AABBCC001122', on: true, code: record.code});
  expect(JSON.stringify(list)).not.toContain(record.ps);

  const session = (await connect(p, record))!;
  expect(session).toBeTruthy();
  const r = report(0x66);
  const toKey = await p.gate.handle(0x04, sealedReport(session, r), PC);
  expect(toKey).toEqual(r);

  const back = p.gate.outgoing(PC, report(0x99))!;
  expect(back.cmd).toBe(CMD.SEALED);
  const opened = bt.open(session, back.bytes);
  expect(opened[0]).toBe(KIND.REPORT);
  expect(opened.slice(1)).toEqual(report(0x99));
});

test('a replayed or changed frame is refused, silently', async () => {
  const p = phone();
  const {record} = await pair(p);
  const session = (await connect(p, record))!;
  const frame = sealedReport(session, report(0x10));
  expect(await p.gate.handle(0x04, frame, PC)).not.toBeNull();
  expect(await p.gate.handle(0x04, frame, PC)).toBeNull(); /* replay */
  const flipped = sealedReport(session, report(0x11));
  flipped[10] ^= 1;
  expect(await p.gate.handle(0x04, flipped, PC)).toBeNull();
  expect(p.sent).toHaveLength(0);
});

test('plaintext gets silence while transit is on, in every build', async () => {
  const p = phone({testing: false});
  await p.gate.setTransitOff(true); /* the switch does nothing outside testing mode */
  expect(await p.gate.handle(0x03, report(0x66), PC)).toBeNull();
  expect(p.gate.outgoing(PC, report(0x66))).toBeNull();
});

test('testing mode with transit switched off lets plaintext through', async () => {
  const p = phone({testing: true});
  expect(await p.gate.handle(0x03, report(0x66), PC)).toBeNull();
  await p.gate.setTransitOff(true);
  expect(p.gate.transitOff()).toBe(true);
  expect(await p.gate.handle(0x03, report(0x66), PC)).toEqual(report(0x66));
  expect(p.gate.outgoing(PC, report(0x77))).toEqual({cmd: CMD.PLAIN, bytes: report(0x77)});
});

test('unpaired, switched off and revoked computers get silence; On again works', async () => {
  const p = phone();
  const stranger = {id: '00'.repeat(16), ps: '11'.repeat(32), epoch: 0, renewedAt: 0};
  expect(await connect(p, stranger)).toBeNull();

  const {record} = await pair(p);
  const id = (await p.gate.list())[0].id;
  await p.gate.setOn(id, false);
  expect(await connect(p, record)).toBeNull();
  await p.gate.setOn(id, true);
  expect(await connect(p, record)).not.toBeNull();
  await p.gate.revoke(id);
  expect(await connect(p, record)).toBeNull();
  expect(await p.gate.list()).toHaveLength(0);
});

test('switching a computer off ends its live session', async () => {
  const p = phone();
  const {record} = await pair(p);
  const session = (await connect(p, record))!;
  await p.gate.setOn((await p.gate.list())[0].id, false);
  expect(await p.gate.handle(0x04, sealedReport(session, report(1)), PC)).toBeNull();
  expect(p.gate.outgoing(PC, report(1))).toBeNull();
});

test('the pairing is bound to the computer name and its Bluetooth address: either changed = revoked', async () => {
  const p = phone();
  const {record} = await pair(p);
  expect(await connect(p, record, 'OTHER-PC')).toBeNull();
  expect((await p.gate.notices())[0]).toMatchObject({kind: 'revoked-name', name: 'NITRO16'});
  expect(p.alarms[0]).toMatch(/another computer name/);
  expect(await p.gate.list()).toHaveLength(0);

  const q = phone();
  const second = await pair(q);
  expect(await connect(q, second.record, 'NITRO16', '11:22:33:44:55:66')).toBeNull();
  expect((await q.gate.notices())[0]).toMatchObject({kind: 'revoked-mac'});
});

test('day 6: the renewal rides inside the session; the old secret used afterwards is the copy alarm', async () => {
  const p = phone();
  const {record} = await pair(p);
  const copied = {...record}; /* someone copied ~/.onlykey-js before the renewal */
  p.tick(6 * DAY + 1);
  const session = (await connect(p, record))!;
  const offer = p.take()!;
  expect(offer.cmd).toBe(CMD.SEALED);
  const pt = bt.open(session, offer.bytes);
  expect(pt[0]).toBe(KIND.CONTROL);
  const accepted = bt.cliRenewAccept(record, pt.slice(1), Date.now());
  const reply = new Uint8Array(1 + accepted.payload.length);
  reply[0] = KIND.CONTROL;
  reply.set(accepted.payload, 1);
  expect(await p.gate.handle(0x04, bt.seal(session, reply), PC)).toBeNull();
  expect((await p.gate.list())[0].epoch).toBe(0); /* two-phase: pending until the CLI proves it */

  /* the renewed pairing connects (and is promoted); the copy raises the alarm and the computer is dropped */
  const renewed = bt.cliUseNext(accepted.record);
  expect(await connect(p, renewed)).not.toBeNull();
  expect((await p.gate.list())[0].epoch).toBe(1);
  expect(await connect(p, copied)).toBeNull();
  expect((await p.gate.notices())[0]).toMatchObject({kind: 'copy', name: 'NITRO16'});
  expect(p.alarms).toHaveLength(1); /* T5: the phone notification, not only the card */
  expect(p.alarms[0]).toMatch(/copy of NITRO16's pairing/);
  expect(await p.gate.list()).toHaveLength(0);
  expect(await connect(p, renewed)).toBeNull(); /* re-pair needed */
});

test('a pairing that missed its renewal expires and must pair again', async () => {
  const p = phone();
  const {record} = await pair(p);
  p.tick(7 * DAY + 1);
  expect(await connect(p, record)).toBeNull();
  expect((await p.gate.notices())[0]).toMatchObject({kind: 'expired'});
});

test('the store is sealed by the Keystore box and survives a restart', async () => {
  const p = phone();
  const {record} = await pair(p);
  const stored = p.storage.m.get('okt.btpair.v1')!;
  expect(stored.startsWith('bx')).toBe(true);
  /* the secret as it would appear inside hex(JSON): each hex character as its ASCII code */
  const plainHex = Array.from(String(record.ps), c => c.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  expect(stored).not.toContain(plainHex);

  const again = phone({storage: p.storage});
  expect(await again.gate.list()).toHaveLength(1);
  expect(await connect(again, record)).not.toBeNull();
});

test('an unreadable store (Keystore key gone) starts clean instead of guessing', async () => {
  const storage = memory();
  storage.m.set('okt.btpair.v1', 'not-sealed');
  const p = phone({storage});
  expect(await p.gate.list()).toHaveLength(0);
  expect(storage.m.get('okt.btpair.v1')!.startsWith('bx')).toBe(true);
});

test('a second bridge that takes over keeps the sender when the first one stops (two React roots, production 2026-10-05)', async () => {
  const p = phone();
  const {record} = await pair(p);
  const second: {cmd: number; bytes: Uint8Array}[] = [];
  const first = (cmd: number, bytes: Uint8Array) => p.sent.push({cmd, bytes});
  const other = (cmd: number, bytes: Uint8Array) => second.push({cmd, bytes});
  p.gate.setSender(first);
  p.gate.setSender(other); /* the new root's bridge starts... */
  p.gate.releaseSender(first); /* ...then the old root's bridge stops */
  const h = bt.cliHello(record, {name: 'NITRO16'});
  await p.gate.handle(0x05, h.msg, PC);
  expect(second.some(f => f.cmd === CMD.PAIR)).toBe(true); /* the answer went out */
});
