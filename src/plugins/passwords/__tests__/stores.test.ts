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

type Mode = 'ok' | 'refuse' | 'asks' | 'retries';
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
        if (press || mode === 'asks') { opts.onKeepAlive?.({retry: true}); opts.onKeepAlive?.(1); opts.onKeepAlive?.(2); }
        if (mode === 'retries') { opts.onKeepAlive?.({retry: true, attempt: 2}); opts.onKeepAlive?.(1); }
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

const TF = {touchFree: 'preference' as const};

test('a NEW store never opens by itself: no derive, no press, until Open with OnlyKey', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  expect(await s.tryOpen('embedded', soft.okcrypto)).toBeNull();
  expect(soft.calls.derives).toEqual([]);
});

test('a touch-free key: the first open is the button, after that the tab opens by itself', async () => {
  const kv = memory();
  const s = createStores({storage: kv, randomBytes});
  const soft = fakeKey('seed-A');
  const r = await s.openWithKey('embedded', soft.okcrypto, TF);
  expect(r.why).toBe('touch-free');
  expect(soft.calls.derives).toEqual([false]);
  const id = await s.identify('embedded', soft.okcrypto);
  expect(await s.readMeta(id)).toMatchObject({press: false, asked: false});
  await r.manager.put({kind: 'login', title: 'GitHub', password: 'p'});
  expect([...kv.map.keys()].every(k => k.startsWith(prefixOf(id)))).toBe(true);
  s.lockNow('embedded', () => soft.okcrypto);
  expect((await s.tryOpen('embedded', soft.okcrypto))?.why).toBe('touch-free');
});

test('a key that refuses the touch-free derive: the button makes a press store, and it never opens by itself', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'refuse');
  let pressAsked = 0;
  const r = await s.openWithKey('embedded', soft.okcrypto, {...TF, onKeepAlive: () => { pressAsked += 1; }});
  expect(r.why).toBe('press');
  expect(pressAsked).toBe(1);
  expect(soft.calls.derives).toEqual([false, true]);
  s.lockNow('embedded', () => soft.okcrypto);
  expect(await s.tryOpen('embedded', soft.okcrypto)).toBeNull();
  expect(soft.calls.derives).toEqual([false, true]);
});

test('a key that ASKS a press for the touch-free derive (the live Pixel key): recorded, the tab waits for the button', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'asks');
  expect((await s.openWithKey('embedded', soft.okcrypto, TF)).why).toBe('touch-free');
  expect(await s.readMeta(await s.identify('embedded', soft.okcrypto))).toMatchObject({press: false, asked: true});
  s.lockNow('embedded', () => soft.okcrypto);
  expect(await s.tryOpen('embedded', soft.okcrypto)).toBeNull();
  expect((await s.openWithKey('embedded', soft.okcrypto, TF)).why).toBe('touch-free'); /* same flag, same key */
  expect(soft.calls.derives).toEqual([false, false]);
});

test('a dropped link on the first open decides nothing: the store has no flag yet', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  soft.okcrypto.deviceVault.key = async () => { throw new Error('the link closed'); };
  await expect(s.openWithKey('embedded', soft.okcrypto, TF)).rejects.toThrow('the link closed');
  expect(await s.readMeta(await s.identify('embedded', soft.okcrypto))).toBeNull();
});

test('a derive retry or a "processing" keepalive is not a press: the tab still opens by itself', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'retries');
  await s.openWithKey('embedded', soft.okcrypto, TF);
  expect(await s.readMeta(await s.identify('embedded', soft.okcrypto))).toMatchObject({press: false, asked: false});
  s.lockNow('embedded', () => soft.okcrypto);
  expect((await s.tryOpen('embedded', soft.okcrypto))?.why).toBe('touch-free');
});

test('an open session reopens with no derive; an expired one closes the store', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A', 'refuse');
  await s.openWithKey('embedded', soft.okcrypto, TF);
  s.close('embedded'); /* the tab closed the store; the session key is still cached */
  expect((await s.tryOpen('embedded', soft.okcrypto))?.why).toBe('session');
  expect(soft.calls.derives).toEqual([false, true]);
  expect(s.touch('embedded', soft.okcrypto)).toBe(true);
  soft.expire();
  s.reap('embedded', soft.okcrypto);
  expect(s.current('embedded')).toBeNull();
  expect(s.openCount()).toBe(0);
});

test('same backup on two keys: one store, one list; a key with other seeds sees none of it', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  const hard = fakeKey('seed-A'); /* a hard key restored from the soft key's backup */
  const other = fakeKey('seed-B');
  const a = await s.openWithKey('embedded', soft.okcrypto, TF);
  await a.manager.put({kind: 'login', title: 'Shared', password: 's'});
  const h = await s.tryOpen('usb', hard.okcrypto);
  expect(h?.why).toBe('session');
  expect(h!.manager).toBe(a.manager);
  expect(hard.calls.derives).toEqual([]);
  s.close('embedded');
  expect(s.current('usb')!.list().map((e: any) => e.title)).toEqual(['Shared']);
  s.close('usb');
  const o = await s.openWithKey('usb', other.okcrypto, TF);
  expect(o.manager.size).toBe(0);
  expect(o.manager.refused()).toEqual([]);
});

test('Lock now closes the shared store for both keys and wipes both session keys', async () => {
  const s = createStores({storage: memory(), randomBytes});
  const soft = fakeKey('seed-A');
  const hard = fakeKey('seed-A');
  await s.openWithKey('embedded', soft.okcrypto, TF);
  await s.tryOpen('usb', hard.okcrypto);
  hard.cache.set(LABEL, new Uint8Array(32));
  s.lockNow('usb', b => (b === 'usb' ? hard.okcrypto : soft.okcrypto));
  expect(s.openCount()).toBe(0);
  expect(soft.cache.has(LABEL)).toBe(false);
  expect(hard.cache.has(LABEL)).toBe(false);
});

test('firmware that cannot derive touch-free: the button makes a press store at once; a damaged meta is an error', async () => {
  const kv = memory();
  const s = createStores({storage: kv, randomBytes});
  const soft = fakeKey('seed-A');
  expect((await s.openWithKey('embedded', soft.okcrypto, {touchFree: 'broken'})).why).toBe('press');
  expect(soft.calls.derives).toEqual([true]);
  const id = await s.identify('embedded', soft.okcrypto);
  s.lockNow('embedded', () => soft.okcrypto);
  kv.map.set(prefixOf(id) + 'meta', '{"v":2}');
  await expect(s.openWithKey('embedded', soft.okcrypto, TF)).rejects.toThrow(/damaged/);
});
