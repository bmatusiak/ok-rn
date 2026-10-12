/*
 * WHICH ENTRIES BELONG TO THE FORM - the anti-phishing half of Autofill.
 *
 * A browser form names its site (`webDomain`); an app's form names only the app (its package).
 * An entry matches a site when both have the same REGISTRABLE DOMAIN (eTLD+1, the public suffix
 * list - tldts, vendored in the lib): accounts.github.com and github.com are one site, both ways;
 * "evil-github.com", "github.com.evil.io", and foo.co.uk vs bar.co.uk are not. Private suffixes
 * count (allowPrivateDomains): alice.github.io and bob.github.io are two sites, not one. A host
 * with no registrable domain (localhost, an IP address) matches only itself.
 * An app matches only an entry that names it in androidApps by package AND signing certificate
 * (SHA-256): an app that only took the package name gets nothing.
 *
 * Anything else is not offered as a match; the sheet can still show every entry, with the
 * site's name in a warning, for a site saved under another address.
 */

import {getDomain} from 'node-onlykey-lib/vendor/tldts';

/* certs: an app form's signing certificates (SHA-256, hex), from the Autofill service */
export type FormTarget = {domain: string; packageName: string; certs?: string[]};

/** The registrable domain of a host, private suffixes counted; null for localhost or an IP. */
export const siteOf = (host: string): string | null => getDomain(host, {allowPrivateDomains: true});
type Entry = {kind: string; urls?: string[]; totp?: unknown; inner?: unknown; androidApps?: {package: string; cert: string}[]};

/** The app linked by package and certificate. */
export const linksApp = (e: Entry, form: FormTarget): boolean =>
  !!form.packageName && (e.androidApps ?? []).some(a => a.package === form.packageName && (form.certs ?? []).includes(a.cert));

/** The host of a URL or bare host, lowercased, without "www." and without a port. */
export function hostOf(url: string): string {
  const bare = url.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  return bare.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/^www\./, '');
}

export function matchesSite(entryUrl: string, domain: string): boolean {
  if (/^android(app)?:\/\//i.test(entryUrl.trim())) return false;
  const want = hostOf(domain);
  const have = hostOf(entryUrl);
  if (!want || !have) return false;
  if (want === have) return true;
  const site = siteOf(want);
  return site !== null && site === siteOf(have);
}

export function matchesApp(entryUrl: string, packageName: string): boolean {
  const m = /^android(?:app)?:\/\/([^/?#]+)/i.exec(entryUrl.trim());
  return !!m && !!packageName && m[1].toLowerCase() === packageName.toLowerCase();
}

/** The logins (and derived passwords) that belong to this form. */
export function matching<E extends Entry>(entries: E[], form: FormTarget): E[] {
  return entries.filter(e => (e.kind === 'login' || e.kind === 'derived') && belongs(e, form));
}

const belongs = (e: Entry, form: FormTarget) =>
  form.domain ? (e.urls ?? []).some(u => matchesSite(u, form.domain)) : linksApp(e, form);

/** The codes that belong to this form: a login carrying one, or an authenticator entry, by its sites. */
export function matchingCodes<E extends Entry>(entries: E[], form: FormTarget): E[] {
  /* a code sealed a second time is inside `inner`: listed, opened at the pick */
  return entries.filter(e => (!!e.totp || !!e.inner) && (e.kind === 'login' || e.kind === 'totp') && belongs(e, form));
}

/** What the sheet calls the form: the site's host, or the app's package. */
export const formName = (form: FormTarget) => (form.domain ? hostOf(form.domain) : form.packageName || 'this app');
