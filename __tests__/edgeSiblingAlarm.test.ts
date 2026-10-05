/**
 * R30 (spec, 2026-10-05): the stopped-anchoring alarm - a paired key with no
 * anchor here for 24 h (a setting) is an alarm, with a reminder at 20 h; each
 * stage posts once per clock start; nothing syncs on its own.
 */
const mockAnchors: Record<string, number[]> = {};
const mockPost = jest.fn();
jest.mock('../src/edgeStore', () => ({
  loadMirror: async (id: Uint8Array) => ({anchors: (mockAnchors[Array.from(id, x => x.toString(16).padStart(2, '0')).join('')] ?? []).map(at => ({seq: 1, mySeq: 1, at}))}),
}));
jest.mock('../specs/NativeEdgeAlert', () => ({__esModule: true, default: {post: (...a: unknown[]) => mockPost(...a)}}));
jest.mock('../src/edgeSiblingNames', () => ({siblingNames: async () => ({['aa'.repeat(64)]: 'A13'})}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {raiseSiblingAlarms, reminderHours, setAlarmHours, stageOf} from '../src/edgeSiblingAlarm';

const H = 3600_000;
const sib = {key: 'aa'.repeat(64), deviceId: '11'.repeat(16)};

beforeEach(async () => {
  mockPost.mockClear();
  for (const k of Object.keys(mockAnchors)) delete mockAnchors[k];
  await AsyncStorage.clear();
});

test('stages: quiet, a reminder 4 h before, the alarm at the setting', () => {
  expect(reminderHours(24)).toBe(20);
  expect(reminderHours(12)).toBe(8);
  expect(stageOf(19.9 * H, 24)).toBe(0);
  expect(stageOf(20 * H, 24)).toBe(1);
  expect(stageOf(24 * H, 24)).toBe(2);
  expect(stageOf(9 * H, 12)).toBe(1);
});

test('a key never anchored or paired here starts its clock at the first look - no alarm yet', async () => {
  await raiseSiblingAlarms([sib], 1_000 * H);
  expect(mockPost).not.toHaveBeenCalled();
  await raiseSiblingAlarms([sib], 1_021 * H);
  expect(mockPost).toHaveBeenCalledTimes(1); /* 21 h after that first look: the reminder */
});

test('anchored 21 h ago: the reminder once; at 25 h the alarm once; a new anchor starts over', async () => {
  const now = 10_000 * H;
  mockAnchors['11'.repeat(16)] = [now - 21 * H];
  await raiseSiblingAlarms([sib], now);
  await raiseSiblingAlarms([sib], now + 60_000);
  expect(mockPost).toHaveBeenCalledTimes(1);
  expect(mockPost.mock.calls[0][1]).toMatch(/sync with A13 soon/);
  expect(mockPost.mock.calls[0][4]).toBe(true); /* the reminder is quiet */
  await raiseSiblingAlarms([sib], now + 4 * H);
  expect(mockPost).toHaveBeenCalledTimes(2);
  expect(mockPost.mock.calls[1][1]).toMatch(/A13 has not synced for 24 h/);
  expect(mockPost.mock.calls[1][4]).toBe(false);
  await raiseSiblingAlarms([sib], now + 8 * H);
  expect(mockPost).toHaveBeenCalledTimes(2);
  mockAnchors['11'.repeat(16)].push(now + 9 * H); /* synced again */
  await raiseSiblingAlarms([sib], now + 10 * H);
  expect(mockPost).toHaveBeenCalledTimes(2);
});

test('the setting moves both stages', async () => {
  await setAlarmHours(12);
  const now = 20_000 * H;
  mockAnchors['11'.repeat(16)] = [now - 13 * H];
  await raiseSiblingAlarms([sib], now);
  expect(mockPost.mock.calls[0][1]).toMatch(/has not synced for 12 h/);
});
