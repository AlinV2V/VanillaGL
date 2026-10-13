import * as THREE from 'three';
import { qaGlobals } from '../qa-globals.ts';

type FallSupport = {
  height: number;
  source: 'terrain' | 'wmo';
  terrainType?: number;
};

export type FallDebugProbe = {
  map: number;
  tile: string | null;
  world: { x: number; y: number };
  renderOrigin: { x: number; y: number };
  terrainHeight: number;
  support: FallSupport;
  player?: unknown;
  collisionStats?: unknown;
};

export type DebugWorldPickerDeps = {
  scene: THREE.Scene;
  camera: THREE.Camera;
  domElement: HTMLElement;
  fallDebug: boolean;
  probe: (localX: number, localY: number, visualZ: number, currentTerrainZ?: number) => FallDebugProbe;
};

type SurfaceKind = 'terrain' | 'wmo' | 'doodad';
type SurfaceDescription = {
  kind: SurfaceKind;
  object: string;
  uuid: string;
  instanceId: number | null;
  metadata: Record<string, unknown> | null;
};

const round = (value: number, digits = 3) => Number.isFinite(value) ? +value.toFixed(digits) : null;
const point = (value: THREE.Vector3) => ({ x: round(value.x), y: round(value.y), z: round(value.z) });

function compactMetadata(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry === null || ['string', 'number', 'boolean'].includes(typeof entry)) output[key] = entry;
    else if (Array.isArray(entry) && entry.length <= 12
      && entry.every((item) => item === null || ['string', 'number', 'boolean'].includes(typeof item))) output[key] = entry;
  }
  return Object.keys(output).length ? output : null;
}

function describeSurface(hit: THREE.Intersection): SurfaceDescription | null {
  let node: THREE.Object3D | null = hit.object;
  let terrain: THREE.Object3D | null = null;
  let wmo: Record<string, unknown> | null = null;
  let doodad: Record<string, unknown> | null = null;
  while (node) {
    const data = node.userData as Record<string, unknown>;
    if (!terrain && data.vanillaPerfCategory === 'terrain') terrain = node;
    if (!wmo && data.wmoPick && typeof data.wmoPick === 'object') wmo = data.wmoPick as Record<string, unknown>;
    if (!doodad && data.wowDoodad && typeof data.wowDoodad === 'object') doodad = data.wowDoodad as Record<string, unknown>;
    node = node.parent;
  }
  const kind: SurfaceKind | null = doodad ? 'doodad' : wmo ? 'wmo' : terrain ? 'terrain' : null;
  if (!kind) return null;
  return {
    kind,
    object: hit.object.name || hit.object.parent?.name || '(unnamed)',
    uuid: hit.object.uuid,
    instanceId: hit.instanceId ?? null,
    metadata: compactMetadata(doodad ?? wmo),
  };
}

function isPickableWorldHit(hit: THREE.Intersection): boolean {
  let node: THREE.Object3D | null = hit.object;
  while (node) {
    if (!node.visible || node.userData?.wowCollision || node.userData?.fallDebugMarker) return false;
    node = node.parent;
  }
  return describeSurface(hit) !== null;
}

export function classifyFallDebugProbe(
  surface: SurfaceKind,
  visualZ: number,
  terrainHeight: number,
  support: FallSupport,
): { status: 'aligned' | 'review' | 'coordinate-only'; reason: string } {
  if (![visualZ, terrainHeight, support.height].every(Number.isFinite)) {
    return { status: 'review', reason: 'non-finite ground data' };
  }
  if (surface === 'doodad') {
    return { status: 'coordinate-only', reason: 'doodad surfaces are not treated as walkable ground' };
  }
  if (surface === 'terrain' && Math.abs(visualZ - terrainHeight) > 0.75) {
    return { status: 'review', reason: 'rendered terrain and movement heightfield disagree' };
  }
  if (surface === 'wmo' && support.source !== 'wmo' && visualZ - support.height > 0.75) {
    return { status: 'review', reason: 'rendered WMO surface has no matching WMO ground support' };
  }
  if (Math.abs(visualZ - support.height) > 2) {
    return { status: 'review', reason: 'movement support is more than 2 yards from the rendered surface' };
  }
  return { status: 'aligned', reason: 'rendered surface and movement support agree at this point' };
}

function installWmoPicker(scene: THREE.Scene, camera: THREE.Camera, domElement: HTMLElement) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const onClick = (event: MouseEvent) => {
    const rect = domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera as THREE.PerspectiveCamera);
    const hits = raycaster.intersectObjects(scene.children, true);
    for (const hit of hits) {
      if (!isPickableWorldHit(hit)) continue;
      let node: THREE.Object3D | null = hit.object;
      let batch: unknown;
      let placement: unknown;
      while (node) {
        const meta = node.userData?.wmoPick;
        if (meta?.kind === 'wmoBatch' && !batch) batch = meta;
        if (meta?.kind === 'wmo') { placement = meta; break; }
        node = node.parent;
      }
      if (!placement) continue;
      const payload = {
        placement,
        batch: batch ?? null,
        hitWorld: point(hit.point),
        distanceYd: round(hit.distance, 2),
      };
      const text = JSON.stringify(payload, null, 2);
      console.log('[pick]', payload);
      const hitMesh = hit.object as THREE.Mesh;
      const original = hitMesh.material;
      const highlight = new THREE.MeshBasicMaterial({ color: 0xff2255, wireframe: true });
      hitMesh.material = highlight;
      const box = new THREE.BoxHelper(hitMesh, 0xffdd00);
      scene.add(box);
      window.setTimeout(() => {
        hitMesh.material = original;
        scene.remove(box);
        box.geometry.dispose();
        highlight.dispose();
      }, 2500);
      void navigator.clipboard?.writeText(text).catch(() => {});
      return;
    }
    console.log('[pick] no WMO under cursor');
  };
  qaGlobals.__wowPick = (on = true) => {
    domElement.removeEventListener('click', onClick);
    if (on) domElement.addEventListener('click', onClick);
    return on ? 'pick ON — click a building; JSON goes to console + clipboard' : 'pick OFF';
  };
}

