/** Asset conversion utility. */
import { TypeID, type WorldEntity } from '../world-entities';

export const SERVER_ONLY_MARKER_DISPLAY_IDS = new Set([
  1287, // World\Generic\PassiveDoodads\Traps\SpellObject_InvisibleTrap.m2
]);

/** A GameObject the server should have kept to itself: draw no model, no placeholder, no shadow. */
export const isServerOnlyMarker = (entity: WorldEntity) =>
  entity.typeId === TypeID.GAMEOBJECT
  && (
    // A zero GAMEOBJECT_DISPLAYID is authoritative, not a bake miss. Current vMaNGOS data uses it
    // for invisible trigger overlays such as entry 2061 Campfire (type 6, spell trap); the visible
    // fire is already a terrain doodad. Rendering the entity placeholder creates a duplicate cube.
    !entity.displayId
    || SERVER_ONLY_MARKER_DISPLAY_IDS.has(entity.displayId)
  );
