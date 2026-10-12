/*
 * THE PASSWORD STORES, one per key identity - the part of the hook with no React in it, so the
 * rules below are tested without a phone (__tests__/stores.test.ts).
 *
 * WHICH STORE (Brad, 2026-10-11: "password storage is encrypted to the keys identity,, so
 * multipul keys can use the app at same itme"; "if i used a differkey with different
 * backup/keys/seeds ... it should no show the same list ... unless its the same key (shared
 * backup)"). A key is identified by the public key of the manager's derive label
 * (`vault:ok-rn-manager`): asking for a public key never needs a press, and slot 128, which it
 * comes from, travels in the backup. So a soft key and a hard key restored from one backup get
 * the same store id, and share ONE open store - one list, one session; keys with other seeds get
 * other ids and never see each other's entries. Each store lives under its own AsyncStorage
 * prefix, `okrn.passwords.<id>/`.
 *
 * TOUCH-FREE OR PRESS, decided once per store (Brad, 2026-10-11: "touch free if possible, and
 * press to open if not"). The press flag is an INPUT to the derive - the same label with and
 * without a press gives two different keys - so a store is made with one flag, records it in its
 * meta, and is never opened with the other (that would open nothing and look like an empty list).
 * A new store first tries the touch-free derive; a key that refuses it (firmware 3.1.0 asks field
 * 30 before a touch-free shared secret) gets a press store instead, made when the person taps
 * "Open with OnlyKey". The derive itself is okcrypto.deviceVault.key, so the manager key sits in
 * that backend's session cache (default session:30m, sliding) with every other vault key, and
 * lockAll on a lock wipes it too.
 *
 * WHEN THE TAB MAY OPEN IT BY ITSELF (Brad, 2026-10-11: "the password manager should unlock when
 * i open the tab"; "if there is a press needed,, then a Open with OnlyKey button will be needed so
 * we dont hammer the key"): when the backend's session already holds the key, or the store is
 * touch-free and its last open asked for no press. Anything else waits for the button, so
 * switching tabs never sends a press request.
 */

import {manager as m} from 'node-onlykey-lib/passwords';

export type Backend = 'embedded' | 'usb';
export type Manager = Awaited<ReturnType<typeof m.openManager>>;

/** What a store records about itself, in clear: nothing in it names a site or a secret. */
/*
 * policy: how long the store stays open once its key is derived (spec "Unlock and session
 * policy": "a person can pick ... up to session:8h"). Absent = the default, 30 minutes.
 */
export type StoreMeta = {v: 1; press: boolean; asked: boolean; createdAt: string; policy?: StorePolicy};

/*
 * The choices. No 'always' (no cache): the screen checks the session on every tap and closes the
 * store when the key is not held, so a store opened under 'always' would shut on its first tap.
 * Up to 1 h a window slides with use; 8 h and 'startup' (until the app restarts) are fixed.
 */
export const STORE_POLICIES = ['session:5m', 'session:30m', 'session:8h', 'startup'] as const;
export type StorePolicy = (typeof STORE_POLICIES)[number];
export const DEFAULT_STORE_POLICY: StorePolicy = 'session:30m';
const isStorePolicy = (p: unknown): p is StorePolicy => (STORE_POLICIES as readonly unknown[]).includes(p);

/** Key/value storage with AsyncStorage's three methods. */
export type KV = {
  getItem(k: string): Promise<string | null>;
  setItem(k: string, v: string): Promise<void>;
  removeItem(k: string): Promise<void>;
};

/** The parts of a backend's okcrypto this uses. */
export type Okcrypto = {
  derivePublicKey(label: string, opts?: object): Promise<{publicKey: Uint8Array}>;
  deviceVault: {
    key(label: string, opts?: object): Promise<Uint8Array>;
    isUnlocked(label: string): boolean;
    lock(label: string): unknown;
    reap(): string[];
    /* read-only: the policy and the cached keys' time left (neither counts as a use) */
    getPolicy?(label: string): string;
    setPolicy?(label: string, policy: string): unknown;
    status?(): {serviceId: string; policy: string; remainingMs: number}[];
  };
};

export type OpenWhy = 'session' | 'touch-free' | 'press';

/** The label deviceVault derives (it adds `vault:` itself). */
export const LABEL = m.LABEL;
const PUBLIC_LABEL = `vault:${LABEL}`;
const META = 'meta';
/*
 * CTAP keepalive status 2: the key waits for a press. The library also calls onKeepAlive with
 * {retry: true} before a derive's retry, and with status 1 (processing) - neither is a press.
 */
const UP_NEEDED = 2;

