import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn} from '../ui/components';
import {Keypad, PinDots} from '../ui/Keypad';
import {Logo} from '../ui/Logo';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
import OkEmu from '../transport/OkEmu';

/** The firmware refuses anything outside this, and says so by name. */
const MIN_PIN = 7;
const MAX_PIN = 10;

type Stage = 'choose' | 'confirm' | 'applying' | 'done' | 'failed';

/**
 * First-time setup: choosing the PIN a blank key will use.
 *
 * THE DIGITS ARE NOT PRESSED ON THE DEVICE HERE, which is the difference from
 * the unlock pad. Unlocking is the device checking a PIN it already holds, so
 * every tap has to be a real button press. Setting one is a conversation: the
 * library walks a six-step bracket with the firmware - arm, send, store,
 * confirm, resend, commit - and sends the digits itself. So this pad only
 * collects them.
 *
 * It asks twice on purpose. The firmware's own confirm step is answered by the
 * library with the same digits it already sent, so a typo would be confirmed
 * against itself and committed happily. The only place a mistyped PIN can be
 * caught is here, before any of it starts.
 */
export function SetupScreen({onDone}: {onDone?: () => void}) {
  const [stage, setStage] = useState<Stage>('choose');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const entered = stage === 'confirm' ? again : pin;
  const setEntered = stage === 'confirm' ? setAgain : setPin;

  const press = useCallback(
    (button: number) => {
      if (entered.length >= MAX_PIN) {
        return;
      }
      setError(null);
      setEntered(entered + String(button));
    },
    [entered, setEntered],
  );

  const back = useCallback(() => {
    setError(null);
    setEntered(entered.slice(0, -1));
  }, [entered, setEntered]);

  const apply = useCallback(
    async (digits: string) => {
      setStage('applying');
      setSteps([]);
      let off: (() => void) | undefined;
      try {
        const {device} = await getOnlyKey();
        off = device.on('progress', (e: {step: string}) =>
          setSteps(prev => [...prev, e.step]),
        );
        await device.setPin(digits);
        setStage('done');
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStage('failed');
      } finally {
        off?.();
      }
    },
    [],
  );

  const next = useCallback(() => {
    if (stage === 'choose') {
      setStage('confirm');
      setAgain('');
      return;
    }
    if (again !== pin) {
      setError('Those did not match. Try the second one again.');
      setAgain('');
      return;
    }
    void apply(pin);
  }, [again, apply, pin, stage]);

  if (stage === 'applying' || stage === 'done' || stage === 'failed') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.progress}>
        <Logo height={28} />
        <Text style={styles.title}>
          {stage === 'applying'
            ? 'Setting the PIN'
            : stage === 'done'
              ? 'Done'
              : 'That did not work'}
        </Text>

        <View style={styles.steps}>
          {steps.map((s, i) => (
            <Text key={i} style={styles.step}>
              {s}
            </Text>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {stage === 'done' ? (
          <>
            <Text style={styles.hint}>
              The key only reads its PIN when it boots, and its firmware cannot
              be restarted in this process — so the app has to start again
              before the new PIN means anything.
            </Text>
            <View style={styles.action}>
              <Btn
                title="Restart the app"
                tone="primary"
                onPress={() => OkEmu.restartApp()}
              />
            </View>
          </>
        ) : null}

        {stage === 'failed' ? (
          <View style={styles.action}>
            <Btn
              title="Start over"
              onPress={() => {
                setPin('');
                setAgain('');
                setSteps([]);
                setError(null);
                setStage('choose');
              }}
            />
            {onDone ? <Btn title="Cancel" onPress={onDone} /> : null}
          </View>
        ) : null}
      </ScrollView>
    );
  }

  const ready = entered.length >= MIN_PIN;

  return (
    <View style={styles.root}>
      <View style={styles.centre}>
        <Logo height={28} />

        <Text style={styles.title}>
          {stage === 'choose' ? 'Choose a PIN' : 'Enter it again'}
        </Text>
        <Text style={styles.hint}>
          {stage === 'choose'
            ? `${MIN_PIN} to ${MAX_PIN} presses. There is no keyboard on a key — a PIN is a sequence of its buttons.`
            : 'So a slip cannot be committed twice.'}
        </Text>

        <View style={styles.dots}>
          <PinDots count={entered.length} max={MAX_PIN} />
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.pad}>
          <Keypad onPress={press} />
        </View>

        <View style={styles.action}>
          <View style={styles.cell}>
            <Btn title="Back" disabled={!entered.length} onPress={back} />
          </View>
          <View style={styles.cell}>
            <Btn
              title={stage === 'choose' ? 'Next' : 'Set the PIN'}
              tone="primary"
              disabled={!ready}
              onPress={next}
            />
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  centre: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  progress: {alignItems: 'center', paddingVertical: 40},
  title: {color: theme.text, fontSize: 21, fontWeight: '700', marginTop: 24},
  hint: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: 6,
    maxWidth: 300,
  },
  dots: {marginTop: 20, marginBottom: 18},
  error: {color: theme.error, fontSize: 12, textAlign: 'center', marginBottom: 10, maxWidth: 300},
  pad: {width: '100%', maxWidth: 320},
  action: {flexDirection: 'row', gap: 10, marginTop: 20, width: '100%', maxWidth: 320},
  cell: {flex: 1},
  steps: {marginTop: 18, alignItems: 'center'},
  step: {color: theme.textDim, fontSize: 12, fontFamily: theme.mono, marginTop: 2},
});
