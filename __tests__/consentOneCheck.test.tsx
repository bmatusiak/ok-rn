/**
 * ONE CHECK FOR EVERY CONSENT (Brad, 2026-10-05): "the new peer sheet must follow
 * the same rule as budgets and registrations: one shared check, not a per-sheet
 * rule". Every approve / press / waive / accept-loss path asks
 * debugGuard.consentRefusal() - no argument, so nothing a path knows about its
 * request can loosen the lock; only testing mode does (option 1, 2026-10-04).
 *
 * Two halves:
 *  1. the request sheet RENDERED for each kind it shows (budget, registration,
 *     place that keeps copies) with debugging on: refused outside testing mode,
 *     allowed inside it - the same answer for every kind;
 *  2. the source: every other path (waive, accept loss, the key's Confirm panel,
 *     the press buttons, Mark as test) calls the shared check, no file but
 *     debugGuard reads the debugging state, and no call passes an argument.
 * A sibling (P2b, R29) is a sheet kind when it lands: the kinds list below must
 * then name it, or half 1 fails on the unknown kind.
 */
import React from 'react';
import TestRenderer, {act} from 'react-test-renderer';
import NativeOkEmu from '../specs/NativeOkEmu';

/* no Node types in this project's tsconfig - typed by hand, as configModeHasOneWriter.test.ts does */
declare const __dirname: string;
const fs = require('fs') as {
  readFileSync(p: string, encoding: string): string;
  readdirSync(p: string, opts: {withFileTypes: true}): {name: string; isDirectory(): boolean}[];
};
const path = require('path') as {join(...parts: string[]): string};

let mockSheetState: any = null;
jest.mock('../src/edgeAgents', () => ({
  onSheet: (l: (s: any) => void) => { l(mockSheetState); return () => undefined; },
  answerSheet: jest.fn(),
  closeSheet: jest.fn(),
  pressFromSheet: jest.fn(),
}));

const {EdgeRequestSheet} = require('../src/ui/EdgeRequestSheet');
const guard = require('../src/debugGuard');

const debugging = (on: boolean) => (NativeOkEmu.debuggingOn as jest.Mock).mockReturnValue(on);

/* every kind of SheetAsk (src/edgeAgents.ts) and the button that gives consent on it */
const KINDS: Record<string, {ask: any; button: string}> = {
  request: {
    button: 'Approve',
    ask: {kind: 'request', agentName: 'claude', blocked: null, at: Date.now(), view: {
      agent: 'aa'.repeat(32), continues: null, reason: 'TEST: one check', uses: 1, lifetime: 10, covered: [], ownWarning: false,
      scopes: [{op: 'sign', slot: 221, cap: 1, identity: 'ssh://test@nitro16'}],
    }},
  },
  register: {button: 'Register', ask: {kind: 'register', agent: 'bb'.repeat(32), name: 'claude', fingerprint: 'bbbbbbbb…bbbbbbbb'}},
  peer: {button: 'Add', ask: {kind: 'peer', peer: 'cc'.repeat(64), name: 'TEST: copies', fingerprint: 'cccccccc…cccccccc'}},
};

test('the kinds list names every SheetAsk kind (a new kind - a sibling - must be added here)', () => {
  const src = fs.readFileSync(path.join(__dirname, '../src/edgeAgents.ts'), 'utf8');
  const union = src.slice(src.indexOf('export type SheetAsk'), src.indexOf('export type SheetState'));
  const kinds = [...union.matchAll(/kind: '([a-z]+)'/g)].map(m => m[1]).sort();
  expect(kinds).toEqual(Object.keys(KINDS).sort());
});

function consentButton(kind: string) {
  mockSheetState = {phase: 'ask', ask: KINDS[kind].ask, until: Date.now() + 120000};
  let r: any;
  jest.useFakeTimers();
  act(() => { r = TestRenderer.create(<EdgeRequestSheet />); });
  /* the buttons wake 1 s after the sheet appears (no double taps) - past that, only the lock can hold them */
  act(() => { jest.advanceTimersByTime(1100); });
  jest.useRealTimers();
  const b = r.root.findAll((n: any) => n.props && n.props.title === KINDS[kind].button && typeof n.type === 'function')[0];
  const refused = r.root.findAll((n: any) => typeof n.props?.children === 'string' && n.props.children === guard.DEBUG_REFUSAL).length > 0;
  const disabled = !!b.props.disabled; /* read before the unmount */
  act(() => r.unmount());
  return {disabled, refused};
}

