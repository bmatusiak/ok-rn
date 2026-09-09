/**
 * The OnlyKey library, composed for this app.
 *
 * Every piece of protocol knowledge the app used to carry inline now lives in
 * `node-onlykey-lib`. This file is the whole of the wiring: it hands the
 * library a byte pipe and gets back a device.
 *
 * ONE APP, NOT ONE PER MOUNT. The Rectify app is built lazily and kept, for the
 * same reason `OkEmu` is a singleton - the firmware is a process-wide thing.
 * Building one per component mount would tear down the session key on every
 * re-render, and the device would be asked to redo OKCONNECT for a React
 * lifecycle event it knows nothing about.
 */
import Rectify from '@bmatusiak/rectify';
import AsyncStorage from '@react-native-async-storage/async-storage';
import hostPlugin from 'node-onlykey-lib/plugins/host';
import embeddedTransport from 'node-onlykey-lib/plugins/transport/embedded';
import sessionPlugin from 'node-onlykey-lib/plugins/session';
import devicePlugin from 'node-onlykey-lib/plugins/device';
import okcryptoPlugin from 'node-onlykey-lib/plugins/okcrypto';

import OkEmu, {type Iface} from './transport/OkEmu';

/**
 * The pipe contract, as `plugins/transport/embedded` defines it.
 *
 * OkEmu already has every method; this only names the subset the library
 * relies on, so a change to either side is a type error here rather than a
 * runtime surprise on the phone.
 */
type BytePipe = {
  start(): Promise<unknown>;
  stop(): Promise<void>;
  isRunning(): boolean;
  write(iface: Iface, bytes: Uint8Array): Promise<number>;
  on(event: 'stream', listener: (e: {iface: number; dir: number; bytes: Uint8Array}) => void): () => void;
};

export type OnlyKeyApp = {
  device: any;
  okcrypto: any;
  transport: any;
  destroy: () => Promise<void>;
};

let booting: Promise<OnlyKeyApp> | null = null;

/**
 * Build the app, or return the one already built.
 *
 * The promise itself is cached rather than the result, so two callers racing
 * at startup - the screen mounting while the auto-start effect runs - share one
 * app instead of building two against the same firmware.
 */
export function getOnlyKey(): Promise<OnlyKeyApp> {
  if (booting) {
    return booting;
  }

  booting = new Promise<OnlyKeyApp>((resolve, reject) => {
    /*
     * Rectify carries settings on the plugin ARRAY, as `plugins.config`, keyed
     * by the service name each plugin provides. An array with a property is
     * unusual enough that the type has to say so explicitly.
     */
    const plugins: any[] & {config?: Record<string, unknown>} = [
      hostPlugin,
      embeddedTransport,
      sessionPlugin,
      devicePlugin,
      okcryptoPlugin,
    ];

    /*
     * The transport is given OkEmu as its pipe, and the host is given
     * AsyncStorage. This is the only place the library learns anything
     * platform-specific: it never imports react-native, so it stays loadable
     * in Node for tests and in a browser for the web app.
     *
     * AsyncStorage already has exactly the three methods the store contract
     * asks for - getItem, setItem, removeItem - so it goes in unwrapped. Only
     * SEALED blobs are written through it: the key that opens them is derived
     * from the device and is stored nowhere, so a phone's backup carrying this
     * data reveals which services have credentials and none of their contents.
     */
    plugins.config = {
      transport: {pipe: OkEmu as unknown as BytePipe},
      host: {store: AsyncStorage},
    };

    const app = Rectify.build(plugins, (err: Error | null, started: any) => {
      if (err) {
        booting = null; // let a later caller retry rather than caching a failure
        reject(err);
        return;
      }
      resolve({
        device: started.services.device,
        okcrypto: started.services.okcrypto,
        transport: started.services.transport,
        destroy: () => started.destroy(),
      });
    });

    app.start();
  });

  return booting;
}

/** Tear the app down and allow a fresh one. Used by tests, not by the UI. */
export async function resetOnlyKey(): Promise<void> {
  const pending = booting;
  booting = null;
  if (!pending) {
    return;
  }
  try {
    const app = await pending;
    await app.destroy();
  } catch {
    /* a build that never succeeded has nothing to tear down */
  }
}
