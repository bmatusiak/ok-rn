/**
 * ONE CHECK FOR EVERY CONSENT (Brad, 2026-10-05): "the new peer sheet must follow
 * the same rule as budgets and registrations: one shared check, not a per-sheet
 * rule". Every approve / press / settle / accept-loss path asks
 * debugGuard.consentRefusal() - no argument, so nothing a path knows about its
 * request can loosen the lock; only testing mode does (option 1, 2026-10-04).
 *
 * Two halves:
 *  1. the request sheet RENDERED for each kind it shows (budget, registration,
 *     place that keeps copies) with debugging on: refused outside testing mode,
 *     allowed inside it - the same answer for every kind;
 *  2. the source: every other path (settle, accept loss, the key's Confirm panel,
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
/* the lock as every non-TEST build has it - never whatever the last build staged in src/generated */
jest.mock('../src/buildInfo', () => ({...jest.requireActual('../src/buildInfo'), buildInfo: {...jest.requireActual('../src/buildInfo').buildInfo, debugLock: true}}));
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
    ask: {kind: 'request', computer: 'NITRO16', blocked: null, at: Date.now(), view: {
      continues: null, reason: 'TEST: one check', uses: 1, lifetime: 10, covered: [],
      scopes: [{op: 'sign', slot: 221, cap: 1, identity: 'ssh://test@nitro16'}],
    }},
  },
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
  {path: 'settle', file: 'src/screens/EdgeScreen.tsx', anchor: /title="Yes, settle"[^\n]*/},
  {path: 'accept loss (a gap)', file: 'src/screens/EdgeScreen.tsx', anchor: /title=\{`Yes, accept loss of \$\{range\}`\}[^\n]*/},
  /* the press sheet when an EDGE press waits (2026-10-10: it replaced the Confirm panel; every button of it presses through press()) */
  {path: 'the press sheet (Edge)', file: 'src/ui/PressSheet.tsx', anchor: /onPress=\{\(button: string\) => \{\n[^\n]*\n[^\n]*/},
  {path: 'resume a held budget', file: 'src/screens/EdgeScreen.tsx', anchor: /title="Resume"[^\n]*/},
  {path: 'the sheet (budget, registration)', file: 'src/ui/EdgeRequestSheet.tsx', anchor: /const consent = [^\n]*\n[^\n]*/},
  /* 2026-10-08: merging a log a sync brought - every button of the banner's sheet goes through act() */
  {path: 'merge a held log (the banner sheet)', file: 'src/ui/MergeSheet.tsx', anchor: /const act = [\s\S]{0,120}?consentRefusal\(\)/},
];

test.each(PATHS)('$path asks the shared check', ({file, anchor}) => {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const m = text.match(anchor);
  expect(m).not.toBeNull();
  expect(m![0]).toMatch(/consentRefusal\(\)/);
});

test('every "Press the soft key" button on the Edge tab asks the shared check', () => {
  const text = ['src/screens/EdgeScreen.tsx'].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  const presses = [...text.matchAll(/title="Press the soft key"[^\n]*/g)].map(m => m[0]);
  expect(presses.length).toBeGreaterThan(0);
  for (const p of presses) expect(p).toMatch(/consentRefusal\(\)/);
});
