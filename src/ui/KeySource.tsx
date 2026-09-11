import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Btn, Section, Segmented} from './components';
import {theme} from './theme';
import type {KeyControl} from '../hooks/useKey';

/**
 * Which key the app is talking to, and how it decides.
 *
 * TWO DEVICES, NEVER MERGED. The soft key and a hard key answer the same
 * protocol, so every other screen is the same code either way - but they hold
 * different secrets, and this is the only control that says which one is being
 * read.
 *
 * ## Why the override is separate from the mode
 *
 * "In auto, but pinned to the soft key for now" is a real thing to want while
 * testing. Folding the override into the mode makes that state unreachable
 * without changing a preference you then have to remember to change back, so
 * they are two controls.
 */
export function KeySource({keys}: {keys: KeyControl}) {
  const {mode, setMode, override, setOverride, backend, attached, name} = keys;

  return (
    <Section title="Which key">
      <View style={styles.row}>
        <Text style={styles.active}>{name}</Text>
        <Text style={styles.dim}>
          {attached === null
            ? 'looking for a hard key…'
            : attached
              ? 'a hard key is attached'
              : 'no hard key attached'}
        </Text>
      </View>

      <Text style={styles.hint}>
        {backend === 'usb'
          ? /*
             * Three answers, because the probe is three-valued and each one
             * changes what the person should do with their finger.
             */
            keys.hard.canPress === true
            ? 'Reading a physical OnlyKey over USB. This is a developer build ' +
              'whose console takes presses from the app, so a keypad is drawn — ' +
              'its own buttons work too.'
            : keys.hard.canPress === false
              ? 'Reading a physical OnlyKey over USB. Its buttons are its own — the ' +
                'app does not draw a keypad for one.'
              : 'Reading a physical OnlyKey over USB. Asking whether its console ' +
                'takes presses from the app…'
          : 'Reading the soft key: the same firmware, running inside this app. ' +
            'It stays running while a hard key is in use, so switching back ' +
            'finds it where you left it.'}
      </Text>

      <Text style={styles.label}>When a hard key is attached</Text>
      <Segmented
        value={mode}
        options={['auto', 'manual'] as const}
        onChange={next => void setMode(next)}
      />
      <Text style={styles.hint}>
        {mode === 'auto'
          ? 'Switch to it, and back to the soft key when it is unplugged.'
          : 'Stay where you are. Attaching one only makes it available.'}
      </Text>

      <Text style={styles.label}>Override</Text>
      <View style={styles.actions}>
        <Btn
          title="Soft Key"
          tone={override === 'embedded' ? 'primary' : undefined}
          onPress={() => void setOverride('embedded')}
        />
        <Btn
          title="Hard Key"
          tone={override === 'usb' ? 'primary' : undefined}
          onPress={() => void setOverride('usb')}
        />
        <Btn
          title="Off"
          tone={override === null ? 'primary' : undefined}
          onPress={() => void setOverride(null)}
        />
      </View>
      <Text style={styles.hint}>
        {override
          ? 'Forced, whatever is plugged in. This wins over the setting above.'
          : 'Not forced — the setting above decides.'}
      </Text>
    </Section>
  );
}

const styles = StyleSheet.create({
  row: {flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4},
  active: {color: theme.text, fontSize: 16, fontWeight: '700', flex: 1},
  dim: {color: theme.textDim, fontSize: 12},
  label: {color: theme.text, fontSize: 13, fontWeight: '600', marginTop: 14},
  hint: {color: theme.textDim, fontSize: 12, lineHeight: 18, marginTop: 6},
  actions: {flexDirection: 'row', gap: 8, marginTop: 6, flexWrap: 'wrap'},
});