describe.each(Object.keys(KINDS))('the %s sheet', kind => {
  afterEach(() => { guard.setTestingMode(false); debugging(false); });

  test('debugging on, outside testing mode: refused with the shared text', () => {
    debugging(true);
    guard.setTestingMode(false);
    expect(consentButton(kind)).toEqual({disabled: true, refused: true});
  });

  test('debugging on, in testing mode: allowed - the same rule as every other kind', () => {
    debugging(true);
    guard.setTestingMode(true);
    expect(consentButton(kind)).toEqual({disabled: false, refused: false});
  });
});

/* ---------------------------------------------------------------- the source */

const ROOT = path.join(__dirname, '..');
function sources(): {file: string; text: string}[] {
  const out: {file: string; text: string}[] = [{file: 'App.tsx', text: fs.readFileSync(path.join(ROOT, 'App.tsx'), 'utf8')}];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(path.join(ROOT, dir), {withFileTypes: true})) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(rel);
      else if (/\.(ts|tsx)$/.test(e.name)) out.push({file: rel, text: fs.readFileSync(path.join(ROOT, rel), 'utf8')});
    }
  };
  walk('src');
  return out;
}

test('only debugGuard reads the debugging state - no path keeps its own copy of the lock', () => {
  const readers = sources().filter(s => s.file !== 'src/debugGuard.ts' && /debuggingOn\s*\(/.test(s.text)).map(s => s.file);
  expect(readers).toEqual([]);
});

test('no call passes anything to the shared check - nothing a path knows can loosen it', () => {
  const withArgs = sources().flatMap(s => [...s.text.matchAll(/consentRefusal\(\s*[^)\s]/g)].map(() => s.file));
  expect(withArgs).toEqual([]);
});

/*
 * Each path outside the sheet: the file, and a stretch of source that must hold
 * the shared check (the line with the button or the handler).
 */
const PATHS: {path: string; file: string; anchor: RegExp}[] = [
  {path: 'waive', file: 'src/screens/EdgeScreen.tsx', anchor: /title="Yes, waive"[^\n]*/},
  {path: 'accept loss (a gap)', file: 'src/screens/EdgeScreen.tsx', anchor: /title=\{`Yes, accept loss of \$\{range\}`\}[^\n]*/},
  {path: 'accept loss (restore)', file: 'src/screens/EdgeScreen.tsx', anchor: /title=\{`Yes, accept loss of \$\{lossRange\}`\}[^\n]*/},
  /* the soft key's Confirm panel when an EDGE press waits (the FIDO Confirm above it is a passkey press, not an Edge consent) */
  {path: 'the key\'s Confirm panel (Edge)', file: 'App.tsx', anchor: /title="Confirm" tone="primary" onPress=\{\(\) => \{ if \(keyWaiting\.what === 'edge'[^\n]*/},
  {path: 'resume a held budget', file: 'src/screens/EdgeScreen.tsx', anchor: /title="Resume"[^\n]*/},
  {path: 'Mark as test', file: 'src/ui/EdgeAgentsCard.tsx', anchor: /title="Mark as test"[\s\S]{0,400}?setTestRefused\(true\)/},
  {path: 'the sheet (budget, registration, peer, sibling)', file: 'src/ui/EdgeRequestSheet.tsx', anchor: /const consent = [^\n]*\n[^\n]*/},
];

test.each(PATHS)('$path asks the shared check', ({file, anchor}) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = text.match(anchor);
  expect(m).not.toBeNull();
  expect(m![0]).toMatch(/consentRefusal\(\)/);
});

test('every "Press the soft key" button on the Edge tab asks the shared check', () => {
  const text = fs.readFileSync(path.join(ROOT, 'src/screens/EdgeScreen.tsx'), 'utf8');
  const presses = [...text.matchAll(/title="Press the soft key"[^\n]*/g)].map(m => m[0]);
  expect(presses.length).toBeGreaterThan(0);
  for (const p of presses) expect(p).toMatch(/consentRefusal\(\)/);
});
