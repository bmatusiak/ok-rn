import React, {useCallback, useEffect} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {Btn, KeyValue, Section, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {useSharedBtKeyboard} from '../hooks/BtKeyboardContext';
import {useKeyName} from '../hooks/KeyContext';
import type {FidoSession} from '../hooks/useFidoGatt';
import type {BtAuto} from '../hooks/useBtAuto';

/*
 * ONE TAB, ONE FLOW: turn it on, choose a target, use it.
 *
 * Two features share this radio - the phone as a keyboard, and the phone as a
 * security key - and they were two screens stacked end to end, each explaining
 * itself from scratch, each with its own pairing talk. Between them they
 * offered ten buttons and four status lines, and the first thing anyone asked
 * was which had to be on before the others would work.
 *
 * So the shape answers that, in order:
 *
 *   1. Bluetooth      - on or off; nothing below exists while it is off
 *   2. Target         - WHICH computer, chosen once
 *   3. Keyboard       - on or off, for that target
 *   4. Authenticator  - on or off, for that target
 *
 * The target is shared and comes FIRST because it is shared: a host is bonded
 * to the phone, not to a feature, and both of these type into the same chosen
 * computer. Saying it twice on one screen was most of why the tab read as two
 * apps bolted together.
 *
 * Neither feature can be switched on before a target is chosen. That is not a
 * restriction, it is the flow made visible - a keyboard with nowhere to type
 * is the state this app spent a day being confused by.
 */


export function BluetoothScreen({
  fido,
  on,
  setOn,
  auto,
  testing = false,
}: {
  fido: FidoSession;
  /**
   * The master switch, owned by App.
   *
   * It lives up there because the top bar reports it on every tab, and a
   * screen that unmounts when you look at another one cannot be the home of
   * something the whole app is showing.
   */
  on: boolean;
  setOn: (next: boolean) => void;
  /**
   * The auto preferences, owned by App and ACTED ON by the status icons in the
   * top bar - not here. This screen only edits them: it is unmounted whenever
   * another tab is on top, which is exactly when "start on app start" matters.
   */
  auto: BtAuto;
  /** The authenticator's service and MTU rows ride on this. */
  testing?: boolean;
}) {
  const bt = useSharedBtKeyboard();
  const keyName = useKeyName();

  const published = bt.state !== 'unregistered' && bt.state !== 'unsupported';
  const advertising = fido.state === 'advertising' || fido.state === 'connected';

  const setMaster = useCallback(
    (next: boolean) => {
      setOn(next);
      /*
       * Off means off, for both. Leaving either running under a switch that
       * says Bluetooth is off would be the screen lying about the radio.
       */
      if (!next) {
        if (published) void bt.withdraw();
        if (advertising) void fido.stop();
      }
    },
    [bt, fido, setOn, published, advertising],
  );

  /*
   * CHOOSING "NONE" STANDS BOTH FEATURES DOWN.
   *
   * Not tidiness - the switches below are disabled without a target, so a
   * keyboard left published under "None" would be running behind a control
   * that can no longer turn it off. The invariant is the simple one the tab is
   * built on: a feature is on FOR a target, or it is not on.
   */
  const setTarget = useCallback(
    async (address: string | null) => {
      await bt.chooseHost(address);
      if (address === null) {
        if (published) void bt.withdraw();
        if (advertising) void fido.stop();
      }
    },
    [bt, fido, published, advertising],
  );

  /*
   * THE TARGET LIST LOADS WHILE BLUETOOTH IS ON, not while the keyboard is
   * published. The hook's own poll is gated on being published, which was
   * right when this list lived inside the keyboard's own panel - but the
   * target is chosen BEFORE either feature is switched on, and a panel that
   * says "nothing is paired" because the feature under it is off is the screen
   * reporting its own state as the world's.
   *
   * Only while unpublished, so this does not run alongside the hook's poll.
   */
  useEffect(() => {
    if (!on || published) return undefined;
    void bt.refreshHosts();
    const timer = setInterval(() => void bt.refreshHosts(), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, published]);

  if (bt.supported === false) {
    return (
      <ScrollView style={styles.root} contentContainerStyle={styles.content}>
        <Section title="Bluetooth">
          <Text style={styles.body}>
            This phone does not offer the Bluetooth HID Device profile, so it
            cannot present itself as a keyboard. The profile is optional in
            Android and some builds ship without it — it is not something the
            app can turn on.
          </Text>
        </Section>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.root} contentContainerStyle={styles.content}>
      {/* 1 ─ the master switch */}
      <Section
        title="Bluetooth"
        right={<Switch value={on} onValueChange={setMaster} />}>
        <Text style={styles.note}>
          Lets this phone be a keyboard or a security key for another computer.
        </Text>
      </Section>

      {on ? (
        <>
          {/* 2 ─ what starts by itself */}
          <Section title="Auto">
            <AutoRow
              label="Start on app start"
              hint="Turn Bluetooth on when the app opens."
              value={auto.autos.start}
              onChange={v => auto.setAuto('start', v)}
            />
            <AutoRow
              label="Start keyboard"
              hint="Publish as a keyboard once a target is chosen."
              value={auto.autos.keyboard}
              onChange={v => auto.setAuto('keyboard', v)}
            />
            <AutoRow
              label="Start authenticator"
              hint="Advertise as a security key once a target is chosen."
              value={auto.autos.authenticator}
              onChange={v => auto.setAuto('authenticator', v)}
            />
          </Section>

          {/* 3 ─ the target, shared by both features */}
          <Section title="Target">
            <Text style={styles.note}>
              {bt.hosts.length === 0
                ? `No computer paired yet. Make the phone visible, then add ${bt.localName || 'this phone'} from its Bluetooth settings.`
                : 'The computer both features below talk to. Chosen once, then reconnected on its own.'}
            </Text>

            {/*
             * PICK ONE, then it is trusted - selecting connects now and keeps
             * reconnecting to that host. The app never guesses which computer
             * a password should be typed into: no choice, no attempt. See
             * FINDING-reconnecting-the-keyboard-was-a-chore.md.
             */}
            {/*
             * NONE IS A ROW, not the absence of a selection. It is where this
             * starts and what it falls back to, and a radio group whose "off"
             * state is "nothing looks selected" reads as a list that has not
             * loaded yet.
             */}
            <Pressable
              style={styles.hostRow}
              disabled={bt.busy}
              onPress={() => setTarget(null)}>
              <View style={[styles.radio, !bt.chosenHost && styles.radioOn]}>
                {!bt.chosenHost ? <View style={styles.radioDot} /> : null}
              </View>
              <View style={styles.hostText}>
                <Text style={styles.hostName}>None</Text>
                <Text style={styles.hostAddr}>nothing is targeted</Text>
              </View>
            </Pressable>

            {bt.hosts.map(h => {
              const chosen = bt.chosenHost === h.address;
              return (
                <Pressable
                  key={h.address}
                  style={styles.hostRow}
                  disabled={bt.busy}
                  onPress={() => setTarget(h.address)}>
                  <View style={[styles.radio, chosen && styles.radioOn]}>
                    {chosen ? <View style={styles.radioDot} /> : null}
                  </View>
                  <View style={styles.hostText}>
                    <Text style={styles.hostName}>{h.name || h.address}</Text>
                    <Text style={styles.hostAddr}>{h.address}</Text>
                  </View>
                  {h.connected ? (
                    <Text style={styles.connected}>connected</Text>
                  ) : chosen ? (
                    <Text style={styles.note}>connecting…</Text>
                  ) : null}
                </Pressable>
              );
            })}

            {/* No Refresh button: the list refreshes itself while this is on. */}
            <Btn
              title={bt.busy ? 'Asking…' : 'Pair a new computer'}
              disabled={bt.busy}
              onPress={bt.makeDiscoverable}
            />
          </Section>

          {/* 4 ─ keyboard */}
          <Section
            title="Keyboard"
            right={
              <Switch
                value={published}
                disabled={bt.busy || !bt.chosenHost}
                onValueChange={next => (next ? bt.publish() : bt.withdraw())}
              />
            }>
            <View style={styles.stateRow}>
              <View style={[styles.dot, dotStyle(bt.state)]} />
              <Text style={styles.stateText}>
                {bt.chosenHost ? bt.state : 'choose a target first'}
              </Text>
            </View>
            {bt.message ? <Text style={styles.note}>{bt.message}</Text> : null}
            {bt.error ? <Text style={styles.error}>{bt.error}</Text> : null}

            {bt.state === 'connected' ? (
              /*
               * NO SEPARATE ARM. The switch above is the arm: the target says
               * WHERE, the switch says WHETHER, and a third control asking
               * "yes but really?" was the same intent a third time. It also
               * had the failure mode this whole tab was rewritten to remove -
               * on, connected, and silently not typing.
               */
              <Text style={styles.note}>
                Everything {keyName} types goes to {bt.host || 'the target'}.
                Put the cursor there first. {bt.sent} reports sent.
              </Text>
            ) : null}

          </Section>

          {/* 5 ─ authenticator */}
          <Section
            title="Authenticator"
            right={
              <Switch
                value={advertising}
                disabled={fido.supported === false || !bt.chosenHost}
                onValueChange={next => (next ? fido.start() : fido.stop())}
              />
            }>
            <View style={styles.stateRow}>
              <StatusPill state={fido.state} />
            </View>
            <Text style={styles.note}>
              {bt.chosenHost
                ? `A browser can use this phone as a security key. ${keyName} must be unlocked — the firmware answers, not this screen.`
                : 'Choose a target first.'}
            </Text>
            {fido.supported === false ? (
              <Text style={styles.error}>
                This phone cannot advertise as a BLE peripheral.
              </Text>
            ) : null}

            {fido.pending ? (
              <View style={styles.pendingBlock}>
                <KeyValue
                  label="command"
                  value={
                    fido.pending.commandName ||
                    '0x' + fido.pending.command.toString(16)
                  }
                />
                <KeyValue label="relying party" value={fido.pending.rpId || '-'} />
                <KeyValue
                  label="payload"
                  value={fido.pending.hex.length / 2 + ' bytes'}
                />
                {fido.presenceNeeded ? (
                  <>
                    <Text style={styles.note}>
                      The key is waiting for a button. It will not produce a
                      credential without one — this is the device asking, not the
                      app.
                    </Text>
                    <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
                  </>
                ) : (
                  <Text style={styles.note}>
                    Forwarding to the firmware. Nothing to do unless it asks for
                    a button.
                  </Text>
                )}
              </View>
            ) : (
              <Text style={styles.note}>Nothing pending.</Text>
            )}

            {testing ? (
              <View style={styles.kvBlock}>
                <KeyValue label="service" value="0xFFFD" />
                <KeyValue label="ATT MTU" value={fido.mtu ? String(fido.mtu) : '-'} />
              </View>
            ) : null}
          </Section>
        </>
      ) : null}
    </ScrollView>
  );
}

function AutoRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <View style={styles.autoRow}>
      <View style={styles.autoText}>
        <Text style={styles.autoLabel}>{label}</Text>
        <Text style={styles.note}>{hint}</Text>
      </View>
      <Switch value={value} onValueChange={onChange} />
    </View>
  );
}

