import React, {useEffect, useRef, useState} from 'react';
import {Animated, Easing, StyleSheet, View, type StyleProp, type ViewStyle} from 'react-native';
import {currentNet, onNet} from '../net';
import {theme} from './theme';

/*
 * A COUNTDOWN BAR that follows the wall clock in fixed windows - shared, because two features
 * count down the same way: the Password Manager's TOTP codes (30 s) and Guest Book's rotating
 * swap QR (15 s, guestbook/src/invite.js). Windows start on multiples of the period since the
 * epoch, exactly as both codes do, so the bar empties the moment the code changes.
 */

/*
 * QUIET MOTION IN TESTING MODE (Brad, 2026-10-12: "during test mode disable animation if you
 * need to"). The screen tools (tools/tap.js, uiautomator) read a screen only after a second with
 * no change, and a moving time bar or a seconds counter never gives one - so in testing mode
 * (a debug build on the testnet, src/net.ts) the bars step every 5 s and the counters tick on
 * 5-second marks. Everyday use keeps the smooth bar.
 */
export function useQuietMotion(): boolean {
  const [quiet, setQuiet] = useState(() => __DEV__ && currentNet() === 'test');
  useEffect(() => onNet(net => setQuiet(__DEV__ && net === 'test')), []);
  return quiet;
}

/*
 * THE TIME LEFT, as a bar (Brad, 2026-10-11: "i want to add a progress bar"): full when a code
 * starts, empty when it changes; yellow in its last 5 s. Its own clock, so a screen can drop it in
 * anywhere - the picker has one at its top for every code it lists (they share the 30 s window).
 */
/*
 * One native animation per window (useNativeDriver), not a redraw every 250 ms: React draws the
 * bar twice per window (the start, and yellow at 5 s left). A screen that repaints all the time
 * also never goes idle for the UI tooling (tools/tap.js: "something on screen is repainting
 * continuously"), which a live code row in the list would otherwise cause.
 */
/* style: placed by the screen - e.g. flush along the bottom edge of the swap QR */
export function CountdownBar({period = 30, stepSeconds, style}: {period?: number; stepSeconds?: number; style?: StyleProp<ViewStyle>}) {
  const quiet = useQuietMotion();
  const steps = stepSeconds ?? (quiet ? 5 : undefined);
  const left = useRef(new Animated.Value(1)).current;
  const [width, setWidth] = useState(0);
  const [warn, setWarn] = useState(false);
  /*
   * Steps instead of motion (stepSeconds, or every 5 s in testing mode - useQuietMotion): the bar
   * jumps every N seconds. A screen with ANY continuous motion, native or not, never gives the UI
   * tooling the quiet second it reads in (measured on the Pixel 2026-10-12: the list stayed
   * unreadable with the native bar); steps leave quiet gaps.
   */
  useEffect(() => {
    if (!steps) return;
    let timer: ReturnType<typeof setTimeout>;
    const step = () => {
      const s = period - ((Date.now() / 1000) % period);
      const shown = Math.ceil(s / steps) * steps;
      left.setValue(Math.min(1, shown / period));
      setWarn(s <= 5);
      timer = setTimeout(step, (s - (shown - steps)) * 1000 + 20);
    };
    step();
    return () => clearTimeout(timer);
  }, [period, steps, left]);
  useEffect(() => {
    if (steps) return;
    let timers: ReturnType<typeof setTimeout>[] = [];
    const run = () => {
      const s = period - ((Date.now() / 1000) % period);
      left.setValue(s / period);
      setWarn(s <= 5);
      Animated.timing(left, {toValue: 0, duration: s * 1000, easing: Easing.linear, useNativeDriver: true}).start();
      timers = [setTimeout(() => setWarn(true), Math.max(0, (s - 5) * 1000)), setTimeout(run, s * 1000 + 20)];
    };
    run();
    return () => {
      timers.forEach(clearTimeout);
      left.stopAnimation();
    };
  }, [period, left, steps]);
  /* the fill slides out to the left as the window runs out; the track clips it */
  const translateX = left.interpolate({inputRange: [0, 1], outputRange: [-width, 0]});
  return (
    <View style={[styles.track, style]} onLayout={e => setWidth(e.nativeEvent.layout.width)}>
      <Animated.View style={[styles.fill, {width: '100%', backgroundColor: warn ? theme.warn : theme.ok, transform: [{translateX}]}]} />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {height: 4, borderRadius: 2, backgroundColor: theme.inputBg, overflow: 'hidden', marginTop: 8},
  /* as tall as its track, whatever height the screen gives the track */
  fill: {height: '100%', borderRadius: 2},
});
