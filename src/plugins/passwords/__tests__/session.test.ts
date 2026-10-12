/* The session policy and time left, in words (src/plugins/passwords/session.ts). */
import {policyWords, timeLeftWords} from '../session';

test('the policy, as the locked view says it', () => {
  expect(policyWords('session:30m')).toBe('30 minutes of use (each use restarts it)');
  expect(policyWords('session:1h')).toBe('1 hour of use (each use restarts it)');
  expect(policyWords('session:2h')).toBe('2 hours');
  expect(policyWords('startup')).toBe('until the app closes');
  expect(policyWords('always')).toBe('one use: every open asks the key');
  expect(policyWords(undefined)).toBe('one use: every open asks the key');
});

test('the time left, as the open list says it', () => {
  expect(timeLeftWords(27 * 60000)).toBe('open, 27 min left');
  expect(timeLeftWords(26.2 * 60000)).toBe('open, 27 min left');
  expect(timeLeftWords(30000)).toBe('open, under a minute left');
  expect(timeLeftWords(Infinity)).toBe('open until the app closes');
});
