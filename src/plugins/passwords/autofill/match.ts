/*
 * WHICH ENTRIES BELONG TO THE FORM - the anti-phishing half of Autofill.
 *
 * A browser form names its site (`webDomain`); an app's form names only the app (its package).
 * An entry matches a site when the form's host IS the entry's host or a subdomain of it
 * (accounts.github.com fills from an entry saved for github.com), compared on whole labels:
 * "evil-github.com" and "github.com.evil.io" are not github.com. Never the other way round - an
 * entry saved for login.example.com is not offered on example.com, which could be anyone's
 * subdomain host. An app matches only an entry that names its package as android://<package>.
 *
 * Anything else is not offered as a match; the sheet can still show every entry, with the
 * site's name in a warning, for a site saved under another address.
 */

export type FormTarget = {domain: string; packageName: string};
type Entry = {kind: string; urls?: string[]; totp?: unknown};

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
  /* a subdomain only of a dotted host: an entry saved for "com" must not match every .com site */
  return have.includes('.') && want.endsWith('.' + have);
}

export function matchesApp(entryUrl: string, packageName: string): boolean {
  const m = /^android(?:app)?:\/\/([^/?#]+)/i.exec(entryUrl.trim());
  return !!m && !!packageName && m[1].toLowerCase() === packageName.toLowerCase();
}

/** The logins that belong to this form. */
export function matching<E extends Entry>(entries: E[], form: FormTarget): E[] {
  return entries.filter(
    e =>
      e.kind === 'login' &&
      (e.urls ?? []).some(u => (form.domain ? matchesSite(u, form.domain) : matchesApp(u, form.packageName))),
  );
}

const belongs = (e: Entry, form: FormTarget) =>
  (e.urls ?? []).some(u => (form.domain ? matchesSite(u, form.domain) : matchesApp(u, form.packageName)));

/** The codes that belong to this form: a login carrying one, or an authenticator entry, by its sites. */
export function matchingCodes<E extends Entry>(entries: E[], form: FormTarget): E[] {
  return entries.filter(e => !!e.totp && (e.kind === 'login' || e.kind === 'totp') && belongs(e, form));
}

/** What the sheet calls the form: the site's host, or the app's package. */
export const formName = (form: FormTarget) => (form.domain ? hostOf(form.domain) : form.packageName || 'this app');