function installFallDebugPicker(deps: DebugWorldPickerDeps) {
  const { scene, camera, domElement, probe } = deps;
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const nearbyOffsets = [[0, 0], [0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]] as const;
  let marker: THREE.Group | null = null;
  let lastReport: Record<string, unknown> | null = null;

  const panel = document.createElement('div');
  panel.id = 'fall-debug-panel';
  panel.style.cssText = [
    'position:fixed', 'left:50%', 'top:8px', 'transform:translateX(-50%)', 'z-index:99999',
    'max-width:min(620px,90vw)', 'background:rgba(8,10,14,.9)', 'color:#ffe8a3',
    'font:12px/1.4 Consolas,monospace', 'padding:7px 10px', 'border:1px solid #9a7422',
    'border-radius:5px', 'white-space:pre-wrap', 'pointer-events:none', 'user-select:none',
  ].join(';');
  panel.textContent = 'FALL DEBUG ON · Alt+click the unsafe ground (the character will not move).';
  document.body.appendChild(panel);

  const clearMarker = () => {
    if (!marker) return;
    scene.remove(marker);
    marker.traverse((object) => {
      const mesh = object as THREE.Mesh;
      mesh.geometry?.dispose();
      if (mesh.material && !Array.isArray(mesh.material)) mesh.material.dispose();
    });
    marker = null;
  };
  const placeMarker = (at: THREE.Vector3) => {
    clearMarker();
    marker = new THREE.Group();
    marker.userData.fallDebugMarker = true;
    const material = new THREE.MeshBasicMaterial({ color: 0xff2d2d, side: THREE.DoubleSide, depthTest: false });
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.32, 0.5, 32), material);
    const stemGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 2)]);
    const stem = new THREE.Line(stemGeometry, new THREE.LineBasicMaterial({ color: 0xffff00, depthTest: false }));
    marker.add(ring, stem);
    marker.position.copy(at);
    marker.position.z += 0.04;
    marker.renderOrder = 10000;
    scene.add(marker);
  };
  const copyReport = async () => {
    if (!lastReport) return false;
    try {
      await navigator.clipboard.writeText(JSON.stringify(lastReport, null, 2));
      return true;
    } catch {
      return false;
    }
  };

  domElement.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0 || !event.altKey) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const rect = domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera as THREE.PerspectiveCamera);
    const hit = raycaster.intersectObjects(scene.children, true).find(isPickableWorldHit);
    const surface = hit ? describeSurface(hit) : null;
    if (!hit || !surface) {
      panel.textContent = 'FALL DEBUG · No terrain, WMO, or doodad surface under that point.';
      return;
    }

    placeMarker(hit.point);
    const center = probe(hit.point.x, hit.point.y, hit.point.z);
    const verdict = classifyFallDebugProbe(surface.kind, hit.point.z, center.terrainHeight, center.support);
    const nearbySupport = nearbyOffsets.map(([x, y]) => {
      const sample = probe(hit.point.x + x, hit.point.y + y, hit.point.z, center.terrainHeight);
      return {
        offset: { x, y },
        world: { x: round(sample.world.x), y: round(sample.world.y) },
        terrainZ: round(sample.terrainHeight),
        supportZ: round(sample.support.height),
        supportSource: sample.support.source,
      };
    });
    lastReport = {
      kind: 'vanillagl-fall-debug',
      formatVersion: 1,
      capturedAt: new Date().toISOString(),
      map: center.map,
      tile: center.tile,
      world: { x: round(center.world.x), y: round(center.world.y), z: round(hit.point.z) },
      local: point(hit.point),
      renderOrigin: center.renderOrigin,
      surface,
      distanceYd: round(hit.distance, 2),
      heights: {
        renderedZ: round(hit.point.z),
        terrainZ: round(center.terrainHeight),
        movementSupportZ: round(center.support.height),
        movementSupportSource: center.support.source,
        renderedMinusTerrain: round(hit.point.z - center.terrainHeight),
        renderedMinusSupport: round(hit.point.z - center.support.height),
      },
      verdict,
      nearbySupport,
      playerAtCapture: center.player ?? null,
      collisionStats: center.collisionStats ?? null,
    };
    console.log('[falldebug]', lastReport);
    const location = `map=${center.map} x=${round(center.world.x)} y=${round(center.world.y)} z=${round(hit.point.z)}`;
    panel.textContent = `FALL DEBUG · ${verdict.status.toUpperCase()}: ${verdict.reason}\n${location}\nCopying report…`;
    void copyReport().then((copied) => {
      panel.textContent = `FALL DEBUG · ${verdict.status.toUpperCase()}: ${verdict.reason}\n${location}\n`
        + (copied ? 'Report copied — paste it into Codex.' : 'Clipboard blocked — report is in the browser console.');
    });
  }, true);

  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    clearMarker();
    lastReport = null;
    panel.textContent = 'FALL DEBUG ON · Cleared. Alt+click the unsafe ground.';
  });

  qaGlobals.__wowFallDebug = {
    last: () => lastReport,
    copy: copyReport,
    clear: () => { clearMarker(); lastReport = null; },
  };
  console.log('[falldebug] ready — Alt+click an unsafe surface; report copies automatically');
}

export function installDebugWorldPicker(deps: DebugWorldPickerDeps): void {
  installWmoPicker(deps.scene, deps.camera, deps.domElement);
  if (deps.fallDebug) installFallDebugPicker(deps);
}
