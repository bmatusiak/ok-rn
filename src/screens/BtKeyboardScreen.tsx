import React, {useCallback, useEffect, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Btn, Section} from '../ui/components';
import {theme} from '../ui/theme';
import {useBtKeyboard} from '../hooks/useBtKeyboard';
import {PRESS_TICKS} from '../transport/OkEmu';
import type {Keystrokes} from '../hooks/useKeystrokes';
import {useKeyName} from '../hooks/KeyContext';
import type {EmuSession} from '../hooks/useOkEmu';

/*
 * Typing into a real computer.
 *
 * This is the half of the soft key that the phone has been missing. The
 * firmware already types - every slot leaves the key as keystrokes and nothing
 * else - but on a phone those keystrokes had nowhere to go. Published as a
 * Bluetooth keyboard, they go where they were always meant to.
 *
 * The pairing is driven from the OTHER machine, because that is how a keyboard
 * works: it is discovered and bonded from the host's Bluetooth settings, and
 * that bond is what makes the link encrypted and trusted. There is nothing to
 * type here and no address to enter.
 */

/** Buttons 1-6, the same six a slot is read from. */
const SLOT_BUTTONS = [1, 2, 3, 4, 5, 6];

export function BtKeyboardScreen({emu, typed}: {emu: EmuSession; typed: Keystrokes}) {
  const bt = useBtKeyboard();
  /* The name, for the panel that shows what the key typed. */
  const keyName = useKeyName();
  const [pressing, setPressing] = useState<number | null>(null);
  const locked = emu.device !== 'unlocked';

  useEffect(() => {
    if (bt.state === 'registered' || bt.state === 'connected') {
      void bt.refreshHosts();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bt.state]);

  /*
   * A tap types slot N; a hold types its b profile. Same bands as everywhere
   * else, and deliberately no gesture band - nothing on this screen should be
   * able to reach backup() by being held a moment too long.
   */
  const type = useCallback(
    async (button: number, ticks: number) => {
      setPressing(button);
      try {
        /* The ACTIVE key's hold, not the emulator's. See useOkEmu.holdTicks. */
        await emu.holdTicks(button, ticks);
      } finally {
        setPressing(null);
      }
    },
    [emu],
  );

  if (bt.supported === false) {
    return (
      <>
        <Section title="Bluetooth keyboard">
          <Text style={styles.body}>
            This phone does not offer the Bluetooth HID Device profile, so it
            cannot present itself as a keyboard. The profile is optional in
            Android and some builds ship without it — it is not something the
            app can turn on.
          </Text>
        </Section>
      </>
    );
  }

  /*
   * NO SCROLL VIEW OF ITS OWN any more. This is one half of the Bluetooth
   * tab, and the tab owns the scrolling - two nested scroll views fight each
   * other for the same drag.
   */
  return (
    <>
      <Section title="Bluetooth keyboard">
        <Text style={styles.body}>
          The key types its slots rather than sending them. Published here, it
          types them into another computer over Bluetooth, exactly as the USB
          key does — the reports are the firmware's own, not a re-typing of
          decoded text.
        </Text>

        <View style={styles.stateRow}>
          <View style={[styles.dot, dotStyle(bt.state)]} />
          <Text style={styles.stateText}>{bt.state}</Text>
        </View>
        {bt.message ? <Text style={styles.note}>{bt.message}</Text> : null}
        {bt.error ? <Text style={styles.error}>{bt.error}</Text> : null}

        {bt.state === 'unregistered' || bt.state === 'unsupported' ? (
          <Btn
            title={bt.busy ? 'Publishing…' : 'Publish as a keyboard'}
            tone="primary"
            disabled={bt.busy}
            onPress={bt.publish}
          />
        ) : (
          <Btn
            title={bt.busy ? 'Withdrawing…' : 'Stop being a keyboard'}
            disabled={bt.busy}
            onPress={bt.withdraw}
          />
        )}
      </Section>

      {/*
        * THE CAPTURE PANE. Everything the key types comes here and nowhere
        * else on the phone - a hard key's keyboard interface is claimed, and
        * the soft key never had another outlet - so this is where a slot is
        * seen to come out, and where a wrong decode layout shows itself.
        */}
      <Section
        title={`Typed by the key — ${keyName}`}
        right={<Btn title="Clear" onPress={typed.clear} disabled={!typed.reports} />}>
        <Text style={styles.body}>
          {typed.text ? typed.text : 'Nothing yet. Press a button on the key and its slot appears here.'}
        </Text>
        <Text style={styles.note}>
          {typed.reports} reports, decoded as {typed.layout.replace(/_/g, ' ').toLowerCase()}.
          If the characters look wrong, the key is typing in a layout this app was not told about — set it under Settings.
        </Text>
      </Section>

      {bt.state !== 'unregistered' && bt.state !== 'unsupported' ? (
        <Section title="Pairing">
          <Text style={styles.note}>
            Make the phone visible, then go to the other computer's Bluetooth
            settings and add{' '}
            <Text style={styles.name}>{bt.localName || 'this phone'}</Text> — it
            appears there under the phone's own Bluetooth name, with a keyboard
            icon. The bond it creates is what encrypts the link; this app never
            sends a password to something it has not been paired with.
          </Text>
          <Btn
            title={bt.busy ? 'Asking…' : 'Make visible for 5 minutes'}
            tone="primary"
            disabled={bt.busy}
            onPress={bt.makeDiscoverable}
          />
          <Text style={styles.note}>
            A COMPUTER ALREADY PAIRED WITH THIS PHONE STILL HAS TO ADD IT AGAIN
            AS A KEYBOARD. An existing pairing was made for something else — a
            phone, a headset — and a host refuses an incoming keyboard
            connection from a device it never accepted as one. Remove the old
            pairing on that computer first, then add it fresh.
          </Text>

          {bt.hosts.length === 0 ? (
            <Text style={styles.note}>Nothing is paired with this phone yet.</Text>
          ) : (
            bt.hosts.map(h => (
              <View key={h.address} style={styles.hostRow}>
                <View style={styles.hostText}>
                  <Text style={styles.hostName}>{h.name || h.address}</Text>
                  <Text style={styles.hostAddr}>{h.address}</Text>
                </View>
                {h.connected ? (
                  <Text style={styles.connected}>connected</Text>
                ) : (
                  <Btn
                    title="Connect"
                    disabled={bt.busy}
                    onPress={() => bt.connect(h.address)}
                  />
                )}
              </View>
            ))
          )}

          <Btn title="Refresh" disabled={bt.busy} onPress={bt.refreshHosts} />
        </Section>
      ) : null}

      {bt.state === 'connected' ? (
        <Section title="Typing">
          <Text style={styles.body}>
            While this is on, everything the key types goes to{' '}
            {bt.host || 'the connected computer'}. Put the cursor where you want
            it first.
          </Text>
          <Btn
            title={bt.typing ? 'Stop typing to the host' : 'Type to the host'}
            tone={bt.typing ? 'danger' : 'primary'}
            onPress={() => bt.setTyping(!bt.typing)}
          />
          <Text style={styles.note}>{bt.sent} reports sent</Text>

          {bt.typing ? (
            <>
              <Text style={styles.note}>
                Tap a button to type that slot; hold to type its b profile.
              </Text>
              <View style={styles.pad}>
                {SLOT_BUTTONS.map(n => (
                  <View key={n} style={styles.padCell}>
                    <Btn
                      title={pressing === n ? '…' : String(n)}
                      disabled={pressing !== null || locked}
                      onPress={() => type(n, PRESS_TICKS.TAP)}
                    />
                    <Btn
                      title={`${n}b`}
                      disabled={pressing !== null || locked}
                      onPress={() => type(n, PRESS_TICKS.HOLD)}
                    />
                  </View>
                ))}
              </View>
              {locked ? (
                <Text style={styles.note}>Unlock the key first.</Text>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}
    </>
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

  body: {color: theme.textSecondary, fontSize: theme.fontSize, lineHeight: theme.lineHeight},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 18},
  error: {color: theme.error, fontSize: 13, lineHeight: 20},

  stateRow: {flexDirection: 'row', alignItems: 'center', gap: 8},
  dot: {width: 8, height: 8, borderRadius: 4},
  stateText: {color: theme.text, fontSize: 13, fontFamily: theme.mono},

  hostRow: {flexDirection: 'row', alignItems: 'center', gap: 10},
  hostText: {flex: 1},
  hostName: {color: theme.text, fontSize: 14},
  hostAddr: {color: theme.textDim, fontSize: 11, fontFamily: theme.mono},
  connected: {color: theme.ok, fontSize: 12},
  name: {color: theme.text, fontFamily: theme.mono},

  pad: {flexDirection: 'row', flexWrap: 'wrap', gap: 8},
  padCell: {gap: 4, width: '30%'},
});
