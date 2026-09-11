import React, {useCallback, useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Btn} from './components';
import {theme} from './theme';

/**
 * A DUO's PIN is TYPED, not pressed.
 *
 * The Classic captures digits from its own six buttons and the host only
 * brackets that; a DUO has three buttons and carries its PINs in the message
 * body (okcore.cpp:978 copies sixteen bytes out of it and hashes them by
 * strlen). So the keypad the Classic screens draw is the wrong control here:
 * this is a text field with a numeric keyboard, and the library encodes what
 * is typed (device.duoPin, pin.encodeDuoPins).
 *
 * WHICH DIGITS: any numeral 0-9, 7 to 16 of them - settled from the firmware,
 * which has no digit check on this path, and recorded on
 * pin.validateDuoPins. The two reference clients disagreed.
 *
 * Setup collects the primary PIN twice and an optional self-destruct PIN
 * twice, exactly the fields the desktop wizard collects; the secondary
 * profile has no PIN on a DUO ("Only primary pin used by OnlyKey DUO").
 */
export type DuoSetupPins = {pin: string; selfDestruct: string};

export function DuoPinForm({
  mode,
  busy = false,
  onUnlock,
  onSetup,
}: {
  mode: 'unlock' | 'setup';
  busy?: boolean;
  onUnlock?: (pin: string) => void;
  onSetup?: (pins: DuoSetupPins) => void;
}) {
  const [pin, setPin] = useState('');
  const [pinConfirm, setPinConfirm] = useState('');
  const [sd, setSd] = useState('');
  const [sdConfirm, setSdConfirm] = useState('');
  const [problems, setProblems] = useState<string[]>([]);

  const submit = useCallback(() => {
    if (mode === 'unlock') {
      /* Only the shape is checked here; a wrong PIN is the device's verdict. */
      const found = /^\d{7,16}$/.test(pin) ? [] : ['A DUO PIN is 7 to 16 numerals.'];
      setProblems(found);
      if (!found.length) onUnlock?.(pin);
      return;
    }
    const result = okdevice.pin.validateDuoPins({
      pin, pinConfirm, selfDestruct: sd, selfDestructConfirm: sdConfirm,
    });
    const found = [...result.primary, ...result.selfDestruct];
    setProblems(found);
    if (!found.length) onSetup?.({pin, selfDestruct: sd});
  }, [mode, pin, pinConfirm, sd, sdConfirm, onUnlock, onSetup]);

  const field = (
    value: string,
    onChange: (t: string) => void,
    placeholder: string,
  ) => (
    <TextInput
      value={value}
      onChangeText={t => onChange(t.replace(/\D/g, ''))}
      keyboardType="number-pad"
      secureTextEntry
      maxLength={16}
      placeholder={placeholder}
      placeholderTextColor={theme.textDim}
      editable={!busy}
      style={styles.input}
    />
  );

  return (
    <View style={styles.root}>
      <Text style={styles.hint}>
        {mode === 'unlock'
          ? 'A DUO takes its PIN typed: 7 to 16 numerals.'
          : 'Choose a PIN of 7 to 16 numerals, and optionally a self-destruct PIN that WIPES the key when entered.'}
      </Text>
      {field(pin, setPin, mode === 'unlock' ? 'PIN' : 'primary PIN')}
      {mode === 'setup' ? field(pinConfirm, setPinConfirm, 'primary PIN again') : null}
      {mode === 'setup' ? field(sd, setSd, 'self-destruct PIN (optional)') : null}
      {mode === 'setup' && sd ? field(sdConfirm, setSdConfirm, 'self-destruct PIN again') : null}
      {problems.map(p => (
        <Text key={p} style={styles.error}>{p}</Text>
      ))}
      <Btn
        title={busy ? 'Working…' : mode === 'unlock' ? 'Unlock' : 'Set the PIN'}
        tone="primary"
        disabled={busy || !pin}
        onPress={submit}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {gap: 10, alignSelf: 'stretch'},
  hint: {color: theme.textDim, fontSize: 13, lineHeight: 18, textAlign: 'center'},
  input: {
    backgroundColor: theme.surfaceAlt,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: theme.border,
    color: theme.text,
    fontFamily: theme.mono,
    fontSize: 18,
    paddingHorizontal: 12,
    paddingVertical: 10,
    textAlign: 'center',
  },
  error: {color: theme.error, fontSize: 12, textAlign: 'center'},
});
