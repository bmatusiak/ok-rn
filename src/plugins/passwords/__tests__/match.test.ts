/*
 * Autofill's site matching (src/plugins/passwords/autofill/match.ts): a look-alike address is not
 * the site.
 */
import {hostOf, linksApp, matching, matchingCodes, matchesSite} from '../autofill/match';

test('the same site and its subdomains match; look-alikes do not', () => {
  expect(matchesSite('https://github.com/login', 'github.com')).toBe(true);
  expect(matchesSite('github.com', 'www.github.com')).toBe(true);
  expect(matchesSite('https://github.com', 'accounts.github.com')).toBe(true);
  expect(matchesSite('https://GitHub.com:443/', 'GITHUB.COM')).toBe(true);
  expect(matchesSite('https://github.com', 'evil-github.com')).toBe(false);
  expect(matchesSite('https://github.com', 'github.com.evil.io')).toBe(false);
  /* one registrable domain, both ways */
  expect(matchesSite('https://login.example.com', 'example.com')).toBe(true);
  expect(matchesSite('https://foo.co.uk', 'foo.co.uk')).toBe(true);
  expect(matchesSite('https://foo.co.uk', 'bar.co.uk')).toBe(false);
  expect(matchesSite('https://alice.github.io', 'bob.github.io')).toBe(false);
  expect(matchesSite('https://alice.github.io', 'www.alice.github.io')).toBe(true);
  expect(matchesSite('http://192.168.1.2', '192.168.1.3')).toBe(false);
  expect(matchesSite('http://localhost', 'localhost')).toBe(true);
  expect(matchesSite('com', 'evil.com')).toBe(false);
});

const CERT = 'ab'.repeat(32);
test('an app matches by package AND signing certificate; the package alone is not enough', () => {
  const e = {kind: 'login', androidApps: [{package: 'com.example.bank', cert: CERT}]};
  expect(linksApp(e, {domain: '', packageName: 'com.example.bank', certs: [CERT]})).toBe(true);
  expect(linksApp(e, {domain: '', packageName: 'com.example.bank', certs: ['cd'.repeat(32)]})).toBe(false);
  expect(linksApp(e, {domain: '', packageName: 'com.example.bank'})).toBe(false);
  expect(linksApp(e, {domain: '', packageName: 'com.other', certs: [CERT]})).toBe(false);
  expect(matchesSite('android://com.example.bank', 'com.example.bank')).toBe(false);
});

test('only logins are offered, by site or by app', () => {
  const entries = [
    {kind: 'login', title: 'GitHub', urls: ['https://github.com']},
    {kind: 'note', title: 'GitHub note', urls: ['https://github.com']},
    {kind: 'login', title: 'Bank app', androidApps: [{package: 'com.example.bank', cert: CERT}]},
    {kind: 'login', title: 'No site'},
  ];
  expect(matching(entries, {domain: 'github.com', packageName: 'com.android.chrome'}).map(e => e.title)).toEqual(['GitHub']);
  expect(matching(entries, {domain: '', packageName: 'com.example.bank', certs: [CERT]}).map(e => e.title)).toEqual(['Bank app']);
  expect(matching(entries, {domain: '', packageName: 'com.example.bank', certs: []})).toEqual([]);
  expect(hostOf('https://www.Example.com:8080/a?b')).toBe('example.com');
});

test('codes: a login carrying one, or an authenticator with the site in its Sites; a look-alike gets none', () => {
  const t = {secret: 'X'};
  const entries = [
    {kind: 'login', title: 'GitHub', urls: ['https://github.com'], totp: t},
    {kind: 'totp', title: 'GitHub 2FA', urls: ['github.com'], totp: t},
    {kind: 'totp', title: 'No sites', totp: t},
    {kind: 'login', title: 'GitHub, no code', urls: ['https://github.com']},
  ];
  const site = {domain: 'github.com', packageName: 'com.android.chrome'};
  expect(matchingCodes(entries, site).map(e => e.title)).toEqual(['GitHub', 'GitHub 2FA']);
  expect(matchingCodes(entries, {domain: 'github.com.evil.io', packageName: 'com.android.chrome'})).toEqual([]);
});
