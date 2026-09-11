import React, {useCallback, useEffect, useState} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Btn} from '../ui/components';
import {theme} from '../ui/theme';
import {useActiveKey} from '../hooks/KeyContext';
import {useKeyboardLayout} from '../hooks/useKeyboardLayout';
import {Segmented} from '../ui/components';
import type {EmuSession} from '../hooks/useOkEmu';
import NativeSecrets from '../../specs/NativeSecrets';
import {useSecureScreen} from '../hooks/useSecureScreen';

/*
 * One slot, in full.
 *
 * A FULL SCREEN AND NOT A SHEET. There are sixteen fields in a slot plus the
 * read action; a sheet on a phone would spend half its height on the sheet.
 *
 * THE EDITOR IS THE SLOT VIEW - there is no separate "view" screen - because
 * there is nothing to view until the key is asked. Labels are the only slot
 * data any client can read back; a url, username or password exists on the
 * device only as something it will TYPE. So the fields start empty and
 * "Read from key" is what fills them: it presses the slot's button, captures
 * the keystrokes in-process and decodes them.
 *
 * That is the one thing this app can do that the desktop app cannot, and it is
 * why the button says "read" rather than "refresh".
 */

/** Fields worth showing together, in the order someone fills them in. */
const GROUPS: {title: string; note?: string; fields: string[]}[] = [
  {
    title: 'Login',
    fields: ['label', 'url', 'username', 'password'],
  },
  {
    title: 'Typing',
    note:
      'Delays are in seconds and pause before the field that follows. ' +
      'Next-key values choose what is typed between fields: 1 is TAB, 2 is RETURN.',
    fields: [
      'delay1', 'nextKey1', 'delay2', 'nextKey2',
      'delay3', 'nextKey3', 'nextKey4', 'nextKey5',
      'typeSpeed',
    ],
  },
];

/**
 * How long a copied secret stays on the clipboard.
 *
 * Long enough to switch apps and paste, short enough that it is not still
 * there an hour later. The clearing happens natively so it survives a JS
 * reload; see specs/NativeSecrets.ts.
 */
const CLIPBOARD_TTL_MS = 45000;

/**
 * How long a revealed value stays on screen.
 *
 * Bounded rather than left to a toggle, because the failure mode of a
 * toggle is walking away from a phone showing a password. Long enough to
 * read one out or check it, short enough that it is gone before the screen
 * is put down.
 *
 * THE PLAN WANTED A DEVICE BUTTON PRESS HERE and the device cannot give one.
 * On an unlocked OnlyKey every press runs gen_press() and TYPES A SLOT
 * (OnlyKey.ino:936-941), so there is no press that means only "yes, I am
 * here" - asking for one would type a password into the keystroke stream
 * every time somebody wanted to look at a different one. See
 * FINDING-no-side-effect-free-confirmation-press.md.
 */
const REVEAL_MS = 15000;

/** Fields never shown in the clear until someone asks. */
const SECRET = new Set(['password', 'totpKey', 'yubikey']);

/*
 * THE FIELD TABLE IS THE LIBRARY'S. Each input takes its length and its
 * keyboard from slotConfig.SLOT_FIELDS rather than from a second list here:
 * a label is 16 characters and a URL 56 because the firmware says so, and a
 * digit field wants a numeric keyboard because it is one digit.
 */
const SPEC = okdevice.slotConfig.FIELD_BY_NAME as Map<string, {encoding: string; maxLength?: number}>;
const {ENCODING} = okdevice.slotConfig;

/**
 * Two-factor, as three shapes rather than three boxes.
 *
 * The reference apps show tfaType as free text where the device wants one of
 * two exact strings, totpKey as raw hex where every authenticator hands out
 * base32, and the Yubico credential as one box where it is three fields in
 * two encodings - and the desktop app's base32 decoder turns a bad character
 * into garbage hex silently. The library validates all three
 * (device.totpFields, device.yubikeyFields), so this asks for what a person
 * actually has and lets a bad secret fail BY NAME before anything is written.
 */
type TfaMode = 'none' | 'totp' | 'yubico';
const TFA_MODES: readonly TfaMode[] = ['none', 'totp', 'yubico'] as const;
const TFA_TITLE: Record<TfaMode, string> = {none: 'none', totp: 'TOTP', yubico: 'Yubico OTP'};

