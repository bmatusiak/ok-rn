import React, {useEffect, useRef} from 'react';
import {Animated, Easing, Image, StyleSheet, View} from 'react-native';
import {theme} from './theme';

/*
 * The wordmark, spreading out of "OK".
 *
 * assets/OKS1.png ("ONLY") and assets/OKS2.png ("KEY") are the two halves of
 * assets/onlykey-logo.png, split by the owner so they can move. The whole
 * animation is TWO WIDTHS - each half sits in a clipping view that starts at
 * its first letter and widens to the full word. No image library, no masks.
 *
 * Measured from the art (alpha columns), all at the same 215 px lettering:
 *
 *   start  = assets/OK.png   500 wide = OKS1 clipped to 268 (the O)
 *                                     + OKS2 clipped to 232 (the K)
 *   end    = onlykey-logo.png          = OKS1 at x=67 (960 wide)
 *                                     + OKS2 at x=1027 (746 wide), butted
 *
 * The two halves always touch - every gap in the wordmark is inside the
 * halves' own transparent margins - so nothing but the widths moves. And the
 * box is Logo's box (1840x332, lettering offset 67/58), so the last frame IS
 * <Logo> at the same height: the splash lands exactly on the wordmark the
 * rest of the app shows.
 *
 * Black on transparent like the static logo, so it is tinted the same way
 * (see Logo.tsx).
 */
const LOGO_W = 1840;
const LOGO_H = 332;
const INK_LEFT = 67;
const INK_TOP = 58;
const INK_H = 215;
const ONLY_W = 960;
const KEY_W = 746;
const O_W = 268;
const K_W = 232;

export function AnimatedLogo({
  height = 44,
  tint = theme.text,
  /*
   * The owner's timing: one second showing OK, one second spreading, one
   * second showing the full wordmark - three seconds in all, then onDone.
   */
  delayMs = 1000,
  durationMs = 1000,
  holdMs = 1000,
  onDone,
  mode = 'play',
  runId = 0,
}: {
  /** The same meaning as Logo's height: the whole wordmark box. */
  height?: number;
  tint?: string | null;
  delayMs?: number;
  durationMs?: number;
  /** How long the finished wordmark shows before onDone. */
  holdMs?: number;
  /** Called holdMs after the spread has finished (not if it was stopped). */
  onDone?: () => void;
  /**
   * 'play' spreads from the start frame; 'start' holds the O and the K;
   * 'end' shows the finished wordmark. onDone fires only when a 'play' run
   * finishes.
   */
  mode?: 'start' | 'play' | 'end';
  /** Change it to replay 'play' from the start. */
  runId?: number;
}) {
  const k = height / LOGO_H;
  const spread = useRef(new Animated.Value(0)).current;
  /* Held in a ref so a new callback identity does not restart the animation. */
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (mode !== 'play') {
      spread.setValue(mode === 'end' ? 1 : 0);
      return undefined;
    }
    spread.setValue(0);
    let hold: ReturnType<typeof setTimeout> | undefined;
    const run = Animated.timing(spread, {
      toValue: 1,
      delay: delayMs,
      duration: durationMs,
      easing: Easing.out(Easing.cubic),
      /* width is layout, which the native driver cannot animate */
      useNativeDriver: false,
    });
    run.start(({finished}) => {
      if (finished) hold = setTimeout(() => doneRef.current?.(), holdMs);
    });
    return () => {
      run.stop();
      if (hold) clearTimeout(hold);
    };
  }, [spread, delayMs, durationMs, holdMs, mode, runId]);

  const onlyWidth = spread.interpolate({inputRange: [0, 1], outputRange: [O_W * k, ONLY_W * k]});
  const keyWidth = spread.interpolate({inputRange: [0, 1], outputRange: [K_W * k, KEY_W * k]});
  /*
   * CENTRED AS IT GROWS. The box is only as wide as what shows: both clip
   * widths plus the wordmark's margin on each side - 67 px left AND right in
   * onlykey-logo.png (ink 67..1773 of 1840) - so a centring parent keeps it
   * in the middle, and at the end the box is exactly Logo's 1840.
   */
  const boxWidth = spread.interpolate({
    inputRange: [0, 1],
    outputRange: [(O_W + K_W + 2 * INK_LEFT) * k, LOGO_W * k],
  });
  const art = {height: INK_H * k};
  const tinted = tint ? {tintColor: tint} : null;
  /*
   * THE REST FADES IN AS IT OPENS, so the O and the K stay bright and read
   * first (the owner's call). Each word is drawn twice: the whole word,
   * fading from 0 on the same timeline as the width, and on top of it a
   * fixed clip of just its first letter at full opacity. White over white is
   * invisible, so the letter simply never fades.
   */
  const reveal = spread.interpolate({inputRange: [0, 1], outputRange: [0, 1]});
  const word = (source: number, fullW: number, firstW: number, width: Animated.AnimatedInterpolation<number>) => (
    <Animated.View style={[styles.clip, art, {width}]}>
      <Animated.Image fadeDuration={0} source={source} style={[art, {width: fullW * k, opacity: reveal}, tinted]} />
      <View style={[styles.clip, styles.first, art, {width: firstW * k}]}>
        <Image fadeDuration={0} source={source} style={[art, {width: fullW * k}, tinted]} />
      </View>
    </Animated.View>
  );

  return (
    <Animated.View style={{width: boxWidth, height: LOGO_H * k}}>
      <View style={[styles.row, {left: INK_LEFT * k, top: INK_TOP * k}]}>
        {word(require('../../assets/OKS1.png'), ONLY_W, O_W, onlyWidth)}
        {word(require('../../assets/OKS2.png'), KEY_W, K_W, keyWidth)}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {position: 'absolute', flexDirection: 'row'},
  clip: {overflow: 'hidden'},
  first: {position: 'absolute', left: 0, top: 0},
});
