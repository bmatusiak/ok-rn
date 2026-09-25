module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],

  /*
   * @noble/* ships ESM, and under Jest's export conditions that is what gets
   * resolved - so `require('@noble/ciphers/utils.js')` from inside
   * node-onlykey-lib lands on `export function ...` and Jest cannot parse it.
   *
   * The preset's pattern excludes everything in node_modules from transforms
   * except React Native's own packages, so @noble has to be added to the
   * allowed list rather than ignored. Babel then converts it, which is exactly
   * what Metro already does for the app bundle - this only brings Jest into
   * line with how the code actually runs on the device.
   *
   * Note this is a Jest-only concern. In Node, the library's own test suite
   * resolves the CJS build through the `require` condition and never sees ESM;
   * in Metro, ESM is transformed as a matter of course. Jest sits between the
   * two and gets neither by default.
   *
   * @react-native-async-storage is a SEPARATE scope from @react-native, so the
   * preset's `@react-native(-community)?` does not cover it - its lib/module
   * build and even its own Jest mock are ESM. Left out, every suite that
   * reaches src/onlykey.ts stopped RUNNING rather than failing, which shows up
   * in the summary as a smaller number of tests rather than as a red line.
   */
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community|-async-storage)?|@noble)/)',
  ],

  /*
   * The same scope problem metro.config.js solves with resolver.nodeModulesPaths,
   * in Jest's dialect.
   *
   * node-onlykey-lib is a linked sibling, so resolution from inside it walks up
   * out of the workspace without ever reaching this project's node_modules. It
   * breaks on Babel's own injected helper - transforming the library emits a
   * require of @babel/runtime/helpers/interopRequireDefault, a devDependency
   * HERE and nowhere in the sibling - so the error names a library file and
   * reads like a missing library dependency.
   */
  modulePaths: ['<rootDir>/node_modules'],

  /* apk-signer/ is a separate project with its own `npm test`. */
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/apk-signer/'],
  modulePathIgnorePatterns: ['<rootDir>/apk-signer/'],
};
