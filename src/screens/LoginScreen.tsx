import React from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {Logo} from '../ui/Logo';
import {Btn} from '../ui/components';
import {theme} from '../ui/theme';
import {buildInfo} from '../buildInfo';
import type {DeviceState} from '../hooks/useOkEmu';

/**
 * The first thing you see, and a provenance screen as much as a door.
 *
 * "Which firmware and which library is this actually running" is the first
 * question worth answering on a device whose whole premise is that it carries
 * someone else's C compiled for Android - so the versions lead, rather than
 * hiding in an About box.
 */
export function LoginScreen({
  device,
  attached,
  onContinue,
  onTesting,
}: {
  device: DeviceState;
  attached?: boolean | null;
  onContinue: () => void;
  /** Turns testing mode on from outside the door. Debug builds only. */
  onTesting?: () => void;
}) {
  const setup = device === 'uninitialized';
  const hint = setup
    ? 'This key has no PIN yet. Choose one to finish setting it up.'
    : device === 'locked'
      ? null
      : 'Waiting for the key…';


  return (
    <View style={styles.root}>
      <Logo height={44} />

      <View style={styles.versions}>
        <Row label="firmware" value={buildInfo.firmware} />
        {buildInfo.sources ? <Row label="sources" value={buildInfo.sources} /> : null}
        <Row label="built for" value={buildInfo.builtFor} />
        <Row label="library" value={buildInfo.library} />
        <Row label="app" value={buildInfo.app} />
      </View>

      {/*
        * A HARD KEY BEING PRESENT IS NOT VISIBLE ANYWHERE ELSE ON THIS SCREEN.
        *
        * Everything in the card above comes from `buildInfo` - the soft key's
        * staged firmware, baked in at build time - so it reads exactly the same
        * with a key plugged in as without, and describes the emulator either
        * way. Attachment is the one fact here that the device gets a say in.
        *
        * `attached` is tri-state: null means USB has not answered yet, which is
        * not the same as nothing being there, so only `true` says anything.
        */}
      {attached === true ? (
        <Text style={styles.attached}>Hard key attached</Text>
      ) : null}

      <View style={styles.action}>
        <Btn
          title={setup ? 'Set up this key' : 'Log in'}
          tone="primary"
          onPress={onContinue}
        />
        {/*
          * THE PIN LINE IS GONE at the user's direction: by the time it was
          * read the keypad it describes is already on screen, and it said
          * nothing the pad did not. What is left are the two states that are
          * not "enter your PIN" - a key with no PIN yet, and one that has not
          * answered.
          */}
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>

      {/*
        * TESTING MODE SITS AT THE FOOT OF THE PAGE, not under Log in.
        *
        * It is not part of logging in - it is a non-production tool that
        * bypasses the PIN and drops the screenshot block - and a button
        * directly below the primary action reads as a second way to do the
        * same thing. Absolutely positioned so it does not shift the centred
        * block above it.
        *
        * `__DEV__` rather than a prop check alone: this must not exist in a
        * release bundle at all, not merely go unrendered. It is the only way
        * in from outside the door - the toggle lives in the drawer, which
        * opens from a top bar this screen does not draw - so tools/e2e.js taps
        * it too.
        */}
      {__DEV__ && onTesting ? (
        <View style={styles.devFooter}>
          <View style={styles.devFooterInner}>
            <Btn title="Enter testing mode" onPress={onTesting} />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function Row({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text style={styles.rowValue} numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24},
  versions: {
    marginTop: 36,
    width: '100%',
    maxWidth: 320,
    borderRadius: theme.radius,
    borderWidth: 1,
    borderColor: theme.border,
    backgroundColor: theme.surface,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  row: {flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 6},
  rowLabel: {color: theme.textDim, fontSize: 12},
  rowValue: {color: theme.textSecondary, fontSize: 12, fontFamily: theme.mono, flexShrink: 1},
  attached: {
    marginTop: 12,
    color: theme.textSecondary,
    fontSize: 12,
    textAlign: 'center',
  },
  /*
   * left/right rather than a width, with the sizing on the inner view: an
   * absolute box takes its width from its anchors, so `maxWidth` alone pinned
   * it to the left edge at 320 wide instead of centring it. The inner view
   * carries the same 320 cap as `action`, so it lines up under Log in.
   */
  devFooter: {
    position: 'absolute',
    left: 24,
    right: 24,
    bottom: 24,
    alignItems: 'center',
  },
  devFooterInner: {width: '100%', maxWidth: 320},
  action: {marginTop: 32, width: '100%', maxWidth: 320, gap: 12},
  hint: {color: theme.textDim, fontSize: 12, textAlign: 'center', lineHeight: 17},
});
