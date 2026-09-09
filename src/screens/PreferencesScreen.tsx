import React, {useCallback, useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {getOnlyKey} from '../onlykey';
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

  const config = useConfigMode(emu.device);
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
