/**
 * The soft key's "waiting for you" state as the JNI bridge packs it
 * (okemu_jni.cpp nativeConfirmState): bits 0-7 CRYPTO_AUTH, 8-15 opcode,
 * 16-23 slot, 24-26 input mode, 27 isfade.
 */
import {decodeConfirmState} from '../src/transport/OkEmu';
import {describeWaiting} from '../src/hooks/useKeyWaiting';

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