function dotStyle(state: string) {
  if (state === 'connected') return {backgroundColor: theme.ok};
  if (state === 'registered' || state === 'connecting') return {backgroundColor: theme.warn};
  return {backgroundColor: theme.textDim};
}

const styles = StyleSheet.create({
  root: {flex: 1},
  content: {padding: 16, gap: 16, paddingBottom: 48},
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 17},
  error: {color: theme.error, fontSize: 12, lineHeight: 17},
  name: {fontFamily: theme.mono, color: theme.textSecondary},

  autoRow: {flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 6},
  autoText: {flex: 1},
  autoLabel: {color: theme.text, fontSize: 14},

  stateRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  dot: {width: 10, height: 10, borderRadius: 5},
  stateText: {color: theme.textSecondary, fontFamily: theme.mono, fontSize: 13},

  radio: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: theme.border,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 12,
  },
  radioOn: {borderColor: theme.accent},
  radioDot: {width: 10, height: 10, borderRadius: 5, backgroundColor: theme.accent},
  hostRow: {flexDirection: 'row', alignItems: 'center', paddingVertical: 8},
  hostText: {flex: 1},
  hostName: {color: theme.text, fontSize: 14},
  hostAddr: {color: theme.textDim, fontSize: 11, fontFamily: theme.mono},
  connected: {color: theme.ok, fontSize: 12},

  typedBlock: {gap: 6},
  typedHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  typedTitle: {color: theme.text, fontSize: 14, fontWeight: '600'},

  devBlock: {gap: 10},
  testInput: {
    borderWidth: 1,
    borderColor: theme.border,
    borderRadius: theme.radius,
    color: theme.text,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontFamily: theme.mono,
    fontSize: 13,
  },
  pad: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  padCell: {width: '30%', gap: 6},

  pendingBlock: {gap: 8},
  kvBlock: {gap: 2},
});