const LABELS: Record<string, string> = {
  label: 'Label',
  url: 'URL',
  username: 'Username',
  password: 'Password',
  tfaType: 'Two-factor type',
  totpKey: 'TOTP secret',
  yubikey: 'Yubikey secret',
  delay1: 'Delay before username',
  delay2: 'Delay before password',
  delay3: 'Delay before 2FA',
  nextKey1: 'After URL',
  nextKey2: 'After username',
  nextKey3: 'After password',
  nextKey4: 'Before username',
  nextKey5: 'Before 2FA',
  typeSpeed: 'Typing speed',
  totpSecret: 'TOTP secret (base32)',
  yubiPublicId: 'Yubico public id (modhex)',
  yubiPrivateId: 'Yubico private id (hex)',
  yubiSecretKey: 'Yubico secret key (hex)',
};

type Values = Record<string, string>;

export function SlotEditorScreen({
  slot,
  emu,
  onBack,
  blockScreenshots = true,
}: {
  slot: {id: string; index: number};
  /** The active key's handle - what presses the button for a read. */
  emu: EmuSession;
  onBack: () => void;
  /** Off in testing mode, where adb screenshots are the verification. */
  blockScreenshots?: boolean;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* What the key types in, remembered per key. See useKeyboardLayout. */
  const {layout} = useKeyboardLayout();

  const [values, setValues] = useState<Values>({});
  const [tfa, setTfa] = useState<TfaMode>('none');
  const [totpSecret, setTotpSecret] = useState('');
  const [yubi, setYubi] = useState({publicId: '', privateId: '', secretKey: ''});
  const [captured, setCaptured] = useState<string[] | null>(null);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState<null | 'reading' | 'saving'>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useSecureScreen(blockScreenshots);

  /**
   * Which button types this slot, and for how long.
   *
   * Not `slot.id[0]`, which was right only for a classic: a DUO's ids run to
   * '12b' over three buttons, so the first character of '12b' is button 1 where
   * the answer is button 3. slots.pressForSlot() is the inverse of the
   * firmware's own gen_press()/gen_hold(), and it needs the device type, so
   * this is asked rather than assumed.
   *
   * Null until the device has answered. The header says what it knows.
   */
  const [plan, setPlan] = useState<{button: number; band: string} | null>(null);

  useEffect(() => {
    let alive = true;
    getKey()
      .then(({device}) => {
        const p = okdevice.slots.pressForSlot(slot.id, {
          deviceType: device.deviceType,
        });
        if (alive) setPlan({button: p.button, band: p.band});
      })
      .catch(() => {
        if (alive) setPlan(null);
      });
    return () => {
      alive = false;
    };
  }, [getKey, slot.id]);

  useEffect(() => {
    /*
     * Everything resets when the slot changes. Leaving a captured password on
     * screen while the header says a different slot is the worst kind of wrong
     * - it is legible, plausible and someone else's.
     */
    setValues({});
    setCaptured(null);
    setRevealed(new Set());
    setStatus(null);
    setError(null);
  }, [slot.index]);

  const set = useCallback((name: string, text: string) => {
    setValues(v => ({...v, [name]: text}));
  }, []);

  /**
   * Ask the key to type this slot, and read what it typed.
   *
   * THE SEQUENCE IS THE LIBRARY'S. device.readSlot() works out which button
   * types this slot and for how long, waits for the typing to stop rather than
   * for a fixed time, and decodes and splits what came back. This screen used
   * to carry its own copy of all four, including a quiescence loop and a
   * hard-coded "a is a tap, b is a hold" that is only true on a classic.
   *
   * The press itself stays here, because pressing is the host's job - a JNI
   * call to the soft key here, a finger on a real one.
   */
  const readFromKey = useCallback(async () => {
    setBusy('reading');
    setError(null);
    setStatus(null);

    try {
      const {device} = await getKey();
      const read = await device.readSlot(slot.id, {
        /* The ACTIVE key's hold, not the emulator's. See useOkEmu.holdTicks. */
        press: (button: number, ticks: number) => emu.holdTicks(button, ticks),
        layout,
      });

      if (!read.reports) {
        setError(
          'The key typed nothing. An unlocked key types a slot when its button ' +
            'is pressed; if it has just finished a security-key ceremony it ' +
            'ignores presses for up to 20 seconds.',
        );
        return;
      }

      setCaptured(read.segments);
      setStatus(`Read ${read.segments.length} field(s) from slot ${slot.id}.`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, slot.id]);

  const save = useCallback(async () => {
    const dirty = Object.entries(values).filter(([, v]) => v !== '');
    setBusy('saving');
    setError(null);
    setStatus(null);
    try {
      const {device} = await getKey();
      /*
       * Encoded by the library, which THROWS on a bad base32 character or a
       * Yubico field of the wrong length - before a byte reaches the key.
       * The desktop app writes garbage hex in the same situation.
       */
      const toWrite: Record<string, unknown> = Object.fromEntries(dirty);
      if (tfa === 'totp' && totpSecret.trim()) {
        Object.assign(toWrite, device.totpFields(totpSecret));
      } else if (tfa === 'yubico' && (yubi.publicId || yubi.privateId || yubi.secretKey)) {
        Object.assign(toWrite, device.yubikeyFields(yubi));
      }
      if (!Object.keys(toWrite).length) {
        setStatus('Nothing to save.');
        return;
      }
      const applied = await device.setSlot(slot.id, toWrite);
      setStatus(`Saved ${applied.length} field(s).`);
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(null);
    }
  }, [getKey, slot.id, tfa, totpSecret, values, yubi]);

  /**
   * Wipe ONE field, or the whole slot. The library has had per-field wipe
   * (OKWIPESLOT with a field byte) since before this screen; the screen told
   * people to wipe the whole slot instead.
   */
  const wipe = useCallback(
    async (field: string | null) => {
      setBusy('saving');
      setError(null);
      setStatus(null);
      try {
        const {device} = await getKey();
        await device.wipeSlot(slot.id, field);
        setStatus(field ? `${LABELS[field] ?? field} wiped on the key.` : `Slot ${slot.id} wiped on the key.`);
        if (field) set(field, '');
        else setValues({});
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    },
    [getKey, slot.id],
  );

  /**
   * Copy a captured value, without the system announcing it.
   *
   * Android 13 shows a preview chip of whatever was copied, which would put a
   * password on screen that this editor has deliberately kept masked. The
   * native side sets ClipDescription.EXTRA_IS_SENSITIVE so the chip says
   * "Copied" and nothing else, and starts the timer that clears it again.
   */
  const copy = useCallback(async (value: string, what: string) => {
    try {
      const marked = await NativeSecrets.copySensitive(value, CLIPBOARD_TTL_MS);
      setStatus(
        `${what} copied — clears in ${Math.round(CLIPBOARD_TTL_MS / 1000)}s` +
          (marked ? '.' : '. This Android is too old to hide the paste preview.'),
      );
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    }
  }, []);

  const toggleReveal = useCallback((name: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  /*
   * Anything revealed goes back under after REVEAL_MS.
   *
   * One timer for the whole set rather than one each: revealing a second
   * field restarts the clock for both, which is what someone comparing two
   * values expects, and it cannot leak a field whose own timer was
   * cancelled by a re-render.
   */
  useEffect(() => {
    if (revealed.size === 0) return undefined;
    const timer = setTimeout(() => setRevealed(new Set()), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [revealed]);


  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <View style={styles.header}>
        <Pressable
          onPress={onBack}
          accessibilityRole="button"
          accessibilityLabel="Back to slots"
          style={({pressed}) => [styles.back, pressed && styles.backPressed]}>
          <Text style={styles.backText}>‹</Text>
        </Pressable>
        <View style={styles.headerText}>
          <Text style={styles.title}>Slot {slot.id}</Text>
          <Text style={styles.subtitle}>
            {plan
              ? `${plan.band === 'hold' ? 'Hold' : 'Tap'} button ${plan.button} to type this slot`
              : 'Asking the key which button types this slot…'}
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Btn
          title={busy === 'reading' ? 'Reading…' : 'Read from key'}
          tone="primary"
          disabled={busy !== null}
          onPress={readFromKey}
        />
        <Btn
          title={busy === 'saving' ? 'Saving…' : 'Save'}
          disabled={busy !== null}
          onPress={save}
        />
        <Btn title="Wipe slot" tone="danger" disabled={busy !== null} onPress={() => wipe(null)} />
      </View>

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {captured ? (
        <CapturedFields
          segments={captured}
          revealed={revealed}
          onToggle={toggleReveal}
          onCopy={copy}
        />
      ) : null}

      {GROUPS.map(group => (
        <View key={group.title} style={styles.group}>
          <Text style={styles.groupTitle}>{group.title}</Text>
          {group.note ? <Text style={styles.groupNote}>{group.note}</Text> : null}
          {group.fields.map(name => (
            <Field
              key={name}
              name={name}
              value={values[name] ?? ''}
              secret={SECRET.has(name)}
              revealed={revealed.has(name)}
              onToggle={() => toggleReveal(name)}
              onChange={text => set(name, text)}
              onWipe={() => wipe(name)}
            />
          ))}
        </View>
      ))}

      <View style={styles.group}>
        <Text style={styles.groupTitle}>Two-factor</Text>
        <Text style={styles.groupNote}>
          Entered after the password, if the slot has one. A TOTP secret is the
          base32 an authenticator app shows; a Yubico credential is the three
          values from the personalisation tool.
        </Text>
        <Segmented
          options={TFA_MODES.map(m => TFA_TITLE[m]) as readonly string[]}
          value={TFA_TITLE[tfa]}
          onChange={title => setTfa(TFA_MODES.find(m => TFA_TITLE[m] === title) ?? 'none')}
        />
        {tfa === 'totp' ? (
          <Field
            name="totpSecret"
            value={totpSecret}
            secret
            revealed={revealed.has('totpSecret')}
            onToggle={() => toggleReveal('totpSecret')}
            onChange={setTotpSecret}
            onWipe={() => wipe('totpKey')}
          />
        ) : null}
        {tfa === 'yubico' ? (
          <>
            <Field name="yubiPublicId" value={yubi.publicId} secret={false} revealed
              onToggle={() => {}} onChange={t => setYubi(y => ({...y, publicId: t}))} />
            <Field name="yubiPrivateId" value={yubi.privateId} secret revealed={revealed.has('yubiPrivateId')}
              onToggle={() => toggleReveal('yubiPrivateId')} onChange={t => setYubi(y => ({...y, privateId: t}))} />
            <Field name="yubiSecretKey" value={yubi.secretKey} secret revealed={revealed.has('yubiSecretKey')}
              onToggle={() => toggleReveal('yubiSecretKey')} onChange={t => setYubi(y => ({...y, secretKey: t}))}
              onWipe={() => wipe('yubikey')} />
          </>
        ) : null}
      </View>

      <Text style={styles.footer}>
        A field left blank is not written. Wipe clears one field on the key;
        Wipe slot clears all of them.
      </Text>
    </ScrollView>
  );
}

/**
 * What the key just typed, before anyone decides which field is which.
 *
 * The separators say where the boundaries are but NOT which field is which - a
 * slot with only a password produces one segment and so does a slot with only
 * a username. Guessing would put a username in a password box some of the time,
 * so the segments are shown as they came.
 */
function CapturedFields({
  segments,
  revealed,
  onToggle,
  onCopy,
}: {
  segments: string[];
  revealed: Set<string>;
  onToggle: (name: string) => void;
  onCopy: (value: string, what: string) => void;
}) {
  return (
    <View style={styles.captured}>
      <Text style={styles.groupTitle}>Read from the key</Text>
      <Text style={styles.groupNote}>
        The fields this slot types, in the order it typed them. Which is which
        depends on how the slot is configured, so they are shown as they came.
      </Text>
      {segments.map((segment, i) => {
        const name = `captured:${i}`;
        const show = revealed.has(name);
        return (
          <View key={name} style={styles.capturedRow}>
            <Text style={styles.capturedIndex}>{i + 1}</Text>
            <Text style={styles.capturedValue} numberOfLines={1}>
              {show ? segment : '•'.repeat(Math.min(segment.length, 24)) || '(empty)'}
            </Text>
            <Pressable
              onPress={() => onToggle(name)}
              accessibilityRole="button"
              accessibilityLabel={show ? `Hide field ${i + 1}` : `Reveal field ${i + 1}`}
              style={({pressed}) => [styles.reveal, pressed && styles.revealPressed]}>
              <Text style={styles.revealText}>{show ? 'Hide' : 'Reveal'}</Text>
            </Pressable>
            <Pressable
              onPress={() => onCopy(segment, `Field ${i + 1}`)}
              disabled={!segment}
              accessibilityRole="button"
              accessibilityLabel={`Copy field ${i + 1}`}
              style={({pressed}) => [
                styles.reveal,
                pressed && styles.revealPressed,
                !segment && styles.revealDisabled,
              ]}>
              <Text style={styles.revealText}>Copy</Text>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

function Field({
  name,
  value,
  secret,
  revealed,
  onToggle,
  onChange,
  onWipe,
}: {
  name: string;
  value: string;
  secret: boolean;
  revealed: boolean;
  onToggle: () => void;
  onChange: (text: string) => void;
  /** Clears this one field on the key. Absent for inputs that are not a device field. */
  onWipe?: () => void;
}) {
  const spec = SPEC.get(name);
  const numeric = spec?.encoding === ENCODING.DIGIT || spec?.encoding === ENCODING.BYTE;
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>
        {LABELS[name] ?? name}
        {spec?.maxLength ? ` · up to ${spec.maxLength}` : ''}
      </Text>
      <View style={styles.fieldRow}>
        <TextInput
          value={value}
          onChangeText={onChange}
          secureTextEntry={secret && !revealed}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={spec?.maxLength}
          keyboardType={numeric ? 'number-pad' : 'default'}
          placeholder="—"
          placeholderTextColor={theme.textDim}
          style={styles.input}
        />
        {onWipe ? (
          <Pressable
            onPress={onWipe}
            accessibilityRole="button"
            accessibilityLabel={`Wipe ${name}`}
            style={({pressed}) => [styles.reveal, pressed && styles.revealPressed]}>
            <Text style={styles.revealText}>Wipe</Text>
          </Pressable>
        ) : null}
        {secret ? (
          <Pressable
            onPress={onToggle}
            accessibilityRole="button"
            accessibilityLabel={revealed ? `Hide ${name}` : `Reveal ${name}`}
            style={({pressed}) => [styles.reveal, pressed && styles.revealPressed]}>
            <Text style={styles.revealText}>{revealed ? 'Hide' : 'Show'}</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  header: {flexDirection: 'row', alignItems: 'center', gap: 12},
  back: {
    width: 44,
    height: 44,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPressed: {backgroundColor: theme.surfaceAlt, borderColor: theme.accent},
  /* The glyph sits high in its line box; the offset centres it optically. */
  backText: {color: theme.text, fontSize: 30, lineHeight: 34, marginTop: -4},
  headerText: {flex: 1},
  title: {color: theme.text, fontSize: 20, fontWeight: '700'},
  subtitle: {color: theme.textDim, fontSize: 13, marginTop: 2},

  actions: {flexDirection: 'row', gap: 10},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  group: {
    gap: 12,
    padding: 14,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
  },
  groupTitle: {color: theme.text, fontSize: 16, fontWeight: '600'},
  groupNote: {color: theme.textDim, fontSize: 12, lineHeight: 18},

  captured: {
    gap: 10,
    padding: 14,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.accent,
    backgroundColor: theme.surface,
  },
  capturedRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  capturedIndex: {color: theme.textDim, fontSize: 12, fontFamily: theme.mono, width: 14},
  capturedValue: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    fontFamily: theme.mono,
  },

  field: {gap: 6},
  fieldLabel: {color: theme.textSecondary, fontSize: 12},
  fieldRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  input: {
    flex: 1,
    color: theme.text,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.inputBg,
  },

  reveal: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surfaceAlt,
  },
  revealPressed: {borderColor: theme.accent},
  revealDisabled: {opacity: 0.4},
  revealText: {color: theme.textSecondary, fontSize: 12},

  footer: {color: theme.textDim, fontSize: 12, lineHeight: 18},
});
