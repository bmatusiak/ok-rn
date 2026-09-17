/**
 * The screen the system sheet launches when the user picks OnlyKey.
 *
 * EXPERIMENT - see REMOVAL.md. Registered as the root "OkRNCredProvider" in
 * index.js, rendered by CredProviderActivity.
 *
 * ## Why it is a running log rather than a tidy confirmation
 *
 * Chosen deliberately while the experiment is young: every CTAP step is shown
 * as it happens. When a registration fails against a relying party the useful
 * question is always WHICH step failed - opening the key, the PIN token, the
 * makeCredential itself, or assembling the response - and a spinner that says
 * "working" answers none of them. The screen can be quietened later; it cannot
 * be un-debugged later.
 *
 * ## The one thing this screen must never do
 *
 * Finish without answering. Chrome is blocked on a PendingIntent, and an
 * activity that simply closes leaves the page hanging until the framework times
 * it out. Every exit path here goes through respond() or fail().
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {SafeAreaProvider, SafeAreaView} from 'react-native-safe-area-context';
import NativeCredProvider from '../../specs/NativeCredProvider';
import {Keypad} from '../ui/Keypad';
import {
  dropChannel,
  pressForPresence,
  pressKeyButton,
  readKeyState,
  runCredentialFlow,
  targetLabel,
  type StepStatus,
  type Target,
} from './flow';

type Step = {label: string; status: StepStatus; detail?: string};

export default function CredProviderScreen() {
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  /* The PIN prompt is a promise the flow awaits; these hold its resolver. */
  const [pinAsked, setPinAsked] = useState<{retries: number | null} | null>(null);
  const [pinValue, setPinValue] = useState('');
  const pinResolve = useRef<((pin: string) => void) | null>(null);

  /*
   * The key is waiting for a finger. NOT a promise the flow waits on - see
   * AskPresence in flow.ts. The panel is a prompt, and the ceremony completes
   * because the key was pressed, not because this screen said so.
   */
  const [presenceAsked, setPresenceAsked] = useState<Target | null>(null);

  /* The key is locked; the flow is parked until the PIN goes in. */
  const [unlockAsked, setUnlockAsked] = useState<{state: string; target: Target} | null>(null);
  const [digits, setDigits] = useState(0);
  const unlockResolve = useRef<(() => void) | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * Which key this attempt is using, and which one the person asked for.
   *
   * `force` is null until someone switches. The app cannot work out on its own
   * which key holds a credential - a credential it cannot see is precisely the
   * case where it has to ask - so switching is a person's decision and the
   * flow simply starts again on the other one.
   */
  const [target, setTarget] = useState<Target | null>(null);
  const [force, setForce] = useState<'usb' | 'embedded' | null>(null);
  const [runKey, setRunKey] = useState(0);

  const emit = useCallback((label: string, status: StepStatus, detail?: string) => {
    setSteps(prev => {
      const at = prev.findIndex(s => s.label === label);
      const next: Step = {label, status, detail};
      if (at < 0) {
        return [...prev, next];
      }
      // Same label twice means 'run' being resolved into 'ok'/'fail'; keep the
      // earlier detail when the later call did not supply one.
      const merged = [...prev];
      merged[at] = {...next, detail: detail ?? prev[at].detail};
      return merged;
    });
  }, []);

  const askPin = useCallback((retries: number | null) => {
    setPinAsked({retries});
    return new Promise<string>(resolve => {
      pinResolve.current = resolve;
    });
  }, []);

  const submitPin = useCallback(
    (value: string) => {
      setPinAsked(null);
      setPinValue('');
      pinResolve.current?.(value);
      pinResolve.current = null;
    },
    [],
  );

  const askPresence = useCallback((target: Target) => {
    setPresenceAsked(target);
  }, []);

  /*
   * The soft key has no pad to touch, so the button here IS the finger. It
   * presses on the person's behalf only when they say so - satisfying presence
   * automatically would make the soft key a different thing from the hard key
   * rather than a stand-in for it.
   */
  const doPress = useCallback(async (target: Target) => {
    try {
      await pressForPresence(target);
    } catch {
      /* A hard key is pressed with a finger; there is nothing to call. */
    }
    /*
     * The panel is NOT cleared here. It clears when the flow marks the touch
     * done, which is when the KEY answered - so a press that the firmware did
     * not accept leaves the prompt up instead of pretending it worked.
     */
  }, []);

  const askUnlock = useCallback((state: string, target: Target) => {
    setUnlockAsked({state, target});
    setDigits(0);
    return new Promise<void>(resolve => {
      unlockResolve.current = resolve;
    });
  }, []);

  /**
   * One PIN digit: a real button press on the key.
   *
   * There is no submit, because the firmware has no concept of one - it hashes
   * what it has after every press and announces UNLOCKED the moment it matches
   * (OnlyKey.ino:697). So the only way to know the PIN is complete is to ask
   * the key after the presses stop, which is what the debounce below is: a
   * digit typed 400ms after the last one cancels the pending question and asks
   * again later, so a seven-digit PIN costs one status read rather than seven.
   */
  const onDigit = useCallback(
    async (target: Target, button: number) => {
      setDigits(n => n + 1);
      try {
        await pressKeyButton(target, button);
      } catch {
        /* A hard key is pressed with a finger; there is nothing to call. */
      }

      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
      }
      checkTimer.current = setTimeout(async () => {
        checkTimer.current = null;
        try {
          const state = await readKeyState(target);
          if (state.state === 'unlocked') {
            setUnlockAsked(null);
            unlockResolve.current?.();
            unlockResolve.current = null;
          }
        } catch {
          /* Still locked, or busy. The next digit asks again. */
        }
      }, 400);
    },
    [],
  );

  /**
   * A key we cannot press unlocks without telling us, so ask.
   *
   * When the keypad is drawn, each digit schedules its own check and no polling
   * is needed. When it is not - a production key, pressed by a finger - nothing
   * in this app knows a digit happened, so the only way to notice the unlock is
   * to keep asking. One second is well under the time it takes to press seven
   * buttons, and this runs only while the unlock panel is up.
   */
  useEffect(() => {
    if (!unlockAsked || unlockAsked.target.canPress) {
      return;
    }
    let alive = true;
    const timer = setInterval(async () => {
      try {
        const state = await readKeyState(unlockAsked.target);
        if (alive && state.state === 'unlocked') {
          setUnlockAsked(null);
          unlockResolve.current?.();
          unlockResolve.current = null;
        }
      } catch {
        /* Busy or still locked; the next tick asks again. */
      }
    }, 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [unlockAsked]);

  /*
   * The touch prompt comes down when the key answers, not when a button is
   * tapped. Either kind of press - the on-screen one or a finger on real
   * hardware - ends the same way, with the flow marking the step done.
   */
  useEffect(() => {
    if (
      presenceAsked &&
      steps.some(step => step.label === 'touch the key' && step.status === 'ok')
    ) {
      setPresenceAsked(null);
    }
  }, [steps, presenceAsked]);

  /* A pending question outlives the screen otherwise. */
  useEffect(
    () => () => {
      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    /* A switch starts over, so nothing from the last key is left on screen. */
    setSteps([]);
    setError(null);
    setDone(false);
    setPinAsked(null);
    setPresenceAsked(null);
    setUnlockAsked(null);

    (async () => {
      try {
        const request = await NativeCredProvider.getPendingRequest();
        const json = await runCredentialFlow(
          request,
          emit,
          askPin,
          askPresence,
          askUnlock,
          {
            force: force ?? undefined,
            onTarget: chosen => {
              if (!cancelled) {
                setTarget(chosen);
              }
            },
          },
        );
        if (cancelled) {
          return;
        }
        setDone(true);
        await NativeCredProvider.respond(json);
      } catch (e) {
        if (cancelled) {
          return;
        }
        /*
         * A FAILURE DOES NOT CLOSE THE SHEET ANY MORE.
         *
         * It used to answer Chrome immediately, on the grounds that leaving a
         * modal sitting over a blocked page helps nobody. That was right until
         * there were two keys: the commonest failure is now "this key does not
         * hold that credential", and the fix for it is one tap on the other
         * key. Closing first would make the person start the whole ceremony
         * again from the browser.
         *
         * Cancel still answers, so Chrome is never left waiting by accident -
         * and the error is on screen and in logcat under okcredprovider either
         * way.
         */
        const message = String((e as Error)?.message ?? e);
        /*
         * A held CTAPHID channel survives a CTAP2 refusal - a wrong PIN, a
         * missing credential - and must be kept, or a run of failures would
         * allocate a channel each time and exhaust the firmware's ten. It does
         * NOT survive the transport going away, and reusing a dead one would
         * fail forever without ever trying to reopen.
         */
        if (/no CTAPHID reply|No open transport|endpoint|detached/i.test(message)) {
          dropChannel();
        }
        setError(message);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [emit, askPin, askPresence, askUnlock, force, runKey]);

  /** Start again on the other key. */
  const switchKey = useCallback(() => {
    setForce(prev => (prev === 'embedded' ? 'usb' : 'embedded'));
    setRunKey(n => n + 1);
  }, []);

  return (
    /*
     * KeyboardAvoidingView, not just a bottom-anchored View.
     *
     * The panels below are meant to sit at the bottom, and they did - under the
     * keyboard. android:windowSoftInputMode="adjustResize" is set on the
     * activity and is NOT enough on its own here: the app draws edge to edge,
     * so the window does not shrink when the IME opens and the PIN field, the
     * Cancel and the Unlock buttons were all off-screen with no way to reach
     * them. Measured on the bench.
     *
     * "padding" rather than "height" keeps the step log scrollable while the
     * keyboard is up, so the diagnostic list does not get squashed away at the
     * moment someone is being asked to trust it.
     */
    /*
     * ITS OWN SafeAreaProvider.
     *
     * This root is mounted by CredProviderActivity, not by App, so it inherits
     * nothing from the provider App.tsx sets up - and without one the header
     * drew straight over the status bar clock. A second provider is correct
     * rather than wasteful: these are two independent React roots that happen
     * to share a ReactHost.
     */
    <SafeAreaProvider>
      <SafeAreaView
        style={styles.screen}
        edges={['top', 'left', 'right', 'bottom']}>
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
      <Text style={styles.title}>OnlyKey</Text>
      {/*
        WHICH KEY, ABOVE THE FOLD.
        It was only ever in the "open key" step's detail line, and that is not
        where anyone looks - reported from the bench as "it says hard key over
        USB but I didn't see that right away". Two keys means the question
        "which one is this talking to" is asked on every single request.
      */}
      <View style={styles.headRow}>
        <Text style={styles.subtitle}>
          <Text style={styles.keyName}>
            {target ? targetLabel(target) : 'Finding a key'}
          </Text>
          {'  ·  '}
          {done ? 'Answered' : error ? 'Failed' : 'Talking to the key'}
        </Text>
        {!!target && (target.hard || target.hardOnBus) && !done && (
          <Pressable style={styles.switchBtn} onPress={switchKey}>
            <Text style={styles.switchText}>
              Use {target.hard ? 'Soft Key' : 'Hard key'}
            </Text>
          </Pressable>
        )}
      </View>

      <ScrollView style={styles.log} contentContainerStyle={styles.logInner}>
        {steps.map(step => (
          <View key={step.label} style={styles.row}>
            <Text style={[styles.mark, markStyle(step.status)]}>
              {step.status === 'ok' ? '✓' : step.status === 'fail' ? '✗' : '·'}
            </Text>
            <View style={styles.rowText}>
              <Text style={styles.label}>{step.label}</Text>
              {!!step.detail && <Text style={styles.detail}>{step.detail}</Text>}
            </View>
            {step.status === 'run' && <ActivityIndicator size="small" />}
          </View>
        ))}

        {!!error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>

      {!!unlockAsked && (
        <View style={styles.pinBox}>
          <Text style={styles.label}>
            The key is {unlockAsked.state}.{' '}
            {unlockAsked.target.canPress
              ? 'Enter your PIN on the keypad.'
              : "Enter your PIN on the key's own buttons."}
          </Text>
          <Text style={styles.detail}>
            {digits === 0
              ? 'It unlocks itself the moment the PIN matches — there is no submit.'
              : `${digits} digit${digits === 1 ? '' : 's'} pressed`}
          </Text>
          {/*
            No keypad for a key the app cannot press. The same rule the rest of
            the app follows (useHardKey.ts:34): a production key takes presses
            from a finger and nothing else, and drawing a pad that silently does
            nothing is worse than drawing none.
          */}
          {unlockAsked.target.canPress && (
            <View style={styles.pad}>
              <Keypad onPress={button => void onDigit(unlockAsked.target, button)} />
            </View>
          )}
          <View style={styles.buttons}>
            <Pressable
              style={styles.button}
              onPress={() => {
                NativeCredProvider.fail(
                  'the key was not unlocked on the OnlyKey screen',
                ).catch(() => {});
              }}>
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
          </View>
        </View>
      )}

      {presenceAsked && (
        <View style={styles.pinBox}>
          <Text style={styles.label}>The key is waiting for a touch</Text>
          <Text style={styles.detail}>
            {presenceAsked.canPress
              ? presenceAsked.hard
                ? 'Touch a button on the key, or press it from here.'
                : 'A security key signs because a person asked it to. Press the key to complete the ceremony.'
              : 'Touch any button on your OnlyKey to complete the ceremony.'}
          </Text>
          {presenceAsked.canPress && (
            <View style={styles.buttons}>
              <Pressable
                style={[styles.button, styles.primary]}
                onPress={() => void doPress(presenceAsked)}>
                <Text style={styles.buttonText}>Press the key</Text>
              </Pressable>
            </View>
          )}
        </View>
      )}

      {!!pinAsked && (
        <View style={styles.pinBox}>
          <Text style={styles.label}>
            This key has a FIDO PIN
            {pinAsked.retries === null ? '' : ` — ${pinAsked.retries} attempts left`}
          </Text>
          <TextInput
            style={styles.input}
            value={pinValue}
            onChangeText={setPinValue}
            secureTextEntry
            autoFocus
            /*
             * A number pad, because an OnlyKey's FIDO PIN is digits - the same
             * button numbers the key itself takes. The full QWERTY keyboard was
             * both wrong for the input and twice the height, which is what put
             * the field behind it in the first place.
             */
            keyboardType="number-pad"
            placeholder="PIN"
            placeholderTextColor="#667"
            onSubmitEditing={() => submitPin(pinValue)}
          />
          <View style={styles.buttons}>
            <Pressable style={styles.button} onPress={() => submitPin('')}>
              <Text style={styles.buttonText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.button, styles.primary]}
              onPress={() => submitPin(pinValue)}>
              <Text style={styles.buttonText}>Unlock</Text>
            </Pressable>
          </View>
        </View>
      )}

      {/*
        Cancel survives an error on purpose. Since a failure now leaves the
        sheet open so the other key can be tried, this is the only thing that
        answers Chrome - without it a failed attempt would strand the page
        until the framework's own timeout.
      */}
      {!pinAsked && !presenceAsked && !unlockAsked && !done && (
        <Pressable
          style={styles.button}
          onPress={() => {
            NativeCredProvider.fail('cancelled on the OnlyKey screen').catch(() => {});
          }}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      )}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

function markStyle(status: StepStatus) {
  if (status === 'ok') {
    return {color: '#3ddc84'};
  }
  if (status === 'fail') {
    return {color: '#ff6b6b'};
  }
  return {color: '#8aa'};
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#0b1016'},
  fill: {flex: 1, padding: 20},
  title: {color: '#e8eef5', fontSize: 22, fontWeight: '600'},
  subtitle: {color: '#8aa', fontSize: 14, flexShrink: 1},
  keyName: {color: '#e8eef5', fontWeight: '600'},
  headRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  switchBtn: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: '#2b3a4a',
    marginLeft: 12,
  },
  switchText: {color: '#8fc7ff', fontSize: 12, fontWeight: '500'},
  log: {flex: 1},
  logInner: {paddingBottom: 12},
  row: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: 10},
  mark: {width: 20, fontSize: 15, lineHeight: 20},
  rowText: {flex: 1},
  label: {color: '#e8eef5', fontSize: 15},
  detail: {color: '#8aa', fontSize: 12, marginTop: 2},
  error: {color: '#ff6b6b', fontSize: 13, marginTop: 12},
  pinBox: {borderTopWidth: 1, borderTopColor: '#1d2630', paddingTop: 14},
  pad: {marginTop: 12},
  input: {
    backgroundColor: '#121a24',
    color: '#e8eef5',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
    marginTop: 10,
  },
  buttons: {flexDirection: 'row', justifyContent: 'flex-end', marginTop: 12},
  button: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#1d2630',
    marginLeft: 10,
    alignSelf: 'flex-end',
  },
  primary: {backgroundColor: '#2f6feb'},
  buttonText: {color: '#e8eef5', fontSize: 14, fontWeight: '500'},
});
