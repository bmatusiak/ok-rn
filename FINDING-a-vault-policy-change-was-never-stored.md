# A vault policy change was never stored, and after a restart the key cached anyway

## What happens

Set a saved credential to `always` on the Crypto tab. The status line says
"github policy is now always". The control under it snaps back to
`session:30m`, and nothing explains why.

Restart the app, open the same credential, and the device-derived key is
cached for thirty minutes - under the policy that was supposed to forbid
caching entirely.

## Why

`deviceVault.setPolicy` wrote to ONE place:

    setPolicy: (label, policy) => vaultKeys.setPolicy(label, policy),

`vaultKeys` is the in-memory cache manager in `src/crypto/vault.js`. Its
policy map is a plain `Map` built when the plugin is constructed. It holds
what governs caching right now, and it holds it nowhere else.

The DURABLE copy of a policy is the `policy` field on the stored record, and
that field was written in exactly one place: `save()`, at the moment a
credential was sealed. Nothing ever updated it again.

So the two copies drift the moment anybody changes a policy:

| | after `setPolicy(github, always)` |
|---|---|
| `vaultKeys` policy map | `always` |
| stored record | `session:30m` - whatever it was at save time |

`list()` returns the records, so the screen redraws from the stale copy. That
is the snap-back: the screen is not ignoring the change, it is reading the
copy that never received it.

The restart is the same drift pointing the other way. A new process builds an
empty policy map, `getPolicy` falls through to `defaultPolicy`, and the stored
`always` is sitting in a field nothing reads. `vaultKeys.put` then caches the
derived key, because as far as it can tell nobody asked it not to.

## Why it matters more than a control snapping back

`always` is the policy that means "derive it every time, never hold it". It is
what a person picks for the credential they care most about. The visible
symptom is a control that will not stay put; the invisible one is that the
credential they picked it for is the credential whose key is sitting in memory
after every restart.

Tightening a policy DID take effect immediately within the session -
`vaultKeys.setPolicy` evicts on a `noCache` policy, and that part was right.
It just did not survive the process.

## The fix

The stored record becomes the authority, and both directions are closed:

- `setPolicy` is now async. It sets the live policy first, so tightening still
  evicts immediately even if storage then fails, and writes the policy through
  to the record when one exists.
- `list()` restores each stored policy into the live map before returning.
  Every host must list the vault before it can use a credential from it, so
  this is the point where a policy from a previous run comes back into force.

A policy set for a service that has not been saved yet still lives only in
memory; `save()` already records `vaultKeys.getPolicy(serviceId)`, so it is
written the moment there is a record to write it to.

`VaultList` awaits the call now. The refresh after it reads the record it just
wrote, so the control shows what was asked for.

## Measured

`test/crypto.test.js`: a policy set, read back through a fresh `list()`, and
the stored record checked directly. Plus the restart case - a second plugin
built over the same store, where `getPolicy` must answer `always` without
anybody having set it in that process.
