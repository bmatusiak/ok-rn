import React, {useEffect, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {Btn, HoldTicks, KeyValue, LedCircle, Section} from '../ui/components';
import {Keypad} from '../ui/Keypad';
import {theme} from '../ui/theme';
import OkEmu from '../transport/OkEmu';
import {PinScreen} from './PinScreen';
import {SetupScreen} from './SetupScreen';
import type {EmuSession} from '../hooks/useOkEmu';
import type {KeyControl} from '../hooks/useKey';
import {KeySource} from '../ui/KeySource';
import {useActiveKey} from '../hooks/KeyContext';

/**
 * The key itself: what state it is in, what it holds, and its buttons.
 *
 * Shows one thing at a time, chosen by the DEVICE's state rather than the
 * firmware process's. Those are different questions - the firmware can be
 * running perfectly while the device is locked and refuses everything - and
 * conflating them is what produced a screen that said "running" over a device
 * that would not answer.
 */
/** "OnlyKey DUO (24 slots)", or a dash when the device has not said. */
function describeModel(identity: EmuSession['identity']): string {
  if (!identity || identity.model === 'unknown') {
    return '-';
  }
  const names: Record<string, string> = {
    classic: 'OnlyKey Classic',
    duo: 'OnlyKey DUO',
    original: 'OnlyKey Original',
  };
  const name = names[identity.model] ?? identity.model;
  // A DUO is the one model that says whether a PIN has been set.
  if (identity.pinSet === false) {
    return `${name} (no PIN set)`;
  }
  return name;
}

/** Which firmware build, and what that means for the console. */
/**
 * Every capability the library reports, as rows.
 *
 * The screen used to show two of seventeen. The rest are not trivia: each one
 * is a MEASUREMENT against a firmware release - which gesture bands exist,
 * which reply layout the key uses, whether a derive can be touch-free, how
 * many slots there are - and several were wrong in the app before the version
 * matrix settled them. This is where that work becomes visible to the person
 * holding the key, instead of living only in a test table.
 *
 * Gestures are rendered as "button N, hold >= M" because that is what a
 * person has to DO. The raw band numbers mean nothing without the firmware
 * loop they count.
 */
function describeCapabilities(
  caps: EmuSession['capabilities'],
): {label: string; value: string}[] {
  if (!caps) return [];
  const rows: {label: string; value: string}[] = [];
  const say = (v: unknown): string => {
    if (v === true) return 'yes';
    if (v === false) return 'no';
    if (v === null || v === undefined) return '-';
    return String(v);
  };

  for (const [name, value] of Object.entries(caps)) {
    if (name === 'gestures') continue;
    if (value && typeof value === 'object') continue;
    rows.push({label: name, value: say(value)});
  }

  const gestures = (caps as any).gestures;
  if (gestures && typeof gestures === 'object') {
    for (const [name, band] of Object.entries<any>(gestures)) {
      if (!band || typeof band !== 'object') continue;
      const upper = band.hi === null || band.hi === undefined ? '' : ` and under ${band.hi}`;
      rows.push({
        label: name,
        value: `button ${band.button}, hold ${band.lo}+${upper}`,
      });
    }
  }
  return rows;
}

function describeBuild(caps: EmuSession['capabilities']): string {
  if (!caps || caps.debugConsole === null) {
    return 'unknown';
  }
  return caps.debugConsole ? 'debug (console)' : 'production (no console)';
}

export function KeyScreen({emu, keys}: {emu: EmuSession; keys: KeyControl}) {

  if (emu.state === 'halted') {
    return (
      <Message
        title="The key has stopped"
        body={
          'The firmware thread cannot be replaced in this process — it is ' +
          'linked into the same library as the bridge, so nothing short of a ' +
          'new process resets it. Restarting the app is the way back, and ' +
          'nothing is lost: flash and EEPROM are files, so the key comes back ' +
          'exactly as it was.'
        }
        tone="error"
        action={{title: 'Restart the app', onPress: () => OkEmu.restartApp()}}
      />
    );
  }

  if (emu.state === 'unavailable') {
    return (
      <Message
        title="No firmware for this device"
        body={
          'libokemu.so was not built for this ABI. Check the APK carries it — ' +
          'a 32-bit-only handset needs armeabi-v7a.'
        }
        tone="error"
      />
    );
  }

  /*
   * A blank key offers SETUP, for the same reason a locked one offers the
   * keypad: a screen that only names the problem is a dead end, and testing
   * mode can land here without ever passing the login flow.
   */
  if (emu.device === 'uninitialized') {
    /*
     * `model` is not optional here even though the prop is. It defaults to
     * 'classic', and omitting it put a DUO - which has no six-button keypad
     * and takes its whole PIN set in one OKSETPIN body - in front of the
     * classic pad on its first run.
     */
    return (
      <SetupScreen
        onProvision={emu.provision}
        model={emu.model}
        led={emu.led}
      />
    );
  }

  /*
   * A locked key shows the KEYPAD, not a sign saying it is locked.
   *
   * Telling someone the door is shut while offering no handle is not a screen,
   * it is a dead end - and it is reachable: testing mode skips the login flow
   * entirely, so a locked device landed here with nothing to press. The same
   * pad the door uses works just as well inside, and it means there is exactly
   * one place a PIN is ever typed.
   */
  /*
   * THE SOURCE CONTROL IS ABOVE THE LOCK, not behind it.
   *
   * Found by looking at the screen: it was inside the unlocked view, which
   * means you could not choose which key to talk to until you had already
   * unlocked one. That is backwards - the choice decides WHICH key you would
   * be unlocking, and on a phone with a hard key attached the wrong one may
   * be the one asking for a PIN.
   *
   * So it sits above every state this screen has, and the state view scrolls
   * under it.
   */
  if (emu.device !== 'unlocked') {
    return (
      <ScrollView
        style={styles.root}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}>
        <KeySource keys={keys} />
        <View style={styles.locked}>
          <PinScreen onPress={emu.press} onPressRun={emu.pressRun} canPress={emu.canPress} model={emu.model} settling={emu.settling} led={keys.backend === 'embedded' ? emu.led : undefined} />
        </View>
      </ScrollView>
    );
  }

  return <Unlocked emu={emu} keys={keys} />;
}

