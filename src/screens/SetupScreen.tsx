import React, {useCallback, useEffect, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import OkEmu from '../transport/OkEmu';
import {useActiveKey} from '../hooks/KeyContext';
import {Logo} from '../ui/Logo';
import {DuoPinForm} from '../ui/DuoPinForm';
import {Btn, LedCircle} from '../ui/components';
import {Keypad, QueueDots} from '../ui/Keypad';
import {usePressQueue} from '../hooks/usePressQueue';
import {theme} from '../ui/theme';

/** The firmware refuses anything outside this, and says so by name. */
const MIN_PIN = 7;
const MAX_PIN = 10;

/** A backup passphrase shorter than this is refused. */
const MIN_PASSPHRASE = 25;

/**
 * First-time setup: choosing the PIN a blank key will use, and what follows.
 *
 * MODELLED ON OnlyKey-App's WIZARD, because that is the app that has always
 * done this. Its Step2/Step3 send an OKSETPIN at each boundary and the person
 * presses the key in between (OnlyKeyWizard.js:171-190); the host never sends
 * a digit. This screen is the same shape, with the phone's own buttons.
 *
 * ## Entry is only open between the messages, and that governs everything
 *
 * set_primary_pin is a state machine advanced by the MESSAGE, not by presses:
 *
 *   msg -> case 0   password.reset(), "OnlyKey is ready, enter your PIN"
 *          ...the person presses; the firmware appends each one...
 *   msg -> case 1   keeps what was pressed, "Successful PIN entry"
 *   msg -> case 2   "OnlyKey is ready, re-enter your PIN to confirm"
 *          ...the person presses again...
 *   msg -> case 3   password.evaluate(), commit, "Successfully set PIN"
 *
 * So a press BEFORE the arming message is wiped by that reset, and a press
 * after the next one lands in the following pass. The pad is therefore
 * disabled until arming has been answered, and the advance button is disabled
 * while any press is still in flight - the queue's depth is drawn as the dots.
 *
 * ## Two things this screen does NOT do
 *
 * It does not send the digits. A first version pressed them and sent no
 * messages at all, which left the firmware parked at case 0 with nothing ever
 * stored; a second collected them and let device.setPin() press the lot, which
 * works but is not how anyone types a PIN.
 *
 * It does not compare the two passes. Both are in the device and
 * password.evaluate() is what decides; comparing our own strings would only
 * check that the screen counted the same taps twice, and would disagree with
 * the device the moment a press was dropped.
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
  onPress,
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
   * Press a button ON THE DEVICE - the same handler the unlock pad uses.
   *
   * A tap here is a real press, because the device is where a PIN is typed.
   * See the header: entry is only open between the bracket's messages, and
   * this screen is what opens and closes it.
   */
  onPress: (button: number) => Promise<void> | void;
  /**
   * The key's own LED, packed 0x00RRGGBB per pixel.
   *
   * It is not decoration here, it is the ONLY progress this screen has. The
   * firmware narrates setup through the light - it has no other channel on a
   * production build - so what it is doing between the two passes, and whether
   * it accepted them, is read off this and nowhere else.
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
   * A TAP HERE PRESSES THE DEVICE'S BUTTON, exactly as the unlock pad does.
   *
   * It used to only collect digits into a string, because the library sent
   * them afterwards over the debug console - and that console does not exist
   * on a firmware built the way it ships, so setup simply never worked on a
   * production build. See the header comment.
   *
   * The count kept here is for the dots and nothing else. What the firmware
   * holds is the presses, and it is the firmware that compares the two passes.
   */
  /*
   * COLLECTED HERE, PRESSED BY setPin - and the order is not a preference.
   *
   * The device only captures a PIN between the bracket's messages: case 0 of
   * set_primary_pin calls password.reset() as it arms, so anything pressed
   * before that message is wiped and anything pressed after the next one
   * lands in the following pass. This pad cannot know where in that bracket
   * the device is; setPin does, because it is the thing sending the messages.
   *
   * So a tap here is counted, and the digits are pressed - through the same
   * okemu_set_button the unlock pad uses - once entry is actually open. A
   * version of this screen pressed live and sent no messages at all, which
   * left the firmware parked at case 0 with nothing ever stored.
   *
   * Counted with the updater form because taps outrun renders: React batches,
   * so two taps in one render both computing from the same captured string
   * lose one, and seven taps counted three.
   */
  const {press: sendPress, pending} = usePressQueue(onPress);

  /*
   * OPEN THE DEVICE'S ENTRY BEFORE ANY DIGIT IS PRESSED.
   *
   * set_primary_pin case 0 calls password.reset() as it arms, so a press that
   * happens before this message is WIPED, and a press after the next message
   * lands in the following pass. The pad cannot be honest about a digit unless
   * the bracket is where the pad thinks it is - so the message that opens
   * entry is sent when the pad appears, and the pad is disabled until it has
   * been answered.
   *
   * Sent once per pass, keyed on the stage. Re-arming would reset the buffer
   * and silently discard everything already typed.
   */
  const [armed, setArmed] = useState(false);
  const armingFor = useRef<string | null>(null);

  useEffect(() => {
    if (stage !== 'choose' && stage !== 'confirm') return;
    /* 'choose' is opened by `armed`; 'confirm' by `confirming`. */
    const label = stage === 'choose' ? 'armed' : 'confirming';
    if (armingFor.current === `${kind}:${label}`) return;
    armingFor.current = `${kind}:${label}`;
    setArmed(false);
    /* A new pass, so the count starts again with the device's own buffer. */
    enteredRef.current = '';
    let alive = true;
    (async () => {
      try {
        const {device} = await getKey();
        await device.pinStep(label, {kind});
        if (alive) setArmed(true);
      } catch (e) {
        if (!alive) return;
        setError(String((e as Error)?.message ?? e));
        setStage('failed');
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, kind]);

  /*
   * A TAP PRESSES THE DEVICE, and is counted only so the screen can say how
   * many have gone in. Entry is open - `armed` or `confirming` has already
   * been sent - so the firmware is appending each press to its own buffer,
   * and that buffer is the only copy that matters.
   *
   * Counted with the updater form because taps outrun renders: React batches,
   * so two taps in one render both computing from the same captured string
   * lose one, and seven taps counted three.
   */
  const press = useCallback(
    (button: number) => {
      setError(null);
      if (enteredRef.current.length >= MAX_PIN) return;
      enteredRef.current += String(button);
      setEntered(enteredRef.current);
      /*
       * Counted and sent in the same breath. A disagreement either way puts
       * the screen out of step with the device, and the firmware's PIN buffer
       * cannot be cleared except by running it to its rollover.
       */
      sendPress(button);
    },
    [setEntered, sendPress],
  );

  /*
   * THERE IS NO UNDOING A PRESS. The device has it; this only corrects what is
   * drawn. Left in place because a miscount is worse than a wrong digit - the
   * firmware rejects a PIN of the wrong length outright - but it is deliberately
   * not called "delete", and the copy below says what it does.
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
         * THE LAST TWO STEPS. `matched` is what makes the device compare the
         * two passes and commit; it answers "Successfully set PIN" AFTER the
         * flash write, or refuses with "Error PINs Don't Match", and either
         * way that is the device's verdict rather than the screen's.
         *
         * `committed` has nothing left to wait for on the wire and is run for
         * its progress line, so the summary reads the same as the suite's.
         */
        void digits;
        await device.pinStep('matched', {kind});
        await device.pinStep('committed', {kind});
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
      /*
       * `stored` closes entry and makes the device keep what was pressed; the
       * effect above then sends `confirming`, which opens it again. Splitting
       * them that way keeps one rule: the message that OPENS a pass is sent by
       * whatever puts the pad on screen for that pass.
       */
      void (async () => {
        try {
          const {device} = await getKey();
          await device.pinStep('stored', {kind});
          setAgain('');
          setStage('confirm');
        } catch (e) {
          setError(String((e as Error)?.message ?? e));
          setStage('failed');
        }
      })();
      return;
    }
    /*
     * NO LOCAL COMPARISON. Both passes are in the device, and password.evaluate
     * is what decides whether they agree - comparing our own two strings would
     * only be checking that the screen counted the same taps twice, and would
     * disagree with the device the moment a press was dropped.
     */
    void apply(pin);
  }, [apply, getKey, kind, pin, stage]);

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
            * THE DOTS ARE THE QUEUE, not the PIN.
            *
            * One goes on as a button is tapped and comes off as that press
            * reaches the device, so typing fast makes the row GROW and then
            * drain. That is the only thing on screen that separates "the key
            * has my digits" from "my digits are still on their way" - a press
            * takes about 400ms, and a row that filled per tap claimed the work
            * was done the moment the finger lifted.
            *
            * How many have been entered is a different question, and it is
            * answered in words below rather than by the same row.
            */}
          <QueueDots count={pending} />
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
          {/*
            * DISABLED UNTIL ENTRY IS OPEN. Until the arming message has been
            * answered the firmware is not capturing, so a tap would be a press
            * the device discards while this screen counts it.
            */}
          <Keypad onPress={press} disabled={!armed} />
        </View>

        <View style={styles.action}>
          <View style={styles.cell}>
            <Btn title="Fix count" disabled={!entered.length} onPress={back} />
          </View>
          <View style={styles.cell}>
            <Btn
              title={stage === 'choose' ? 'Next' : 'Set the PIN'}
              tone="primary"
              /*
               * `pending` matters here: the last tap is still travelling to
               * the device when a fast finger reaches this button, and the
               * next message CLOSES entry - so advancing early leaves that
               * digit in the following pass, or in no pass at all.
               */
              disabled={!ready || pending > 0 || !armed}
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
