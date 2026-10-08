/**
 * The background watch (A13, 2026-10-07): no key reads past the head when nothing
 * moved, the clock-driven alarms still run, and two clocks make one schedule.
 */
import {createWatchRound, type WatchAnswer} from '../src/edgeWatchRound';

function setup() {
  let t = 0;
  let moved = true; /* the first round always checks */
  const calls = {validity: 0, synced: 0, alarms: 0};
  const round = createWatchRound<WatchAnswer>({
    now: () => t,
    validity: async () => {
      calls.validity++;
      if (!moved) return {path: 'skipped'};
      moved = false;
      calls.synced++;
      return {path: 'new-links'};
    },
    alarms: async () => { calls.alarms++; },
  }, {periodMs: 15000, alarmEveryMs: 60000});
  return {round, calls, at: (ms: number) => { t = ms; }, link: () => { moved = true; }};
}

test('nothing moved: one sync, then head-only rounds; the alarms on their own clock', async () => {
  const {round, calls, at} = setup();
  for (const ms of [0, 15000, 30000, 45000]) { at(ms); await round.run(); }
  expect(calls).toEqual({validity: 4, synced: 1, alarms: 1});
  at(60000); await round.run();
  expect(calls.alarms).toBe(2); /* an owed receipt or an expired budget still gets seen */
});

test('a new link: synced and its alarms at once, whatever the alarm clock says', async () => {
  const {round, calls, at, link} = setup();
  at(0); await round.run();
  at(15000); link(); await round.run();
  expect(calls).toEqual({validity: 2, synced: 2, alarms: 2});
});

test('the timer and the native tick share one clock: one round per period', async () => {
  const {round, at} = setup();
  at(0); expect(round.due()).toBe(true); await round.run();
  at(10000); expect(round.due()).toBe(false); /* the tick, 10 s in */
  at(14500); expect(round.due()).toBe(true); /* the timer, a little early */
});
