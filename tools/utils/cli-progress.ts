const DEFAULT_WIDTH = 24;

export function formatProgress(
  current: number,
  total: number,
  label: string,
  width = DEFAULT_WIDTH,
): string {
  const safeTotal = Math.max(1, total);
  const clamped = Math.max(0, Math.min(current, safeTotal));
  const ratio = clamped / safeTotal;
  const filled = Math.round(ratio * width);
  const bar = `${'█'.repeat(filled)}${'░'.repeat(Math.max(0, width - filled))}`;
  const percent = Math.round(ratio * 100).toString().padStart(3, ' ');
  return `[${bar}] ${percent}% - ${label}`;
}

export function printProgress(current: number, total: number, label: string): void {
  console.log(formatProgress(current, total, label));
}
