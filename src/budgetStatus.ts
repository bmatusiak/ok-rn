/**
 * A budget's status word (Brad, 2026-10-06): Active; Ended · N tickets owed;
 * Validated - and red when the copy fails its check. "Complete" (every use
 * spent, said while a ticket was still owed - budget 351 on the A13) and a plain
 * "Ended" are gone.
 *
 * VALIDATED IS NEVER STORED. It is read off the view the phone just verified
 * (edgeStore.evaluate - this session's in-memory check, re-done at every start):
 * the budget has ended, the copy verified, every spend of it is in the copy, and
 * each spend and the ticket that answers it are links the check verified.
 */
import {codes} from 'node-onlykey-lib/edge';
import type {EdgeBudget} from './edgeFake';
import type {EdgeView} from './edgeStore';

export type BudgetStatus =
  | {kind: 'active'}
  | {kind: 'ended'; owed: number}
  | {kind: 'validated'}
  | {kind: 'failed'; seq?: number; reason?: string};

export function budgetStatus(b: EdgeBudget, live: boolean, view: EdgeView | null | undefined): BudgetStatus {
  if (live) return {kind: 'active'};
  if (view?.verdict.kind === 'tampered') return {kind: 'failed', seq: view.verdict.seq, reason: view.verdict.reason};
  const rows = view?.rows ?? [];
  const bySeq = new Map(rows.map(r => [r.seq, r]));
  const uses = rows.filter(r => r.fields.grantId === b.grantId && r.fields.decision === codes.DECISION.SELF_PRESS);
  type Paired = {status?: string; ticket?: {seq: number} | null};
  const answered = (r: (typeof rows)[number]) => (r.ticket as Paired | undefined)?.ticket ?? null;
  /* a use with no ticket and no waive, that owes one */
  const owedRows = uses.filter(r => {
    const t = r.ticket as Paired | undefined;
    return !answered(r) && t?.status !== 'no-ticket-owed' && t?.status !== 'waived' && t?.status !== 'waived-unlisted';
  });
  const owed = Math.max(owedRows.length, b.used - (b.ticketsFiled ?? 0));
  if (owed > 0) return {kind: 'ended', owed};
  const allChecked = uses.length === b.used && uses.every(r => {
    const t = answered(r);
    return r.verified && t !== null && bySeq.get(t.seq)?.verified === true;
  });
  return view?.verdict.kind === 'verified' && allChecked ? {kind: 'validated'} : {kind: 'ended', owed: 0};
}

/** the words the cards show */
export function budgetStatusText(s: BudgetStatus): string {
  if (s.kind === 'active') return 'Active';
  if (s.kind === 'validated') return 'Validated';
  if (s.kind === 'failed') return s.seq !== undefined ? `Copy failed its check at #${s.seq}` : 'Copy failed its check';
  return `Ended · ${s.owed} ticket${s.owed === 1 ? '' : 's'} owed`;
}
