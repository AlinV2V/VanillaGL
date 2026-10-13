/** Priority-resolved Build-5875 ContainerFrame.lua geometry, independent of the Canvas renderer. */
export const CONTAINER_FRAME_WIDTH = 192;
export const CONTAINER_MAX_ITEMS = 36;
export const CONTAINER_SLOT_SIZE = 37;
export const CONTAINER_SLOT_STEP_X = 42;
export const CONTAINER_SLOT_STEP_Y = 41;

export type ContainerFrameSpec = {
  frameHeight: number;
  backpack: boolean;
  topHeight: number;
  topTexCoords?: readonly [number, number];
  middleHeights: readonly number[];
};

export function containerFrameSpecFor(slotCount: number, backpack = false): ContainerFrameSpec {
  if (backpack) return { frameHeight: 240, backpack: true, topHeight: 256, middleHeights: [] };
  const size = Math.max(1, Math.min(CONTAINER_MAX_ITEMS, Math.floor(slotCount)));
  const rows = Math.ceil(size / 4);
  const plusTwo = size % 4 === 2;
  const topHeight = plusTwo ? 72 : rows === 1 ? 86 : 94;
  const topTexCoords: readonly [number, number] = plusTwo
    ? [0.189453125, 0.330078125]
    : rows === 1 ? [0.00390625, 0.16796875] : [0.00390625, 0.18359375];
  const middleHeights: number[] = [];
  let remainingRows = rows - 1;
  while (remainingRows > 0) {
    if (remainingRows > 6) {
      middleHeights.push(6 * CONTAINER_SLOT_STEP_Y + 0.353515625);
      remainingRows -= 6;
    } else {
      middleHeights.push(remainingRows * CONTAINER_SLOT_STEP_Y - 9);
      remainingRows = 0;
    }
  }
  return {
    frameHeight: topHeight + middleHeights.reduce((sum, height) => sum + height, 0) + 10,
    backpack: false,
    topHeight,
    topTexCoords,
    middleHeights,
  };
}

export function bagSlotRectFor(slotCount: number, backpack: boolean, slot: number) {
  const size = Math.max(0, Math.min(CONTAINER_MAX_ITEMS, Math.floor(slotCount)));
  if (slot < 0 || slot >= size) return undefined;
  const reverseIndex = size - 1 - slot;
  const frameHeight = containerFrameSpecFor(size, backpack).frameHeight;
  return {
    x: CONTAINER_FRAME_WIDTH - 12 - CONTAINER_SLOT_SIZE - (reverseIndex % 4) * CONTAINER_SLOT_STEP_X,
    y: frameHeight - (backpack ? 30 : 9) - CONTAINER_SLOT_SIZE
      - Math.floor(reverseIndex / 4) * CONTAINER_SLOT_STEP_Y,
    width: CONTAINER_SLOT_SIZE,
    height: CONTAINER_SLOT_SIZE,
  };
}
