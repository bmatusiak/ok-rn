/**
 * @format
 */

/*
 * FIRST IMPORT, and it has to stay first.
 *
 * Hermes has no global `crypto`, so `crypto.getRandomValues` does not exist -
 * and @noble calls it to generate the X25519 secret key for every OKCONNECT.
 * Without this the session cannot be established at all: the failure is an
 * exception thrown before a single byte is written, which surfaces as "the
 * device did not answer" and sends you looking at the firmware.
 *
 * react-native-get-random-values bridges to Android's SecureRandom. That
 * matters more here than in most apps: this key is one half of the session
 * key protecting everything the device is told, so a weak source would not
 * fail loudly, it would just make the session predictable. There is no
 * acceptable pure-JS fallback for it.
 *
 * It must be imported before anything that reaches for randomness, which in
 * practice means before App - the soft-key screen connects on mount.
 */
import 'react-native-get-random-values';

/*
 * SECOND, and it depends on the first.
 *
 * A side-effect import rather than a call, because `import` statements hoist:
 * a bare install() between two imports would run after App had already been
 * evaluated. See src/installWebCrypto.js for what it does and why.
 */
import './src/installWebCrypto';

import React from 'react';
import { AppRegistry } from 'react-native';
import { name as appName } from './app.json';
import { startupFailure, StartupBoundary } from './src/StartupFailure';

/*
 * App is required inside a guard, not imported: an error while its modules load
 * (a native module this APK lacks) would otherwise leave the launch splash up
 * forever with nothing to read. See src/StartupFailure.tsx.
 */
let Root;
try {
  const App = require('./App').default;
  Root = function GuardedApp() {
    return React.createElement(StartupBoundary, null, React.createElement(App));
  };
} catch (e) {
  Root = startupFailure(e, 'loading the app');
}

AppRegistry.registerComponent(appName, () => Root);

/*
 * B7 stage 2: keeps React Native's JS timers running while Edge watches in the
 * background (NativeEdgeAlertModule.keepJsTimers starts it, finishes it when
 * watching stops). It does nothing itself and never ends; the watcher's own code
 * lives in src/hooks/useEdgeBackgroundSync.ts.
 */
AppRegistry.registerHeadlessTask('OkrnEdgeWatch', () => () => new Promise(() => {}));

/*
 * EXPERIMENT - see REMOVAL.md. Remove this import and registration to drop it.
 *
 * A SECOND registered root on the same bundle. The Credential Manager sheet
 * launches CredProviderActivity, which renders this root instead of App, so a
 * WebAuthn request handed over by Chrome gets its own screen rather than the
 * whole app. Both activities share one ReactHost (MainApplication.reactHost),
 * so this costs a component, not a second runtime.
 */
AppRegistry.registerComponent(
  "OkRNCredProvider",
  () => require("./src/credprovider/CredProviderScreen").default,
);
