/**
 * A budget's status word (spec okrn-edge-tab.md, Budgets; Brad, 2026-10-06):
 *   Active     - live with uses left, OR any use still owes a ticket ("it's
 *                still active if a ticket is owed"); when nothing more can be
 *                spent it says so: "Active · 1 ticket owed · no uses left";
 *   Validated  - ended, and every use has a ticket that verifies in the copy
 *                re-checked this session - the only green "done";
 *   red        - the copy failed its check.
 * There is no "Complete" and no "Ended" state.
 *
 * VALIDATED IS NEVER STORED. It is read off the view the phone just verified
 * (edgeStore.evaluate - this session's in-memory check, re-done at every start).
 */
import {codes} from 'node-onlykey-lib/edge';
import type {EdgeBudget} from './edgeFake';
import type {EdgeView} from './edgeStore';

export type BudgetStatus =
  | {kind: 'active'; owed: number; live: boolean; noUsesLeft: boolean}
  | {kind: 'validated'}
  /* ended, nothing owed, but this session's check has not verified it (not read yet, or a gap) */
  | {kind: 'unchecked'}
  | {kind: 'failed'; seq?: number; reason?: string};

export function budgetStatus(b: EdgeBudget, live: boolean, view: EdgeView | null | undefined): BudgetStatus {
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
  /* nothing more can be spent: every use gone, or the budget is no longer live (ended, expired, a lock) */
  const noUsesLeft = !live || (b.uses > 0 && b.used >= b.uses);
  if (live || owed > 0) return {kind: 'active', owed, live, noUsesLeft};
  const allChecked = uses.length === b.used && uses.every(r => {
    const t = answered(r);
    return r.verified && t !== null && bySeq.get(t.seq)?.verified === true;
  });
  return view?.verdict.kind === 'verified' && allChecked ? {kind: 'validated'} : {kind: 'unchecked'};
}

/** the words the cards show */
export function budgetStatusText(s: BudgetStatus): string {
  if (s.kind === 'validated') return 'Validated';
  if (s.kind === 'failed') return s.seq !== undefined ? `Copy failed its check at #${s.seq}` : 'Copy failed its check';
  if (s.kind === 'unchecked') return 'Not checked yet';
  const parts = ['Active'];
  if (s.owed > 0) parts.push(`${s.owed} ticket${s.owed === 1 ? '' : 's'} owed`);
  if (s.noUsesLeft && (s.owed > 0 || s.live)) parts.push('no uses left');
  return parts.join(' · ');
}
