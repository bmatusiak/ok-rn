# config - OKGETCONFIG and OKSETCONFIG (design)

**Why:** the firmware lets a host write every setting and read none back. ok-rn's Preferences and Advanced tabs can't show the key's real values, and the CLI can't tell whether a sign will want a code, a press or nothing. Proposal and status: `PROPOSAL.md` (this folder).

**Owner's rules (2026-10-02):**
- simple: the key prints an INI file (`OKGETCONFIG`) and imports one (`OKSETCONFIG`, config mode only);
- the API name `OKGETCONFIG`;
- vendor API only, after PIN entry; refused over CTAP;
- soft key only: a hard key is not emulated, so the app is not in the middle.

**Shape:** two requests, no press: OKGETCONFIG reads, OKSETCONFIG imports (config mode only). The INI's key names are node-onlykey-lib's preference names, so an exported file imports with no translation. `[input]` is the firmware's own resolution (`okcore_user_input_mode_for_slot`), read-only. `[advanced]` holds the lib's one-way settings (webcryptPolicy, wipeMode, backupKeyMode); an import changes them only when asked to.

**Import: `OKSETCONFIG`, config mode only** (owner, 2026-10-02). The host sends the INI; the firmware hands each value to its own setting write (`set_slot`), so every check it makes still applies, then the host reads the result back with OKGETCONFIG (allowed in config mode for that) and compares. `[input]` is never written; the host leaves `[advanced]` out unless told.

See `AUDIT.md` for every hook, every value and its source, and the tests.
