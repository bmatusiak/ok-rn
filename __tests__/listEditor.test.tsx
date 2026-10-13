/**
 * The add/remove list (src/ui/ListEditor.tsx) Guest Book's edit page uses for phones, emails and
 * nicknames: + Add appends a row, tapping a label moves it to the next one, ✕ removes the row.
 */
import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ListEditor, type ListRow} from '../src/ui/ListEditor';

function harness(start: ListRow[]) {
  let rows = start;
  let tree!: ReactTestRenderer.ReactTestRenderer;
  const render = () =>
    React.createElement(ListEditor, {title: 'Phone', rows, onChange: (r: ListRow[]) => { rows = r; act(() => tree.update(render())); }, addTitle: 'Add phone', labels: ['Mobile', 'Home', 'Work', 'Other']});
  act(() => { tree = ReactTestRenderer.create(render()); });
  const press = (label: string) => {
    const p = tree.root.findAll(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')[0];
    act(() => p.props.onPress());
  };
  return {rows: () => rows, press};
}

test('add a row, change its label, remove it', () => {
  const h = harness([{label: 'Mobile', value: '555-0100'}]);
  h.press('Add phone');
  expect(h.rows()).toEqual([{label: 'Mobile', value: '555-0100'}, {label: 'Mobile', value: ''}]);
  h.press('Phone label Mobile, tap to change');
  expect(h.rows()[0].label).toBe('Home');
  h.press('Remove Phone 1');
  expect(h.rows()).toEqual([{label: 'Mobile', value: ''}]);
});
