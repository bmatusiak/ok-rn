# The vault runs on v3.0.4, and the migration risk is latent rather than actual

## The question

Firmware 3.0.5 changed how a derived key is built, so anything the vault sealed
on older firmware stops opening after an upgrade. The obvious follow-up is who
that hurts - and the answer decides whether it is a live defect or a thing to
prevent before it can happen.

Three separate questions get confused here, so they are answered separately.

## Is the vault gated to 3.0.5 in the FIRMWARE?

**No.** v3.0.4 defines `RESERVED_KEY_WEB_DERIVATION 128`; 3.0.5 renamed it to
`RESERVED_KEY_WEB_AGENT_DERIVATION` and kept the old name as an alias for the
same number. Same slot, both releases.

## Is it DEBUG-gated, i.e. development-only?

**No**, and this is the test that matters - a feature behind `#ifdef DEBUG` is
under development and no user has it. Measured against a PRODUCTION build of
the last signed release:

    device: UNLOCKEDv3.0.4-prodc
    derive attempt 1/3 for "vault:vault.example"
    ✓ a vault blob sealed on this device opens again

So a v3.0.4 key really can do this, on the firmware as it ships.

## Has anyone USED it?

**UNKNOWN, and an earlier version of this file said "no" on incomplete
evidence.** That answer came from looking only at ok-rn: `deviceVault` arrived
in node-onlykey-lib on 2026-09-08, and ok-rn is unreleased. Both true, and both
about the wrong GUI.

**The vault is older than that in the WEB APP.**
`onlykey.github.io@439a1b8`, 2026-07-18: "app: add hardware-encrypted
credential vault to onlyagent.app" - about two months earlier. It is the same
feature, not a similar one:

    web app   phrase = "vault:" + serviceId,  KEYTYPE_P256R1
    lib       `vault:${label}`,               KEYTYPE.P256R1 (default)

Same label convention and same keytype, so an entry sealed in one is readable
by the other. That is deliberate interop, and it means the migration hazard was
never ok-rn's alone.

Whether anyone actually used it there is not something this repository can
answer - the checkout is of uncertain currency, and whether onlyagent.app
carried the feature to real users is the bench owner's question, not a fact in
the tree. The honest answer is UNKNOWN rather than no.

**And on 3.0.5 that origin is refused outright.** `onlyagent.app` is not in the
trusted table - `fido2/device.cpp` admits `apps.crp.to` and `apps.onlykey.io`
and nothing else, after libraries@e44ff6c dropped it deliberately. So a user
with vault data created at onlyagent.app would not merely find it unreadable
after upgrading; they could not reach the device from that page at all, which
takes the recovery route away at the same moment as the data.

The app does not gate the vault by capability either, unlike the age section
which fades on `postQuantum`.

## So what

The exposure is LATENT FOR OK-RN and UNQUANTIFIED ELSEWHERE. Every part is in
place for a user to seal data on v3.0.4 and lose access to it on upgrading. For
ok-rn nobody has been near it, because that app has not shipped. For the web
app the question is open, and it is the one worth asking of a human rather than
of a repository.

That is worth stating precisely because it decides the response:

- It is NOT a live defect needing a migration tool. There is nothing to
  migrate.
- It IS worth the pre-upgrade warning that now sits above the reboot button in
  FirmwareScreen, because the warning costs little and the failure it prevents
  is silent and unrecoverable after the fact.
- It leaves a CHOICE still open: the vault could be gated to 3.0.5+ so the
  situation can never arise at all. That trades a capability a v3.0.4 key
  genuinely has against a hazard no one has hit. Left open deliberately on
  2026-09-23 - "it may be enabled in 3.0.4 but not used yet on the user side".

## The general shape

Judge a hazard by WHO CAN BE AFFECTED, not by how alarming the mechanism
sounds. The same test retired four upstream items earlier the same day: a
Curve25519 key whose private half was a published constant read as urgent until
it turned out the only two people who ran the command both knew.

And the test needs all three questions, not one. "The firmware supports it" is
not "users have it", and "it is in the app" is not "the app has shipped".
