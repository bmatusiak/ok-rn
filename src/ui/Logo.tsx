import React from 'react';
import {Image, type StyleProp, type ImageStyle} from 'react-native';
import {theme} from './theme';

/*
 * The OnlyKey mark, taken from the app rewrite so both apps carry the same
 * identity.
 *
 *   assets/onlykey-logo.png  1840x332  public/images/onlykey-logo_full.png
 *   assets/onlykey-mark.png   128x128  resources/onlykey_logo_128.png
 *
 * Two shapes because they are not interchangeable: the wordmark is 5.5:1 and
 * turns into an unreadable sliver in a top bar, and the square mark says
 * nothing on a splash screen. Heights are fixed and widths derived from the
 * real aspect ratio, so neither is ever squashed.
 *
 * BOTH ASSETS ARE BLACK ON TRANSPARENT, so they are invisible on this
 * background until recoloured. The rewrite does the same thing in CSS and says
 * so: "Transparent PNG is black by default - invert to white on dark UI",
 * `filter: brightness(0) invert(1)` (ok-app-rewrite/src/index.css:476). RN's
 * tintColor replaces every opaque pixel, which for a monochrome mark is the
 * same operation. A `tint` of null opts out if a coloured asset ever lands
 * here.
 */
const WORDMARK_RATIO = 1840 / 332;

export function Logo({
  variant = 'wordmark',
  height = 44,
  tint = theme.text,
  style,
}: {
  variant?: 'wordmark' | 'mark';
  height?: number;
  tint?: string | null;
  style?: StyleProp<ImageStyle>;
}) {
  const mark = variant === 'mark';
  const size = {width: mark ? height : height * WORDMARK_RATIO, height};

  return (
    <Image
      source={
        mark
          ? require('../../assets/onlykey-mark.png')
          : require('../../assets/onlykey-logo.png')
      }
      style={[size, tint ? {tintColor: tint} : null, style]}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="OnlyKey"
    />
  );
}
