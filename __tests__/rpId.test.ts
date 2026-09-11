import {protocol, bytes as okbytes} from 'node-onlykey-lib';
import {rpIdFromPayload} from '../src/transport/FidoGatt';

/* The library's own encoder, so the fixture is CBOR the way a browser sends it. */
const hex = (value: unknown) => okbytes.toHex(protocol.cbor.encode(value));

test('makeCredential: key 2 is the rp map, its "id" is the relying party', () => {
  const req = new Map<number, unknown>([
    [1, new Uint8Array(32)],
    [2, new Map<string, unknown>([['id', 'example.org'], ['name', 'Example']])],
    [3, new Map<string, unknown>([['id', new Uint8Array(8)], ['name', 'u']])],
    [4, [new Map<string, unknown>([['alg', -7], ['type', 'public-key']])]],
  ]);
  expect(rpIdFromPayload('makeCredential', hex(req))).toBe('example.org');
});

test('getAssertion: key 1 is the relying party as text', () => {
  const req = new Map<number, unknown>([[1, 'login.example.net'], [2, new Uint8Array(32)]]);
  expect(rpIdFromPayload('getAssertion', hex(req))).toBe('login.example.net');
});

test('anything else is "", never a throw', () => {
  expect(rpIdFromPayload('getInfo', '')).toBe('');
  expect(rpIdFromPayload('makeCredential', 'ff')).toBe('');
  expect(rpIdFromPayload('makeCredential', hex(new Map([[2, 'not a map']])))).toBe('');
  expect(rpIdFromPayload('getAssertion', hex(new Map([[1, 42]])))).toBe('');
  expect(rpIdFromPayload('', hex(new Map([[1, 'x']])))).toBe('');
});
