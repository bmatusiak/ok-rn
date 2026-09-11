import React, {useCallback, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import OkEmu from '../transport/OkEmu';
import {useActiveKey} from '../hooks/KeyContext';
import {Logo} from '../ui/Logo';
import {DuoPinForm} from '../ui/DuoPinForm';
import {Btn} from '../ui/components';
import {Keypad, PinDots} from '../ui/Keypad';
import {theme} from '../ui/theme';

/** The firmware refuses anything outside this, and says so by name. */
const MIN_PIN = 7;
const MAX_PIN = 10;

/** A backup passphrase shorter than this is refused. */
const MIN_PASSPHRASE = 25;

/**
 * First-time setup: choosing the PIN a blank key will use, and what follows.
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
 *
 * ## The rest of the wizard
 *
 * The desktop wizard is eleven steps, and five of them are "now press the same
 * thing again on the key" - on hardware each PIN is entered on the device's own
 * keypad, twice. That split is already handled above, so what is left is the
 * three PINs the firmware distinguishes and the backup passphrase:
 *
 *   primary        unlocks the key
 *   secondary      unlocks a second, separate profile
 *   selfDestruct   WIPES the key
 *
 * The passphrase is here rather than on the Backup screen because of when it is
 * allowed: OKSETPRIV is accepted in config mode OR on a device's first use
 * (okcore.cpp:452). During setup the second applies, so it can be set now
 * without the config-mode dance the Backup screen otherwise has to do.
 */

type Stage =
  | 'choose'
  | 'confirm'
  | 'applying'
  | 'passphrase'
  | 'done'
  | 'failed';

/** Which PIN is being collected. Order is the order they are offered in. */
type Kind = 'primary' | 'secondary' | 'selfDestruct';

const KINDS: Kind[] = ['primary', 'secondary', 'selfDestruct'];

const HEADING: Record<Kind, string> = {
  primary: 'Choose a PIN',
  secondary: 'Second profile PIN',
  selfDestruct: 'Self-destruct PIN',
};

const BLURB: Record<Kind, string> = {
  primary:
    'This unlocks the key, and it cannot be recovered. There is no reset that keeps what is on it.',
  secondary:
    'An optional second PIN that unlocks a separate set of slots on the same key. Most keys never need one.',
  selfDestruct:
    'Entering this PIN WIPES THE KEY — every slot, every private key — with no confirmation and nothing to undo.',
};

/**
 * On a DUO the whole PIN set travels in one OKSETPIN body - primary, the
 * (unused) secondary slot, self-destruct - each in a 16-byte slot behind a
 * 0xFF that means SET (pin.encodeDuoPins). No bracket, no presses, no
 * "enter it again" stage on the device: the form asks twice instead.
 */
/**
 * CHANGE MODE: one PIN on a key that already has one.
 *
 * The desktop offers Change Primary / Secondary / Self-Destruct PIN on an
 * initialized key; this screen only ever appeared on a blank one. The
 * firmware takes OKPIN on an initialized key only in config mode
 * (okcore.cpp:362-374, `!initcheck || configmode`), so the caller walks
 * that door first - PreferencesScreen does, with useConfigMode - and this
 * screen then runs the same bracket for the one kind asked for and stops:
 * no other kinds, no passphrase stage. Config mode ends only at a restart,
 * which the done view offers through `onRestart` (the app for the soft
 * key, the device for a hard one).
 */
export function SetupScreen({
  onDone,
  model = 'classic',
  mode = 'setup',
  only,
  onRestart,
}: {
  onDone?: () => void;
  model?: 'classic' | 'duo';
  mode?: 'setup' | 'change';
  /** In change mode, which PIN. */
  only?: Kind;
  /** In change mode, how to restart this key so config mode ends. */
  onRestart?: () => void;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();

  const [kind, setKind] = useState<Kind>(mode === 'change' ? (only ?? 'primary') : 'primary');
  const [stage, setStage] = useState<Stage>('choose');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** PIN kinds that have actually been committed, for the closing summary. */
  const [set, setSet] = useState<Kind[]>([]);

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

  /** Start collecting the next PIN, or move on when there are none left. */
  const advance = useCallback((from: Kind) => {
    setPin('');
    setAgain('');
    setSteps([]);
    setError(null);

    /* One PIN was asked for; the rest of the wizard is not this visit. */
    if (mode === 'change') {
      setStage('done');
      return;
    }
    const next = KINDS[KINDS.indexOf(from) + 1];
    if (next) {
      setKind(next);
      setStage('choose');
    } else {
      setStage('passphrase');
    }
  }, [mode]);

  const apply = useCallback(
    async (digits: string) => {
      setStage('applying');
      setSteps([]);
      let off: (() => void) | undefined;
      try {
        const {device} = await getKey();
        off = device.on('progress', (e: {step: string}) =>
          setSteps(prev => [...prev, e.step]),
        );
        await device.setPin(digits, {kind});
        setSet(prev => [...prev, kind]);
        advance(kind);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStage('failed');
      } finally {
        off?.();
      }
    },
    [getKey, kind, advance],
  );

  const setupDuo = useCallback(
    async ({pin: primary, selfDestruct}: {pin: string; selfDestruct: string}) => {
      setStage('applying');
      setSteps([]);
      try {
        const {device} = await getKey();
        const reply = await device.duoPin([primary, '', selfDestruct], {set: true});
        setSteps([`device: ${String(reply && (reply.text || reply)).trim().slice(0, 60)}`]);
        setSet(['primary', ...(selfDestruct ? ['selfDestruct' as Kind] : [])]);
        setStage(mode === 'change' ? 'done' : 'passphrase');
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStage('failed');
      }
    },
    [getKey, mode],
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

  const applyPassphrase = useCallback(async () => {
    setStage('applying');
    setSteps([]);
    setError(null);
    try {
      const {device} = await getKey();
      await device.setBackupPassphrase(passphrase);
      setPassphrase('');
      setStage('done');
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
      setStage('failed');
    }
  }, [getKey, passphrase]);

  const startOver = useCallback(() => {
    setPin('');
    setAgain('');
    setSteps([]);
    setError(null);
    setStage('choose');
  }, []);

  /* ---------------------------------------------------------- passphrase */

  if (stage === 'passphrase') {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.progress}>
        <Logo height={28} />
        <Text style={styles.title}>Backup passphrase</Text>
        <Text style={styles.hint}>
          A backup is encrypted under this, and the key will not produce one at
          all until it is set. The passphrase never reaches the device — only a
          key derived from it does — so this is the only copy of it.
        </Text>
        <Text style={styles.hint}>
          It is offered now because the key has not finished setup, and that is
          the one other time it is accepted. Afterwards it needs config mode,
          which only a restart leaves.
        </Text>
        <TextInput
          value={passphrase}
          onChangeText={setPassphrase}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={`at least ${MIN_PASSPHRASE} characters`}
          placeholderTextColor={theme.textDim}
          style={styles.input}
        />
        <Text style={styles.step}>
          {passphrase.length}/{MIN_PASSPHRASE}
        </Text>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        <View style={styles.action}>
          <View style={styles.cell}>
            <Btn title="Skip" onPress={() => setStage('done')} />
          </View>
          <View style={styles.cell}>
            <Btn
              title="Set it"
              tone="primary"
              disabled={passphrase.length < MIN_PASSPHRASE}
              onPress={applyPassphrase}
            />
          </View>
        </View>
      </ScrollView>
    );
  }

  /* ------------------------------------------------- applying/done/failed */

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
            <Text style={styles.step} key={i}>
              {s}
            </Text>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {stage === 'done' ? (
          <>
            <Text style={styles.hint}>
              {set.length === 1
                ? 'A PIN is set.'
                : `${set.length} PINs are set: ${set.join(', ')}.`}
            </Text>
            <Text style={styles.hint}>
              {mode === 'change'
                ? 'The key is in config mode until it restarts, and only reads its PIN when it boots — restart it to finish.'
                : 'The key only reads its PIN when it boots, and its firmware cannot be restarted in this process — so the app has to start again before the new PIN means anything.'}
            </Text>
            <View style={styles.action}>
              <Btn
                title={mode === 'change' && onRestart ? 'Restart the key' : 'Restart the app'}
                tone="primary"
                onPress={() => (mode === 'change' && onRestart ? onRestart() : OkEmu.restartApp())}
              />
            </View>
          </>
        ) : null}

        {stage === 'failed' ? (
          <View style={styles.action}>
            <Btn title="Start over" onPress={startOver} />
            {onDone ? <Btn title="Cancel" onPress={onDone} /> : null}
          </View>
        ) : null}
      </ScrollView>
    );
  }

  /* ----------------------------------------------------------- collecting */

  const ready = entered.length >= MIN_PIN;
  const optional = kind !== 'primary';

  if (model === 'duo') {
    return (
      <View style={styles.root}>
        <View style={styles.centre}>
          <Logo height={28} />
          <Text style={styles.title}>Set up this DUO</Text>
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {/* The applying/done/failed stages returned above, so this is never busy. */}
          <DuoPinForm mode="setup" onSetup={setupDuo} />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <View style={styles.centre}>
        <Logo height={28} />
        <Text style={styles.title}>
          {stage === 'choose' ? HEADING[kind] : 'Enter it again'}
        </Text>
        <Text style={styles.hint}>
          {stage === 'choose'
            ? `${MIN_PIN} to ${MAX_PIN} presses. There is no keyboard on a key — a PIN is a sequence of its buttons.`
            : 'So a slip cannot be committed twice.'}
        </Text>
        {stage === 'choose' ? (
          <Text style={styles.blurb}>{BLURB[kind]}</Text>
        ) : null}

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

        {/*
          * Only the primary PIN is required. The other two are offered because
          * the firmware has them, not because a key needs them - and a
          * self-destruct PIN nobody meant to set is worse than none at all.
          */}
        {optional && stage === 'choose' ? (
          <View style={styles.action}>
            <Btn title="Skip this one" onPress={() => advance(kind)} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  centre: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 4},
  progress: {padding: 24, gap: 12, alignItems: 'center'},

  title: {color: theme.text, fontSize: 22, fontWeight: '700', marginTop: 24},
  hint: {
    color: theme.textDim,
    fontSize: 12,
    lineHeight: 18,
    textAlign: 'center',
    maxWidth: 320,
  },
  blurb: {
    color: theme.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 320,
    marginTop: 6,
  },

  dots: {marginTop: 20, marginBottom: 20},
  pad: {width: '100%', maxWidth: 320},
  action: {flexDirection: 'row', gap: 10, marginTop: 18, width: '100%', maxWidth: 320},
  cell: {flex: 1},

  steps: {gap: 2, alignItems: 'center'},
  step: {color: theme.textDim, fontSize: 12, fontFamily: theme.mono},
  error: {color: theme.error, fontSize: 13, lineHeight: 20, textAlign: 'center'},

  input: {
    width: '100%',
    maxWidth: 320,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },
});
