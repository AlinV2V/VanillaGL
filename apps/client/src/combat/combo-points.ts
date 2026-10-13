export const STOCK_PLAYER_FIELD_COMBO_TARGET = 0x2c4;
export const STOCK_PLAYER_FIELD_BYTES = 0x4c0;
export const COMBO_POINT_BYTE = 1;
export const MAX_COMBO_POINTS = 5;

function fieldGuid(fields: ReadonlyMap<number, number>, index: number): string | undefined {
  const low = fields.get(index) ?? 0;
  const high = fields.get(index + 1) ?? 0;
  if ((low | high) === 0) return undefined;
  const bytes = new Uint8Array(8);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, low >>> 0, true);
  view.setUint32(4, high >>> 0, true);
  return Array.from(bytes)
    .reverse()
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
/** Asset conversion utility. */
export function readComboPointState(
  fields: ReadonlyMap<number, number>,
  layoutShift: number,
): { targetGuid?: string; points: number } {
  const targetGuid = fieldGuid(fields, STOCK_PLAYER_FIELD_COMBO_TARGET + layoutShift);
  if (!targetGuid) return { points: 0 };
  const raw = fields.get(STOCK_PLAYER_FIELD_BYTES + layoutShift) ?? 0;
  const points = (raw >>> (COMBO_POINT_BYTE * 8)) & 0xff;
  return {
    targetGuid,
    points: points >= 1 && points <= MAX_COMBO_POINTS ? points : 0,
  };
}
