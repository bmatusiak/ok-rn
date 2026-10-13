/**
 * THE SWAP, BOTH PHONES IN ONE PROCESS: two swap controllers joined by a fake radio, each with a
 * stand-in OnlyKey holding a real X-Wing key. The whole path the sheet drives - QR, link,
 * handshake, one press each, picked keys across - minus Bluetooth itself (the Pixel + A13 test).
 */
import {createSwap, type Link, type SwapView} from '../swapLink';

const nodeCrypto = require('crypto');
const {ml_kem768_x25519: xwing} = require('node-onlykey-lib/vendor/@noble/post-quantum/hybrid.js');

const randomBytes = (n: number) => new Uint8Array(nodeCrypto.randomBytes(n));

/** Two ends of a radio: what one sends, the other receives as 'data'; join finds the host by link id. */
function radio() {
  const ends: any[] = [];
  let hosted: string | null = null;
  const make = (me: number): Link => {
    const listeners = new Set<(e: any) => void>();
    const end = {
      deliver: (e: any) => setTimeout(() => listeners.forEach(l => l({hex: '', mtu: 0, message: '', ...e})), 0),
      closed: false,
    };
    ends[me] = end;
    const other = () => ends[1 - me];
    return {
      host: async linkHex => {
        hosted = linkHex;
      },
      join: async linkHex => {
        if (linkHex !== hosted) throw new Error('the other phone was not found');
        other().deliver({type: 'connected', mtu: 185});
        return 182;
      },
      send: async hex => {
        if (end.closed) throw new Error('closed');
        other().deliver({type: 'data', hex});
      },
      close: async () => {
        if (end.closed) return;
        end.closed = true;
        other()?.deliver({type: 'closed', message: 'the other phone disconnected'});
      },
      listen: fn => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    };
  };
  return [make(0), make(1)];
}

function onlyKey() {
  const kp = xwing.keygen();
  const key = {
    presses: 0,
    identity: async () => ({
      publicKey: kp.publicKey,
      decapsulate: async (ct: Uint8Array) => {
        key.presses += 1;
        return xwing.decapsulate(ct, kp.secretKey);
      },
    }),
  };
  return key;
}

const until = async (pred: () => boolean, what: string) => {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise<void>(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const ALICE = {name: 'Alice', keys: [{format: 'age', label: 'files (quantum-safe)', text: 'age1onlykey1qtestrecipientforswaplinktest'}]};
const BOB = {name: 'Bob', keys: [{format: 'ssh', label: 'laptop', text: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFRlc3RLZXlGb3JTd2FwTGlua1Rlc3RPbmx5MDA bob@laptop'}]};

test('a QR, one scan: both phones link, each OnlyKey presses once, the picked keys cross', async () => {
  const [hostLink, joinLink] = radio();
  const a = onlyKey();
  const b = onlyKey();
  let av: SwapView = {step: 'connecting'};
  let bv: SwapView = {step: 'connecting'};
  const alice = createSwap({link: hostLink, identity: a.identity, randomBytes, onView: v => (av = v)});
  const bob = createSwap({link: joinLink, identity: b.identity, randomBytes, onView: v => (bv = v)});

  await alice.host();
  expect(av.step).toBe('waiting');
  const url = (av as any).url as string;
  expect(url).toMatch(/^okrn:\/\/connect\?v=2&/);

  await bob.join(url);
  await until(() => av.step === 'linked' && bv.step === 'linked', 'both linked');
  expect(a.presses).toBe(1);
  expect(b.presses).toBe(1);

  await alice.send(ALICE);
  await bob.send(BOB);
  await until(() => (av as any).received && (bv as any).received, 'both cards');
  expect((bv as any).received).toEqual(ALICE);
  expect((av as any).received).toEqual(BOB);
  expect((av as any).sent && (bv as any).sent).toBe(true);
});

test('a photo of an old QR finds no phone; a QR that is not an invite is refused by name', async () => {
  const [hostLink, joinLink] = radio();
  let av: SwapView = {step: 'connecting'};
  let bv: SwapView = {step: 'connecting'};
  const alice = createSwap({link: hostLink, identity: onlyKey().identity, randomBytes, onView: v => (av = v)});
  await alice.host();
  const url = (av as any).url as string;
  await alice.close();

  /* a different invite (another QR) - this link id is not advertised */
  const stale = url.replace(/b=[0-9a-f]{16}/, 'b=0011223344556677');
  const bob = createSwap({link: joinLink, identity: onlyKey().identity, randomBytes, onView: v => (bv = v)});
  await bob.join(stale);
  expect(bv).toEqual({step: 'failed', message: 'the other phone was not found'});

  const carol = createSwap({link: radio()[1], identity: onlyKey().identity, randomBytes, onView: v => (bv = v)});
  await carol.join('https://example.com/not-an-invite');
  expect(bv.step).toBe('failed');
  expect((bv as any).message).toMatch(/not an OnlyKey contact invite/);
});
