/** Explicit trial quality choice. Saved renderScale and canvas UI resolution remain authoritative. */
export function parseWorldPixelBudget(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const budget = Number(value);
  return Number.isSafeInteger(budget) && budget >= 100000 && budget <= 4000000 ? budget : null;
}

export function worldPixelBudgetRatio(requested: number, width: number, height: number, budget: number | null): number {
  if (budget === null || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return requested;
  return Math.min(requested, Math.sqrt(budget / (width * height)));
}

export const worldPixelBudget = typeof location === 'undefined' ? null : parseWorldPixelBudget(new URLSearchParams(location.search).get('worldpixels'));
