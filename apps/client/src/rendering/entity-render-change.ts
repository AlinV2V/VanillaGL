import { PLAYER_FIELDS } from '../data/player-field-layout';
import { TypeID, type WorldEntityChange } from '../world-entities';

export type EntityRenderDomains = {
  combat: boolean;
  appearance: boolean;
  equipment: boolean;
};

const OBJECT_FIELD_TYPE = 0x02;
const OBJECT_FIELD_ENTRY = 0x03;
const OBJECT_FIELD_SCALE_X = 0x04;
const GAMEOBJECT_DISPLAYID = 0x08;
const GAMEOBJECT_TYPE_ID = 0x15;
const GAMEOBJECT_ARTKIT = 0x17;
const UNIT_FIELD_HEALTH = 0x16;
const UNIT_FIELD_MAXHEALTH = 0x1c;
const UNIT_FIELD_BYTES_0 = 0x24;
const UNIT_VIRTUAL_ITEM_SLOT_DISPLAY = 0x25;
const UNIT_VIRTUAL_ITEM_INFO_END = 0x2d;
const UNIT_FIELD_FLAGS = 0x2e;
const UNIT_FIELD_AURA = 0x2f;
const UNIT_FIELD_AURASTATE = 0x7d;
const UNIT_FIELD_BOUNDINGRADIUS = 0x81;
const UNIT_FIELD_COMBATREACH = 0x82;
const UNIT_FIELD_DISPLAYID = 0x83;
const UNIT_FIELD_NATIVEDISPLAYID = 0x84;
const UNIT_FIELD_MOUNTDISPLAYID = 0x85;
const UNIT_DYNAMIC_FLAGS = 0x8f;
const UNIT_FIELD_BYTES_2 = 0xa4;
const PLAYER_VISIBLE_ITEM_STRIDE = 12;
const PLAYER_VISIBLE_ITEM_SLOTS = 19;

/** Build-5875 field routing for renderer work; transform state is always consumed by snapshots. */
export function classifyEntityRenderChange(change: WorldEntityChange): EntityRenderDomains {
  if (change.kind === 'create') return { combat: true, appearance: true, equipment: true };
  if (change.kind !== 'update') return { combat: false, appearance: false, equipment: false };
  const fields = change.changedFields;
  if (change.entity.typeId === TypeID.GAMEOBJECT) {
    return {
      combat: false,
      appearance: fields.some((field) => field === OBJECT_FIELD_TYPE || field === OBJECT_FIELD_ENTRY
        || field === OBJECT_FIELD_SCALE_X || field === GAMEOBJECT_DISPLAYID
        || field === GAMEOBJECT_TYPE_ID || field === GAMEOBJECT_ARTKIT),
      equipment: false,
    };
  }

  const visibleItemStart = PLAYER_FIELDS.PLAYER_VISIBLE_ITEM_1_0;
  const visibleItemEnd = visibleItemStart + PLAYER_VISIBLE_ITEM_STRIDE * PLAYER_VISIBLE_ITEM_SLOTS;
  const equipment = fields.some((field) => field === UNIT_FIELD_FLAGS || field === UNIT_FIELD_BYTES_2
    || (field >= UNIT_VIRTUAL_ITEM_SLOT_DISPLAY && field <= UNIT_VIRTUAL_ITEM_INFO_END)
    || (field >= visibleItemStart && field < visibleItemEnd));
  const appearance = fields.some((field) => field === OBJECT_FIELD_TYPE || field === OBJECT_FIELD_SCALE_X
    || field === UNIT_FIELD_BYTES_0 || field === UNIT_FIELD_BOUNDINGRADIUS || field === UNIT_FIELD_COMBATREACH
    || field === UNIT_FIELD_DISPLAYID
    || field === UNIT_FIELD_NATIVEDISPLAYID || field === UNIT_FIELD_MOUNTDISPLAYID
    || field === PLAYER_FIELDS.PLAYER_BYTES || field === PLAYER_FIELDS.PLAYER_BYTES_2);
  const combat = fields.some((field) => field === UNIT_FIELD_HEALTH || field === UNIT_FIELD_MAXHEALTH
    || field === UNIT_FIELD_FLAGS || field === UNIT_DYNAMIC_FLAGS
    || (field >= UNIT_FIELD_AURA && field <= UNIT_FIELD_AURASTATE));
  return { combat, appearance, equipment };
}
