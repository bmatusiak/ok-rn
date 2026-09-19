import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {Btn, StatusPill} from './src/ui/components';
import {WANTED, OFF, PRE, ON, type ConfigState} from './src/ui/configModeNotes';
import OkEmu from './src/transport/OkEmu';
import {Drawer} from './src/ui/Drawer';
import {Logo} from './src/ui/Logo';
import {ledColor, theme} from './src/ui/theme';

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
import {useCapabilityOverrides} from './src/capabilityOverride';
import {useWipeOnLock} from './src/hooks/useWipeOnLock';

import {SplashScreen} from './src/screens/SplashScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {PinScreen} from './src/screens/PinScreen';
import {SetupScreen} from './src/screens/SetupScreen';
import {KeyScreen} from './src/screens/KeyScreen';
import {SlotsScreen} from './src/screens/SlotsScreen';
import {SlotEditorScreen} from './src/screens/SlotEditorScreen';
import {KeysScreen} from './src/screens/KeysScreen';
import {BackupScreen} from './src/screens/BackupScreen';
import {BluetoothScreen} from './src/screens/BluetoothScreen';
import {CryptoScreen} from './src/screens/CryptoScreen';
import {MessagesScreen} from './src/screens/MessagesScreen';
import {PreferencesScreen} from './src/screens/PreferencesScreen';
import {PasskeysScreen} from './src/screens/PasskeysScreen';
import {LogScreen} from './src/screens/LogScreen';
import {AdvancedScreen} from './src/screens/AdvancedScreen';
import {TestingScreen} from './src/screens/TestingScreen';

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
const TABS = [
  'This Key',
  'Slots',
  'Keys',
  'Bluetooth',
  'Backup',
  'Crypto',
  'Messages',
  'Settings',
  'Advanced',
  'Passkeys',
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
type Tab = (typeof TABS)[number] | typeof TESTING_TAB;

/** Splash until the device can answer, then a door, then the app. */
type Phase = 'splash' | 'login' | 'pin' | 'setup' | 'main';

/*
 * The provider has to sit ABOVE whatever reads insets, so the shell is its own
 * component - a hook inside App would be reading a provider that is its own
 * child, and would get zeros.
 */
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
  useEffect(() => {
    if (!auto.ready || !on) return;
    if (!published && !btk.busy) void btk.publish();
    if (!advertising && fido.supported !== false) void fido.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto.ready, on, published, advertising]);

  const color = (enabled: boolean, connected: boolean) =>
    connected ? theme.ok : enabled ? theme.accentHover : theme.textDim;

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel="Bluetooth status"
      style={({pressed}) => [styles.barMid, pressed && styles.pressed]}>
      <Text style={[styles.barIcon, {color: color(on, linked)}]}>{'ᛒ'}</Text>
      <Text style={[styles.barIcon, {color: color(published, linked)}]}>
        {'⌨'}
      </Text>
      <Text
        style={[styles.barIcon, {color: color(advertising, fido.state === 'connected')}]}>
        {'⚿'}
      </Text>
    </Pressable>
  );
}

