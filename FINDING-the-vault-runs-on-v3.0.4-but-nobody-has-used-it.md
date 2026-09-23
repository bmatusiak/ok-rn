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

**No.** The vault is new on the APP side - `deviceVault` arrived in
node-onlykey-lib on 2026-09-08 - and ok-rn is unreleased. The app does not gate
it by capability either, unlike the age section which fades on `postQuantum`.

## So what

The exposure is LATENT. Every part is in place for a user to seal data on
v3.0.4 and lose access to it on upgrading, and no user has been anywhere near
it, because the app that would do the sealing has not shipped.

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
