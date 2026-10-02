# config - OKGETCONFIG (design)

**Why:** the firmware lets a host write every setting and read none back. ok-rn's Preferences and Advanced tabs can't show the key's real values, and the CLI can't tell whether a sign will want a code, a press or nothing. Proposal: `onlykey-RN/PROPOSAL-softkey-config-plugin.md`.

**Owner's rules (2026-10-02):**
- simple: the key prints an INI file; import is the library's;
- the API name `OKGETCONFIG`;
- vendor API only, after PIN entry; refused over CTAP;
- soft key only: a hard key is not emulated, so the app is not in the middle.

**Shape:** one request, no press, read-only. The INI's key names are node-onlykey-lib's preference names, so an exported file imports with no translation. `[input]` is the firmware's own resolution (`okcore_user_input_mode_for_slot`), read-only. `[advanced]` holds the lib's one-way settings (webcryptPolicy, wipeMode, backupKeyMode); an import changes them only when asked to.

**Import (the library, not this plugin):** each value is written through the existing `OKSETSLOT` setting writes, in config mode where the firmware wants it. The firmware's own checks still apply: a value it refuses is reported, never forced.

See `AUDIT.md` for every hook, every value and its source, and the tests.
