# Soft-key firmware plugins

Experimental firmware features for the **soft key only** (owner, 2026-10-01). Each plugin is its own folder, so:
- it is **removed** by deleting the folder;
- it is **audited** by reading just the folder.

Hard keys never get them.

**This folder holds only the plugins ok-rn ships** (none yet; Edge will be the first). The demo plugin, `hello`, lives in node-onlykey-emulator (`emulator/plugins/hello/`). The loader is the library's (`node-onlykey-lib/cli/firmware-plugins`), shared with that emulator.

## Use one
Name the plugins when you stage or build. Without the variable, nothing is staged, and the soft key is the base build, byte for byte (the staged digest is unchanged):
```
OKEMU_PLUGINS=edge ./gradlew app:installDebug        # PowerShell: $env:OKEMU_PLUGINS='edge'
OKEMU_PLUGINS=edge node scripts/stage.js             # stage only
```
To stage from another folder, such as the emulator's demo:
```
OKEMU_PLUGINS=hello OKEMU_PLUGINS_DIR=<node-onlykey-emulator>/emulator/plugins ./gradlew app:installDebug
```

**What a plugin build does differently:**
- **Its own soft key:** it gets a storage slot of its own (`plugins-<names>`, `src/buildInfo.ts`), so it never boots against the normal soft key's flash. The normal soft key keeps its data and comes back when you build without plugins.
- **Shows itself:** the start page's "plugins" row lists them.
- **Soft-key-only features:** the app treats a plugin's features as the soft key's alone, through `hasSoftKeyPlugin(name)`, never through a firmware version.

## Folder layout: `plugins/<name>/`
| File | What |
|---|---|
| `plugin.js` | the manifest: `name`, `minBase` (oldest firmware it is written for), `hooks`, `notes` |
| `src/` | the plugin's own C/C++, prefixed `okplugin_<name>_`; staged to `.stage/libraries/onlykey/plugins/<name>/`, which the build already compiles and includes |
| `AUDIT.md` | every hook, every new message, every byte stored, and what it does not do |
| `tests/e2e.js` | its on-device tests (ok-rn e2e): `module.exports = function register({it}, ctx)` |
| `tests/kit.test.js` | its emulator tests (the onlykey-testing kit): same shape |

**Tests live in the plugin and are side-loaded,** so they leave with it.
- **ok-rn:** the stager copies each staged plugin's `tests/e2e.js` into `src/generated/plugins/` and lists them in `src/generated/pluginTests.js` (empty for a base build). The `softKeyPlugins` suite registers them.
- **Kit:** node-onlykey-emulator records `plugins` and `pluginsDir` in its `.stage/build.json`. The kit's `01-protocol/38-softkey-plugins.test.js` registers each `<pluginsDir>/<name>/tests/kit.test.js`.

**After editing a plugin's `tests/e2e.js`, restage (or copy it to `src/generated/plugins/<name>.e2e.js`) and restart Metro with `--reset-cache`:** Metro does not pick up changes in the generated copy, and the phone keeps running the old test. That cost a round of debugging Edge against code the phone was not running.

**In testing mode the soft key's firmware console goes to logcat** as `[okemu-fw] …` (`useOkEmu`, owner 2026-10-02), so `adb logcat` and `tools/logwatch.js` can read what a plugin does while a test drives it.

Neither the emulator nor the kit depends on ok-rn. A test gets the app or the kit through `ctx` (device access, `IFACE`, `okmsg` or `protocol`, the PIN), never by a relative path.

**Hooks:** `{file, anchor, insert: 'before' | 'after', text}`.
- The anchor must occur **exactly once** in the staged file. Otherwise the stage stops, so a plugin never builds into a firmware it wasn't written against.
- Keep hooks to the minimum: an `#include`, and a `case` in the vendor switch.

**The mechanism:** `scripts/stage.js` calls the library's loader after the literal patches and before the digest.

## Plugins
| Name | What |
|---|---|
| (none yet) | Edge comes next |
