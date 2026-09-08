import React, {useEffect, useState} from 'react';
import {Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';

import {Btn, StatusPill} from './src/ui/components';
import {Drawer} from './src/ui/Drawer';
import {Logo} from './src/ui/Logo';
import {theme} from './src/ui/theme';

import {useLog} from './src/hooks/useLog';
import {useOkEmu} from './src/hooks/useOkEmu';
import {useUsbHid} from './src/hooks/useUsbHid';
import {useFidoGatt} from './src/hooks/useFidoGatt';
import {useTestingMode} from './src/hooks/useTestingMode';

import {SplashScreen} from './src/screens/SplashScreen';
import {LoginScreen} from './src/screens/LoginScreen';
import {PinScreen} from './src/screens/PinScreen';
import {SetupScreen} from './src/screens/SetupScreen';
import {KeyScreen} from './src/screens/KeyScreen';
import {FidoScreen} from './src/screens/FidoScreen';
import {LogScreen} from './src/screens/LogScreen';
import {TestingScreen} from './src/screens/TestingScreen';

const TABS = ['Key', 'Security', 'Log'] as const;
const TESTING_TAB = 'Testing' as const;
type Tab = (typeof TABS)[number] | typeof TESTING_TAB;

/** Splash until the device can answer, then a door, then the app. */
type Phase = 'splash' | 'login' | 'pin' | 'setup' | 'main';

/*
 * The provider has to sit ABOVE whatever reads insets, so the shell is its own
 * component - a hook inside App would be reading a provider that is its own
 * child, and would get zeros.
 */
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

  /*
   * Sessions are APP-SCOPED. Created inside a screen they died with it, so
   * switching views tore down every listener while the native thing carried on
   * running - the firmware kept going and the screen came back saying
   * "stopped", and the CTAP bridge stopped answering whenever you looked away.
   */
  const emu = useOkEmu({log: emuLog.log, autoStart: true});
  const fido = useFidoGatt({log: fidoLog.log});
  const hid = useUsbHid({log: usbLog.log});
  const testing = useTestingMode();

  const [tab, setTab] = useState<Tab>('Key');
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
    if (emu.device === 'unlocked') {
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
        return 'login';
      }
      return prev;
    });
  }, [testing.enabled, emu.device, emu.state]);

  const ready = phase === 'main';

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
    <>
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
            <StatusPill
              state={emu.device}
              label={emu.device === 'unknown' ? emu.state : emu.device}
            />
          </View>
        ) : null}

        {testing.enabled ? (
          <View style={styles.testing}>
            <Text style={styles.testingText}>
              Testing mode — PIN bypassed, developer tools shown
            </Text>
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
                A site is asking for a security key. This is the press it wants.
              </Text>
            </View>
            <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
          </View>
        ) : null}

        <View style={styles.body}>
          {phase === 'splash' ? (
            <SplashScreen />
          ) : phase === 'login' ? (
            <LoginScreen
              device={emu.device}
              onContinue={() =>
                // A blank key has no PIN to enter; it needs one chosen.
                setPhase(emu.device === 'uninitialized' ? 'setup' : 'pin')
              }
            />
          ) : phase === 'setup' ? (
            <SetupScreen onDone={() => setPhase('login')} />
          ) : phase === 'pin' ? (
            <PinScreen onPress={emu.press} onBack={() => setPhase('login')} />
          ) : tab === 'Key' ? (
            <KeyScreen emu={emu} />
          ) : tab === 'Security' ? (
            <FidoScreen fido={fido} />
          ) : tab === 'Log' ? (
            <LogScreen
              buffers={{
                Firmware: {entries: emuLog.entries, clear: emuLog.clear},
                CTAP: {entries: fidoLog.entries, clear: fidoLog.clear},
                USB: {entries: usbLog.entries, clear: usbLog.clear},
              }}
            />
          ) : (
            <TestingScreen
              emu={emu}
              hid={hid}
              usbEntries={usbLog.entries}
              clearUsb={usbLog.clear}
            />
          )}
        </View>

        <Drawer
          open={drawer && ready}
          tabs={testing.enabled ? [...TABS, TESTING_TAB] : TABS}
          value={tab}
          onChange={setTab}
          onClose={() => setDrawer(false)}
          footer={
            <Btn
              title={testing.enabled ? 'Leave testing mode' : 'Enter testing mode'}
              onPress={() => {
                testing.toggle();
                if (tab === TESTING_TAB) {
                  setTab('Key');
                }
              }}
            />
          }
        />
      </SafeAreaView>
    </>
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
