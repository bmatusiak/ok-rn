/*
 * The store rules of src/plugins/passwords/stores.ts, against fake keys: a key is a seed, its
 * public key and its vault key are hashes of that seed (the vault key also of the press flag, as
 * on the device), and its session cache is a Map.
 */
import {sha256} from 'node-onlykey-lib/vendor/@noble/hashes/sha2.js';
import {createStores, LABEL, prefixOf, type Okcrypto} from '../stores';

const sha = (...parts: string[]) => sha256(Uint8Array.from(parts.join('|'), c => c.charCodeAt(0)));
/* tests only: distinct bytes are all the seal needs here */
const randomBytes = (n: number) => Uint8Array.from({length: n}, () => Math.floor(Math.random() * 256));

type Mode = 'ok' | 'refuse' | 'asks';
function fakeKey(seed: string, mode: Mode = 'ok') {
  const cache = new Map<string, Uint8Array>();
  const calls = {derives: [] as boolean[], publicKeys: 0};
  let expired = false;
  const okcrypto: Okcrypto = {
    async derivePublicKey(label) {
      calls.publicKeys += 1;
      return {publicKey: new Uint8Array([4, ...sha(seed, 'pub', label), ...sha(seed, 'pub2', label)])};
    },
    deviceVault: {
      async key(label, opts: any = {}) {
        const hit = cache.get(label);
        if (hit) return hit;
        const press = opts.requirePress ?? true;
        calls.derives.push(press);
        if (!press && mode === 'refuse') throw new Error('CTAP2_ERR_OPERATION_DENIED');
        if (press || mode === 'asks') opts.onKeepAlive?.();
        const k = sha(seed, 'vault', label, String(press));
        cache.set(label, k);
        return k;
      },
      isUnlocked: label => !expired && cache.has(label),
      lock: label => cache.delete(label),
      reap: () => (expired ? [...cache.keys()].filter(l => cache.delete(l)) : []),
    },
  };
  return {okcrypto, calls, cache, expire: () => { expired = true; }};
}

function memory() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => void map.set(k, v),
    removeItem: async (k: string) => void map.delete(k),
  };
}

test('a touch-free key opens on the tab by itself, and records its store as touch-free', async () => {
  const kv = memory();
  const s = createStores({storage: kv, randomBytes});
  const soft = fakeKey('seed-A');
  const r = await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'});
  expect(r?.why).toBe('touch-free');
  expect(soft.calls.derives).toEqual([false]);
  const id = await s.identify('embedded', soft.okcrypto);
  expect(await s.readMeta(id)).toMatchObject({press: false, asked: false});
  await r!.manager.put({kind: 'login', title: 'GitHub', password: 'p'});
  expect([...kv.map.keys()].every(k => k.startsWith(prefixOf(id)))).toBe(true);
});

test('a key that refuses the touch-free derive waits for the button, then makes a press store', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'refuse');
  expect(await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'})).toBeNull();
  let pressAsked = 0;
  const r = await s.openWithKey('embedded', soft.okcrypto, {onKeepAlive: () => { pressAsked += 1; }});
  expect(r.why).toBe('press');
  expect(pressAsked).toBe(1);
  expect(soft.calls.derives).toEqual([false, true]);
  /* the tab never tries again by itself: a press store waits for the button, no derive sent */
  s.lockNow('embedded', () => soft.okcrypto);
  expect(await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'})).toBeNull();
  expect(soft.calls.derives).toEqual([false, true]);
});

test('a dropped link on the first try decides nothing: the store has no flag yet', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  soft.okcrypto.deviceVault.key = async () => { throw new Error('the link closed'); };
  await expect(s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'})).rejects.toThrow('the link closed');
  expect(await s.readMeta(await s.identify('embedded', soft.okcrypto))).toBeNull();
});

test('a touch-free derive that asked for a press opens, but the tab waits for the button next time', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'asks');
  expect((await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'}))?.why).toBe('touch-free');
  s.lockNow('embedded', () => soft.okcrypto);
  expect(await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'})).toBeNull();
  const again = await s.openWithKey('embedded', soft.okcrypto);
  expect(again.why).toBe('touch-free'); /* same flag as the store was made with: same key */
  expect(soft.calls.derives).toEqual([false, false]);
});

test('an open session reopens with no derive; an expired one closes the store', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'refuse');
  await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'});
  await s.openWithKey('embedded', soft.okcrypto);
  s.close('embedded'); /* the tab closed the store; the session key is still cached */
  expect((await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'}))?.why).toBe('session');
  expect(soft.calls.derives).toEqual([false, true]);
  expect(s.touch('embedded', soft.okcrypto)).toBe(true);
  soft.expire();
  s.reap('embedded', soft.okcrypto);
  expect(s.current('embedded')).toBeNull();
  expect(s.openCount()).toBe(0);
});

test('same backup on two keys: one store, one list; a key with other seeds sees none of it', async () => {
  const kv = memory();
  const s = createStores({storage: kv, randomBytes});
  const soft = fakeKey('seed-A');
  const hard = fakeKey('seed-A'); /* a hard key restored from the soft key's backup */
  const other = fakeKey('seed-B');
  const a = await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'});
  await a!.manager.put({kind: 'login', title: 'Shared', password: 's'});
  const h = await s.tryOpen('usb', hard.okcrypto, {touchFree: 'preference'});
  expect(h?.why).toBe('session');
  expect(h!.manager).toBe(a!.manager);
  expect(hard.calls.derives).toEqual([]);
  expect(s.openCount()).toBe(1);

  /* the soft key locks: the hard key, same backup, keeps the list open */
  s.close('embedded');
  expect(s.current('usb')!.list().map((e: any) => e.title)).toEqual(['Shared']);

  /* another key on the same phone: its own store, empty, nothing refused */
  s.close('usb');
  const o = await s.tryOpen('usb', other.okcrypto, {touchFree: 'preference'});
  expect(o!.manager.size).toBe(0);
  expect(o!.manager.refused()).toEqual([]);
  expect(await s.identify('usb', other.okcrypto)).not.toBe(await s.identify('embedded', soft.okcrypto));
});

test('Lock now closes the shared store for both keys and wipes both session keys', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  const hard = fakeKey('seed-A');
  await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'});
  await s.tryOpen('usb', hard.okcrypto, {touchFree: 'preference'});
  hard.cache.set(LABEL, new Uint8Array(32));
  s.lockNow('usb', b => (b === 'usb' ? hard.okcrypto : soft.okcrypto));
  expect(s.openCount()).toBe(0);
  expect(soft.cache.has(LABEL)).toBe(false);
  expect(hard.cache.has(LABEL)).toBe(false);
});

test('a firmware that cannot derive touch-free never tries; a damaged meta is an error, not a new store', async () => {
  const kv = memory();
  const s = createStores({storage: kv, randomBytes});
  const soft = fakeKey('seed-A');
  expect(await s.tryOpen('embedded', soft.okcrypto, {touchFree: 'broken'})).toBeNull();
  expect(soft.calls.derives).toEqual([]);
  const id = await s.identify('embedded', soft.okcrypto);
  kv.map.set(prefixOf(id) + 'meta', '{"v":2}');
  await expect(s.tryOpen('embedded', soft.okcrypto, {touchFree: 'preference'})).rejects.toThrow(/damaged/);
});
