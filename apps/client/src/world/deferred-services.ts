import { UNIT_NPC_FLAG } from './alpha-opcodes';

export const DEFERRED_SERVICE_OPCODES = {
  MSG_TABARDVENDOR_ACTIVATE: 0x01f2,
  SMSG_BATTLEFIELD_LIST: 0x023d,
} as const;

export const BATTLEGROUND_DEFERRED = 'Battlegrounds are not available in this PvE alpha.';
export const TABARD_DEFERRED = 'Guild tabard design is not available in this alpha.';
export const MEETING_STONE_DEFERRED = 'Meeting-stone matchmaking is not available; use chat to form a group.';

export function deferredNpcServiceMessage(npcFlags: number) {
  if (npcFlags & UNIT_NPC_FLAG.BATTLEMASTER) return BATTLEGROUND_DEFERRED;
  if (npcFlags & UNIT_NPC_FLAG.TABARDDESIGNER) return TABARD_DEFERRED;
  return undefined;
}

export function deferredGameObjectServiceMessage(gameObjectType?: number) {
  return gameObjectType === 23 ? MEETING_STONE_DEFERRED : undefined;
}

export function deferredServicePacketMessage(opcode: number) {
  if (opcode === DEFERRED_SERVICE_OPCODES.SMSG_BATTLEFIELD_LIST) return BATTLEGROUND_DEFERRED;
  if (opcode === DEFERRED_SERVICE_OPCODES.MSG_TABARDVENDOR_ACTIVATE) return TABARD_DEFERRED;
  return undefined;
}
