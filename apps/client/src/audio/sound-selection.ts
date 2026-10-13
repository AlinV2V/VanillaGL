export const normalizeSoundUrl = (path: string) => {
  const normalized = path.replaceAll('\\', '/').replace(/^\/+/, '');
  if (/^(https?:|data:|blob:)/i.test(normalized)) return normalized;
  if (normalized.startsWith('sounds/')) return `/${normalized}`;
  return `/sounds/${normalized}`;
};
export const weightedIndex = (length: number, weights?: number[]) => {
  if (length <= 1) return 0;
  const normalized = Array.from({ length }, (_, index) => Math.max(0, weights?.[index] ?? 1));
  const total = normalized.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return Math.floor(Math.random() * length);
  let pick = Math.random() * total;
  for (let index = 0; index < normalized.length; index++) {
    pick -= normalized[index];
    if (pick <= 0) return index;
  }
  return length - 1;
};
