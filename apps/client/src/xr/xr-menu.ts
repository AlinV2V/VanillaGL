import * as THREE from 'three';
import { defaultXrSettings, saveXrSettings, type XrSettings } from './xr-settings';

export const XR_MENU_ITEMS = ['Bags', 'Character', 'Skills', 'Spells', 'Quests', 'Map', 'Minimap', 'Combat', 'Settings', 'Recenter', 'Exit VR', 'Close'];
export function radialSelection(x: number, y: number): number {
  if (Math.hypot(x, y) < 0.4) return -1;
  return Math.round((Math.atan2(y, x) + Math.PI / 2 + Math.PI * 2) / (Math.PI * 2) * XR_MENU_ITEMS.length) % XR_MENU_ITEMS.length;
}
type Hit = { x: number; y: number; w: number; h: number; run: () => void };
/** A canvas radial menu and readable VR-specific settings, positioned in world space. */
export class XrMenu {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly raycaster = new THREE.Raycaster();
  private readonly intersections: THREE.Intersection[] = [];
  private hits: Hit[] = [];
  private selected = -1;
  private mode: 'wheel' | 'settings' = 'wheel';
  private appliedResolution = 1;
  constructor(scene: THREE.Scene, private readonly settings: XrSettings, private readonly action: (name: string) => void,
    private readonly changed: () => void) {
    this.canvas.width = 1200; this.canvas.height = 1000; this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false; this.texture.minFilter = THREE.LinearFilter;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 1.9 * 1000 / 1200),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true, toneMapped: false, depthTest: false, depthWrite: false }));
    this.mesh.name = 'VR menu'; this.mesh.visible = false; this.mesh.renderOrder = 10000; scene.add(this.mesh);
  }
  get visible() { return this.mesh.visible; }
  get wheel() { return this.visible && this.mode === 'wheel'; }
  show(camera: THREE.Camera, mode: 'wheel' | 'settings', appliedResolution: number) {
    this.mode = mode; this.appliedResolution = appliedResolution; this.selected = -1;
    camera.getWorldPosition(this.mesh.position); camera.getWorldQuaternion(this.mesh.quaternion);
    this.mesh.position.add(new THREE.Vector3(0, -0.1, -1.8).applyQuaternion(this.mesh.quaternion));
    this.mesh.visible = true; this.mesh.updateMatrixWorld(true); this.paint();
  }
  hide() { this.mesh.visible = false; this.selected = -1; }
  stick(x: number, y: number) {
    if (!this.wheel) return;
    const next = radialSelection(x, y);
    if (this.selected !== next) { this.selected = next; this.paint(); }
  }
  choose() {
    if (!this.wheel) return;
    const name = XR_MENU_ITEMS[this.selected]; this.hide(); if (name && name !== 'Close') this.action(name);
  }
  pointer(ray: THREE.Ray, down: boolean): boolean {
    if (!this.visible) return false;
    this.raycaster.ray.copy(ray); this.intersections.length = 0; this.raycaster.intersectObject(this.mesh, false, this.intersections);
    const uv = this.intersections[0]?.uv; if (!uv) return false;
    const x = uv.x * 1200, y = (1 - uv.y) * 1000;
    if (this.mode === 'wheel') {
      const dx = (x - 600) / 330, dy = (y - 490) / 330;
      this.stick(dx, dy); if (down) this.choose();
    } else if (down) this.hits.find(h => x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h)?.run();
    return true;
  }
  private button(label: string, x: number, y: number, w: number, run: () => void) {
    const ctx = this.ctx; ctx.fillStyle = '#34465d'; ctx.fillRect(x, y, w, 64);
    ctx.fillStyle = '#ffdc87'; ctx.fillText(label, x + w / 2, y + 32);
    this.hits.push({ x, y, w, h: 64, run });
  }
  private paint() {
    const ctx = this.ctx; ctx.clearRect(0, 0, 1200, 1000); this.hits = [];
    ctx.fillStyle = 'rgba(12,20,31,0.97)'; ctx.fillRect(0, 0, 1200, 1000);
    ctx.font = '32px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff';
    if (this.mode === 'wheel') {
      ctx.fillText('Game menu', 600, 60);
      XR_MENU_ITEMS.forEach((name, i) => {
        const angle = i / XR_MENU_ITEMS.length * Math.PI * 2 - Math.PI / 2;
        const x = 600 + Math.cos(angle) * 415, y = 490 + Math.sin(angle) * 340;
        ctx.fillStyle = this.selected === i ? '#806338' : '#263b52';
        ctx.beginPath(); ctx.ellipse(x, y, 105, 52, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#fff'; ctx.fillText(name, x, y, 200);
      });
      ctx.font = '27px sans-serif'; ctx.fillText('Point + trigger, or right stick + release B', 600, 915);
      ctx.fillText('Release in the centre to cancel', 600, 958);
    } else {
      ctx.fillText('VR clarity & comfort', 600, 50);
      const update = (fn: () => void) => { fn(); saveXrSettings(this.settings); this.changed(); this.paint(); };
      this.button('Quest', 45, 100, 240, () => update(() => Object.assign(this.settings, defaultXrSettings(true))));
      this.button('PC clarity', 310, 100, 240, () => update(() => Object.assign(this.settings, defaultXrSettings(false))));
      this.button('Game settings', 575, 100, 270, () => this.action('Game settings'));
      this.button('Close', 870, 100, 285, () => this.hide());
      const rows: [keyof XrSettings, string, number, number, number][] = [
        ['resolution', 'Resolution (next VR entry)', 0.05, 0.7, 1.5], ['foveation', 'Edge blur / foveation (0 = clear)', 0.25, 0, 1],
        ['distance', 'View distance', 50, 100, 700], ['handScale', 'Hand size', 0.05, 0.6, 1],
        ['pitch', 'Grip pitch (degrees)', 5, -90, 90], ['roll', 'Grip roll (mirrored)', 5, -90, 90],
      ];
      rows.forEach(([key, label, step, min, max], i) => {
        const y = 195 + i * 95; ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(label, 45, y + 32);
        ctx.textAlign = 'center'; ctx.fillText(String(Math.round(this.settings[key] * 100) / 100), 880, y + 32);
        this.button('−', 735, y, 80, () => update(() => { this.settings[key] = Math.max(min, Math.round((this.settings[key] - step) * 100) / 100); }));
        this.button('+', 1000, y, 80, () => update(() => { this.settings[key] = Math.min(max, Math.round((this.settings[key] + step) * 100) / 100); }));
      });
      ctx.font = '25px sans-serif'; ctx.fillStyle = '#ffdc87';
      ctx.fillText(`Current resolution: ${Math.round(this.appliedResolution * 100)}%. Resolution changes need Exit VR → Enter VR.`, 600, 815, 1140);
      ctx.fillText('Other controls apply now. Link streaming quality is set in the PC runtime.', 600, 855, 1140);
      this.button('Recenter', 150, 900, 400, () => this.action('Recenter'));
      this.button('Exit VR / apply resolution', 600, 900, 480, () => this.action('Exit VR'));
    }
    this.texture.needsUpdate = true;
  }
  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose(); }
}
