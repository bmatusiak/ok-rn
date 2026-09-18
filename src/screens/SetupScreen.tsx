import React, {useCallback, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import OkEmu from '../transport/OkEmu';
import {useActiveKey} from '../hooks/KeyContext';
import {Logo} from '../ui/Logo';
import {DuoPinForm} from '../ui/DuoPinForm';
import {Btn, LedCircle} from '../ui/components';
import {Keypad, QueueDots} from '../ui/Keypad';
import {theme} from '../ui/theme';

/** The firmware refuses anything outside this, and says so by name. */
const MIN_PIN = 7;
const MAX_PIN = 10;

/** A backup passphrase shorter than this is refused. */
const MIN_PASSPHRASE = 25;

/**
 * First-time setup: choosing the PIN a blank key will use, and what follows.
 *
 * THIS SCREEN IS A FORM. It collects the PIN twice, checks the two agree, and
 * then hands the whole thing to device.setPin(), which owns the bracket and
 * presses every digit itself. Nothing is pressed while someone is typing.
 *
 * ## Why a form, when the device has a keypad
 *
 * set_primary_pin is a state machine advanced by the MESSAGE, not by presses:
 *
 *   msg -> case 0   password.reset(), "OnlyKey is ready, enter your PIN"
 *          ...digits are pressed; the firmware appends each one...
 *   msg -> case 1   keeps what was pressed, "Successful PIN entry"
 *   msg -> case 2   "OnlyKey is ready, re-enter your PIN to confirm"
 *          ...the same digits again...
 *   msg -> case 3   password.evaluate(), commit, "Successfully set PIN"
 *
 * A press BEFORE the arming message is wiped by that reset, and a press after
 * the next one lands in the following pass - so a screen where someone types
 * live has to hold the bracket open under their finger and get every boundary
 * right. That version existed here, and its state was the source of its bugs.
 *
 * setPin already sends all four messages in order and waits on the device
 * between them; what it cannot know is how to press THIS device, so it takes
 * `enterDigits`. The soft key's is okemu_press_queue, which hands the firmware
 * a finished press rather than emulating a finger - about 96ms a digit against
 * 757-855ms sensed. Live typing was worth its complexity when a press took the
 * best part of a second; at 96ms the bracket runs faster than a person types.
 *
 * ## So the form compares the two passes, and the device never sees a mismatch
 *
 * This is a deliberate trade and it runs the other way from the hardware. On a
 * real key both passes go in on the key's own buttons and password.evaluate()
 * is the judge. Here the two strings are in the app, so it can say "those do
 * not match" without spending anything - and on hardware a mismatched bracket
 * costs a PIN ATTEMPT, of which there are ten before the key wipes itself.
 *
 * ## Why none of this needs the debug console
 *
 * Every prompt above is a hidprint, ungated, identical in all nine pinned
 * firmware versions. The Serial.println twins the library used to wait on are
 * inside `#ifdef DEBUG`, which is why setup worked in development and timed
 * out against every release (FINDING-provisioning-needs-a-debug-build.md).
 *
 * ## The rest of the wizard
 *
 * The desktop wizard is eleven steps, and five of them are "now press the same
 * thing again on the key" - on hardware each PIN is entered on the device's own
 * keypad, twice. Those five collapse into the two passes of this form, so what
 * is left is the three PINs the firmware distinguishes and the backup
 * passphrase:
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

/** How a kind is named in the closing summary, rather than by its type name. */
const SUMMARY: Record<Kind, string> = {
  primary: 'the main PIN',
  secondary: 'a second profile',
  selfDestruct: 'self-destruct',
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
  onProvision,
  led,
}: {
  onDone?: () => void;
  model?: 'classic' | 'duo';
  mode?: 'setup' | 'change';
  /** In change mode, which PIN. */
  only?: Kind;
  /** In change mode, how to restart this key so config mode ends. */
  onRestart?: () => void;
  /**
   * COMMIT a collected PIN - the bracket and the presses both.
   *
   * useOkEmu.provision, which is device.setPin() with the soft key's own
   * presser. It is the same call 0-provision.e2e.js makes and asserts seven
   * progress steps against, so the wizard and the suite exercise one path.
   *
   * Nothing is pressed while someone is typing; see the header.
   */
  onProvision: (
    pin: string,
    opts?: {kind?: Kind},
  ) => Promise<boolean | void> | boolean | void;
  /**
   * The key's own LED, packed 0x00RRGGBB per pixel.
   *
   * Shown while the bracket runs, because the firmware narrates setup through
   * the light and has no other channel on a production build.
   */
  led?: number[];
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();

  const [kind, setKind] = useState<Kind>(mode === 'change' ? (only ?? 'primary') : 'primary');
  const [stage, setStage] = useState<Stage>('choose');
  /*
   * JUST THE PRIMARY PIN, which is the desktop's "advanced setup" toggle
   * inverted (app.html:68 hides the second-profile and self-destruct PINs
   * unless it is ticked). This wizard always asked for all three, so
   * setting up a key meant choosing, confirming and remembering three PINs
   * before it could be used once - and two of them are for situations most
   * people will never be in.
   *
   * Neither is lost by skipping: both can be set later from Settings, in
   * config mode, which is the path a key that already has a PIN has to take
   * anyway. Only in setup mode - a change-PIN visit asks for exactly the
   * one kind it was sent for.
   */
  const [simple, setSimple] = useState(true);
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [steps, setSteps] = useState<string[]>([]);
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);

  /** PIN kinds that have actually been committed, for the closing summary. */
  const [set, setSet] = useState<Kind[]>([]);

  const entered = stage === 'confirm' ? again : pin;
  const setEntered = stage === 'confirm' ? setAgain : setPin;

  /*
   * WHAT HAS BEEN TYPED, IN A REF, because a setState updater is not a place
   * to make decisions from.
   *
   * press() used to set a `counted` flag inside setEntered(prev => ...) and
   * then read it on the next line to decide whether to send the press. React
   * does not run that updater synchronously - it runs it in the render phase -
   * so `counted` was usually still false and THE PRESS WAS NEVER SENT. It
   * dropped digits at random: measured 1,2,3,5,1 reaching the firmware while
   * the screen counted all seven of 1234561, and the device then refused the
   * pass with "Error PIN is not between 7 - 10 digits".
   *
   * The ref updates synchronously, so a burst of taps decides against the
   * truth even when no render has happened between them. The state is for
   * drawing; this is for deciding.
   */
  const enteredRef = useRef('');

  /*
   * A TAP ADDS A DIGIT, and nothing else. The device is not pressed until the
   * whole PIN has been collected twice and setPin runs the bracket.
   *
   * The ref is what the tap decides against, because taps outrun renders:
   * React batches, so two taps in one render both computing from the same
   * captured string lose one, and seven taps counted three.
   */
  const press = useCallback(
    (button: number) => {
      setError(null);
      if (enteredRef.current.length >= MAX_PIN) return;
      enteredRef.current += String(button);
      setEntered(enteredRef.current);
    },
    [setEntered],
  );

  /*
   * A REAL DELETE, now that a tap is not a press.
   *
   * This was "Fix count" and could only correct what was drawn - the device
   * already had the press and the firmware's PIN buffer cannot be cleared
   * except by running it to its rollover. Nothing has left the app yet, so a
   * wrong digit can simply be taken back.
   */
  const back = useCallback(() => {
    setError(null);
    enteredRef.current = enteredRef.current.slice(0, -1);
    setEntered(enteredRef.current);
  }, [setEntered]);

  /** Start collecting the next PIN, or move on when there are none left. */
  const advance = useCallback((from: Kind) => {
    setPin('');
    setAgain('');
    enteredRef.current = '';
    setSteps([]);
    setError(null);

    /* One PIN was asked for; the rest of the wizard is not this visit. */
    if (mode === 'change') {
      setStage('done');
      return;
    }
    const next = simple ? undefined : KINDS[KINDS.indexOf(from) + 1];
    if (next) {
      setKind(next);
      setStage('choose');
    } else {
      setStage('passphrase');
    }
  }, [mode, simple]);

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
        /*
         * THE WHOLE BRACKET, in one call, pressing the digits itself.
         *
         * Seven progress steps on a classic key, the last of which is the
         * device answering "Successfully set PIN" - which it prints AFTER the
         * nonce, two Curve25519 evaluations and the flash write, so it is the
         * only one of them that means the PIN is actually stored.
         * 0-provision.e2e.js asserts exactly that count.
         */
        await onProvision(digits, {kind});
        setSet(prev => [...prev, kind]);
        advance(kind);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        setStage('failed');
      } finally {
        off?.();
      }
    },
    [getKey, kind, advance, onProvision],
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
      /* Nothing has been sent; the first pass is just kept and asked again. */
      setAgain('');
      enteredRef.current = '';
      setError(null);
      setStage('confirm');
      return;
    }
    /*
     * THE APP IS THE JUDGE HERE, and that is the point of asking twice.
     *
     * On hardware both passes go in on the key's own buttons and
     * password.evaluate() decides - but a mismatch there costs a PIN ATTEMPT,
     * and a key wipes itself after ten. Both strings are sitting in this
     * screen, so it can refuse for free and the device is only ever handed a
     * PIN that has already been typed the same way twice.
     */
    if (again !== pin) {
      setError('Those two do not match. The second entry has been cleared — try it again.');
      setAgain('');
      enteredRef.current = '';
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

  /*
   * BACK TO THE BEGINNING, and that means the kind too.
   *
   * This used to reset the stage and the two strings but leave `kind` on
   * whichever PIN had just failed, so "Start over" after a failure on, say,
   * the self-destruct PIN reopened the pad still collecting a self-destruct
   * PIN, with the heading to match and no way back to the primary one.
   */
  const startOver = useCallback(() => {
    setPin('');
    setAgain('');
    enteredRef.current = '';
    setSteps([]);
    setError(null);
    setKind(mode === 'change' ? (only ?? 'primary') : 'primary');
    setStage('choose');
  }, [mode, only]);

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
            {/*
              * Zero is reachable - skip the self-destruct PIN on a change
              * visit, or set only a passphrase - and used to render as
              * "0 PINs are set: ." Kind names are spelled the way the screen
              * spelled them while asking, not as `selfDestruct`.
              */}
            <Text style={styles.hint}>
              {set.length === 0
                ? 'No PIN was changed.'
                : set.length === 1
                  ? 'A PIN is set.'
                  : `${set.length} PINs are set: ${set.map(k => SUMMARY[k]).join(', ')}.`}
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
            : 'Type the same one again. If the two do not match, nothing is sent to the key.'}
        </Text>
        {stage === 'choose' ? (
          <Text style={styles.blurb}>{BLURB[kind]}</Text>
        ) : null}

        {stage === 'choose' && mode === 'setup' && kind === 'primary' ? (
          <View style={styles.action}>
            <View style={styles.cell}>
              <Btn
                title="Just this one"
                tone={simple ? 'primary' : 'default'}
                onPress={() => setSimple(true)}
              />
            </View>
            <View style={styles.cell}>
              <Btn
                title="All three PINs"
                tone={simple ? 'default' : 'primary'}
                onPress={() => setSimple(false)}
              />
            </View>
          </View>
        ) : null}
        {stage === 'choose' && mode === 'setup' && kind === 'primary' ? (
          <Text style={styles.blurb}>
            {simple
              ? 'A second profile and a self-destruct PIN can be added later from Settings. Most keys never need either.'
              : 'You will be asked for a second-profile PIN and a self-destruct PIN as well.'}
          </Text>
        ) : null}

        <View style={styles.dots}>
          {/*
            * THE KEY'S OWN LIGHT, above the dots it is narrating.
            *
            * On a production firmware this is the only thing that reports
            * progress - the prompts the library used to read are compiled out
            * - so it is what tells someone the first pass landed and the
            * device is waiting for the second.
            */}
          {led ? (
            <View style={styles.ledRow}>
              <LedCircle pixels={led} />
            </View>
          ) : null}
          {/*
            * ONE DOT PER DIGIT TYPED, which is what the row can honestly mean
            * now. It was the depth of the press QUEUE - growing as taps went
            * in, draining as each press reached the device - because a tap was
            * a press and took the best part of a second to land. Nothing
            * leaves the app while someone is typing any more, so there is no
            * queue to draw, and a filled dot is simply a digit.
            */}
          <QueueDots count={entered.length} />
          <Text style={styles.count}>
            {entered.length === 0
              ? 'No presses yet'
              : `${entered.length} press${entered.length === 1 ? '' : 'es'}` +
                (entered.length < MIN_PIN
                  ? ` — ${MIN_PIN - entered.length} more needed`
                  : '')}
          </Text>
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <View style={styles.pad}>
          {/* Always live. Nothing is sent from here, so there is nothing to wait for. */}
          <Keypad onPress={press} />
        </View>

        <View style={styles.action}>
          <View style={styles.cell}>
            <Btn title="Delete" disabled={!entered.length} onPress={back} />
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
  count: {color: theme.textDim, fontSize: 13, textAlign: 'center', marginTop: 8},
  ledRow: {alignItems: 'center', marginBottom: 12},
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