/**
 * Which device the rows below are about, in a few words.
 *
 * Says HOW it was chosen as well as which it is, because "Hard Key" alone
 * leaves open whether that was a decision or an accident - and if it was
 * forced, the difference matters: an override stays put when the key is
 * unplugged, and a screen still saying "Hard Key" over a device that has left
 * the building is the kind of stale reading this app keeps trying not to do.
 */
function sourceLabel(keys: KeyControl): string {
  if (keys.override) {
    return `${keys.name} (forced)`;
  }
  if (keys.mode === 'auto') {
    return keys.backend === 'usb'
      ? `${keys.name} (attached)`
      : `${keys.name} (no hard key attached)`;
  }
  return `${keys.name} (chosen)`;
}

function Unlocked({emu, keys}: {emu: EmuSession; keys: KeyControl}) {
  const getKey = useActiveKey();
  const capabilityRows = describeCapabilities(emu.capabilities);

  /**
   * What the LIBRARY has proven against firmware, which is a different
   * question from what THIS KEY can do.
   *
   * `okcrypto.deviceOperations` is a table of operations that have been run
   * against real firmware and checked - the composite PGP pair, the P-256
   * derive checked against a host-computed ECDH, X-Wing's split-custody round
   * trip. It is a property of the library's evidence, not of the device on the
   * bus, and it does not change when a different key is plugged in.
   *
   * SO IT GETS ITS OWN SECTION rather than more rows on the capability table
   * above. Merging them would make a claim about the library look like a
   * property of the key in hand, a few lines below sections that fade
   * precisely because this key cannot do something - which is the confusion
   * the fading rule exists to prevent.
   *
   * Read once, not polled: it is a constant in the plugin, and a value that
   * cannot change does not need a timer the way config mode does.
   */
  const [operations, setOperations] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const {okcrypto} = await getKey();
        if (alive) setOperations(okcrypto.deviceOperations);
      } catch {
        /* No key yet. The section simply does not appear. */
      }
    })();
    return () => {
      alive = false;
    };
  }, [getKey]);

  return (
    <ScrollView
      style={styles.root}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}>
      <KeySource keys={keys} />

      {emu.canPress !== true ? (
        <Section title="Buttons">
          <Text style={styles.hint}>
            This key has its own — six of them, under your finger. The app
            does not draw a keypad for a key you can press. A site asking for
            a security key is waiting on one of these; any will do.
          </Text>
        </Section>
      ) : (
      <Section title="Buttons">
        <Text style={styles.hint}>
          The key's entire input surface. A site asking for a security key
          waits on one of these — any of them will do. Hold one and the counter
          below the light says where you are: up to 20 types the slot, past 20
          types its b profile, and past 72 it stops typing and does something —
          a backup on 1, lock on 3, config mode on 6. It lets go at 89, before
          the point the firmware refuses the press outright.
        </Text>
        {keys.backend === 'embedded' ? (
          <View style={styles.ledRow}>
            <LedCircle pixels={emu.led} />
          </View>
        ) : null}
        <HoldTicks ticks={emu.pressTicks} />
        {emu.settling ? <Text style={styles.settling}>{emu.settling}</Text> : null}
        <View style={styles.pad}>
          <Keypad
            onPress={emu.press}
            onHoldStart={emu.beginHold}
            onHoldEnd={emu.endHold}
            buttons={emu.capabilities?.buttons ?? (emu.model === 'duo' ? 3 : 6)}
          />
        </View>
      </Section>
      )}

      {/*
        THE PANEL NAMES ITS OWN SUBJECT.

        Every row below - firmware, model, build - describes a device, and
        two of them are reachable from this screen. Read on its own, with the
        source card scrolled off the top, "OnlyKey Classic, v3.0.4" does not
        say WHICH key that is. On a phone with both a soft key and a hard one
        attached, that is a genuinely ambiguous reading of a screen whose
        whole job is to be unambiguous.
      */}
      <Section title={`Key — ${keys.name}`}>
        <View style={styles.kv}>
          <KeyValue label="source" value={sourceLabel(keys)} />
          <KeyValue label="state" value="unlocked" />
          <KeyValue label="firmware" value={emu.version || '-'} />
          {/*
            Model and build, not just a version string.

            The build matters to someone reading this screen: a production
            build has no serial console, so the provisioning steps that wait
            on console prompts cannot work against it. Saying "unknown" for
            firmware too old to report a build is deliberate - it is not the
            same claim as "no console".
          */}
          <KeyValue label="model" value={describeModel(emu.identity)} />
          <KeyValue label="build" value={describeBuild(emu.capabilities)} />
          {/*
            THE LED IS THE SOFT KEY'S ALONE.

            The emulator reports its pixel state as data because the host IS
            the hardware. A hard key's LED is light in a room - it never
            reaches the wire, so there is nothing to show and a row saying
            "off" would be a lie about a key that may well be lit.
          */}
          {keys.backend === 'embedded' ? (
            <KeyValue label="LED" value={describeLed(emu.led)} />
          ) : (
            <KeyValue label="LED" value="on the key itself" />
          )}
        </View>
      </Section>

      {capabilityRows.length ? (
        <Section title="What this firmware can do">
          <Text style={styles.hint}>
            Measured against each firmware release by the version matrix, not
            assumed. Where a row here is wrong, a screen somewhere is offering
            something the key cannot do.
          </Text>
          <View style={styles.rows}>
            {capabilityRows.map(row => (
              <KeyValue key={row.label} label={row.label} value={row.value} />
            ))}
          </View>
        </Section>
      ) : null}

      {operations ? (
        <Section title="What the library has proven">
          <Text style={styles.hint}>
            Not about this key. These are the crypto operations the library has
            run against real firmware and checked the answer to — the composite
            PGP pair, a derived secret compared with an ECDH computed on the
            host, X-Wing's split-custody round trip. The list above says what
            the key in your hand can do; this says what has been demonstrated
            at all.
          </Text>
          <View style={styles.rows}>
            {Object.entries(operations)
              .filter(([name]) => name !== 'reason')
              .map(([name, value]) => (
                <KeyValue
                  key={name}
                  label={name}
                  value={value === true ? 'proven' : value === false ? 'no' : String(value)}
                />
              ))}
          </View>
          {typeof operations.reason === 'string' && operations.reason ? (
            <Text style={styles.hint}>{operations.reason}</Text>
          ) : null}
        </Section>
      ) : null}

    </ScrollView>
  );
}

