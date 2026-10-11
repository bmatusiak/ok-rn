/**
 * A budget's status word (spec APP.md, Budgets; Brad, 2026-10-06):
 *   Active     - live with uses left, OR any use still owes a receipt ("it's
 *                still active if a receipt is owed"); when nothing more can be
 *                spent it says so: "Active · 1 receipt owed · no uses left";
 *   Validated  - ended, and every use has a receipt that verifies in the copy
 *                re-checked this session - the only green "done";
 *   Settled    - ended, the copy verifies, and a use was cleared by the person's settle
 *                (accepted without its receipt) - yellow: checked, but not receipted;
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
  | {kind: 'validated'; unused?: boolean}
  /* ended and verified, but a use was cleared by a settle, not a receipt */
  | {kind: 'settled'}
  /* ended, nothing owed, but this session's check has not verified it (not read yet, or a gap) */
  | {kind: 'unchecked'}
  | {kind: 'failed'; seq?: number; reason?: string};

export function budgetStatus(b: EdgeBudget, live: boolean, view: EdgeView | null | undefined): BudgetStatus {
  if (view?.verdict.kind === 'tampered') return {kind: 'failed', seq: view.verdict.seq, reason: view.verdict.reason};
  const rows = view?.rows ?? [];
  const bySeq = new Map(rows.map(r => [r.seq, r]));
  const uses = rows.filter(r => r.fields.grantId === b.grantId && r.fields.decision === codes.DECISION.SELF_PRESS);
  type Paired = {status?: string; receipt?: {seq: number} | null; settledBy?: number | null};
  const answered = (r: (typeof rows)[number]) => (r.receipt as Paired | undefined)?.receipt ?? null;
  /* the settle link that cleared this use, when a settle (not a receipt) answered it */
  const settledBy = (r: (typeof rows)[number]) => {
    const t = r.receipt as Paired | undefined;
    return t?.status === 'settled' ? t.settledBy ?? null : null;
  };
  /* a use with no receipt and no settle, that owes one */
  const owedRows = uses.filter(r => {
    const t = r.receipt as Paired | undefined;
    return !answered(r) && t?.status !== 'no-receipt-owed' && t?.status !== 'settled';
  });
  const owed = Math.max(owedRows.length, b.used - (b.receiptsFiled ?? 0));
  /* nothing more can be spent: every use gone, or the budget is no longer live (ended, expired, a lock) */
  const noUsesLeft = !live || (b.uses > 0 && b.used >= b.uses);
  if (live || owed > 0) return {kind: 'active', owed, live, noUsesLeft};
  /* every use answered by a link that verifies: its receipt, or the settle that cleared it */
  const allChecked = uses.length === b.used && uses.every(r => {
    if (!r.verified) return false;
    const t = answered(r);
    if (t) return bySeq.get(t.seq)?.verified === true;
    const s = settledBy(r);
    return s !== null && bySeq.get(s)?.verified === true;
  });
  if (view?.verdict.kind !== 'verified' || !allChecked) return {kind: 'unchecked'};
  return uses.some(r => settledBy(r) !== null) ? {kind: 'settled'} : {kind: 'validated', unused: b.used === 0};
}

/*
 * ANOTHER DEVICE'S BUDGET is judged the same way, from ITS chain view - this phone re-verifies the
 * incoming log under that device's key and checkpoint, receipts paired and checked (Brad,
 * 2026-10-09: "the incoming data must be re-verified"; a shortcut that counted receipts showed
 * Validated before the receipts themselves had arrived). No view: Not checked yet.
 */

/** the words the cards show */
export function budgetStatusText(s: BudgetStatus): string {
  if (s.kind === 'validated') return s.unused ? 'Validated · unused' : 'Validated';
  if (s.kind === 'settled') return 'Settled';
  if (s.kind === 'failed') return s.seq !== undefined ? `Copy failed its check at #${s.seq}` : 'Copy failed its check';
  if (s.kind === 'unchecked') return 'Not checked yet';
  const parts = ['Active'];
  if (s.owed > 0) parts.push(`${s.owed} receipt${s.owed === 1 ? '' : 's'} owed`);
  if (s.noUsesLeft && (s.owed > 0 || s.live)) parts.push('no uses left');
  return parts.join(' · ');
}
