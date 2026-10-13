import * as THREE from 'three';
import type { SpellDestination } from '../combat/spell-targeting';
import { drapeGrid, reticleSegmentsFor } from './ground-target-drape';

export type GroundSpellTargetRequest = {
  spellId: number;
  name: string;
  maxRange: number;
  radius: number;
  /** Item-origin casts use the same reticle but a different CMSG prefix. */
  confirm?: (destination: SpellDestination) => void;
};

/**
 * Build-5875-style two-stage ground casting: pressing the action enters targeting,
 * left click confirms a world destination, and right click/Escape cancels.
 *
 * The server remains authoritative. DBC range only colours/guards the reticle so an
 * obviously invalid click does not turn into a silent SPELL_FAILED_OUT_OF_RANGE.
 */
export class GroundSpellTargetingController {
  private readonly raycaster = new THREE.Raycaster();
  private readonly pointer = new THREE.Vector2();
  private readonly plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
  private readonly point = new THREE.Vector3();
  private readonly group = new THREE.Group();
  private readonly acceptableTexture = new THREE.TextureLoader().load(
    '/ui/Interface/SpellShadow/Spell-Shadow-Acceptable.png',
  );
  private readonly unacceptableTexture = new THREE.TextureLoader().load(
    '/ui/Interface/SpellShadow/Spell-Shadow-Unacceptable.png',
  );
  private readonly reticleMaterial = new THREE.MeshBasicMaterial({
    map: this.acceptableTexture,
    color: 0xffffff,
    transparent: true,
    opacity: 1,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  private reticle = new THREE.Mesh();
  private segments = 0;
  private activeRequest: GroundSpellTargetRequest | null = null;
  private valid = false;
  private lastClientX: number | null = null;
  private lastClientY: number | null = null;
  private priorCursor = '';

  constructor(private readonly deps: {
    scene: THREE.Scene;
    camera: THREE.PerspectiveCamera;
    canvas: HTMLCanvasElement;
    getPlayerPosition: () => THREE.Vector3;
    resolveGround: (localX: number, localY: number, probeZ: number) => number;
    /**
     * Terrain-only height, no WMO collision query. The reticle displaces one vertex per grid
     * node, so it needs the cheap heightmap read — `resolveGround` runs a collision-cylinder box
     * query per call and is far too heavy to run hundreds of times per pointer move.
     */
    sampleTerrainHeight: (localX: number, localY: number) => number;
    localToWorld: (localX: number, localY: number) => { x: number; y: number } | null;
    confirm: (spellId: number, destination: SpellDestination) => void;
    showError: (message: string) => void;
    log: (message: string) => void;
  }) {
    this.group.name = 'ground-spell-target-reticle';
    this.group.visible = false;
    this.group.renderOrder = 10_000;
    deps.scene.add(this.group);
    this.acceptableTexture.colorSpace = THREE.SRGBColorSpace;
    this.unacceptableTexture.colorSpace = THREE.SRGBColorSpace;
    this.acceptableTexture.wrapS = this.acceptableTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.unacceptableTexture.wrapS = this.unacceptableTexture.wrapT = THREE.ClampToEdgeWrapping;

    deps.canvas.addEventListener('pointermove', this.onPointerMove, true);
    deps.canvas.addEventListener('click', this.onClick, true);
    deps.canvas.addEventListener('contextmenu', this.onContextMenu, true);
    window.addEventListener('keydown', this.onKeyDown, true);
  }

  get active(): boolean {
    return this.activeRequest !== null;
  }

  begin(request: GroundSpellTargetRequest): void {
    this.cancel(false);
    this.activeRequest = {
      ...request,
      maxRange: Math.max(1, request.maxRange || 30),
      radius: Math.max(0.75, request.radius || 3),
    };
    this.buildReticle(this.activeRequest.radius);
    this.priorCursor = this.deps.canvas.style.cursor;
    this.deps.canvas.style.cursor = "url('/ui/Interface/Cursor/Cast.png') 16 16, crosshair";
    this.group.visible = true;

    const rect = this.deps.canvas.getBoundingClientRect();
    const clientX = this.lastClientX ?? rect.left + rect.width / 2;
    const clientY = this.lastClientY ?? rect.top + rect.height / 2;
    this.updateReticle(clientX, clientY);
    this.deps.log(
      `spell targeting: ${request.name} (${request.spellId}), left-click ground to cast; right-click/Escape cancels`,
    );
  }

  cancel(log = true): void {
    if (!this.activeRequest) return;
    const name = this.activeRequest.name;
    this.activeRequest = null;
    this.valid = false;
    this.group.visible = false;
    this.deps.canvas.style.cursor = this.priorCursor;
    if (log) this.deps.log(`spell targeting: cancelled ${name}`);
  }

  private buildReticle(radius: number): void {
    this.group.clear();
    this.reticle.geometry?.dispose();
    // The client texture is a complete authored circle (runes, rings, colour, alpha).
    // A square plane preserves it exactly; its diameter is the spell radius from SpellRadius.dbc.
    //
    // SUBDIVIDED, not a single quad: the decal is draped over the terrain, so a Blizzard circle on
    // a slope follows the slope instead of burying one edge in the hill and floating the other.
    // One grid node per ~1.5 yards, clamped so a huge radius cannot explode the sample count —
    // every node costs a heightmap read on each pointer move.
    const segments = reticleSegmentsFor(radius);
    this.segments = segments;
    const geometry = new THREE.PlaneGeometry(radius * 2, radius * 2, segments, segments);
    this.reticle = new THREE.Mesh(geometry, this.reticleMaterial);
    this.reticle.renderOrder = this.group.renderOrder;
    this.group.add(this.reticle);
  }

  /**
   * Drape the reticle over the terrain: each grid vertex is pushed to the ground height beneath
   * it, expressed relative to the group origin so the group's own position stays the cast target.
   */
  private drapeReticle(centreX: number, centreY: number, centreZ: number): void {
    const geometry = this.reticle.geometry as THREE.PlaneGeometry | undefined;
    const position = geometry?.attributes.position as THREE.BufferAttribute | undefined;
    if (!position) return;
    // Plane vertices are authored in the group's local XY, which is already world-aligned.
    let minZ = Infinity, maxZ = -Infinity;
    drapeGrid(
      (i) => ({ x: position.getX(i), y: position.getY(i) }),
      (i, z) => { position.setZ(i, z); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); },
      position.count,
      centreX,
      centreY,
      centreZ,
      this.deps.sampleTerrainHeight,
    );
    position.needsUpdate = true;
    const bound = geometry!.boundingSphere ??= new THREE.Sphere();
    bound.center.set(0, 0, (minZ + maxZ) * 0.5);
    const halfWidth = geometry!.parameters.width * 0.5, halfHeight = geometry!.parameters.height * 0.5;
    bound.radius = Math.hypot(halfWidth, halfHeight, (maxZ - minZ) * 0.5);
  }

  private updateReticle(clientX: number, clientY: number): void {
    const request = this.activeRequest;
    if (!request) return;
    const rect = this.deps.canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      this.valid = false;
      return;
    }
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.deps.camera);

