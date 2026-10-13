import type { WorldEntity } from '../world-entities';
import type { ServerSpeedKind } from './movement-controller';

export function installWorldEntityEvents(handlers: {
  upsert: (entity: WorldEntity) => void;
  remove: (guid: string) => void;
  speed: (guid: string, kind: ServerSpeedKind, speed: number) => void;
}): () => void {
  const upsert = (event: Event) => handlers.upsert((event as CustomEvent<WorldEntity>).detail);
  const remove = (event: Event) => handlers.remove((event as CustomEvent<string>).detail);
  const speed = (event: Event) => {
    const detail = (event as CustomEvent<{ guid: string; kind: ServerSpeedKind; speed: number }>).detail;
    handlers.speed(detail.guid, detail.kind, detail.speed);
  };
  window.addEventListener('wow-world-entity', upsert);
  window.addEventListener('wow-world-entity-remove', remove);
  window.addEventListener('wow-force-speed', speed);
  return () => {
    window.removeEventListener('wow-world-entity', upsert);
    window.removeEventListener('wow-world-entity-remove', remove);
    window.removeEventListener('wow-force-speed', speed);
  };
}
