import React, {useCallback, useEffect, useState} from 'react';
import {AppState, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {device as okdevice} from 'node-onlykey-lib';
import {Btn, Section} from '../ui/components';
import {NEEDS_CONFIG_MODE, ON, type ConfigState} from '../ui/configModeNotes';
import {ConfigModePanel} from '../ui/ConfigModePanel';
import {theme} from '../ui/theme';
import {useActiveKey, useBackend, useKeyName} from '../hooks/KeyContext';
import {layoutNameForId, rememberLayout} from '../hooks/useKeyboardLayout';
import * as biometrics from '../biometrics';
import {SetupScreen} from './SetupScreen';
import OkEmu from '../transport/OkEmu';
import type {EmuSession} from '../hooks/useOkEmu';
import {FidoGatt} from '../transport/FidoGatt';
import type {PermissionStatus} from '../transport/FidoGatt';

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

export function PreferencesScreen({
  emu,
  configMode,
  onWantConfigMode,
}: {
  emu: EmuSession;
  /*
   * Only the Advanced group. Its preferences carry `requires: 'configMode'`
   * in the library's own table (plugins/device/index.js:418) - OKSETSLOT wants
   * `configmode == true` on a provisioned key (okcore.cpp:452) - while the
   * Settings group takes any unlocked key and the setup-only group is refused
   * here whatever the mode.
   *
   * Changing a PIN is NOT gated, and it looks like it should be: the three PIN
   * messages are on the config-mode allowlist, so that panel works either way.
   */
  configMode: ConfigState;
  /** Asks App to want config mode. Nothing here writes the flag. */
  onWantConfigMode: () => void;
}) {
  /* The ACTIVE key, not whichever one this file used to assume. */
  const getKey = useActiveKey();
  /* Named in every panel that states a fact about it. See useKeyName. */
  const keyName = useKeyName();
  const backend = useBackend();

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
      /* Only touchSense has one; every other preference floors at 0. */
      min?: number;
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

  /*
   * PERMISSIONS, visible and re-askable. The security-key role asks for
   * Bluetooth and, on Android 13+, notifications (the foreground service's
   * "acting as a security key" line) the first time advertising starts. A
   * dialog dismissed by accident left no way back in the app: Android does
   * not ask twice on its own, and the service then runs with no notification
   * to say so. This reads the state every time the screen is shown or the
   * app returns from the system settings page, and offers the ask again.
   */
  const [perms, setPerms] = useState<PermissionStatus | null>(null);
  const [permNote, setPermNote] = useState<string | null>(null);
  const readPerms = useCallback(() => {
    FidoGatt.permissionStatus().then(setPerms).catch(e => setPermNote(String((e as Error)?.message ?? e)));
  }, []);
  useEffect(() => {
    readPerms();
    const sub = AppState.addEventListener('change', s => { if (s === 'active') readPerms(); });
    return () => sub.remove();
  }, [readPerms]);
  const askBluetooth = useCallback(async () => {
    setPermNote(null);
    try {
      const ok = await FidoGatt.requestPermissions();
      if (!ok) setPermNote('Bluetooth was not granted. If no dialog appeared, Android has stopped asking; use the system settings.');
    } catch (e) {
      setPermNote(String((e as Error)?.message ?? e));
    }
    readPerms();
  }, [readPerms]);
  const askNotifications = useCallback(async () => {
    setPermNote(null);
    try {
      const ok = await FidoGatt.requestNotificationPermission();
      if (!ok) setPermNote('Notifications were not granted. If no dialog appeared, Android has stopped asking; use the system settings.');
    } catch (e) {
      setPermNote(String((e as Error)?.message ?? e));
    }
    readPerms();
  }, [readPerms]);

  /*
   * CHANGE PINS, which the desktop offers on an initialized key and this app
   * did not. The firmware accepts OKPIN on such a key only in config mode
   * (okcore.cpp:362-374), so the section walks the same door the Keys tab
   * does: enter config mode (the key locks), PIN again, then the setup
   * bracket for the one PIN chosen, then a restart to leave config mode.
   */
  type PinKind = 'primary' | 'secondary' | 'selfDestruct';
  const [changing, setChanging] = useState<PinKind | null>(null);
  const [changed, setChanged] = useState(false);
  const restartKey = useCallback(() => {
    /* The soft key's firmware cannot restart in place; the app can. */
    if (backend === 'usb') void emu.restart();
    else void OkEmu.restartApp();
  }, [backend, emu]);
  const locked = emu.device !== 'unlocked';

  useEffect(() => {
    let cancelled = false;
    getKey()
      .then(({device}) => {
        if (!cancelled) setTable(device.preferences());
      })
      .catch(e => {
        if (!cancelled) setError(String((e as Error)?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [getKey]);

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
        const {device} = await getKey();
        const result = await device.setPreference(name, Number(raw));
        setStatus(`${name}: ${result.response}`);
        /*
         * REMEMBERED, because it cannot be read back. The key takes the
         * layout and never reports it, so the decoder that reads what the
         * key types has to be told by whoever last wrote it - per key, since
         * the soft and hard keys are different devices. See useKeyboardLayout.
         */
        if (name === 'keyboardLayout') {
          const layoutName = layoutNameForId(Number(raw));
          if (layoutName) await rememberLayout(backend, layoutName);
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setBusy(null);
      }
    },
    [backend, getKey, values],
  );


  if (changing) {
    return (
      <SetupScreen
        mode="change"
        only={changing}
        model={emu.model}
        onProvision={emu.provision}
        led={emu.led}
        onDone={() => {
          setChanging(null);
          setChanged(true);
        }}
        onRestart={restartKey}
      />
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
        'The firmware refuses these on a key that is already set up. They are ' +
        'shown so the key can be read, not so it can be changed here.',
      /*
       * Named by what is left rather than by the library's own word for the
       * precondition. `requires` is the LIBRARY's description of a firmware
       * rule and stays where it is; the app only needs to know these are not
       * the two it can offer.
       */
      rows: table.filter(p => p.requires !== 'always' && p.requires !== 'firstUse'),
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
      <Section title="Permissions">
        <Text style={styles.body}>
          What the security-key role needs from the phone. A dialog dismissed
          by accident can be asked again here; once Android has stopped
          asking, the system settings page is the only way back.
        </Text>
        <View style={styles.permRow}>
          <Text style={styles.body}>Bluetooth (acting as a security key)</Text>
          <Text style={perms?.bluetooth ? styles.permOn : styles.permOff}>
            {perms ? (perms.bluetooth ? 'granted' : 'not granted') : '…'}
          </Text>
        </View>
        {perms && !perms.bluetooth ? <Btn title="Ask for Bluetooth" onPress={() => void askBluetooth()} /> : null}
        <View style={styles.permRow}>
          <Text style={styles.body}>Notifications (the "acting as a security key" line)</Text>
          <Text style={perms?.notifications ? styles.permOn : styles.permOff}>
            {perms
              ? perms.notificationsApply
                ? perms.notifications ? 'granted' : 'not granted'
                : 'not needed on this Android'
              : '…'}
          </Text>
        </View>
        {perms && perms.notificationsApply && !perms.notifications ? (
          <Btn title="Ask for notifications" onPress={() => void askNotifications()} />
        ) : null}
        {permNote ? <Text style={styles.error}>{permNote}</Text> : null}
        <Btn title="Open the system settings for this app" onPress={() => FidoGatt.openAppSettings()} />
      </Section>

      <Section title={`Change PINs — ${keyName}`}>
        {changed ? (
          <>
            <Text style={styles.body}>
              The PIN is set. The key is still in config mode, and only reads
              its PIN when it boots — restart it to finish.
            </Text>
            <Btn title={backend === 'usb' ? 'Restart the key' : 'Restart the app'} tone="primary" onPress={restartKey} />
          </>
        ) : (
          <>
            <Text style={styles.body}>In config mode. Which PIN?</Text>
            <View style={styles.chips}>
              {emu.model === 'duo' ? (
                <Btn title="Set or change the DUO's PINs" tone="primary" onPress={() => setChanging('primary')} />
              ) : (
                <>
                  <Btn title="Primary" tone="primary" onPress={() => setChanging('primary')} />
                  <Btn title="Second profile" onPress={() => setChanging('secondary')} />
                  <Btn title="Self-destruct" onPress={() => setChanging('selfDestruct')} />
                </>
              )}
            </View>
          </>
        )}
      </Section>

      <Section title={`Preferences — ${keyName}`}>
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
        <Section
          key={group.title}
          title={group.title}
          unavailable={
            group.title === 'Advanced' && configMode !== ON ? NEEDS_CONFIG_MODE : null
          }>
          <Text style={styles.note}>{group.note}</Text>

          {/*
            * GATED BY THE MODE EACH GROUP NEEDS, as a panel rather than row by
            * row - a whole section that cannot be used should look it, and the
            * reason sits directly above.
            *
            *   Settings   OKSETSLOT on any unlocked key
            *   Advanced   OKSETSLOT wants `configmode == true` on a
            *              provisioned key (okcore.cpp:452)
            *   setup only `!initcheck`, so refused here whatever we do -
            *              shown for completeness, never offered
            *
            * Wipe mode and Backup key mode are the awkward pair: their
            * DANGEROUS value needs config mode and their safe one needs first
            * use, so `requires` names the stricter and the note says so.
            */}
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
                  pref.requires === 'firstUse'
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
      {/*
        THE WAY IN, AT THE FOOT - after the panels it unlocks.
    
        The Advanced group only. Its preferences carry `requires: configMode`
        in the library's own table; Settings takes any unlocked key, and the
        setup-only group is refused here whatever the mode.
      */}
      <ConfigModePanel
        state={configMode}
        emu={emu}
        backend={backend}
        onWant={onWantConfigMode}
        purpose="change an Advanced preference"
      />
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
    min?: number;
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
          {'  '}{pref.min ?? 0}–{pref.max}
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
  permRow: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 6},
  permOn: {color: theme.ok, fontSize: 13, fontWeight: '600'},
  permOff: {color: theme.warn, fontSize: 13, fontWeight: '600'},
  bits: {gap: 6},
});
