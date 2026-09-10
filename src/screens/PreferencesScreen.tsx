import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
import * as biometrics from '../biometrics';
import {useConfigMode} from '../hooks/useConfigMode';
import {PinScreen} from './PinScreen';
import type {EmuSession} from '../hooks/useOkEmu';

const {keystrokes} = okdevice;

/*
 * Settings, rendered from the library's own table.
 *
 * Every one of these is the same operation - OKSETSLOT on the global slot with
 * a field id and a byte - so the screen asks the library what there is rather
 * than repeating a list that already exists twice (here and in the firmware).
 *
 * THEY ARE WRITE-ONLY. No command reads a preference back, so this screen
 * cannot show what the key currently has, only change it. That is the same
 * shape as slots and it is stated rather than papered over with a control that
 * shows a default and implies it is the device's.
 *
 * AND THEY ARE NOT ALL EQUALLY WRITABLE. set_slot gates them field by field:
 * four need config mode and answer "Error not in config mode" otherwise, and
 * one is refused for ever once setup has finished. Presenting twelve identical
 * controls would present four that silently do nothing.
 */

/** Layouts the firmware in this build can actually type. */
function layoutOptions() {
  return keystrokes.layouts();
}

export function PreferencesScreen({emu}: {emu: EmuSession}) {
  const [bioStatus, setBioStatus] = useState<biometrics.BiometricStatus>('unavailable');
  const [bioStored, setBioStored] = useState(false);
  const [bioBusy, setBioBusy] = useState(false);
  const [bioError, setBioError] = useState<string | null>(null);
  const [pinToSave, setPinToSave] = useState('');

  /* Both asked WITHOUT prompting, so the section can render itself honestly. */
  const refreshBiometrics = useCallback(async () => {
    setBioStatus(await biometrics.status());
    try {
      setBioStored(await biometrics.has(biometrics.ALIAS.devicePin));
    } catch {
      setBioStored(false);
    }
  }, []);

  useEffect(() => {
    refreshBiometrics();
  }, [refreshBiometrics]);

  const savePin = useCallback(async () => {
    setBioBusy(true);
    setBioError(null);
    try {
      /*
       * NOT checked against the device. The app cannot ask whether a PIN is
       * correct without entering it, and entering a wrong one poisons a buffer
       * that cannot be cleared except by running it to its rollover. So this
       * saves what it is given, and a wrong PIN shows up as an unlock that does
       * not unlock - the same as typing it wrong.
       */
      await biometrics.store(
        biometrics.ALIAS.devicePin,
        pinToSave,
        'Save your PIN',
        'It is encrypted under a key only your biometric can use.',
      );
      setPinToSave('');
      await refreshBiometrics();
    } catch (e) {
      setBioError(String((e as Error)?.message ?? e));
    } finally {
      setBioBusy(false);
    }
  }, [pinToSave, refreshBiometrics]);

  const forgetPin = useCallback(async () => {
    setBioBusy(true);
    setBioError(null);
    try {
      await biometrics.forget(biometrics.ALIAS.devicePin);
      await refreshBiometrics();
    } catch (e) {
      setBioError(String((e as Error)?.message ?? e));
    } finally {
      setBioBusy(false);
    }
  }, [refreshBiometrics]);

  const [table, setTable] = useState<
    {
      name: string;
      label: string;
      max: number;
      unit?: string;
      requires: string;
      note?: string;
      bits?: Record<string, string>;
    }[]
  >([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const config = useConfigMode();
  const locked = emu.device !== 'unlocked';

  useEffect(() => {
    let cancelled = false;
    getOnlyKey()
      .then(({device}) => {
        if (!cancelled) setTable(device.preferences());
      })
      .catch(e => {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const apply = useCallback(
    async (name: string) => {
      const raw = values[name];
      if (raw === undefined || raw === '') {
        setError(`${name}: enter a value first.`);
        return;
      }
      setBusy(name);
      setError(null);
      setStatus(null);
      try {
        const {device} = await getOnlyKey();
        const result = await device.setPreference(name, Number(raw));
        setStatus(`${name}: ${result.response}`);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    },
    [values],
  );

  /* Config mode locks the key, so the PIN has to go back in. */
  if (config.entered && !config.ready) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Section title="Config mode">
          <Text style={styles.body}>
            The key locked itself on entering config mode. Enter your PIN to
            carry on.
          </Text>
        </Section>
        <PinScreen onPress={emu.press} />
      </ScrollView>
    );
  }

  const groups = [
    {
      title: 'Settings',
      note: 'These can be changed whenever the key is unlocked.',
      rows: table.filter(p => p.requires === 'always'),
    },
    {
      title: 'Advanced',
      note:
        'The firmware refuses these outside config mode, so the key has to be ' +
        'put into it first — which locks it, and ends only when the app is ' +
        'restarted.',
      rows: table.filter(p => p.requires === 'configMode'),
    },
    {
      title: 'Set during setup only',
      note:
        'The firmware accepts these only before setup is finished. On a key ' +
        'that is already provisioned they are refused, so they are shown for ' +
        'completeness rather than offered.',
      rows: table.filter(p => p.requires === 'firstUse'),
    },
  ];

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <Section title="Preferences">
        <Text style={styles.body}>
          The key does not report its settings, so this screen changes them
          without being able to show what they are now. A field left blank is
          not written.
        </Text>
      </Section>

      <Section title="Unlock with biometrics">
        <Text style={styles.body}>
          Save your PIN on this phone so unlocking is a fingerprint instead of
          seven taps. It is encrypted under a key in Android&apos;s Keystore
          that cannot be used without your biometric, so the saved value is
          unreadable to anything that can read this app&apos;s files.
        </Text>

        {/*
          The trade-off is STATED, not buried. This is not a preference like
          typing speed, and someone turning it on should be able to see what
          they are choosing.
        */}
        <Text style={styles.warn}>{biometrics.PIN_WARNING}</Text>

        {bioStatus !== 'available' ? (
          <Text style={styles.note}>
            {biometrics.STATUS_TEXT[bioStatus]}
          </Text>
        ) : bioStored ? (
          <>
            <Text style={styles.note}>
              A PIN is saved. Adding or removing a fingerprint on this phone
              clears it — deliberately, so a finger enrolled later cannot open
              what was saved before it.
            </Text>
            <Btn
              title={bioBusy ? 'Working…' : 'Forget the saved PIN'}
              tone="danger"
              disabled={bioBusy}
              onPress={forgetPin}
            />
          </>
        ) : (
          <>
            <Text style={styles.label}>PIN</Text>
            <TextInput
              value={pinToSave}
              onChangeText={setPinToSave}
              secureTextEntry
              keyboardType="number-pad"
              autoCapitalize="none"
              placeholder="the digits you press to unlock"
              placeholderTextColor={theme.textDim}
              style={styles.input}
            />
            <Btn
              title={bioBusy ? 'Waiting…' : 'Save the PIN behind my biometric'}
              tone="primary"
              disabled={bioBusy || pinToSave.length < 7}
              onPress={savePin}
            />
            <Text style={styles.note}>
              {pinToSave.length}/7 digits minimum
            </Text>
          </>
        )}
        {bioError ? <Text style={styles.error}>{bioError}</Text> : null}
      </Section>

      {status ? <Text style={styles.status}>{status}</Text> : null}
      {error ? <Text style={styles.error}>{error}</Text> : null}

      {groups.map(group => (
        <Section key={group.title} title={group.title}>
          <Text style={styles.note}>{group.note}</Text>

          {group.title === 'Advanced' && !config.ready ? (
            <>
              <Btn
                title={config.entering ? 'Holding…' : 'Enter config mode'}
                tone="primary"
                disabled={config.entering || locked}
                onPress={config.enter}
              />
              {config.error ? <Text style={styles.error}>{config.error}</Text> : null}
            </>
          ) : null}

          {group.rows.map(pref => (
            <PrefRow
              key={pref.name}
              pref={pref}
              value={values[pref.name] ?? ''}
              onChange={v => setValues(prev => ({...prev, [pref.name]: v}))}
              onApply={() => apply(pref.name)}
              busy={busy === pref.name}
              disabled={
                busy !== null ||
                locked ||
                pref.requires === 'firstUse' ||
                (pref.requires === 'configMode' && !config.ready)
              }
            />
          ))}
        </Section>
      ))}

      <Section title="Keyboard layout">
        <Text style={styles.note}>
          Which layout the key types in. Setting one this firmware does not
          have tables for makes the key type NOTHING AT ALL, with no error, so
          only the ones it can actually type are offered.
        </Text>
        <View style={styles.chips}>
          {layoutOptions()
            .filter(l => l.compiledIn)
            .map(l => (
              <Btn
                key={l.name}
                title={l.name.replace(/_/g, ' ').toLowerCase()}
                tone={values.keyboardLayout === String(l.id) ? 'primary' : 'default'}
                onPress={() =>
                  setValues(prev => ({...prev, keyboardLayout: String(l.id)}))
                }
              />
            ))}
        </View>
        <Text style={styles.note}>
          {layoutOptions().filter(l => l.compiledIn).length} of{' '}
          {layoutOptions().length} layouts are compiled into this build. Dvorak
          is one of them only because it shares the US table — a key set to it
          types US English, which is usable but not what was asked for.
        </Text>
        <Text style={styles.note}>
          Pick one above, then use the Keyboard layout field under Settings to
          write it.
        </Text>
      </Section>
    </ScrollView>
  );
}

function PrefRow({
  pref,
  value,
  onChange,
  onApply,
  busy,
  disabled,
}: {
  pref: {
    name: string;
    label: string;
    max: number;
    unit?: string;
    note?: string;
    bits?: Record<string, string>;
  };
  value: string;
  onChange: (v: string) => void;
  onApply: () => void;
  busy: boolean;
  disabled: boolean;
}) {
  return (
    <View style={styles.row}>
      <Text style={styles.label}>
        {pref.label}
        <Text style={styles.range}>
          {'  '}0–{pref.max}
          {pref.unit ? ` ${pref.unit}` : ''}
        </Text>
      </Text>
      {pref.note ? <Text style={styles.note}>{pref.note}</Text> : null}

      {/*
        * A BITMASK IS NOT A NUMBER TO TYPE. Each bit is a separate setting on a
        * different code path, and asking for "8" means asking someone to know
        * that bit 3 is what allows a derived key without a touch. The toggles
        * write the same single byte.
        */}
      {pref.bits ? (
        <View style={styles.bits}>
          {Object.entries(pref.bits).map(([bit, meaning]) => {
            const mask = 1 << Number(bit);
            const on = (Number(value) & mask) !== 0;
            return (
              <Btn
                key={bit}
                title={`${on ? '✓' : '–'}  ${meaning}`}
                tone={on ? 'primary' : 'default'}
                disabled={disabled}
                onPress={() =>
                  onChange(String((Number(value) || 0) ^ mask))
                }
              />
            );
          })}
        </View>
      ) : null}

      <View style={styles.rowControls}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="number-pad"
          placeholder="—"
          placeholderTextColor={theme.textDim}
          editable={!disabled}
          style={[styles.input, disabled && styles.inputDisabled]}
        />
        <Btn
          title={busy ? '…' : 'Set'}
          disabled={disabled || value === ''}
          onPress={onApply}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  /* A trade-off worth reading, not a passing note. */
  warn: {color: theme.warn, fontSize: 12, lineHeight: 18, marginTop: 10},
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},

  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  status: {color: theme.ok, fontSize: 13, lineHeight: 20},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  row: {gap: 6},
  rowControls: {flexDirection: 'row', alignItems: 'center', gap: 8},
  label: {color: theme.textSecondary, fontSize: 13},
  range: {color: theme.textDim, fontSize: 11, fontFamily: theme.mono},

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
  inputDisabled: {opacity: 0.4},

  chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
  bits: {gap: 6},
});
