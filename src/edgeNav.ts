/**
 * "Open this budget's details" from anywhere (Brad, 2026-10-07: the request sheet's
 * budget card, tapped, "takes me to the budget details view"). App switches to the
 * Edge tab and hands EdgeScreen the budget to open, as a tapped Edge alarm does
 * with its link.
 */
const listeners = new Set<(grantId: number) => void>();

export function openBudget(grantId: number): void {
  for (const fn of [...listeners]) fn(grantId);
}

export function onOpenBudget(fn: (grantId: number) => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
