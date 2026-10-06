/**
 * The soft key's "waiting for you" state as the JNI bridge packs it
 * (okemu_jni.cpp nativeConfirmState): bits 0-7 CRYPTO_AUTH, 8-15 opcode,
 * 16-23 slot, 24-26 input mode, 27 isfade.
 */
import {decodeConfirmState} from '../src/transport/OkEmu';
import {createStuckWatch, describeWaiting} from '../src/hooks/useKeyWaiting';

const pack = (auth: number, opcode: number, slot: number, mode: number, open = 1) =>
  auth | (opcode << 8) | (slot << 16) | (mode << 24) | (open << 27);

test('an agent sign waiting for a single press', () => {
  const w = decodeConfirmState(pack(3, 0xed, 201, 1));
  expect(w).toEqual({what: 'sign', opcode: 0xed, slot: 201, mode: 'press', entered: 0});
  expect(describeWaiting(w!)).toMatch(/sign with a derived key \(the ssh \/ gpg agent\)/);
});

test('a code wait counts the digits entered, and never carries the code', () => {
  const w = decodeConfirmState(pack(2, 0xf0, 1, 0));
  expect(w).toEqual({what: 'decrypt', opcode: 0xf0, slot: 1, mode: 'code', entered: 1});
  expect(JSON.stringify(w)).not.toMatch(/digit|challenge|button/i);
});

test('nothing waits: 0, approved-and-running (4), a closed window, not running, or a WebAuthn wait (CTAP has its own prompt)', () => {
  expect(decodeConfirmState(0)).toBeNull();
  expect(decodeConfirmState(pack(4, 0xed, 201, 1))).toBeNull();
  expect(decodeConfirmState(pack(3, 0xed, 201, 1, 0))).toBeNull();
  expect(decodeConfirmState(-1)).toBeNull();
  expect(decodeConfirmState(pack(3, 0xf6, 0, 1))).toBeNull();
});

test('HMAC and Edge always want a single press; an older firmware with no input mode is unknown', () => {
  expect(decodeConfirmState(pack(3, 0xf5, 0, 0))!.mode).toBe('press');
  expect(decodeConfirmState(pack(1, 0xf8, 0, 1))!.what).toBe('edge');
  expect(decodeConfirmState(pack(1, 0xed, 2, 7))!.mode).toBe('unknown');
});

test('a wait still open past 30 s is logged once, and its end is logged', () => {
  const lines: string[] = [];
  const see = createStuckWatch(l => lines.push(l));
  const w = decodeConfirmState(pack(1, 0xed, 201, 1));
  see(w, 0);
  see(w, 20_000);
  expect(lines).toEqual([]); /* inside the firmware's own window */
  see(w, 31_000);
  see(w, 40_000);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toMatch(/still waiting after 31 s .*sign opcode 0xed slot 201 mode press/);
  see(null, 45_000);
  expect(lines[1]).toMatch(/the stuck wait ended after 45 s/);
});

test('a wait that ends inside its window logs nothing', () => {
  const lines: string[] = [];
  const see = createStuckWatch(l => lines.push(l));
  see(decodeConfirmState(pack(1, 0xed, 201, 1)), 0);
  see(null, 19_000);
  see(null, 60_000);
  expect(lines).toEqual([]);
});
