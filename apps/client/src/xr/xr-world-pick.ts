import type * as THREE from 'three';
import type { WorldEntityRenderer } from '../world-entity-renderer';
import type { WorldCollision } from '../world-collision';
import type { WorldEntity } from '../world-entities';

export function pickXrWorld(camera: THREE.PerspectiveCamera, interact: boolean, deps: {
  renderer?: WorldEntityRenderer | null; collision: WorldCollision; player: THREE.Vector3;
  select: (guid: string) => void; pendingSpell: (entity: WorldEntity) => boolean;
  interact: (guid: string) => void;
}) {
  const picked = deps.renderer?.pick(camera, 0, 0, false,
    point => deps.collision.clampSegment(camera.position, point, 0).distanceToSquared(point) > 0.001);
  if (!picked) return;
  deps.select(picked.entity.guid);
  if (deps.pendingSpell(picked.entity) || !interact) return;
  const point = deps.renderer?.localPositionOf(picked.entity.guid);
  if (point && Math.hypot(point.x - deps.player.x, point.y - deps.player.y, point.z - deps.player.z) <= 5) deps.interact(picked.entity.guid);
}