function Message({
  title,
  body,
  tone = 'dim',
  action,
}: {
  title: string;
  body: string;
  tone?: 'dim' | 'error';
  action?: {title: string; onPress: () => void};
}) {
  return (
    <View style={styles.message}>
      <Text style={[styles.messageTitle, tone === 'error' && styles.messageError]}>
        {title}
      </Text>
      <Text style={styles.messageBody}>{body}</Text>
      {action ? (
        <View style={styles.messageAction}>
          <Btn title={action.title} tone="primary" onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

function describeLed(pixels: number[]): string {
  if (!pixels.length) {
    return 'off';
  }
  return pixels
    .slice(0, 2)
    .map(p => `#${p.toString(16).padStart(6, '0')}`)
    .join(' ');
}

const styles = StyleSheet.create({
  rows: {marginTop: 4},
  /*
   * PinScreen centres itself in whatever it is given, and a ScrollView gives
   * a child no height at all - so it needs one here or the pad collapses.
   */
  locked: {minHeight: 520},
  root: {flex: 1},
  content: {paddingBottom: 4},
  kv: {marginTop: 6},
  ledRow: {marginTop: 14, marginBottom: 4},
  spinner: {marginVertical: 18},
  hint: {color: theme.textDim, fontSize: 11, lineHeight: 16, marginTop: 10},
  settling: {color: theme.warn, fontSize: 12, lineHeight: 17, marginTop: 10},
  error: {color: theme.error, fontSize: 12, lineHeight: 17, marginTop: 6},

  slot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: theme.border,
  },
  slotId: {
    color: theme.textDim,
    fontSize: 12,
    fontFamily: theme.mono,
    width: 26,
  },
  slotLabel: {color: theme.text, fontSize: 14, flexShrink: 1},
  slotEmpty: {color: theme.textDim, fontStyle: 'italic'},

  pad: {marginTop: 12},

  message: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 28},
  messageTitle: {color: theme.text, fontSize: 20, fontWeight: '700'},
  messageError: {color: theme.error},
  messageBody: {
    color: theme.textDim,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    marginTop: 10,
  },
  messageAction: {marginTop: 22, alignSelf: 'stretch', paddingHorizontal: 24},
});
