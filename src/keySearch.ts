/**
 * Find someone's PGP public key online - on request, never on its own.
 *
 * The web app's search page (onlykey.github.io, bundle: keybase(), the
 * ProtonMail proxy in index.js) looks a recipient up on Keybase, at
 * ProtonMail's key server, or at a URL the person typed. This is the same
 * three, with the shape changed in one way that matters: NOTHING here runs
 * unless a person pressed "Look up online" on the Messages screen. This app
 * is air-gapped by default - a phone with a key in it should not be touching
 * keybase.io because a screen opened - so there is no autocomplete, no
 * lookup on paste, and no cache. One press, one query, the result goes into
 * the key box for the person to read before it is used.
 *
 * `fetchFn` is a parameter so the tests hand in a fake and nothing in
 * jest's environment has to provide `fetch`.
 */

export type Source = 'keybase' | 'protonmail' | 'url';

export type Found = {
  /** What to show: a username, an address, or the URL. */
  label: string;
  /** The armoured public key block, exactly as served. */
  armored: string;
  source: Source;
  /** Where it came from, for the person to check. */
  where: string;
};

export type FetchLike = (url: string) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

const ARMORED = /-----BEGIN PGP PUBLIC KEY BLOCK-----[\s\S]*?-----END PGP PUBLIC KEY BLOCK-----/;

/** The first armoured public key in a body, or null. */
export function armoredBlock(text: string): string | null {
  const m = ARMORED.exec(text);
  return m ? m[0] : null;
}

const KEYBASE_SEARCH = 'https://keybase.io/_/api/1.0/user/user_search.json?q=';
const KEYBASE_KEY = (user: string) => `https://keybase.io/${encodeURIComponent(user)}/pgp_keys.asc`;
const PROTONMAIL = 'https://api.protonmail.ch/pks/lookup?op=get&search=';

/** How many Keybase matches to fetch keys for - each is one more request. */
const KEYBASE_MAX = 5;

/**
 * Keybase: search users, then fetch each one's key.
 *
 * The desktop lists matches and downloads a key per match to show its
 * fingerprint (bundle 162220-162266). Same two steps here, bounded: a
 * search for "john" matches thousands, and every key is a request.
 */
export async function lookupKeybase(query: string, fetchFn: FetchLike): Promise<Found[]> {
  const q = query.trim();
  if (!q) throw new Error('Type a Keybase username or a name to search for.');
  const res = await fetchFn(KEYBASE_SEARCH + encodeURIComponent(q));
  if (!res.ok) throw new Error(`Keybase search answered ${res.status}.`);
  let list: Array<{keybase?: {username?: string; full_name?: string}}> = [];
  try {
    const body = JSON.parse(await res.text());
    list = Array.isArray(body?.list) ? body.list : [];
  } catch {
    throw new Error('Keybase answered with something that is not its JSON.');
  }
  const users = list
    .map(e => e.keybase)
    .filter((k): k is {username: string; full_name?: string} => !!k?.username)
    .slice(0, KEYBASE_MAX);

  const found: Found[] = [];
  for (const user of users) {
    const key = await fetchFn(KEYBASE_KEY(user.username));
    if (!key.ok) continue; // a user without a PGP key is a 404 here
    const armored = armoredBlock(await key.text());
    if (!armored) continue;
    found.push({
      label: user.full_name ? `${user.username} (${user.full_name})` : user.username,
      armored,
      source: 'keybase',
      where: KEYBASE_KEY(user.username),
    });
  }
  return found;
}

/**
 * ProtonMail's key server, HKP style: an address or 0x<keyid>. The web app
 * had to proxy this through its own express server for CORS
 * (onlykey.github.io/index.js:91); a native fetch has no such rule.
 */
export async function lookupProtonmail(query: string, fetchFn: FetchLike): Promise<Found[]> {
  const q = query.trim();
  if (!q) throw new Error('Type a ProtonMail address, or 0x followed by a key id.');
  const where = PROTONMAIL + encodeURIComponent(q);
  const res = await fetchFn(where);
  if (!res.ok) {
    if (res.status === 404) return [];
    throw new Error(`ProtonMail's key server answered ${res.status}.`);
  }
  const armored = armoredBlock(await res.text());
  return armored ? [{label: q, armored, source: 'protonmail', where}] : [];
}

/** A URL that serves an armoured key. https only: a key fetched in the clear is anyone's. */
export async function lookupUrl(url: string, fetchFn: FetchLike): Promise<Found[]> {
  const where = url.trim();
  if (!/^https:\/\//i.test(where)) throw new Error('The URL has to start with https://.');
  const res = await fetchFn(where);
  if (!res.ok) throw new Error(`${where} answered ${res.status}.`);
  const armored = armoredBlock(await res.text());
  if (!armored) throw new Error('That page has no PGP public key block in it.');
  return [{label: where, armored, source: 'url', where}];
}

export function lookup(source: Source, query: string, fetchFn: FetchLike): Promise<Found[]> {
  switch (source) {
    case 'keybase':
      return lookupKeybase(query, fetchFn);
    case 'protonmail':
      return lookupProtonmail(query, fetchFn);
    case 'url':
      return lookupUrl(query, fetchFn);
  }
}
