/*
 * R13b (Brad, 2026-10-06): the press prompt shows the agent's text only when it
 * hashes to the intent the agent armed the key with; otherwise "intent unknown".
 */
import {grants} from 'node-onlykey-lib/edge';
import {armedIntent, intentForPrompt, noteIntentText, resetIntents} from '../src/edgeIntent';

beforeEach(() => resetIntents());

test('no armed intent: nothing extra on the prompt', () => {
  noteIntentText('git push origin master');
  expect(intentForPrompt()).toEqual({kind: 'none'});
});

test('the armed intent and a note whose text hashes to it: "the agent says"', () => {
  noteIntentText('git push origin master');
  armedIntent(grants.intentOf('git push origin master'));
  expect(intentForPrompt()).toEqual({kind: 'says', text: 'git push origin master'});
});

test('an armed intent with no matching text: unknown - never another text', () => {
  noteIntentText('something else entirely');
  armedIntent(grants.intentOf('git push origin master'));
  expect(intentForPrompt()).toEqual({kind: 'unknown'});
});

test('an ARM without an intent clears it; an old arm expires', () => {
  noteIntentText('x');
  armedIntent(grants.intentOf('x'));
  armedIntent(null);
  expect(intentForPrompt()).toEqual({kind: 'none'});
  armedIntent(grants.intentOf('x'));
  expect(intentForPrompt(Date.now() + 61_000)).toEqual({kind: 'none'});
});
