import React, {useCallback, useEffect, useRef, useState} from 'react';
import {AppState, KeyboardAvoidingView, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {errText} from './src/logSafe';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {Btn, StatusPill} from './src/ui/components';
import {WANTED, OFF, PRE, ON, type ConfigState} from './src/ui/configModeNotes';
import OkEmu from './src/transport/OkEmu';
import {describeWaiting, useKeyWaiting} from './src/hooks/useKeyWaiting';
import {useEdgeBackgroundSync} from './src/hooks/useEdgeBackgroundSync';
import {rememberTab, takeResumeTab} from './src/resumeTab';
import {Drawer} from './src/ui/Drawer';
import {Logo} from './src/ui/Logo';
import {ledColor, stateColor, theme} from './src/ui/theme';
import {IO_STEP_MS, ioPurple, nextShow, onIo, type IoChannel, type IoShow} from './src/btActivity';
import {onOpenBudget} from './src/edgeNav';

import {useLog} from './src/hooks/useLog';
import {useKey} from './src/hooks/useKey';
import {KeyBackendProvider} from './src/hooks/KeyContext';
import {BtKeyboardProvider, useSharedBtKeyboard} from './src/hooks/BtKeyboardContext';
import {useBtAuto, type BtAuto} from './src/hooks/useBtAuto';
import {useUsbHid} from './src/hooks/useUsbHid';
import {useFidoGatt, type FidoSession} from './src/hooks/useFidoGatt';
import {getOnlyKey} from './src/onlykey';
import type {Backend} from './src/hooks/keySession';
import {useTestingMode} from './src/hooks/useTestingMode';
import NativeShare from './specs/NativeShare';
import {setTestingMode} from './src/debugGuard';
import {useWipeOnLock} from './src/hooks/useWipeOnLock';

import {SplashScreen} from './src/screens/SplashScreen';
import NativeOkEmu from './specs/NativeOkEmu';

/*
 * THE SPLASH PLAYS ONCE PER PROCESS (Brad, 2026-10-04). Read when this module
 * loads: a JS reload loads it again in the same process, and the native flag
 * (specs/NativeOkEmu.ts) says the splash already played - so the app starts past
 * it, and whatever comes next (the soft key's "stopped" banner, an error) is seen
 * instead of a splash waiting forever for a firmware that cannot restart here.
 * An APK without the call just plays the splash, as before.
 */
const SPLASH_SEEN: boolean = (() => {
  try {
    return NativeOkEmu.splashDoneThisProcess?.() === true;
  } catch {
    return false;
  }
})();
import {LoginScreen} from './src/screens/LoginScreen';
import {PinScreen} from './src/screens/PinScreen';
import {SetupScreen} from './src/screens/SetupScreen';
import {KeyScreen} from './src/screens/KeyScreen';
import {SlotsScreen} from './src/screens/SlotsScreen';
import {SlotEditorScreen} from './src/screens/SlotEditorScreen';
import {KeysScreen} from './src/screens/KeysScreen';
import {KeyChainScreen} from './src/screens/KeyChainScreen';
import {BackupScreen} from './src/screens/BackupScreen';
import {BluetoothScreen} from './src/screens/BluetoothScreen';
import {CryptoScreen} from './src/screens/CryptoScreen';
import {EncryptDecryptScreen} from './src/screens/EncryptDecryptScreen';
import {SetupTabScreen} from './src/screens/SetupTabScreen';
import {FirmwareTabScreen} from './src/screens/FirmwareTabScreen';
import {PreferencesScreen} from './src/screens/PreferencesScreen';
import {PasskeysScreen} from './src/screens/PasskeysScreen';
import {LogScreen} from './src/screens/LogScreen';
import {AdvancedScreen} from './src/screens/AdvancedScreen';
import {TestingScreen} from './src/screens/TestingScreen';
import {BT_SEQ_BASE, takeOpenedAlarm} from './src/edgeAlerts';
import NativeFidoGatt from './specs/NativeFidoGatt';
import {btTransit} from './src/btTransit';
import {consentRefusal} from './src/debugGuard';
import {EdgeScreen} from './src/screens/EdgeScreen';
import {EdgeRequestSheet} from './src/ui/EdgeRequestSheet';
import {buildInfo, hasSoftKeyPlugin} from './src/buildInfo';
import {setFirmwareConsoleToLogcat} from './src/hooks/useOkEmu';
import {startKeyChainRecorder} from './src/keyChainRecorder';

/*
 * 'This Key', not 'Key' and no longer 'Soft Key'.
 *
 * Two things a tab could mean by "key": the DEVICE, and the private keys
 * loaded into it. One letter between 'Key' and 'Keys' is not a distinction
 * anyone can hold onto, which is why this tab has never just been called
 * 'Key'.
 *
 * It was 'Soft Key' while that was the only device there was. It can now be
 * either - the same screen reads whichever key is selected - so naming it for
 * one of them would be wrong half the time. The screen itself says which.
 */
/*
 * THE ORDER FOLLOWS THE ORIGINAL APPS (owner, 2026-09-29: "follow the user
 * feel of the original apps, starting with the tab layout and where things
 * are").
 *
 * - This Key stays first: the landing page, ok-rn's own.
 * - Then the desktop App's menu in its order - Setup (here "PIN Setup":
 *   it holds only the PIN changes; the backup passphrase sits on
 *   Backup/Restore beside the restore that uses it), Slots, Keys,
 *   Backup/Restore, Firmware, Preferences, Advanced (OnlyKey-App
 *   app/app.html:36-43) - with the web app's two, Encrypt and Decrypt
 *   (apps.onlykey.io mode-tabs.js), after Setup. The desktop's Tools tab
 *   is left out: it only links to the web app's encrypt/decrypt pages,
 *   which ok-rn has as tabs of its own.
 * - ok-rn's own tabs where the owner placed them: Key Chain right before
 *   Keys (key management: generate, derive, export - the Keys tab stays as
 *   it is for now), Passkeys after Keys, Bluetooth above Advanced, Log last.
 * - Preferences holds what can be changed back, Advanced what cannot (the
 *   library's `oneWay` flag decides). The desktop keeps both in its
 *   Preferences; this is the one deliberate difference.
 */
const TABS = [
  'This Key',
  'PIN Setup',
  'Encrypt',
  'Decrypt',
  'Slots',
  'Key Chain',
  'Keys',
  'Passkeys',
  'Backup/Restore',
  'Firmware',
  'Preferences',
  'Bluetooth',
  'Advanced',
  'Log',
] as const;
/**
 * Whether the screens that show secrets refuse to be captured.
 *
 * FOLLOWS THE BUILD, NOT THE SESSION. This used to be `!testing.enabled`, so a
 * DEBUG build blocked screenshots unless you had entered testing mode - which
 * made the ordinary development loop (change a screen, look at it) impossible
 * without bypassing the PIN first, and left the block untested in the only
 * build where it matters.
 *
 * `__DEV__` is false in a release bundle, so a shipped app always blocks and a
 * development build never does. Testing mode no longer comes into it: it is a
 * way to skip the door, not a statement about whether this screen holds
 * anything worth hiding.
 */
const BLOCK_SCREENSHOTS = !__DEV__;

const TESTING_TAB = 'Testing' as const;
/*
 * What the maintainer has not released - the vault, what it stored on this
 * phone, derived secrets / the password generator. His web app ships them
 * only in its development build (plugins-devel.js), so here they are shown
 * only in testing mode, which is __DEV__-only: a release build never has
 * this tab.
 */
const IN_DEV_TAB = 'In-Development' as const;
/*
 * Edge (onlykey-edge). Shown whenever this build's soft key carries the Edge
 * firmware plugin (OKEMU_PLUGINS=edge) - the owner is trying it out on the
 * real soft key without testing mode (2026-10-03). Without the plugin it is
 * testing mode only, where it runs on the FAKE key. The screen hides its own
 * testing controls when testing mode is off.
 */
const EDGE_TAB = 'Edge' as const;
type Tab = (typeof TABS)[number] | typeof IN_DEV_TAB | typeof EDGE_TAB | typeof TESTING_TAB;

/* the drawer's tabs: testing mode adds its own; Edge also comes with a soft key that has it */
function shownTabs(testingOn: boolean): readonly Tab[] {
  if (__DEV__ && testingOn) return [...TABS, IN_DEV_TAB, EDGE_TAB, TESTING_TAB];
  return hasSoftKeyPlugin('edge') ? [...TABS, EDGE_TAB] : TABS;
}

/** Splash until the device can answer, then a door, then the app. */
type Phase = 'splash' | 'login' | 'pin' | 'setup' | 'main';

/*
 * The provider has to sit ABOVE whatever reads insets, so the shell is its own
 * component - a hook inside App would be reading a provider that is its own
 * child, and would get zeros.
 */
/**
 * Hands the Bluetooth TARGET to the authenticator's IO gate.
 *
 * "Each door has a gate, and a device must be targeted." The target is the
 * keyboard's chosen host - one computer, approved for IO in both directions -
 * and the gates (WebAuthn, API) are useFidoGatt's. That hook is built in the
 * Shell, ABOVE BtKeyboardProvider, so it cannot read the target from the
 * context; this sits inside the provider, always mounted, and passes it
 * across. useFidoGatt then tells the radio (setIoPolicy) whenever the target
 * or either gate changes.
 *
 * Here, not on the Bluetooth tab: the tab unmounts whenever another is
 * shown, and the gate has to follow a target that is forgotten because its
 * bond went away while nobody was looking at the tab.
 */
function IoPolicySync({setTarget}: {setTarget: (address: string | null) => void}) {
  const {chosenHost} = useSharedBtKeyboard();
  useEffect(() => {
    setTarget(chosenHost);
  }, [chosenHost, setTarget]);
  return null;
}

/**
 * Bluetooth, keyboard, authenticator - blue armed, green connected, grey off.
 *
 * AND the thing that starts them, which is not a coincidence.
 *
 * Auto-start used to live on the Bluetooth screen, where it did nothing until
 * you opened the Bluetooth tab - the one component certain not to be mounted
 * at the moment "start on app start" is about. It belongs wherever is mounted
 * for the life of the app, and these icons are exactly that: they report the
 * radio on every tab, so they are always here to act on it.
 *
 * A component rather than three expressions in App, because it reads the
 * keyboard session through the context that App WRAPS but is not inside -
 * calling the hook in App's own body throws.
 */


/* while waiting for Bluetooth to be ready after the phone's Bluetooth came back: ask this often (RadioStatus) */
const READY_ASK_MS = 1500;
/* how many times the Bluetooth off/on sequence restarts ours to land where the computer knows it */
const LAYOUT_MAX_TRIES = 5;

/*
 * PURPLE WHILE DATA CROSSES THE WIRE (Brad, 2026-10-07; the rule is btActivity.ts):
 * true while the icon should show traffic - until a second with none. Re-renders only
 * when the answer flips, on the 250 ms steps of a blink.
 */
function useIoPurple(match: (c: IoChannel) => boolean, solid: boolean): boolean {
  const [purple, setPurple] = useState(false);
  useEffect(() => {
    let show: IoShow | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = () => {
      timer = null;
      const now = Date.now();
      setPurple(ioPurple(show, now, solid));
      if (!show || now >= show.end) { show = null; return; }
      const nextStep = IO_STEP_MS - ((now - show.start) % IO_STEP_MS);
      timer = setTimeout(tick, solid ? show.end - now : Math.min(nextStep, show.end - now));
    };
    const off = onIo((c, at) => {
      if (!match(c)) return;
      show = nextShow(show, at);
      if (!timer) tick();
    });
    return () => { off(); if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solid]);
  return purple;
}

function RadioStatus({
  on,
  setOn,
  fido,
  auto,
  onPress,
}: {
  on: boolean;
  setOn: (next: boolean) => void;
  fido: FidoSession;
  auto: BtAuto;
  /** Opens the Bluetooth tab - the icons are a summary of it, so they lead there. */
  onPress: () => void;
}) {
  const btk = useSharedBtKeyboard();
  const published = btk.state !== 'unregistered' && btk.state !== 'unsupported';
  const linked = btk.state === 'connected';
  const advertising = fido.state === 'advertising' || fido.state === 'connected';

  /*
   * THE PHONE'S BLUETOOTH GOING OFF AND ON IS AN APP RESTART FOR OUR BLUETOOTH
   * (Brad, 2026-10-04, from his own fix by hand on the Pixel).
   *
   * What went wrong: after a Bluetooth off/on the app still held the computer as
   * connected, rebuilt its services before the fresh stack was ready, and a
   * computer's discovery then hung until the app restarted; and the "not ready"
   * empty list during the switch erased the saved target. His sequence fixed it:
   *   radio off -> remember the target, switch to None (drop the connection);
   *   radio on  -> once Bluetooth is READY, the in-app switch off; once ours has
   *                STOPPED, on again (as on an app start); once the keyboard is
   *                published, pick the remembered computer again.
   * Every step waits on FEEDBACK from the native side, never a timer (Brad:
   * "never use timers if we can get feedback"). Only while the in-app switch is on.
   */
  type Step = 'idle' | 'waitReady' | 'waitStopped' | 'waitPublished' | 'waitLanded';
  const layoutTries = useRef(0);
  const step = useRef<Step>('idle');
  const lastRadio = useRef<boolean | null>(null);
  const resumeHost = useRef<string | null>(null);
  useEffect(() => {
    const r = btk.radioOn;
    const prev = lastRadio.current;
    lastRadio.current = r;
    if (r === null || prev === null || r === prev) return;
    if (!r) {
      step.current = 'idle';
      /* no pairing mode while Bluetooth is off (Brad, 2026-10-05) */
      btTransit.closePairWindow();
      if (btk.chosenHost) resumeHost.current = btk.chosenHost;
      if (btk.chosenHost) void btk.chooseHost(null).catch(() => {});
      return;
    }
    if (!on) return;
    /* ready = the native side got a real answer for the paired computers (an empty one counts) */
    layoutTries.current = 0;
    step.current = 'waitReady';
    setAskingReady(true);
    if (btk.ready === true) stopOurs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btk.radioOn]);
  /*
   * THE SAME CHECK AT APP START (2026-10-05). An app that starts before the
   * system's services are in (after a phone restart, an update) lands ours ahead
   * of them, exactly as after a radio toggle - and a computer that knew the
   * other order could not discover us. Once ours first advertises: not where a
   * computer last COMPLETED a message with us -> the same restart sequence.
   * An unknown position (nothing completed yet) is left as it is: a first start
   * already lands after the system's services.
   */
  const startChecked = useRef(false);
  useEffect(() => {
    if (startChecked.current || !on || !advertising || step.current !== 'idle') return;
    startChecked.current = true;
    const now = NativeFidoGatt.fidoHandle();
    const known = NativeFidoGatt.fidoKnownHandle();
    if (known <= 0 || now === known) return;
    console.log(`[bt] app start: our FIDO service at ${now}, a computer last completed with it at ${known} - restarting ours`);
    layoutTries.current = 0;
    resumeHost.current = btk.chosenHost ?? null;
    step.current = 'waitReady';
    setAskingReady(true);
    if (btk.ready === true) stopOurs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advertising, on]);
  useEffect(() => {
    if (step.current === 'waitReady' && btk.ready === true) stopOurs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [btk.ready]);
  /*
   * A timer that LOOKS for that feedback, never one that replaces it (Brad: "timers
   * are good for finding feedback"): while waiting, ask for the paired computers
   * every READY_ASK_MS, in case the last status event came a moment too early.
   * It stops as soon as the answer comes (or Bluetooth goes off again).
   */
  const [askingReady, setAskingReady] = useState(false);
  useEffect(() => {
    if (!askingReady) return undefined;
    const t = setInterval(() => {
      if (step.current !== 'waitReady') return setAskingReady(false);
      void btk.refreshHosts().catch(() => {});
    }, READY_ASK_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askingReady]);
  /* our Bluetooth off, exactly like the in-app switch (the teardown follows the switch, below) */
  function stopOurs() {
    setAskingReady(false);
    step.current = 'waitStopped';
    setOn(false);
  }
  /* on again only when ours has really stopped: keyboard withdrawn and the GATT server down */
  const stopped = !published && !advertising;
  useEffect(() => {
    if (step.current !== 'waitStopped' || on || !stopped) return;
    step.current = 'waitPublished';
    setOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, stopped]);
  /*
   * ...and once ours is on again, the remembered computer, like choosing it from
   * None. NOT gated on the keyboard being published: when Bluetooth comes back
   * the native side republishes the keyboard itself, the app's own publish then
   * loses that race ("another app is registered") and the keyboard reads
   * "unregistered" - and choosing the computer is what brings it back (Brad,
   * 2026-10-05, round 3 on the Pixel). So choose as soon as the switch is on.
   */
  useEffect(() => {
    if (step.current !== 'waitPublished' || !on) return;
    step.current = 'waitLanded';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  /*
   * ...but first: DID OUR SERVICES LAND WHERE THE COMPUTER KNOWS THEM? (the cause,
   * measured 2026-10-05: Windows keys its entries by start handle and hung when
   * ours moved). Checked once ours is advertising again (feedback). Not where the
   * computer last read them -> ours went in before the system's services: restart
   * ours again (a timer only gives the system's services a moment to go in first;
   * the handle is the check), at most LAYOUT_MAX_TRIES times.
   */
  useEffect(() => {
    if (step.current !== 'waitLanded' || !advertising) return;
    const now = NativeFidoGatt.fidoHandle();
    const known = NativeFidoGatt.fidoKnownHandle();
    /*
     * No known position yet (no computer has read us since the app was installed):
     * restart ours ONCE anyway, so they land after the system's services like a
     * fresh start. Without this the computer could not enumerate, so it never read
     * us, so the position was never learned (the Pixel, 2026-10-05, test 2).
     */
    const unknownFirstTry = known <= 0 && layoutTries.current === 0;
    if ((unknownFirstTry || (known > 0 && now !== known)) && layoutTries.current < LAYOUT_MAX_TRIES) {
      layoutTries.current += 1;
      console.log(`[bt] our FIDO service landed at ${now}, the computer knows it at ${known} - restarting ours (try ${layoutTries.current})`);
      step.current = 'waitReady';
      setTimeout(() => { if (step.current === 'waitReady') stopOurs(); }, READY_ASK_MS);
      return;
    }
    console.log(`[bt] our FIDO service at ${now} (computer knows ${known}) - picking the computer again`);
    step.current = 'idle';
    const host = resumeHost.current;
    resumeHost.current = null;
    if (host) void btk.chooseHost(host).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [advertising]);

  /*
   * OFF MEANS THE NATIVE TEARDOWN, WHOEVER TURNED IT OFF (Brad, 2026-10-04). It
   * lived only in the Bluetooth screen's switch handler, so any other path that
   * set the switch off (this sequence's first try, the e2e runner) left the
   * keyboard published and the GATT server running under a switch that said
   * off. On the edge from on to off only: at app start or after a JS reload the
   * switch reads off for a moment while the native server is still running,
   * and must not be torn down for that.
   */
  const prevOn = useRef(on);
  useEffect(() => {
    const was = prevOn.current;
    prevOn.current = on;
    if (!(was && !on)) return;
    if (published) void Promise.resolve(btk.withdraw()).catch(() => {});
    if (advertising) void Promise.resolve(fido.stop()).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);

  /* The radio, once storage has said so. */
  useEffect(() => {
    if (auto.ready && auto.autos.start) setOn(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto.ready, auto.autos.start]);

  /*
   * PRESENCE FOLLOWS THE RADIO, and nothing else.
   *
   * This used to wait for a chosen target before publishing the keyboard or
   * advertising 0xFFFD, which sounded careful and was the source of most of
   * this tab's trouble. A HOST READS A DEVICE'S SERVICE LIST EXACTLY ONCE,
   * WHEN IT PAIRS. Gating presence on a target made the first pairing with any
   * new computer the one pairing guaranteed to record neither service - and
   * the target list only holds computers already paired, so that was the
   * ordinary path, not an edge case. Worse, switching a feature off tore the
   * GATT server down, and Windows stops trusting a service node that keeps
   * vanishing: once dead, the WebAuthn stack stopped offering this phone at
   * all.
   *
   * So both services are offered for as long as Bluetooth is on. What the
   * switches on the Bluetooth tab now control is IO - whether keystrokes
   * cross the link, whether a request is relayed to the key - which is the
   * question someone was actually answering when they turned one off, and it
   * can be answered without ever changing what a host has recorded.
   *
   * Guarded on current state rather than run once, because the honest trigger
   * is "on, and not up yet" - which is also true after a host drops, after a
   * reload, and after the app is swiped away and reopened.
   */
  /*
   * THE RADIO COMING BACK IS ONE OF THOSE TRIGGERS, and it was missing.
   *
   * Reported 2026-09-19: turn Bluetooth off, turn it on again, and nothing
   * republished - the switches still said on, the Keyboard panel still said
   * unregistered. Neither `published` nor `advertising` changes when the
   * adapter goes away, so none of the deps moved and this never re-ran.
   *
   * `btk.radioOn` is the edge that was missing. It is re-read on every status
   * event, and the adapter receiver now emits on both edges, so flipping the
   * switch in Android settings brings both services back without the tab
   * being reopened.
   */
  useEffect(() => {
    if (!auto.ready || !on) return;
    if (btk.radioOn === false) return;
    if (!published && !btk.busy) void btk.publish();
    if (!advertising && fido.supported !== false) void fido.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto.ready, on, published, advertising, btk.radioOn]);

  const color = (enabled: boolean, connected: boolean) =>
    connected ? theme.ok : enabled ? theme.accentHover : theme.textDim;
  /*
   * Purple first (traffic), then the state. ⚿ is yellow while it advertises - the
   * advertising pill's colour on the Bluetooth tab (Brad, 2026-10-07) - and the only
   * icon that is: the key service is the one thing here advertised over BLE.
   */
  const anyIo = useIoPurple(() => true, true);
  const keyboardIo = useIoPurple(c => c === 'keyboard', false);
  const keyIo = useIoPurple(c => c === 'key', false);
  const keyColor = keyIo ? theme.io
    : fido.state === 'connected' ? theme.ok
    : fido.state === 'advertising' ? stateColor('advertising')
    : theme.textDim;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Bluetooth status"
      style={({pressed}) => [styles.barMid, pressed && styles.pressed]}>
      <Text style={[styles.barIcon, {color: anyIo ? theme.io : color(on, linked)}]}>{'ᛒ'}</Text>
      <Text style={[styles.barIcon, {color: keyboardIo ? theme.io : color(published, linked)}]}>
        {'⌨'}
      </Text>
      <Text style={[styles.barIcon, {color: keyColor}]}>
        {'⚿'}
      </Text>
    </Pressable>
  );
}

export default function App() {
  /* every derive the soft key answers goes into the Key Chain list (plugins/key_chain) */
  useEffect(() => startKeyChainRecorder(), []);
  return (
    <SafeAreaProvider>
      <Shell />
    </SafeAreaProvider>
  );
}

function Shell() {
  // One log buffer per source so switching views does not interleave traffic.
  const usbLog = useLog();
  const fidoLog = useLog();
  const emuLog = useLog();

  /* The hard key talks too, and it is a different device saying it. */
  const hardLog = useLog();

  /*
   * Sessions are APP-SCOPED. Created inside a screen they died with it, so
   * switching views tore down every listener while the native thing carried on
   * running - the firmware kept going and the screen came back saying
   * "stopped", and the CTAP bridge stopped answering whenever you looked away.
   */
  /*
   * THE ACTIVE KEY, soft or hard, never both.
   *
   * useKey runs both underlying hooks - React does not allow a conditional
   * one - and hands over whichever the source setting selects. The soft key
   * therefore stays alive in the background while a hard one is in use, which
   * is what makes them comparable: attach a real key, look at it, unplug, and
   * the emulated one is still where it was rather than freshly booted.
   */
  /*
   * THE BRIDGE'S VIEW OF WHICH KEY IS ACTIVE, through refs.
   *
   * useFidoGatt has to be created here, above KeyBackendProvider, because
   * useKey() below needs fido.pending and the provider is fed from useKey's
   * own backend. That ordering is why the hook cannot read the key from
   * context - it did, silently got the default, and relayed every Bluetooth
   * WebAuthn ceremony to the soft key whatever was selected.
   *
   * A ref closes the loop without reordering anything: the getters are stable,
   * so nothing re-subscribes, and they read the CURRENT value at the moment a
   * browser actually asks.
   */
  const backendRef = useRef<Backend>('embedded');
  const getActiveKey = useCallback(() => getOnlyKey(backendRef.current), []);
  const getActiveBackend = useCallback(() => backendRef.current as string, []);
  /*
   * WHETHER THE ACTIVE KEY IS UNLOCKED, through a ref for the same reason as
   * the backend above: useKey() is built BELOW this line - it needs
   * fido.pending - so the value cannot be read here, only pointed at.
   */
  const unlockedRef = useRef(false);
  const isUnlocked = useCallback(() => unlockedRef.current, []);
  const fido = useFidoGatt({
    log: fidoLog.log,
    getKey: getActiveKey,
    getBackend: getActiveBackend,
    isUnlocked,
  });
  const keys = useKey({softLog: emuLog.log, hardLog: hardLog.log, fidoPending: fido.pending});


  backendRef.current = keys.backend;
  unlockedRef.current = keys.key.device === 'unlocked';
  const emu = keys.key;
  /*
   * TESTING MODE's Login (Brad, 2026-10-07: "a login button that sends the passcode
   * 1234561", hidden once unlocked): the dev keys' passcode, pressed on the soft key
   * as the keypad does, 200 ms apart (his keypad timing). Only in the testing bar,
   * which is __DEV__ - Metro folds it out of a release bundle, passcode and all.
   */
  const devLogin = useCallback(async () => {
    for (const button of [1, 2, 3, 4, 5, 6, 1]) {
      keys.soft.press(button);
      await new Promise<void>(r => setTimeout(r, 200));
    }
  }, [keys.soft]);
  const devLoginShown = keys.backend === 'embedded' && keys.soft.state === 'running' && keys.soft.device !== 'unlocked';
  /* the soft key waiting on an API request (a sign, decrypt, HMAC, Edge) - its prompt below */
  const keyWaiting = useKeyWaiting(keys.backend === 'embedded' && keys.soft.state === 'running');
  /* the Edge copy kept current while the soft key runs - a restart keeps only its latest link */
  useEdgeBackgroundSync({
    enabled: keys.backend === 'embedded' && keys.soft.state === 'running' && emu.device === 'unlocked',
    waiting: keyWaiting,
  });

  /*
   * THE BLUETOOTH MASTER SWITCH, here rather than on its tab.
   *
   * The bar reports it on every screen, and the Bluetooth tab unmounts the
   * moment you look at another one - so the tab cannot be where it lives.
   * Off until said otherwise; the tab's Auto panel is the only thing that
   * turns it on by itself, and only because someone asked it to.
   */
  const [btOn, setBtOn] = useState(false);

  /* Read here, acted on by RadioStatus, edited by the Bluetooth tab. */
  const auto = useBtAuto();


  const hid = useUsbHid({log: usbLog.log});
  const testing = useTestingMode();
  /* testing mode: the soft key's firmware console also goes to logcat (useOkEmu) */
  useEffect(() => {
    setFirmwareConsoleToLogcat(testing.enabled);
    setTestingMode(testing.enabled);
  }, [testing.enabled]);

  /*
   * A HARD KEY TURNS TESTING MODE ON, in a debug build.
   *
   * "Enter testing mode" lives only on the login screen, and a hard key can
   * walk straight past that screen: the door opens on the device's own state,
   * and a key that is already unlocked - as it is straight after
   * hardKeyProvision, which unlocks it and hands it back without a power
   * cycle - lands the app in `main`. With no button to press and no Testing
   * item in the drawer, the key was plugged in and nothing on the phone could
   * drive it. tools/e2e.js hit exactly this: it waited out its 60 s for the
   * button and then found no Testing item to open.
   *
   * So plugging one in turns the mode on. The bench owner's rule, 2026-09-24:
   * "if its a hardkey, enable testing mode IF build is debug". The debug half
   * needs no check here - useTestingMode's setEnabled is a no-op unless
   * __DEV__ (useTestingMode.ts:53), so a release build cannot reach this.
   *
   * Keyed on the BACKEND CHANGING, not on every render, so it fires once when
   * the hard key becomes the active one and then leaves the switch alone:
   * someone who turns testing mode off with the key still plugged in keeps it
   * off. It is not turned back off when the key leaves, either - the mode is
   * unpersisted already, and switching it off under a running suite would
   * pull its tab away mid-run.
   */
  useEffect(() => {
    if (keys.backend === 'usb') testing.setEnabled(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keys.backend]);

  /*
   * CONFIG MODE — step one of putting it back, and it is the APP'S OWN FLAG.
   *
   * The idea it serves: config mode decides which features the app offers.
   * Some things can be used in it, some cannot. That is what it is for.
   *
   * At THIS step it decides nothing. Nothing reads it, nothing is gated, no
   * device is asked about it. It can be switched in testing mode and it shows
   * a banner. That is the whole of it, deliberately.
   *
   * IT IS NOT A READING OF THE KEY, and the comment that used to sit here said
   * it was. The version removed in 98f8760 carried a flag four different things
   * could set, interpreted by six screens, none of which agreed - and on a
   * production hard key one tap turned it all on with the key untouched. So
   * this one claims nothing it cannot back up: it is a switch with a light on
   * it, and each thing it controls gets attached on purpose, one at a time.
   */
  const [configMode, setConfigMode] = useState<ConfigState>(OFF);

  /*
   * THE LOCK IS THE ONLY THING CONFIG MODE SAYS ABOUT ITSELF.
   *
   * The gesture sets `configmode = true`, sets `unlocked = false` and re-arms
   * the 1 Hz INITIALIZED broadcast (OnlyKey.ino:898-904, unchanged back to
   * v3.0.2). So a key that was asked to enter config mode and then announces
   * that it is locked, has entered it. That is the whole detector.
   *
   * Earlier in this rebuild I wrote that `emu.device` never goes to 'locked'
   * here "so there was no edge to catch" - that was wrong, and checking it
   * against the pinned firmware rather than against memory is what turned
   * three states into something the app can actually follow. What IS silent is
   * the unlock afterwards, which is why state 1 needs a button.
   *
   * Guarded on WANTED, so an ordinary lock - the idle timer, button 3 - does
   * not get read as config mode.
   */
  useEffect(() => {
    if (configMode === WANTED && emu.device === 'locked') setConfigMode(PRE);
  }, [configMode, emu.device]);

  /*
   * CHANGING KEY WHILE IN CONFIG MODE RESTARTS THE APP - EITHER DIRECTION.
   *
   * `configMode` is one app-wide flag and it describes the SOFT key, while
   * `emu` is whichever key is ACTIVE. The moment the hard key becomes active
   * the app would be carrying a belief about one device onto another: graying
   * what works and offering what does not.
   *
   * Clearing the flag instead would be worse. The soft key really IS still in
   * config mode - the firmware assigns `configmode` in exactly two places, the
   * boot initializer and the button-6 gesture, with no `configmode = false`
   * anywhere - and it cannot boot in place, because the emulator thread only
   * exits through the AIRCR trap. A new process resolves both, and restarting
   * is what the panel has been saying all along.
   *
   * BOTH DIRECTIONS. Inserting was the case this was built for; pulling the
   * key back out is the same problem mirrored. On a REMOVAL the hard key's own
   * config mode died with it - unplugging is a boot - and the app falls back
   * to the soft key, which is a different device with a different answer. A
   * flag that survived that would describe neither.
   *
   * ON THE ACTIVE BACKEND, NOT ON ATTACHMENT, and the difference matters. An
   * earlier version fired when `keys.attached` became true; useKey.ts:258
   * resolves `override > (auto && attached) > embedded`, so in manual mode or
   * with an 'embedded' override a plugged-in key leaves the soft key active -
   * and that version threw the session away for a switch that never happened.
   * In auto mode with no override, inserting a key IS switching to it, and
   * pulling it out IS switching back.
   *
   * Launch is not a switch: `backend` starts 'embedded', so a key already
   * attached produces embedded -> usb on the first poll - but the state is OFF
   * at launch, so nothing fires. The guard is the flag, not the edge.
   */
  const previousBackend = useRef(keys.backend);
  useEffect(() => {
    const from = previousBackend.current;
    previousBackend.current = keys.backend;
    if (from === keys.backend || configMode === OFF) return;
    /*
     * THE ONLY AUTOMATIC RESTART IN THE APP - every other caller is a button
     * somebody pressed. It kills this process and relaunches, so it says why
     * on the way out; a screen that vanishes with no explanation reads as a
     * crash.
     */
    console.log(
      `[app] key changed ${from} -> ${keys.backend} at config state ${configMode} - restarting`,
    );
    void OkEmu.restartApp();
  }, [keys.backend, configMode]);

  /*
   * Ask whether the PIN went back in, because the key will not say.
   *
   * OKGETLABELS is on the config-mode allowlist (okcore.cpp:334 in every
   * pinned release) and is refused while locked, so a label read that succeeds
   * is positive proof of an unlock - the proof the broadcast never gives,
   * since the UNLOCKED announcement is suppressed while in config mode
   * (OnlyKey.ino:707).
   *
   * A BUTTON, NEVER A TIMER. This began as a 2.5 s poll and that HURT PIN
   * ENTRY on a hard key: the probe writes on the vendor interface, and doing
   * that repeatedly while somebody is pressing buttons interferes with the
   * digits going in. The person pressing it has just finished their PIN and is
   * the one who knows.
   */
  const [checking, setChecking] = useState(false);
  const checkConfig = useCallback(async () => {
    setChecking(true);
    try {
      const {device} = await getActiveKey();
      const ok = await device.configModeReady({timeoutMs: 2500});
      console.log(`[config] label probe: ${ok ? 'UNLOCKED' : 'locked'}`);
      if (ok) {
        /* The app has no other way to learn this. */
        emu.markUnlocked();
        setConfigMode(ON);
      }
    } catch (e) {
      console.log(`[config] label probe failed: ${errText(e)}`);
    } finally {
      setChecking(false);
    }
  }, [getActiveKey, emu]);

  const [tab, setTab] = useState<Tab>('This Key');
  /* B7: a tapped Edge alarm opens the Edge tab on its link (on launch and on every return to the app) */
  const [edgeFocus, setEdgeFocus] = useState<number | null>(null);
  /* the request sheet's budget card, tapped: the Edge tab, on that budget's details (edgeNav.ts) */
  const [edgeBudget, setEdgeBudget] = useState<number | null>(null);
  useEffect(() => onOpenBudget(id => { setTab(EDGE_TAB); setEdgeBudget(id); }), []);
  useEffect(() => {
    const look = () => {
      const s = takeOpenedAlarm();
      if (s !== null && s >= BT_SEQ_BASE) setTab('Bluetooth'); /* Part T: a Bluetooth pairing alarm */
      else if (s !== null) { setTab(EDGE_TAB); setEdgeFocus(s); }
    };
    look();
    const sub = AppState.addEventListener('change', st => { if (st === 'active') look(); });
    return () => sub.remove();
  }, []);

  /*
   * NOTHING STAGED FOR A SHARE OUTLIVES IT (Brad, 2026-10-04): a decrypted message,
   * a backup or an encrypted private key sits in the cache only while the share
   * sheet uses it. Wiped when the app goes to the background too - the native side
   * skips this while a share is in flight (opening the sheet backgrounds the app)
   * and wipes on the sheet's own result; MainApplication wipes at start.
   */
  useEffect(() => {
    const sub = AppState.addEventListener('change', st => {
      if (st === 'background') NativeShare.clearShared().catch(() => undefined);
    });
    return () => sub.remove();
  }, []);

  /*
   * BACK TO THE LAST TAB after a restart you asked for (src/resumeTab.ts).
   * Every in-app restart goes through OkEmu.restartApp, which waits for this
   * hook; the first time the app opens after a login, the tab comes back -
   * within five minutes of the restart, once.
   */
  const tabRef = useRef<Tab>(tab);
  tabRef.current = tab;
  useEffect(() => {
    OkEmu.beforeRestart = () => rememberTab(tabRef.current);
    return () => {
      OkEmu.beforeRestart = null;
    };
  }, []);
  const resumeChecked = useRef(false);

  /*
   * The slot being edited, if any.
   *
   * Held here rather than inside SlotsScreen because the editor is a FULL
   * SCREEN with a back arrow, not a sheet - there is too much in a slot for a
   * modal on a phone - so it replaces the body and the drawer alike.
   */
  const [openSlot, setOpenSlot] = useState<{id: string; index: number; label: string | null} | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [phase, setPhase] = useState<Phase>(SPLASH_SEEN ? 'login' : 'splash');
  /* The first time inside after this process started: take the remembered tab, if any. */
  useEffect(() => {
    if (phase !== 'main' || resumeChecked.current) return;
    resumeChecked.current = true;
    /*
     * Only tabs that are SHOWN now. Testing mode is deliberately not kept
     * across a restart (see Log out), so the Testing and In-Development tabs
     * must not come back through here - the render's last branch IS the
     * Testing screen, and this would walk round its gate.
     */
    const valid: readonly string[] = shownTabs(testing.enabled);
    void takeResumeTab(valid).then(remembered => {
      if (remembered) setTab(remembered as Tab);
    });
  }, [phase, testing.enabled]);
  /*
   * The splash plays its animation to the end (AnimatedLogo, 3 s - the
   * owner's choice) even when the key boots faster, so it cannot be cut off
   * half-spread. Leaving it waits for this AND for the firmware to settle.
   */
  const [splashDone, setSplashDone] = useState(SPLASH_SEEN);

  /*
   * The door opens and closes on what the DEVICE says, not on a local flag.
   *
   * Lock state arrives as the firmware's own once-a-second broadcast, so this
   * follows it: unlocking anywhere lands you in the app, and the device
   * locking itself - the idle timer, or a two-second hold on button 3 - puts
   * the door back.
   */
  useEffect(() => {
    if (testing.enabled) {
      setPhase('main');
      return;
    }
    /*
     * THE DOOR STAYS SHUT AT PRE, and it has to be held shut deliberately.
     *
     * Typing the PIN in config mode makes the app see 'unlocked' by itself:
     * useOkEmu.ts:725-737 sends OKCONNECT once a digit settles while locked,
     * and the firmware answers UNLOCKED from inside config mode (okcore.cpp
     * :1317 in v3.0.4, :1315 in v3.0.2 - not a new branch). Without this
     * clause the tabs would come back the instant the PIN landed, taking the
     * "Check config mode" button with them before anyone could press it.
     *
     * The fallthrough below returns `prev` for 'pin', so the PIN view simply
     * stays. Pressing the check sets ON and the next run opens the door.
     */
    if (emu.device === 'unlocked' && configMode !== PRE) {
      setPhase('main');
      return;
    }
    setPhase(prev => {
      // Leaving the splash needs the firmware settled, either way it went.
      if (prev === 'splash' && splashDone && emu.state !== 'stopped' && emu.state !== 'starting') {
        return 'login';
      }
      // It relocked while we were inside.
      if (prev === 'main') {
        /*
         * WHY THE DOOR CLOSED, to logcat.
         *
         * Reported 2026-09-17: leave the app and come back and it asks to log
         * in again, with the key still unlocked. This transition is the only
         * thing that can produce that, and it left no trace - so from outside
         * "the firmware relocked" and "the app lost track of the firmware"
         * looked identical, which is the same hole the Bluetooth keyboard had.
         */
        console.log(
          `[door] main -> login: device=${emu.device} state=${emu.state} testing=${testing.enabled}`,
        );
        return 'login';
      }
      return prev;
    });
    /*
     * `configMode` is in here for the clause above: the PRE -> ON flip is the
     * ONLY thing that changes when the check passes - `emu.device` has been
     * 'unlocked' since the PIN landed - so without it the door would never
     * reopen and the check button would look dead.
     */
  }, [testing.enabled, emu.device, emu.state, configMode, splashDone]);

  const ready = phase === 'main';

  /*
   * Locking forgets everything learned while unlocked. The epoch is a remount
   * key for the screens; the hook also drops the library's cached vault keys,
   * which are not React state and would survive a remount.
   */
  const sessionEpoch = useWipeOnLock(ready);

  /*
   * The drawer does not survive the door.
   *
   * Its open flag is independent of the phase, so a drawer left open when the
   * device locked came straight back the moment you unlocked - the app opened
   * onto a menu nobody had asked for. Closing it on the way out is simpler
   * than making every exit remember to.
   */
  useEffect(() => {
    if (!ready) {
      setDrawer(false);
    }
  }, [ready]);

  return (
    /*
      EVERY SCREEN BELOW READS THE ACTIVE KEY THROUGH THIS.

      Without it they all called getOnlyKey() with no argument and got the
      soft key, so the header could say Hard Key over a screen showing the
      soft one's slots. See KeyContext.tsx for why a provider rather than a
      module-level setter.
    */
    <KeyBackendProvider backend={keys.backend}>
      {/*
        * INSIDE KeyBackendProvider, because the forwarder reads `useBackend()`
        * to choose which pipe it listens on - the soft key's stream or the hard
        * key's. Outside it, the bridge would forward the wrong key's typing.
        */}
      <BtKeyboardProvider>
      <IoPolicySync setTarget={fido.setTarget} />
      <StatusBar barStyle="light-content" />
      {/* an agent's budget request (Edge step 2): over whatever tab is open */}
      {hasSoftKeyPlugin('edge') ? <EdgeRequestSheet /> : null}
      <SafeAreaView style={styles.safe} edges={['top', 'left', 'right', 'bottom']}>
        {ready ? (
          <View style={styles.bar}>
            <Pressable
              onPress={() => setDrawer(true)}
              accessibilityRole="button"
              accessibilityLabel="Menu"
              style={({pressed}) => [styles.barLeft, pressed && styles.pressed]}>
              {/*
                The wordmark, not the square mark: that asset is not
                transparent, so tinting it white fills the whole square.
              */}
              <Logo height={17} />
              <Text style={styles.barSep}>|</Text>
              <Text style={styles.barTitle}>{tab}</Text>
            </Pressable>
            {/*
              WHICH KEY, ON EVERY TAB.

              The lock pill has always said what the device is doing. It did
              not say WHICH device, and once there are two that is a gap on
              every screen rather than one: "12 slots, 3 configured" is a
              different fact about a soft key than about the one in your hand,
              and nothing on the Slots tab said which it had read.

              Here rather than per screen, because the answer is the same
              everywhere and repeating it eleven times is eleven chances to
              disagree.

              It leads to This Key, for the same reason the radio icons lead to
              Bluetooth: each is a summary of one tab, and a summary you cannot
              follow back to the thing it summarises is a dead end.
            */}
            {/*
              WHAT THE RADIO IS DOING, on every tab.

              Three things can be true at once here - the radio is on, the
              keyboard is published, the authenticator is advertising - and
              each of them is either merely ENABLED or actually CONNECTED to
              something. That is six states, and the Bluetooth tab is the only
              place any of it was visible. A keyboard silently not typing is
              the failure this app keeps having; this is where it shows.

              Blue is armed, green is connected, grey is off.
            */}
            <RadioStatus
              on={btOn}
              setOn={setBtOn}
              fido={fido}
              auto={auto}
              onPress={() => setTab('Bluetooth')}
            />

            <Pressable
              onPress={() => setTab('This Key')}
              accessibilityRole="button"
              accessibilityLabel="Key status"
              style={({pressed}) => [styles.barRight, pressed && styles.pressed]}>
              <Text style={styles.barKey}>{keys.name}</Text>
              <StatusPill
                state={emu.device}
                label={emu.device === 'unknown' ? emu.state : emu.device}
                dotColor={keys.backend === 'embedded' ? ledColor(emu.led) : null}
              />
            </Pressable>
          </View>
        ) : null}

        {/*
          A TEST build made with OKRN_DEBUG_LOCK=off (Brad, 2026-10-05): the debugging
          lock is off, so a computer with adb could approve and press. Said in red on
          every screen, so this build can never pass for a pre-release - release.js
          will not package one from it anyway.
        */}
        {!buildInfo.debugLock ? (
          <View style={[styles.testing, {borderColor: theme.error}]}>
            <Text style={[styles.testingText, {color: theme.error}]}>
              TEST BUILD - debugging lock OFF: with adb on, a computer could approve and press
            </Text>
          </View>
        ) : null}

        {/* `__DEV__` inline so Metro folds the branch out of a release bundle. */}
        {__DEV__ && testing.enabled ? (
          <View style={[styles.testing, devLoginShown && styles.testingRow]}>
            <Text style={[styles.testingText, devLoginShown && {flex: 1}]}>
              Testing mode — PIN bypassed, developer tools shown
            </Text>
            {devLoginShown ? <Btn title="Login Bypass" tone="primary" onPress={() => void devLogin()} /> : null}
          </View>
        ) : null}

        {/*
          TWO WORDS, and that is the point.

          The banner this replaces said the key would not sign or type and that
          only a restart would end it. Neither is something an app flag knows,
          and saying it anyway is how the old one came to describe a key nobody
          had touched. Consequences get added to this line as features are
          actually put behind the flag - never in advance of them.
        */}
        {configMode >= PRE ? (
          <View style={styles.configBanner}>
            <Text style={styles.configBannerText}>Config mode</Text>
          </View>
        ) : null}

        {/*
          THE SOFT KEY HALTING IS SAID ON EVERY TAB, not only on This Key.

          A two-second hold on button 3 is the firmware's lock gesture, and on
          a real key it restarts the device; the emulator's thread only exits
          through the reset trap and cannot be replaced in this process
          (FINDING-lock-gesture-ends-the-soft-key.md). Every other tab kept
          drawing its keypad over a firmware that was gone, and a tap there
          did nothing with nothing said. The way back is an app restart, so
          that is offered wherever the halt is seen.
        */}
        {keys.backend === 'embedded' && keys.soft.state === 'halted' ? (
          <HaltedBanner countdown={phase === 'login'} />
        ) : null}

        {/*
          Presence is asked for by the KEY, so the prompt lives above the views
          rather than inside one. A browser says "press the button on your
          security key"; the key has to say where, wherever you are looking.
        */}
        {fido.presenceNeeded ? (
          <View style={styles.prompt}>
            <View style={styles.promptText}>
              <Text style={styles.promptTitle}>Confirm on your key</Text>
              <Text style={styles.promptBody}>
                {emu.canPress === true
                  ? 'A site is asking for a security key. This is the press it wants.'
                  : 'A site is asking for a security key. Press any button on the key itself.'}
              </Text>
            </View>
            {/*
              NO CONFIRM BUTTON ON A KEY THE APP CANNOT PRESS.

              `fido.confirm` presses the active key through holdTicks, which
              throws without the debug console - every production key. Here that
              is worse than elsewhere: the browser is mid-ceremony, and a button
              that throws means the credential is never made and the site just
              times out. The instruction is the honest offer.

              This prompt is app-wide, above the views, so it needed its own
              gate - the one on the Bluetooth tab's Authenticator panel does not
              reach it.
            */}
            {emu.canPress === true ? (
              <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
            ) : null}
          </View>
        ) : null}

        {/*
          THE SAME PROMPT FOR A REQUEST THAT CAME OVER THE API (owner,
          2026-10-02): an ssh login or a gpg sign through onlykey-js --ble waits
          on the soft key exactly as a site does, and the phone said nothing -
          the key just timed out. The wait is the firmware's own
          (useKeyWaiting); CTAP keeps its prompt above, so a WebAuthn wait is
          never shown twice.

          A CODE IS NEVER SHOWN HERE. The 3 digits come from the computer that
          asked; a phone that displayed them would let a bad request supply its
          own code and the person just copy it in - the check would prove
          nothing. So code mode says where the code is and opens the keypad.
        */}
        {keyWaiting && !fido.presenceNeeded ? (
          <View style={styles.prompt}>
            <View style={styles.promptText}>
              <Text style={styles.promptTitle}>Confirm on your key</Text>
              <Text style={styles.promptBody}>
                {describeWaiting(keyWaiting) + ' '}
                {keyWaiting.mode === 'press'
                  ? 'This is the press it wants.'
                  : keyWaiting.mode === 'code'
                    ? `Enter the code the computer shows on This Key's keypad (${keyWaiting.entered} of 3 in).`
                    : 'Press a button, or enter the code the computer shows on This Key.'}
              </Text>
            </View>
            {/*
              * Spec rule 10, the app's lock: an Edge approval (budget, waive, loss,
              * restore, registration) cannot be pressed here while debugging is on,
              * unless a TEST consent started it (src/debugGuard.ts).
              */}
            {keyWaiting.what === 'edge' && consentRefusal() ? (
              <Text style={[styles.promptBody, {color: theme.error, flexShrink: 1}]}>Turn off debugging to approve this.</Text>
            ) : keyWaiting.mode === 'press' ? (
              <Btn title="Confirm" tone="primary" onPress={() => { if (keyWaiting.what === 'edge' && consentRefusal()) return; void OkEmu.pressQueue('1'); }} />
            ) : tab !== 'This Key' ? (
              <Btn title="Keypad" tone="primary" onPress={() => setTab('This Key')} />
            ) : null}
          </View>
        ) : null}

        {/*
          THE KEYBOARD MUST NOT COVER THE FIELD BEING TYPED IN.
          With edge-to-edge on (gradle.properties edgeToEdgeEnabled, target SDK
          36) Android no longer resizes the window for the keyboard, so the
          manifest's adjustResize does nothing: the keyboard is drawn over the
          app and every field below its top edge was typed into blind. One
          wrapper here, around every tab, shrinks the content by the keyboard's
          height instead, so the tab's ScrollView can bring the field into view.
        */}
        <KeyboardAvoidingView style={styles.body} key={sessionEpoch} behavior="padding">
          {phase === 'splash' ? (
            <SplashScreen onDone={() => {
              setSplashDone(true);
              try { NativeOkEmu.markSplashDone?.(); } catch {}
            }} />
          ) : phase === 'login' ? (
            <LoginScreen
              device={emu.device}
              attached={keys.attached}
              /*
                Straight to the Testing tab, not This Key. Someone who turns
                testing mode on from the door is going there next - it is the
                only reason the button exists.
              */
              onTesting={() => {
                testing.toggle();
                setTab(TESTING_TAB);
              }}
              onContinue={() =>
                // A blank key has no PIN to enter; it needs one chosen.
                setPhase(emu.device === 'uninitialized' ? 'setup' : 'pin')
              }
            />
          ) : phase === 'setup' ? (
            <SetupScreen
              onDone={() => setPhase('login')}
              model={emu.model}
              onProvision={emu.provision}
              led={keys.backend === 'embedded' ? emu.led : undefined}
            />
          ) : phase === 'pin' ? (
            <PinScreen
              onPress={emu.press}
              onPressRun={emu.pressRun}
              canPress={emu.canPress}
              model={emu.model}
              settling={emu.settling}
              led={keys.backend === 'embedded' ? emu.led : undefined}
              /*
               * OFFERED ONLY WHEN THERE IS SOMETHING TO CHOOSE BETWEEN. With
               * no hard key on the bus the row would be two options one of
               * which does nothing, so it is not drawn at all.
               *
               * Picking writes the OVERRIDE rather than the mode: the mode is
               * a standing preference ("prefer the hard key when one is
               * attached"), and this is someone saying which key they mean
               * right now, for this login.
               */
              keyPick={
                keys.attached === true
                  ? {
                      value: keys.backend === 'usb' ? 'Hard key' : 'Soft Key',
                      onChange: next =>
                        keys.setOverride(next === 'Hard key' ? 'usb' : 'embedded'),
                    }
                  : null
              }
              onBack={() => setPhase('login')}
              /*
                The door is where someone stands when config mode has locked
                the key and the unlock will never be announced. The panel on
                Keys and Backup cannot help from here.
              */
              configMode={configMode === PRE}
              onCheckConfig={() => void checkConfig()}
              checking={checking}
            />
          ) : tab === 'This Key' ? (
            <KeyScreen emu={emu} keys={keys} configMode={configMode === PRE} onCheckConfig={() => void checkConfig()} checking={checking} />
          ) : tab === 'Slots' ? (
            openSlot ? (
              <SlotEditorScreen
                slot={openSlot}
                emu={emu}
                onBack={() => setOpenSlot(null)}
                /*
                 * FLAG_SECURE blanks adb screenshots as well as a bystander
                 * photo, so testing mode - which exists to make the app
                 * inspectable - turns it off.
                 */
                blockScreenshots={BLOCK_SCREENSHOTS}
              />
            ) : (
              <SlotsScreen onOpen={slot => setOpenSlot(slot)} />
            )
          ) : tab === 'Key Chain' ? (
            <KeyChainScreen emu={emu} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} blockScreenshots={BLOCK_SCREENSHOTS} />
          ) : tab === 'Keys' ? (
            <KeysScreen emu={emu} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} />
          ) : tab === 'Bluetooth' ? (
            <BluetoothScreen fido={fido} on={btOn} setOn={setBtOn} auto={auto} canPress={emu.canPress === true} testing={testing.enabled} />
          ) : tab === 'PIN Setup' ? (
            <SetupTabScreen emu={emu} blockScreenshots={BLOCK_SCREENSHOTS} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} />
          ) : tab === 'Encrypt' || tab === 'Decrypt' ? (
            <EncryptDecryptScreen
              key={tab}
              direction={tab === 'Encrypt' ? 'encrypt' : 'decrypt'}
              emu={emu}
              blockScreenshots={BLOCK_SCREENSHOTS}
              configMode={configMode}
              onWantConfigMode={() => setConfigMode(WANTED)}
              testing={testing.enabled}
            />
          ) : tab === 'Backup/Restore' ? (
            /* The backup key is here, beside the restore that needs it. */
            <BackupScreen emu={emu} blockScreenshots={BLOCK_SCREENSHOTS} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} show={['capture', 'backupKey', 'restore']} />
          ) : tab === 'Firmware' ? (
            <FirmwareTabScreen emu={keys.key} hardRunning={keys.hard.state === 'running'} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} />
          ) : tab === 'Preferences' ? (
            /* The PIN changes are on PIN Setup. */
            <PreferencesScreen emu={emu} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} show={['prefs']} />
          ) : tab === EDGE_TAB ? (
            <EdgeScreen testingMode={testing.enabled} focusSeq={edgeFocus} onFocused={() => setEdgeFocus(null)} openGrantId={edgeBudget} onBudgetOpened={() => setEdgeBudget(null)} />
          ) : tab === IN_DEV_TAB ? (
            <CryptoScreen emu={emu} blockScreenshots={BLOCK_SCREENSHOTS} configMode={configMode} testing={testing.enabled} show={['derive', 'vault', 'stored']} />
          ) : tab === 'Passkeys' ? (
            <PasskeysScreen emu={keys.key} configMode={configMode} />
          ) : tab === 'Advanced' ? (
            <AdvancedScreen emu={keys.key} hard={keys.hard} keys={keys} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} />
          ) : tab === 'Log' ? (
            <LogScreen
              blockScreenshots={BLOCK_SCREENSHOTS}
              /*
                NAMED FOR THE DEVICE, not for the layer.

                "Firmware" was unambiguous while one key existed. It is not
                now: both keys run firmware and both talk. And the buffer
                that used to be called "Hard Key" was never the hard key's
                firmware at all - it is the byte-level USB panel, which is a
                different thing from a device session.
              */
              buffers={{
                'Soft Key': {entries: emuLog.entries, clear: emuLog.clear},
                'Hard Key': {entries: hardLog.entries, clear: hardLog.clear},
                CTAP: {entries: fidoLog.entries, clear: fidoLog.clear},
                'USB bytes': {entries: usbLog.entries, clear: usbLog.clear},
              }}
            />
          ) : (
            /*
              THE SOFT KEY, explicitly - not whichever is active.

              This tab starts and stops firmware, shows the storage files and
              factory-resets. Those are the emulator's controls; a hard key
              has none of them, and following the active key would put a
              Start button over a device that cannot be started.
            */
            <TestingScreen
              configMode={configMode}
              setConfigMode={setConfigMode}
              emu={keys.soft}
              hard={keys.hard}
              active={keys.key}
              backend={keys.backend}
              hid={hid}
              usbEntries={usbLog.entries}
              clearUsb={usbLog.clear}
              /*
               * The suite types a whole backup out on purpose, and a phone
               * paired as a BLE keyboard would deliver it to the paired
               * computer rather than to the suite. Off before anything runs.
               */
              onE2EStart={() => setBtOn(false)}
            />
          )}
        </KeyboardAvoidingView>

        <Drawer
          open={drawer && ready}
          tabs={shownTabs(testing.enabled)}
          value={tab}
          onChange={setTab}
          onClose={() => setDrawer(false)}
          /*
           * LOG OUT, which is a RESTART - and that is not a workaround.
           *
           * There was no way out of the app at all: once past the door every
           * screen assumed an unlocked key, and the only exit was swiping the
           * app away. The menu's footer held "Enter testing mode" instead,
           * ungated, which is what shipped a PIN bypass in a release.
           *
           * Restarting IS the logout for the soft key. Its firmware runs in
           * this process and `initialized` is recomputed from flash only in
           * setup(), so there is no in-process way to re-lock it - the thread
           * only exits through the AIRCR trap. A new process boots the key
           * locked, which is the state a logout is asking for.
           *
           * It also clears testing mode, which is deliberately unpersisted, so
           * a development session cannot leave the gate down for the next one.
           *
           * WHAT IT DOES NOT DO is lock a HARD key. That is a physical device
           * holding its own unlocked state, and nothing here can put it back -
           * the firmware only locks on the button 3 gesture, which also
           * restarts it. So the button says "Log out" rather than "Lock", and
           * the hard key's own state is its own.
           */
          footer={
            <Btn
              title="Log out"
              onPress={() => {
                void OkEmu.restartApp();
              }}
            />
          }
        />
      </SafeAreaView>
      </BtKeyboardProvider>
    </KeyBackendProvider>
  );
}

/*
 * THE SOFT KEY HAS STOPPED - and on the login page, the app restarts itself
 * after a minute (owner, 2026-10-01).
 *
 * On the login page there is nothing else to do: no key, so no way in, and
 * an app left open there just sits. So it counts down and restarts (the
 * resume hook still runs - see src/resumeTab.ts), with Cancel for someone who
 * wants to read the screen first. Elsewhere a restart would throw away what
 * is on screen, so it waits to be asked, as before.
 */
const HALT_RESTART_SECONDS = 60;

function HaltedBanner({countdown}: {countdown: boolean}) {
  const [left, setLeft] = useState(HALT_RESTART_SECONDS);
  const [cancelled, setCancelled] = useState(false);
  const running = countdown && !cancelled;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setLeft(s => s - 1), 1000);
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    if (running && left <= 0) void OkEmu.restartApp();
  }, [running, left]);
  return (
    <View style={styles.testing}>
      <Text style={styles.testingText}>
        The soft key has stopped — its firmware thread cannot be replaced
        in this process. Nothing is lost.
        {running ? ` Restarting the app in ${Math.max(left, 0)} s.` : ''}
      </Text>
      {countdown ? (
        <View style={styles.haltButtons}>
          <View style={styles.haltButton}>
            <Btn title="Restart now" tone="primary" onPress={() => OkEmu.restartApp()} />
          </View>
          {running ? (
            <View style={styles.haltButton}>
              <Btn title="Cancel" onPress={() => setCancelled(true)} />
            </View>
          ) : null}
        </View>
      ) : (
        <Btn title="Restart the app" tone="primary" onPress={() => OkEmu.restartApp()} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  haltButtons: {flexDirection: 'row', gap: 8},
  /* Each button an equal share of the row; alone (after Cancel), the whole row. */
  haltButton: {flex: 1},
  safe: {flex: 1, backgroundColor: theme.bg},
  /*
   * No manual bottom padding. SafeAreaView already insets the bottom edge, and
   * adding Math.max(insets.bottom, 12) on top of it counted the same inset
   * twice - which is the gap that appeared above the navigation bar.
   */
  body: {flex: 1, paddingHorizontal: 16},

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 12,
  },
  barLeft: {flexDirection: 'row', alignItems: 'center', gap: 10},
  barRight: {flexDirection: 'row', alignItems: 'center', gap: 8},
  barMid: {flexDirection: 'row', alignItems: 'center', gap: 12},
  barIcon: {fontSize: 17},

  /* Quiet: it is context, not a headline. The pill beside it is the state. */
  barKey: {color: theme.textDim, fontSize: 12},

  barTitle: {color: theme.text, fontSize: 16, fontWeight: '700'},
  barSep: {color: theme.border, fontSize: 15},
  pressed: {opacity: 0.6},


  testing: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.warn,
    backgroundColor: 'rgba(252, 211, 77, 0.10)',
  },
  testingText: {color: theme.warn, fontSize: 11, fontWeight: '600'},
  testingRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  /* The testing banner's shape in the error colour, as it was before. */
  configBanner: {
    marginHorizontal: 16,
    marginBottom: 10,
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.error,
  },
  configBannerText: {color: theme.error, fontSize: 12, fontWeight: '600'},

  prompt: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginHorizontal: 16,
    marginBottom: 12,
    padding: 12,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.warn,
    backgroundColor: 'rgba(252, 211, 77, 0.10)',
  },
  promptText: {flex: 1},
  promptTitle: {color: theme.text, fontSize: 14, fontWeight: '700'},
  promptBody: {color: theme.textDim, fontSize: 11, marginTop: 2, lineHeight: 15},
});
