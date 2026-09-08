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

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
