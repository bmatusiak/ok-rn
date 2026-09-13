import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Section} from './components';
import {theme} from './theme';

/**
 * Wraps a screen that the key will refuse while it is in config mode.
 *
 * ## Which screens, and why
 *
 * `recvmsg`'s config-mode allowlist (okcore.cpp:347) permits `OKCONNECT`,
 * `OKSETSLOT`, `OKSETPRIV`, `OKRESTORE`, `OKFWUPDATE`, `OKWIPESLOT`,
 * `OKWIPEPRIV`, `OKGETLABELS` and the three PIN messages - and NOTHING else.
 * `OKSIGN` and `OKDECRYPT` are refused with a `Serial.println` and nothing on
 * the vendor bus, so from the app they simply never answer.
 *
 * That is the whole point of greying these out. The failure mode otherwise is
 * silence: press sign, wait, get nothing, and conclude the key is broken. The
 * app knows perfectly well why it will not answer, and saying so beforehand is
 * cheaper than any timeout.
 *
 * Dimmed AND inert - `pointerEvents="none"` - because a control that looks
 * disabled but still fires is worse than either.
 */
export function ConfigModeBlocked({
  active,
  what,
  children,
}: {
  /** True while the app believes the key is in config mode. */
  active: boolean;
  /** What the key will not do, e.g. "sign or decrypt". */
  what: string;
  children: React.ReactNode;
}) {
  if (!active) return <>{children}</>;
  return (
    <>
      <Section title="Not while in config mode">
        <Text style={styles.body}>
          The key will not {what} until it is restarted — the firmware refuses
          those while in config mode, and says so only to itself.
        </Text>
        <Text style={styles.note}>
          Unplug a hard key, or restart the app for the soft key.
        </Text>
      </Section>
      <View pointerEvents="none" style={styles.dimmed}>
        {children}
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  body: {color: theme.text, fontSize: 14, lineHeight: 20},
  note: {color: theme.textDim, fontSize: 12, lineHeight: 17},
  dimmed: {opacity: 0.45},
});

/**
 * The mirror image: content the key will only accept IN config mode.
 *
 * `OKSETPRIV`, `OKSETSLOT`, `OKRESTORE`, `OKFWUPDATE` and the PIN messages are
 * accepted only while `configmode` is set (okcore.cpp:452 and the allowlist at
 * :347). Outside it a key write is **silently dropped** - no acknowledgement,
 * no error, nothing on any interface. The first symptom is a later operation
 * reporting `Error no ECC Private Key set in this slot`, which reads as a
 * failure of the SIGNING path rather than of the write that never happened.
 *
 * So these are dimmed and inert until config mode is ready, rather than
 * offered and quietly ignored. The panel above them says how to get there.
 */
export function ConfigModeRequired({
  ready,
  children,
}: {
  /** In config mode AND the PIN is back in - both halves are needed. */
  ready: boolean;
  children: React.ReactNode;
}) {
  if (ready) return <>{children}</>;
  return (
    <View pointerEvents="none" style={styles.dimmed}>
      {children}
    </View>
  );
}
