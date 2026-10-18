/**
 * The scrolling-list picker (src/ui/ListPicker.tsx) - "not a pile of buttons": one field row, a
 * tap opens the list; several at once toggle with ✓, one at a time picks and closes.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ListPicker, type PickItem} from '../src/ui/ListPicker';

jest.mock('react-native-safe-area-context', () => ({useSafeAreaInsets: () => ({top: 0, bottom: 0, left: 0, right: 0})}));

const ITEMS: PickItem[] = [
  {key: 'a', title: 'Alice', detail: '✓ verified', detailTone: 'ok'},
  {key: 'b', title: 'Bob', detail: '! unverified', detailTone: 'warn'},
];

function harness(multi: boolean) {
  let picked: string[] = [];
  let opened = 0;
  let tree!: ReactTestRenderer.ReactTestRenderer;
  const render = () =>
    React.createElement(ListPicker, {
      label: 'To',
      placeholder: 'Pick people',
      items: ITEMS,
      selected: picked,
      multi,
      onOpen: () => { opened += 1; },
      onChange: (k: string[]) => { picked = k; act(() => tree.update(render())); },
    });
  act(() => { tree = ReactTestRenderer.create(render()); });
  const press = (label: string) => {
    const p = tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
    if (!p) throw new Error(`no "${label}"`);
    act(() => p.props.onPress());
  };
  const has = (label: string) => tree.root.findAll(n => n.props.accessibilityLabel === label).length > 0;
  return {picked: () => picked, opened: () => opened, press, has};
}

test('several: toggle rows on and off; the field names them', () => {
  const h = harness(true);
  h.press('To: Pick people');
  expect(h.opened()).toBe(1);
  h.press('Pick Alice');
  h.press('Pick Bob');
  expect(h.picked()).toEqual(['a', 'b']);
  h.press('Picked Alice');
  expect(h.picked()).toEqual(['b']);
  expect(h.has('To: Bob')).toBe(true);
});

test('one: a tap picks it', () => {
  const h = harness(false);
  h.press('To: Pick people');
  h.press('Pick Bob');
  expect(h.picked()).toEqual(['b']);
});
