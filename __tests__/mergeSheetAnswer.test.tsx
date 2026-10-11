/**
 * THE MERGE SHEET SHOWS AN ANSWER AT ONCE (two-phone testnet walk, 2026-10-11): after "Keep as
 * evidence" the row, its button and the old evidence count stayed for seconds, because the
 * sheet waited for reviewHeld - which re-checks every held log - before drawing anything.
 * Here reviewHeld answers once and then never again, the way a slow re-check looks from the
 * sheet: the answered row must change without it.
 */
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import {SafeAreaProvider} from 'react-native-safe-area-context';

const METRICS = {frame: {x: 0, y: 0, width: 0, height: 0}, insets: {top: 0, left: 0, right: 0, bottom: 0}};
const mockRow = (deviceId: string, extra: object) => ({
  deviceId, nametag: null, claimed: 'Galaxy A13 5G', class: 'mine-known', count: 4, from: 'nitro16', at: 0,
  checkOk: true, alarm: null, declined: false, leak: false, complete: true, missing: [], ...extra,
});
let mockCalls = 0;
jest.mock('../src/edgeDevices', () => ({
  reviewHeld: jest.fn(() => {
    mockCalls += 1;
    return mockCalls === 1
      ? Promise.resolve([mockRow('aa', {class: 'forged', checkOk: false}), mockRow('bb', {declined: true}), mockRow('cc', {nametag: 'Pixel 6a'})])
      : new Promise(() => undefined);
  }),
  declineHeld: jest.fn(() => Promise.resolve()),
  approveHeld: jest.fn(() => Promise.resolve({merged: 4})),
  notMine: jest.fn(() => Promise.resolve()),
  onDevicesChanged: () => () => undefined,
}));
jest.mock('../src/debugGuard', () => ({consentRefusal: () => null}));
jest.mock('../src/net', () => ({netTag: () => ''}));

import {MergeSheet} from '../src/ui/MergeSheet';

const texts = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(n => typeof n.props.children === 'string').map(n => n.props.children as string);
const press = async (r: TestRenderer.ReactTestRenderer, title: string) => {
  const b = r.root.findAll(n => n.props.title === title && typeof n.props.onPress === 'function')[0];
  await act(async () => { await b.props.onPress(); });
};

test('Keep as evidence: the row leaves the waiting list and the count goes up before the re-check ends', async () => {
  mockCalls = 0;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}><MergeSheet visible onClose={() => undefined} /></SafeAreaProvider>);
  });
  expect(texts(r)).toContain('1 log kept as evidence on this phone.');
  await press(r, 'Keep as evidence');
  expect(r.root.findAll(n => n.props.title === 'Keep as evidence')).toHaveLength(0);
  expect(texts(r)).toContain('2 logs kept as evidence on this phone.');
  expect(texts(r)).toContain('Kept as evidence.');
});

test('Approve - merge: the merged row is gone before the re-check ends', async () => {
  mockCalls = 0;
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(<SafeAreaProvider initialMetrics={METRICS}><MergeSheet visible onClose={() => undefined} /></SafeAreaProvider>);
  });
  await press(r, 'Approve - merge');
  expect(r.root.findAll(n => n.props.title === 'Approve - merge')).toHaveLength(0);
  expect(texts(r)).toContain('Merged "Pixel 6a".');
});