export default function App() {
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

  /*
   * FORCED CAPABILITIES, scoped to whichever key is active.
   *
   * Detection cannot see an unsigned working-tree build - it reports the same
   * version string as the release it is ahead of - so this is the manual way
   * to tell the app what the wire cannot. src/capabilityOverride.ts explains
   * the whole of it, including why it is built to be deleted.
   *
   * Named `caps` rather than `override`, which is taken twice already: useKey
   * has one for forcing WHICH KEY is active, and AdvancedScreen has another
   * for the console probe.
   */
  /*
   * FOR THE HARD KEY ONLY. The soft key's firmware is staged by this build, so
   * buildInfo.unreleased already tells capabilities() what it needs and there
   * is nothing to override. See src/capabilityOverride.ts.
   */
  const caps = useCapabilityOverrides();

  /*
   * A HARD KEY'S OVERRIDE DIES WITH THE KEY.
   *
   * useHardKey drops its capabilities to null on detach and on disconnect
   * (useHardKey.ts:146,159). A physical key can be unplugged and a DIFFERENT
   * one plugged in, so an override that outlived the first would quietly claim
   * the second supports something it does not - worse than the faded section
   * it was set to fix. Re-arm it after the next unlock, which is when the app
   * knows which key it is talking to again.
   */
  useEffect(() => {
    if (keys.backend === 'embedded') return;
    if (!keys.hard?.capabilities) caps.clear();
  }, [keys.backend, keys.hard?.capabilities, caps]);
  backendRef.current = keys.backend;
  unlockedRef.current = keys.key.device === 'unlocked';
  const emu = keys.key;

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
      console.log(`[config] label probe failed: ${String((e as Error)?.message ?? e)}`);
    } finally {
      setChecking(false);
    }
  }, [getActiveKey, emu]);

  const [tab, setTab] = useState<Tab>('This Key');

  /*
   * The slot being edited, if any.
   *
   * Held here rather than inside SlotsScreen because the editor is a FULL
   * SCREEN with a back arrow, not a sheet - there is too much in a slot for a
   * modal on a phone - so it replaces the body and the drawer alike.
   */
  const [openSlot, setOpenSlot] = useState<{id: string; index: number} | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [phase, setPhase] = useState<Phase>('splash');

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
      if (prev === 'splash' && emu.state !== 'stopped' && emu.state !== 'starting') {
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
  }, [testing.enabled, emu.device, emu.state, configMode]);

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
      <StatusBar barStyle="light-content" />
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

        {/* `__DEV__` inline so Metro folds the branch out of a release bundle. */}
        {__DEV__ && testing.enabled ? (
          <View style={styles.testing}>
            <Text style={styles.testingText}>
              Testing mode — PIN bypassed, developer tools shown
            </Text>
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
          <View style={styles.testing}>
            <Text style={styles.testingText}>
              The soft key has stopped — its firmware thread cannot be replaced
              in this process. Nothing is lost.
            </Text>
            <Btn title="Restart the app" tone="primary" onPress={() => OkEmu.restartApp()} />
          </View>
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

        <View style={styles.body} key={sessionEpoch}>
          {phase === 'splash' ? (
            <SplashScreen />
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
            <KeyScreen emu={emu} keys={keys} />
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
          ) : tab === 'Keys' ? (
            <KeysScreen emu={emu} configMode={configMode} overrides={caps.overrides} />
          ) : tab === 'Bluetooth' ? (
            <BluetoothScreen fido={fido} on={btOn} setOn={setBtOn} auto={auto} canPress={emu.canPress === true} testing={testing.enabled} />
          ) : tab === 'Backup' ? (
            <BackupScreen emu={emu} blockScreenshots={BLOCK_SCREENSHOTS} configMode={configMode} onWantConfigMode={() => setConfigMode(WANTED)} />
          ) : tab === 'Crypto' ? (
            <CryptoScreen emu={emu} blockScreenshots={BLOCK_SCREENSHOTS} configMode={configMode} overrides={caps.overrides} />
          ) : tab === 'Messages' ? (
            <MessagesScreen emu={emu} configMode={configMode} overrides={caps.overrides} />
          ) : tab === 'Settings' ? (
            <PreferencesScreen emu={emu} configMode={configMode} />
          ) : tab === 'Passkeys' ? (
            <PasskeysScreen emu={keys.key} configMode={configMode} />
          ) : tab === 'Advanced' ? (
            <AdvancedScreen emu={keys.key} hard={keys.hard} caps={caps} />
          ) : tab === 'Log' ? (
            <LogScreen
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
            />
          )}
        </View>

        <Drawer
          open={drawer && ready}
          tabs={__DEV__ && testing.enabled ? [...TABS, TESTING_TAB] : TABS}
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

const styles = StyleSheet.create({
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
