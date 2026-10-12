/**
 * THE SHEET KEEPS OFF THE SYSTEM BARS (Brad, 2026-10-12: "you never consider the action/guesture or
 * status/notification bar's space. if we make stuff re-usable, it prevents this kinda thing").
 * With the A13's 3-button bar (63 px) and a 48 px status bar, the content sits above the bar and
 * the top stays below the clock; Back closes only a sheet that may be closed.
 */
import React from 'react';
import {Dimensions, Modal, StyleSheet, Text} from 'react-native';
import TestRenderer, {act} from 'react-test-renderer';
import {SafeAreaProvider} from 'react-native-safe-area-context';

import {Sheet} from '../src/ui/Sheet';

const BARS = {frame: {x: 0, y: 0, width: 400, height: 800}, insets: {top: 48, left: 0, right: 0, bottom: 63}};

function render(el: React.ReactElement) {
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(<SafeAreaProvider initialMetrics={BARS}>{el}</SafeAreaProvider>);
  });
  return r;
}

test('the content sits above the gesture / 3-button bar, the top below the status bar', () => {
  const r = render(
    <Sheet tone="edge" title="A prompt">
      <Text>body</Text>
    </Sheet>,
  );
  const style = StyleSheet.flatten(r.root.findByProps({testID: 'sheet'}).props.style);
  expect(style.paddingBottom).toBe(63);
  expect(style.maxHeight).toBe(Dimensions.get('window').height - 48 - 24);
  const modal = r.root.findByType(Modal);
  expect(modal.props.statusBarTranslucent).toBe(true);
  expect(modal.props.navigationBarTranslucent).toBe(true);
});

test('Back closes a sheet that may be closed, and nothing else', () => {
  const onClose = jest.fn();
  const open = render(<Sheet onClose={onClose}><Text>x</Text></Sheet>);
  act(() => open.root.findByType(Modal).props.onRequestClose());
  expect(onClose).toHaveBeenCalledTimes(1);
  const fixed = render(<Sheet><Text>x</Text></Sheet>);
  expect(() => act(() => fixed.root.findByType(Modal).props.onRequestClose())).not.toThrow();
  expect(fixed.root.findAllByProps({accessibilityLabel: 'Close'})).toHaveLength(0);
});
