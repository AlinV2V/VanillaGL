import * as THREE from 'three';
import { flushCanvasRenders } from '../ui/vanilla-canvas';
import { dispatchXrPointer } from './xr-pointer-events';

type Tile = { canvas: HTMLCanvasElement; x: number; y: number; w: number; h: number; crop: number[] };
/** Copies authoritative HUD canvases into large, head-relative VR surfaces. No duplicate combat state. */
export class XrHud {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  minimap = false;
  combat = false;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly raycaster = new THREE.Raycaster();
  private readonly intersections: THREE.Intersection[] = [];
  private tiles: Tile[] = [];
  private held?: Tile;
  private lastPaint = -Infinity;
  private readonly offset = new THREE.Vector3(0, -0.5, -1.6);
  private readonly worldOffset = new THREE.Vector3();
  private readonly npcFrames = new Set<Element>();
  private lastDialogScan = -Infinity;
  constructor(scene: THREE.Scene) {
    this.canvas.width = 1400; this.canvas.height = 700; this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 0.775),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthTest: false, depthWrite: false }));
    this.mesh.name = 'VR HUD'; this.mesh.visible = false; this.mesh.renderOrder = 9000; scene.add(this.mesh);
  }
  /** True only on newly opened NPC dialogs, so closing a VR panel does not reopen it every frame. */
  hasNewDialog(time: number) {
    if (time - this.lastDialogScan < 150) return false;
    this.lastDialogScan = time;
    let opened = false;
    for (const element of document.querySelectorAll('#wow-gossip-frame, #wow-quest-frame, #wow-loot-frame, #wow-merchant-frame, #wow-trainer-frame, #wow-taxi-frame, #wow-bank-frame')) {
      const visible = !element.classList.contains('is-hidden') && element.checkVisibility();
      if (visible && !this.npcFrames.has(element)) { opened = true; this.npcFrames.add(element); }
      if (!visible) this.npcFrames.delete(element);
    }
    return opened;
  }
  update(camera: THREE.Camera, time: number, visible: boolean) {
    this.mesh.visible = visible; if (!visible) { this.release(); return; }
    camera.getWorldPosition(this.mesh.position); camera.getWorldQuaternion(this.mesh.quaternion);
    this.mesh.position.add(this.worldOffset.copy(this.offset).applyQuaternion(this.mesh.quaternion)); this.mesh.updateMatrixWorld(true);
    if (time - this.lastPaint < 50) return;
    this.lastPaint = time; flushCanvasRenders(); this.ctx.clearRect(0, 0, 1400, 700); this.tiles = [];
    this.copy('#wow-player-frame .wow-unit-frame-canvas', 0, 260, 560, 240);
    this.copy('#wow-target-frame .wow-unit-frame-canvas', 840, 260, 560, 240);
    if (this.minimap) this.copy('#wow-minimap canvas', 550, 0, 300, 340);
    if (this.combat) {
      // FrameXML's six 42px-spaced action slots per row, enlarged independently of decorative bar art.
      this.copy('.wow-main-menu-bar-canvas', 320, 465, 760, 88, [104 / 1216, 130 / 173, 252 / 1216, 42 / 173]);
      this.copy('.wow-main-menu-bar-canvas', 320, 565, 760, 88, [356 / 1216, 130 / 173, 252 / 1216, 42 / 173]);
    }
    this.ctx.font = '24px sans-serif'; this.ctx.textAlign = 'center'; this.ctx.fillStyle = '#ffdc87';
    this.ctx.fillText('B: Bags · Hold B: Menu · Y: Minimap · X: Target · Right stick click: Combat', 700, 695);
    this.texture.needsUpdate = true;
  }
  private copy(selector: string, x: number, y: number, w: number, h: number, crop = [0, 0, 1, 1]) {
    const canvas = document.querySelector<HTMLCanvasElement>(selector);
    if (!canvas?.width || !canvas.height || !canvas.checkVisibility({ checkVisibilityCSS: true })) return;
    const sourceWidth = canvas.width * crop[2], sourceHeight = canvas.height * crop[3];
    const factor = Math.min(w / sourceWidth, h / sourceHeight);
    const tile = { canvas, x, y, w: sourceWidth * factor, h: sourceHeight * factor, crop };
    this.ctx.drawImage(canvas, canvas.width * crop[0], canvas.height * crop[1], sourceWidth, sourceHeight, x, y, tile.w, tile.h); this.tiles.push(tile);
  }
  pointer(ray: THREE.Ray, down: boolean, up: boolean) {
    if (!this.mesh.visible) return false;
    this.raycaster.ray.copy(ray); this.intersections.length = 0; this.raycaster.intersectObject(this.mesh, false, this.intersections);
    const uv = this.intersections[0]?.uv;
    const x = (uv?.x ?? -1) * 1400, y = (1 - (uv?.y ?? 2)) * 700;
    const hit = this.tiles.find(t => x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h);
    const tile = this.held ?? hit;
    if (tile && uv) {
      const rect = tile.canvas.getBoundingClientRect();
      const clientX = rect.left + (tile.crop[0] + (x - tile.x) / tile.w * tile.crop[2]) * rect.width;
      const clientY = rect.top + (tile.crop[1] + (y - tile.y) / tile.h * tile.crop[3]) * rect.height;
      const emit = (type: string, held: boolean) => dispatchXrPointer(tile.canvas, new PointerEvent(type,
        { pointerId: 91, pointerType: 'mouse', isPrimary: true, button: 0, buttons: held ? 1 : 0, clientX, clientY, bubbles: true, cancelable: true }));
      emit('pointermove', !!this.held);
      if (down && hit) { this.held = hit; emit('pointerdown', true); }
      if (up && this.held) { emit('pointerup', false); this.held = undefined; }
    } else if (up) this.release();
    return !!hit || !!this.held;
  }
  release() {
    if (this.held) dispatchXrPointer(this.held.canvas, new PointerEvent('pointercancel', { pointerId: 91, bubbles: true }));
    this.held = undefined;
  }
  hide() { this.release(); this.mesh.visible = false; this.npcFrames.clear(); this.lastDialogScan = -Infinity; }
  dispose() { this.hide(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose(); }
}
