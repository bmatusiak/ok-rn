/**
 * The budget's status word (Brad, 2026-10-06): Active; Ended · N tickets owed;
 * Validated only when ended and every use's ticket verified in this session's
 * check; red when the copy fails. Never read from storage.
 */
import {codes} from 'node-onlykey-lib/edge';
import {budgetStatus, budgetStatusText} from '../src/budgetStatus';
import type {EdgeBudget} from '../src/edgeFake';
import type {EdgeView} from '../src/edgeStore';

const ID = 351;
const budget = (used: number, ticketsFiled: number): EdgeBudget =>
  ({grantId: ID, reason: 'test', uses: 4, used, scopes: [], genesis: new Uint8Array(0), ticketsFiled} as unknown as EdgeBudget);

/* uses at 10, 12, ...; the ticket for each at the seq after it, when `ticketed` */
function view(used: number, ticketed: number, opts: {verdict?: EdgeView['verdict']; unverified?: number[]} = {}): EdgeView {
  const rows: unknown[] = [];
  for (let i = 0; i < used; i++) {
    const seq = 10 + 2 * i;
    const t = i < ticketed ? {status: 'ticketed', ticket: {seq: seq + 1}} : {status: 'missing', ticket: null};
    rows.push({seq, fields: {seq, grantId: ID, decision: codes.DECISION.SELF_PRESS}, verified: !(opts.unverified ?? []).includes(seq), ticket: t});
    if (i < ticketed) rows.push({seq: seq + 1, fields: {seq: seq + 1, grantId: seq, decision: 0}, verified: !(opts.unverified ?? []).includes(seq + 1)});
  }
  return {verdict: opts.verdict ?? {kind: 'verified', through: 30}, headSeq: 30, lastSync: null, rows: rows as EdgeView['rows'], setAside: [], refusals: [], continued: null} as unknown as EdgeView;
}

test('a live budget is Active, whatever it spent', () => {
  expect(budgetStatusText(budgetStatus(budget(4, 2), true, view(4, 2)))).toBe('Active');
});

test('an ended budget with 2 of 4 spent and no tickets: Ended · 2 tickets owed', () => {
  expect(budgetStatusText(budgetStatus(budget(2, 0), false, view(2, 0)))).toBe('Ended · 2 tickets owed');
});

test('every use ticketed in a verified copy: Validated', () => {
  expect(budgetStatusText(budgetStatus(budget(4, 4), false, view(4, 4)))).toBe('Validated');
});

test('a ticket link the check did not verify: not Validated', () => {
  expect(budgetStatus(budget(4, 4), false, view(4, 4, {unverified: [17]}))).toEqual({kind: 'ended', owed: 0});
});

test('a copy that failed its check is red, never Validated', () => {
  const s = budgetStatus(budget(4, 4), false, view(4, 4, {verdict: {kind: 'tampered', seq: 13, reason: 'hash-mismatch'} as EdgeView['verdict']}));
  expect(s.kind).toBe('failed');
  expect(budgetStatusText(s)).toBe('Copy failed its check at #13');
});

test('nothing checked yet (no view): not Validated', () => {
  expect(budgetStatus(budget(4, 4), false, null)).toEqual({kind: 'ended', owed: 0});
});
