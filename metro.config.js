const path = require('path');
const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */

/*
 * `node-onlykey-lib` and `test-moniker` are siblings of this project, installed
 * with `file:` so npm symlinks them into node_modules. Metro resolves a symlink
 * to its real path and then refuses to serve any file outside the project root
 * unless that root is watched - so without these entries the library resolves
 * and then fails to bundle, which reads as a missing-module error pointing at a
 * file that plainly exists.
 *
 * Package exports and symlinks both default to ON in Metro 0.87, so nothing
 * else is needed here. The library's exports map uses plain string targets
 * rather than condition objects, so `unstable_conditionNames` does not apply to
 * it and there is no react-native-specific entry point to declare.
 */
const workspace = path.resolve(__dirname, '..');
const linkedPackages = ['node-onlykey-lib', 'test-moniker'].map(name =>
  path.join(workspace, name),
);

const config = {
  watchFolders: linkedPackages,
  resolver: {
    /*
     * Metro resolves `node_modules` by walking up from the file that made the
     * request. For a linked sibling that walk starts inside the sibling, so it
     * finds node-onlykey-lib/node_modules and then leaves the workspace - it
     * never reaches this project's node_modules.
     *
     * That breaks on Babel's injected helpers rather than on anything the
     * library imports: transforming its `async` functions emits a require of
     * @babel/runtime/helpers/asyncToGenerator, which is a devDependency HERE
     * and nowhere in the sibling. The failure names the library's own file, so
     * it reads like a missing library dependency rather than a resolver scope
     * problem.
     *
     * Adding this project's node_modules as an explicit search path is the
     * supported fix for linked packages, and it keeps the two trees sharing one
     * copy of anything they both need.
     */
    nodeModulesPaths: [path.join(__dirname, 'node_modules')],

    /*
     * DO NOT WATCH THE NATIVE BUILD DIRECTORIES. Metro dies if one vanishes.
     *
     * `tools/matrix.js` deletes `android/okemu/.cxx` between versions, because
     * stale objects link new sources against old ones and present as undefined
     * symbols in a build that worked minutes earlier. Metro had that directory
     * under its watcher and went down with it mid-sweep:
     *
     *   filename: '…/android/okemu/.cxx/Debug/…/.cmake/api/v1/query'
     *
     * which then reads as every remaining version failing to bundle, nowhere
     * near the cause. None of this is bundled JavaScript - it is CMake's own
     * bookkeeping and the compiled output - so excluding it costs nothing and
     * removes a whole class of "the sweep died halfway" that has no other
     * explanation on the terminal.
     */
    blockList: /android[/\\](?:okemu[/\\](?:\.cxx|\.stage)|[^/\\]+[/\\]build)[/\\]/,
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
