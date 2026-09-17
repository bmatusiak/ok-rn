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
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import NativeCredProvider from '../../specs/NativeCredProvider';
import {Keypad} from '../ui/Keypad';
import {
  pressSoftKey,
  pressSoftKeyButton,
  readKeyState,
  runCredentialFlow,
  type StepStatus,
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

  /* The key is waiting for a finger; the flow is parked until one arrives. */
  const [presenceAsked, setPresenceAsked] = useState(false);
  const presenceResolve = useRef<(() => void) | null>(null);

  /* The key is locked; the flow is parked until the PIN goes in. */
  const [unlockAsked, setUnlockAsked] = useState<string | null>(null);
  const [digits, setDigits] = useState(0);
  const unlockResolve = useRef<(() => void) | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Guards double-run under StrictMode and any remount. */
  const started = useRef(false);

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

  const askPresence = useCallback(() => {
    setPresenceAsked(true);
    return new Promise<void>(resolve => {
      presenceResolve.current = resolve;
    });
  }, []);

  /*
   * The soft key has no pad to touch, so the button here IS the finger. It
   * presses on the person's behalf only when they say so - satisfying presence
   * automatically would make the soft key a different thing from the hard key
   * rather than a stand-in for it.
   */
  const doPress = useCallback(async () => {
    setPresenceAsked(false);
    try {
      await pressSoftKey();
    } catch {
      /* A hard key is pressed with a finger; there is nothing to call. */
    }
    presenceResolve.current?.();
    presenceResolve.current = null;
  }, []);

  const askUnlock = useCallback((state: string) => {
    setUnlockAsked(state);
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
    async (button: number) => {
      setDigits(n => n + 1);
      try {
        await pressSoftKeyButton(button);
      } catch {
        /* A hard key is pressed with a finger; there is nothing to call. */
      }

      if (checkTimer.current) {
        clearTimeout(checkTimer.current);
      }
      checkTimer.current = setTimeout(async () => {
        checkTimer.current = null;
        try {
          const state = await readKeyState();
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
    if (started.current) {
      return;
    }
    started.current = true;

    (async () => {
      try {
        const request = await NativeCredProvider.getPendingRequest();
        const json = await runCredentialFlow(
          request,
          emit,
          askPin,
          askPresence,
          askUnlock,
        );
        setDone(true);
        await NativeCredProvider.respond(json);
      } catch (e) {
        const message = String((e as Error)?.message ?? e);
        setError(message);
        /*
         * Told to the caller straight away rather than on a button: the sheet
         * is modal over Chrome, and leaving it sitting there with an error the
         * user must dismiss keeps the page blocked for no reason. The log stays
         * on screen for the moment before the activity closes, and the same
         * text is in logcat under the okcredprovider tag.
         */
        await NativeCredProvider.fail(message).catch(() => {});
      }
    })();
  }, [emit, askPin, askPresence, askUnlock]);

  return (
    <View style={styles.screen}>
      <Text style={styles.title}>OnlyKey</Text>
      <Text style={styles.subtitle}>
        {done ? 'Answered' : error ? 'Failed' : 'Talking to the key'}
      </Text>

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
            The key is {unlockAsked}. Enter your PIN on the keypad.
          </Text>
          <Text style={styles.detail}>
            {digits === 0
              ? 'Each tap is a real button press on the key. It unlocks itself the moment the PIN matches — there is no submit.'
              : `${digits} digit${digits === 1 ? '' : 's'} pressed`}
          </Text>
          <View style={styles.pad}>
            <Keypad onPress={onDigit} />
          </View>
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
            A security key signs because a person asked it to. Press the key to
            complete the ceremony.
          </Text>
          <View style={styles.buttons}>
            <Pressable style={[styles.button, styles.primary]} onPress={doPress}>
              <Text style={styles.buttonText}>Press the key</Text>
            </Pressable>
          </View>
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
            keyboardType="default"
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

      {!pinAsked && !presenceAsked && !unlockAsked && !done && !error && (
        <Pressable
          style={styles.button}
          onPress={() => {
            NativeCredProvider.fail('cancelled on the OnlyKey screen').catch(() => {});
          }}>
          <Text style={styles.buttonText}>Cancel</Text>
        </Pressable>
      )}
    </View>
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
  screen: {flex: 1, backgroundColor: '#0b1016', padding: 20},
  title: {color: '#e8eef5', fontSize: 22, fontWeight: '600'},
  subtitle: {color: '#8aa', fontSize: 14, marginBottom: 16},
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