export const prefixOf = (id: string) => `okrn.passwords.${id}/`;

/**
 * A refusal of the touch-free derive itself, as opposed to anything else going wrong (a lock, a
 * lost connection). Only this one may turn a new store into a press store: a dropped link must not
 * decide the store's flag for good.
 */
export function isTouchFreeRefusal(err: unknown): boolean {
  const text = String((err as any)?.message ?? err);
  return /OPERATION_DENIED|EXTENSION_NOT_SUPPORTED|without touch|touch-free derive/i.test(text);
}

export function createStores({
  storage,
  randomBytes,
  now = () => new Date(),
}: {
  storage: KV;
  randomBytes: (n: number) => Uint8Array;
  now?: () => Date;
}) {
  /* store id -> the open manager and the backends looking at it */
  const open = new Map<string, {manager: Manager; backends: Set<Backend>}>();
  /* backend -> its store id, learned once per unlock of that key */
  const idOf = new Map<Backend, string>();

  const kvFor = (id: string) => m.prefixedStore(storage, prefixOf(id)) as KV;

  async function readMeta(id: string): Promise<StoreMeta | null> {
    const raw = await kvFor(id).getItem(META);
    if (!raw) return null;
    const meta = JSON.parse(raw);
    if (meta?.v !== 1 || typeof meta.press !== 'boolean') throw new Error('passwords: this store\'s meta is damaged');
    return {v: 1, press: meta.press, asked: meta.asked === true, createdAt: String(meta.createdAt), ...(isStorePolicy(meta.policy) ? {policy: meta.policy} : {})};
  }
  const writeMeta = (id: string, meta: StoreMeta) => kvFor(id).setItem(META, JSON.stringify(meta));

  /*
   * The store's policy goes on the label before every derive: the label is per backend, not per
   * store, so a store opened after another key's store on the same backend must not inherit its
   * window.
   */
  const applyPolicy = async (okcrypto: Okcrypto, meta: StoreMeta | null) => {
    await okcrypto.deviceVault.setPolicy?.(LABEL, meta?.policy ?? DEFAULT_STORE_POLICY);
  };

  /** The store id of the key on `backend`. Never a press: a public-key derive is not gated. */
  async function identify(backend: Backend, okcrypto: Okcrypto): Promise<string> {
    const known = idOf.get(backend);
    if (known) return known;
    const {publicKey} = await okcrypto.derivePublicKey(PUBLIC_LABEL, {requirePress: false});
    const id = m.storeIdOf(publicKey);
    idOf.set(backend, id);
    return id;
  }

  async function attach(id: string, backend: Backend, key: Uint8Array | null): Promise<Manager> {
    const held = open.get(id);
    if (held) {
      held.backends.add(backend);
      return held.manager;
    }
    if (!key) throw new Error('passwords: no key to open this store with');
    const manager = await m.openManager({store: kvFor(id), key, randomBytes, now});
    open.set(id, {manager, backends: new Set([backend])});
    return manager;
  }

  return {
    identify,
    readMeta,

    /** This backend's store id, if it was asked since the key unlocked. */
    idFor: (backend: Backend): string | null => idOf.get(backend) ?? null,

    /** The open manager for this backend's key, or null. */
    current(backend: Backend): Manager | null {
      const id = idOf.get(backend);
      return (id && open.get(id)?.manager) || null;
    },

    /**
     * Open without a press if that is possible, else null (the screen shows "Open with
     * OnlyKey"). Same backup on another key already open -> that store, no derive at all.
     */
    async tryOpen(
      backend: Backend,
      okcrypto: Okcrypto,
      {onKeepAlive}: {onKeepAlive?: () => void} = {},
    ): Promise<{manager: Manager; why: OpenWhy} | null> {
      const id = await identify(backend, okcrypto);
      if (open.has(id)) return {manager: await attach(id, backend, null), why: 'session'};
      const meta = await readMeta(id);
      if (!okcrypto.deviceVault.isUnlocked(LABEL)) await applyPolicy(okcrypto, meta);
      /* a store not made yet, or one whose open asked a press: never by itself (Brad, 2026-10-11) */
      if (!meta || meta.press || meta.asked) {
        if (!meta || !okcrypto.deviceVault.isUnlocked(LABEL)) return null;
      }
      if (okcrypto.deviceVault.isUnlocked(LABEL)) {
        const key = await okcrypto.deviceVault.key(LABEL, {requirePress: meta.press});
        return {manager: await attach(id, backend, key), why: 'session'};
      }
      /* a touch-free store whose last open asked no press: the same derive, by itself */
      let asked = false;
      const key = await okcrypto.deviceVault.key(LABEL, {
        requirePress: false,
        onKeepAlive: (status: unknown) => {
          if (status !== UP_NEEDED) return;
          asked = true;
          onKeepAlive?.();
        },
      });
      if (asked) await writeMeta(id, {...meta, asked: true});
      return {manager: await attach(id, backend, key), why: 'touch-free'};
    },

    /**
     * "Open with OnlyKey" - the person chose to open. A store already made: its own derive (its
     * flag), pressed if the key asks. A NEW store: the touch-free derive first; a key that refuses
     * it outright (no press asked) gets a press store instead. Whether the key asked a press is
     * recorded either way, so the tab knows whether it may ever open the store by itself.
     */
    async openWithKey(
      backend: Backend,
      okcrypto: Okcrypto,
      {onKeepAlive, touchFree = 'preference'}: {onKeepAlive?: () => void; touchFree?: 'always' | 'preference' | 'broken'} = {},
    ): Promise<{manager: Manager; why: OpenWhy}> {
      const id = await identify(backend, okcrypto);
      const meta = await readMeta(id);
      await applyPolicy(okcrypto, meta);
      let asked = false;
      const watch = (status: unknown) => {
        if (status !== UP_NEEDED) return;
        asked = true;
        onKeepAlive?.();
      };
      let press = meta ? meta.press : touchFree === 'broken';
      let key: Uint8Array;
      try {
        key = await okcrypto.deviceVault.key(LABEL, {requirePress: press, onKeepAlive: watch});
      } catch (err) {
        /* only a new store's touch-free try may turn into a press store, and only on a refusal */
        if (meta || press || !isTouchFreeRefusal(err)) throw err;
        press = true;
        key = await okcrypto.deviceVault.key(LABEL, {requirePress: true, onKeepAlive: watch});
      }
      const next: StoreMeta = {v: 1, press, asked: press || asked, createdAt: meta?.createdAt ?? now().toISOString(), ...(meta?.policy ? {policy: meta.policy} : {})};
      if (!meta || meta.asked !== next.asked) await writeMeta(id, next);
      return {manager: await attach(id, backend, key), why: press ? 'press' : 'touch-free'};
    },

    /**
     * The person's choice of how long this backend's store stays open: kept in the store's meta
     * and put on the label now. A shorter window takes effect from the next open (the key already
     * held keeps the time it was given).
     */
    async setPolicy(backend: Backend, okcrypto: Okcrypto, policy: StorePolicy): Promise<void> {
      if (!isStorePolicy(policy)) throw new Error('passwords: not a store policy');
      const id = await identify(backend, okcrypto);
      const meta = await readMeta(id);
      if (meta) await writeMeta(id, {...meta, policy});
      await okcrypto.deviceVault.setPolicy?.(LABEL, policy);
    },

    /**
     * Activity on the store: slides the backend's session. False when the session has run out -
     * the store is then closed for that backend and the screen goes back to its locked view.
     */
    touch(backend: Backend, okcrypto: Okcrypto): boolean {
      if (okcrypto.deviceVault.isUnlocked(LABEL)) return true;
      this.close(backend);
      return false;
    },

    /** The 30 s reaper: wipes expired vault keys, and closes this store if its key was one. */
    reap(backend: Backend, okcrypto: Okcrypto): void {
      if (okcrypto.deviceVault.reap().includes(LABEL)) this.close(backend);
    },

    /**
     * This key locked, was unplugged or stopped: forget its id and let go of its store. The store
     * closes (entries dropped, key bytes wiped) only when no other key is still looking at it -
     * a soft key from the same backup keeps the shared list open.
     */
    close(backend: Backend): void {
      const id = idOf.get(backend);
      idOf.delete(backend);
      const held = id ? open.get(id) : undefined;
      if (!id || !held) return;
      held.backends.delete(backend);
      if (held.backends.size === 0) {
        held.manager.lock();
        open.delete(id);
      }
    },

    /**
     * "Lock now": the store closes for every key looking at it, and each of those keys' session
     * key is wiped - otherwise the other key would reopen it from its own cache without a press.
     */
    lockNow(backend: Backend, okcryptoOf: (b: Backend) => Okcrypto | null): void {
      const id = idOf.get(backend);
      const held = id ? open.get(id) : undefined;
      for (const b of held ? [...held.backends] : [backend]) {
        try {
          okcryptoOf(b)?.deviceVault.lock(LABEL);
        } catch {}
        this.close(b);
      }
    },

    /** for tests */
    openCount: () => open.size,
  };
}

export type Stores = ReturnType<typeof createStores>;
