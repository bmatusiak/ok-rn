import {armoredBlock, lookup, lookupKeybase, lookupProtonmail, lookupUrl} from '../src/keySearch';

const KEY = '-----BEGIN PGP PUBLIC KEY BLOCK-----\nmQINBF\n-----END PGP PUBLIC KEY BLOCK-----';

/** A fetch that answers from a table and records what it was asked. */
function fakeFetch(table: Record<string, {status?: number; body: string}>) {
  const asked: string[] = [];
  const fn = async (url: string) => {
    asked.push(url);
    const hit = table[url];
    if (!hit) return {ok: false, status: 404, text: async () => 'not found'};
    const status = hit.status ?? 200;
    return {ok: status < 400, status, text: async () => hit.body};
  };
  return {fn, asked};
}

test('armoredBlock takes the first public key block out of a page and nothing else', () => {
  expect(armoredBlock(`<html>${KEY}<p>${KEY}`)).toBe(KEY);
  expect(armoredBlock('-----BEGIN PGP PRIVATE KEY BLOCK-----\n-----END PGP PRIVATE KEY BLOCK-----')).toBeNull();
  expect(armoredBlock('')).toBeNull();
});

test('Keybase: search, then one key per match, skipping users without one', async () => {
  const {fn, asked} = fakeFetch({
    'https://keybase.io/_/api/1.0/user/user_search.json?q=alice': {
      body: JSON.stringify({
        list: [
          {keybase: {username: 'alice', full_name: 'Alice A'}},
          {keybase: {username: 'nokey'}},
          {twitter: {username: 'not-keybase'}},
        ],
      }),
    },
    'https://keybase.io/alice/pgp_keys.asc': {body: KEY},
  });
  const found = await lookupKeybase('alice', fn);
  expect(found).toEqual([
    {label: 'alice (Alice A)', armored: KEY, source: 'keybase', where: 'https://keybase.io/alice/pgp_keys.asc'},
  ]);
  /* Exactly the requests a person would expect: the search and the keys. */
  expect(asked).toEqual([
    'https://keybase.io/_/api/1.0/user/user_search.json?q=alice',
    'https://keybase.io/alice/pgp_keys.asc',
    'https://keybase.io/nokey/pgp_keys.asc',
  ]);
});

test('Keybase: at most five keys are fetched for a broad search', async () => {
  const list = Array.from({length: 12}, (_, i) => ({keybase: {username: `u${i}`}}));
  const table: Record<string, {body: string}> = {
    'https://keybase.io/_/api/1.0/user/user_search.json?q=u': {body: JSON.stringify({list})},
  };
  for (let i = 0; i < 12; i++) table[`https://keybase.io/u${i}/pgp_keys.asc`] = {body: KEY};
  const {fn, asked} = fakeFetch(table);
  const found = await lookupKeybase('u', fn);
  expect(found).toHaveLength(5);
  expect(asked).toHaveLength(6);
});

test('ProtonMail: an address or key id, a 404 is "nobody", other errors are errors', async () => {
  const {fn} = fakeFetch({
    'https://api.protonmail.ch/pks/lookup?op=get&search=a%40proton.me': {body: KEY},
    'https://api.protonmail.ch/pks/lookup?op=get&search=0xdead': {status: 500, body: 'oops'},
  });
  expect(await lookupProtonmail('a@proton.me', fn)).toEqual([
    {label: 'a@proton.me', armored: KEY, source: 'protonmail', where: 'https://api.protonmail.ch/pks/lookup?op=get&search=a%40proton.me'},
  ]);
  expect(await lookupProtonmail('nobody@proton.me', fn)).toEqual([]);
  await expect(lookupProtonmail('0xdead', fn)).rejects.toThrow('answered 500');
});

test('ProtonMail: a bare name is an address there, as the web app assumes', async () => {
  /*
   * search.js:140-142 appends the domain to anything with no "@" and no
   * "0x" prefix. Without it, typing a username searched for a bare word,
   * found nothing, and read as "they have no key".
   */
  const {fn, asked} = fakeFetch({
    'https://api.protonmail.ch/pks/lookup?op=get&search=alice%40protonmail.com': {body: KEY},
  });
  expect((await lookupProtonmail('alice', fn))[0].armored).toBe(KEY);
  expect(asked[0]).toContain('alice%40protonmail.com');

  /* An address and a key id are left exactly as typed. */
  const other = fakeFetch({});
  await lookupProtonmail('someone@example.org', other.fn);
  await lookupProtonmail('0xdeadbeef', other.fn);
  expect(other.asked[0]).toContain('someone%40example.org');
  expect(other.asked[1]).toContain('0xdeadbeef');
});

test('a URL: https only, and the page has to carry a key block', async () => {
  const {fn, asked} = fakeFetch({
    'https://example.org/key.asc': {body: `hello ${KEY}`},
    'https://example.org/none': {body: 'nothing here'},
  });
  await expect(lookupUrl('http://example.org/key.asc', fn)).rejects.toThrow('https://');
  expect(asked).toEqual([]);
  expect((await lookupUrl('https://example.org/key.asc', fn))[0].armored).toBe(KEY);
  await expect(lookupUrl('https://example.org/none', fn)).rejects.toThrow('no PGP public key block');
});

test('nothing is fetched for an empty query', async () => {
  const {fn, asked} = fakeFetch({});
  await expect(lookup('keybase', '  ', fn)).rejects.toThrow();
  await expect(lookup('protonmail', '', fn)).rejects.toThrow();
  expect(asked).toEqual([]);
});
