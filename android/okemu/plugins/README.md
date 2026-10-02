# Soft-key firmware plugins

Experimental firmware features for the **soft key only** (owner, 2026-10-01). Each plugin is its own folder, so:
- it is **removed** by deleting the folder;
- it is **audited** by reading just the folder.

Hard keys and the desktop emulator never get them.

## Use one
Name the plugins when you stage or build. Without the variable, nothing is staged, and the soft key is the base build, byte for byte (the staged digest is unchanged):
```
OKEMU_PLUGINS=hello ./gradlew app:installDebug        # PowerShell: $env:OKEMU_PLUGINS='hello'
OKEMU_PLUGINS=edge,hello node scripts/stage.js        # stage only
```

**What a plugin build does differently:**
- **Its own soft key:** it gets a storage slot of its own (`plugins-<names>`, `src/buildInfo.ts`), so it never boots against the normal soft key's flash. The normal soft key keeps its data and comes back when you build without plugins.
- **Shows itself:** the start page's "built for" line lists the plugins.
- **Soft-key-only features:** the app treats a plugin's features as the soft key's alone, through `hasSoftKeyPlugin(name)`, never through a firmware version.

## Folder layout: `plugins/<name>/`
| File | What |
|---|---|
| `plugin.js` | the manifest: `name`, `minBase` (oldest firmware it is written for), `hooks`, `notes` |
| `src/` | the plugin's own C/C++, prefixed `okplugin_<name>_`; staged to `.stage/libraries/onlykey/plugins/<name>/`, which the build already compiles and includes |
| `AUDIT.md` | every hook, every new message, every byte stored, and what it does not do |

**Hooks:** `{file, anchor, insert: 'before' | 'after', text}`. The anchor must occur **exactly once** in the staged file. Otherwise the stage stops, so a plugin never builds into a firmware it wasn't written against. Keep hooks to the minimum: an `#include`, and a `case` in the vendor switch.

**The mechanism:** the library's loader (`node-onlykey-lib/cli/firmware-plugins`, shared with node-onlykey-emulator, which builds the same plugins with `OKEMU_PLUGINS_DIR` pointing here), called from `scripts/stage.js` after the literal patches and before the digest. The e2e suite `1c-softKeyPlugins` arms itself only on a plugin build.

## Plugins
| Name | What |
|---|---|
| `hello` | proves the mechanism: `OKHELLO` (0x7E) answers a fixed sentence |
