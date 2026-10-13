export const RAID_TARGET_ATLAS = '/ui/Interface/TargetingFrame/UI-RaidTargetingIcons.png';

export const RAID_TARGET_NAMES = [
  'Star', 'Circle', 'Diamond', 'Triangle', 'Moon', 'Square', 'Cross', 'Skull',
] as const;

export const RAID_TARGET_COLORS = [
  '#ffeb00', '#fa9100', '#d438e6', '#0af200', '#b3d1df', '#00b5ff', '#ff3d2b', '#fafafa',
] as const;

/** Build 5875 uses the first eight 64x64 cells of a 4x4, 256x256 atlas. */
export function raidTargetSource(uiIndex: number) {
  const index = Math.max(1, Math.min(8, Math.trunc(uiIndex))) - 1;
  return { x: (index % 4) * 64, y: Math.floor(index / 4) * 64, w: 64, h: 64 };
}

export function raidTargetCss(uiIndex: number, size = 26) {
  const source = raidTargetSource(uiIndex);
  return `background-image:url('${RAID_TARGET_ATLAS}');background-size:${size * 4}px ${size * 4}px;` +
    `background-position:-${source.x / 64 * size}px -${source.y / 64 * size}px`;
}