    const player = this.deps.getPlayerPosition();
    let groundZ = player.z;
    let intersected = false;
    // Iterate because the first ray-plane hit uses the player's height while the
    // selected terrain/WMO surface can be above or below it.
    for (let pass = 0; pass < 3; pass++) {
      this.plane.constant = -groundZ;
      if (!this.raycaster.ray.intersectPlane(this.plane, this.point)) break;
      intersected = true;
      groundZ = this.deps.resolveGround(this.point.x, this.point.y, Math.max(player.z, groundZ) + 6);
    }

    if (!intersected || !Number.isFinite(groundZ)) {
      this.valid = false;
      this.setValidity(false);
      return;
    }

    this.point.z = groundZ + 0.045;
    this.group.position.copy(this.point);
    this.drapeReticle(this.point.x, this.point.y, this.point.z);
    const distance = Math.hypot(this.point.x - player.x, this.point.y - player.y);
    this.valid = distance <= request.maxRange + 0.01;
    this.setValidity(this.valid);
  }

  private setValidity(valid: boolean): void {
    this.reticleMaterial.map = valid ? this.acceptableTexture : this.unacceptableTexture;
    this.reticleMaterial.needsUpdate = true;
    this.deps.canvas.style.cursor = valid
      ? "url('/ui/Interface/Cursor/Cast.png') 16 16, crosshair"
      : "url('/ui/Interface/Cursor/UnableCast.png') 16 16, not-allowed";
  }

  private readonly onPointerMove = (event: PointerEvent) => {
    this.lastClientX = event.clientX;
    this.lastClientY = event.clientY;
    if (this.activeRequest) this.updateReticle(event.clientX, event.clientY);
  };

  private readonly onClick = (event: MouseEvent) => {
    const request = this.activeRequest;
    if (!request || event.button !== 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.updateReticle(event.clientX, event.clientY);
    if (!this.valid) {
      this.deps.showError('Out of range.');
      return;
    }
    const world = this.deps.localToWorld(this.point.x, this.point.y);
    if (!world) {
      this.deps.showError('Invalid target.');
      return;
    }
    const destination = { x: world.x, y: world.y, z: this.point.z - 0.045 };
    if (request.confirm) request.confirm(destination);
    else this.deps.confirm(request.spellId, destination);
    this.activeRequest = null;
    this.valid = false;
    this.group.visible = false;
    this.deps.canvas.style.cursor = this.priorCursor;
    this.deps.log(
      `spell targeting: cast ${request.name} at (${destination.x.toFixed(2)}, ${destination.y.toFixed(2)}, ${destination.z.toFixed(2)})`,
    );
  };

  private readonly onContextMenu = (event: MouseEvent) => {
    if (!this.activeRequest) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel();
  };

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (!this.activeRequest || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.cancel();
  };
}
