import React, {useCallback, useEffect} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';
import {Btn, KeyValue, Section, StatusPill} from '../ui/components';
import {theme} from '../ui/theme';
import {useSharedBtKeyboard} from '../hooks/BtKeyboardContext';
import {useKeyName} from '../hooks/KeyContext';
import type {FidoSession} from '../hooks/useFidoGatt';
import type {BtAuto} from '../hooks/useBtAuto';

/** Seconds as m:ss - a pairing window is minutes, and "287s" is not a clock. */
function mmss(total: number): string {
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

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
 *   3. Keyboard       - whether the key's typing crosses the link
 *   4. Authenticator  - whether a browser's request reaches the key
 *
 * The target is shared and comes FIRST because it is shared: a host is bonded
 * to the phone, not to a feature, and both of these type into the same chosen
 * computer. Saying it twice on one screen was most of why the tab read as two
 * apps bolted together.
 *
 * ## The switches are IO, not existence
 *
 * They used to publish and withdraw the services themselves, and both of this
 * tab's long-running bugs came out of that. A host reads a device's service
 * list EXACTLY ONCE, when it pairs: gating publication on a target made the
 * first pairing with a new computer the one pairing that recorded neither
 * service, and the target list only holds computers already paired, so that
 * was the ordinary path. And switching a feature off tore its service down,
 * which teaches Windows to distrust a node that keeps vanishing until it stops
 * offering this phone at all.
 *
 * So both services are present for as long as Bluetooth is on, and these
 * switches decide whether anything flows through them. That is also the
 * question someone is really answering when they turn one off - not "stop
 * existing", but "not right now" - and it can be answered without touching
 * what any host has already written down.
 */

export function BluetoothScreen({
  fido,
  on,
  setOn,
  auto,
  canPress = false,
  testing = false,
}: {
  fido: FidoSession;
  /**
   * Whether the ACTIVE key takes presses from the app.
   *
   * The debug-console probe. False on every production key, which is what
   * decides whether a Confirm button can exist at all.
   */
  canPress?: boolean;
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
   * PAIRING ONLY HAS TO MAKE THE PHONE VISIBLE NOW.
   *
   * A HOST READS A DEVICE'S SERVICE LIST EXACTLY ONCE, WHEN IT PAIRS, so this
   * button used to have to bring both services up first - and before that, it
   * brought up only the keyboard, which is how a pairing came out half-built.
   * Measured against Windows on 2026-09-17 the phone's own stack reported:
   *
   *   NITRO16 [ DUAL ] [ACL BR/EDR:Y LE:N]
   *           [ Encryption status(BR/EDR): keySize=16 ... LE: N/A ]
   *
   * dual-mode, a classic link up, and NO LE KEY AT ALL - so the FIDO
   * characteristics were unreachable from that moment on, no matter that the
   * phone was advertising 0xFFFD connectably the whole time. Windows offered
   * no security key to use, and the only cure was to pair again, which then
   * cost the keyboard. Whichever feature was up at pair time was the one that
   * survived.
   *
   * Presence follows the radio now (see App), so both are already up whenever
   * this button can be pressed, and there is nothing left for it to arrange.
   */
  const pairNewComputer = useCallback(async () => {
    await bt.makeDiscoverable();
  }, [bt]);

  /*
   * CANCEL CLOSES THE WINDOW, AND DELIBERATELY NOTHING ELSE.
   *
   * It does NOT take the services down. The system's discoverable window
   * cannot be revoked by an app without BLUETOOTH_PRIVILEGED, so the phone
   * stays findable until it lapses either way - and withdrawing the keyboard
   * or the GATT server to look decisive would be the exact vanishing act that
   * teaches a host to distrust this phone. Ending the countdown is the honest
   * extent of it: the invitation is over, the phone is still a keyboard and
   * still a security key for the computers that already know it.
   */
  const cancelPairing = useCallback(() => {
    bt.endDiscoverable();
  }, [bt]);

  /*
   * CHOOSING "NONE" FORGETS THE TARGET, AND NOTHING ELSE.
   *
   * It used to stand both features down, because the switches were disabled
   * without a target and a feature left on under "None" would have been
   * running behind a control that could no longer turn it off. Neither half
   * of that is true now: the switches are IO and always reachable, and
   * presence follows the radio. A keyboard with no target simply has nobody
   * connected to type to, which is a state the panel can say plainly instead
   * of a state that had to be prevented.
   */
  const setTarget = useCallback(
    async (address: string | null) => {
      await bt.chooseHost(address);
    },
    [bt],
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
            {/*
              * One button with three readings: the invitation, the window
              * counting down, and the way out of it. The remaining time is on
              * the button itself because it is the only thing on this panel
              * that is running out - a pairing that has to be finished on the
              * OTHER computer is exactly when someone needs to know how long
              * they have, without looking back at the phone.
              */}
            <Btn
              title={
                bt.discoverableFor
                  ? `Cancel · visible for ${mmss(bt.discoverableFor)}`
                  : bt.busy
                    ? 'Asking…'
                    : 'Pair a new computer'
              }
              tone={bt.discoverableFor ? 'danger' : 'default'}
              disabled={bt.busy && !bt.discoverableFor}
              onPress={bt.discoverableFor ? cancelPairing : pairNewComputer}
            />
          </Section>

          {/* 4 ─ keyboard */}
          <Section
            title="Keyboard"
            right={
              <Switch
                value={bt.forwarding}
                disabled={bt.state === 'unsupported'}
                onValueChange={bt.setForwarding}
              />
            }>
            <View style={styles.stateRow}>
              <View style={[styles.dot, dotStyle(bt.state)]} />
              <Text style={styles.stateText}>
                {bt.state}
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
                value={fido.relaying}
                disabled={fido.supported === false}
                onValueChange={fido.setRelaying}
              />
            }>
            <View style={styles.stateRow}>
              <StatusPill state={fido.state} />
            </View>
            <Text style={styles.note}>
              {fido.relaying
                ? `A browser can use this phone as a security key. ${keyName} must be unlocked — the firmware answers, not this screen.`
                : 'Offered to paired computers, but requests are turned away. Switch this on to let a browser reach the key.'}
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
                    {/*
                      * CONFIRM ONLY WHERE THE APP CAN ACTUALLY PRESS.
                      *
                      * `fido.confirm` presses the active key, and that goes
                      * through holdTicks, which throws without the debug
                      * console (useHardKey.ts) - every production key. A
                      * Confirm button there is one that can only fail, on the
                      * screen where failing means a credential is not made.
                      *
                      * A developer hard key and the soft key both take presses
                      * from the app, so they keep the button.
                      */}
                    {canPress ? (
                      <Btn title="Confirm" tone="primary" onPress={fido.confirm} />
                    ) : (
                      <Text style={styles.note}>
                        Press any button on the key itself — this one takes no
                        presses from the app.
                      </Text>
                    )}
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
