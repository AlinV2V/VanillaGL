import * as THREE from 'three';
import { flushCanvasRenders } from '../ui/vanilla-canvas';
import { dispatchXrPointer } from './xr-pointer-events';
import { xrGameAction } from './xr-game-actions';

type CanvasHit = { canvas: HTMLCanvasElement; rect: DOMRect; z: number };
const toolbar = ['Attack', 'Bags', 'Map', 'Quests', 'Spells', 'Chat', 'Settings', 'Close'];
export function xrKey(code: string, key = code) {
  const target = document.activeElement ?? window;
  for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { code, key, bubbles: true, cancelable: true }));
}

/** Composites the existing canvas frames, preserving their layout and interaction handlers. */
export class XrCanvasPanel {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private hits: CanvasHit[] = [];
  private pressed?: { hit: CanvasHit; x: number; y: number };
  private hover?: CanvasHit;
  private lastPaint = -Infinity;
  private keyboard = false;
  private shift = false;
  private focusContents = false;
  private viewport = { x: 0, y: 0, width: 1, height: 1 };
  private readonly raycaster = new THREE.Raycaster();
  private readonly rayHits: THREE.Intersection[] = [];
  private readonly width = 1536;
  private readonly height = 1024;
  constructor(private readonly scene: THREE.Scene, private readonly worldCanvas: HTMLCanvasElement,
    private readonly action: (name: string) => void) {
    this.canvas.width = this.width; this.canvas.height = this.height;
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new THREE.CanvasTexture(this.canvas); this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter; this.texture.generateMipmaps = false;
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8 * this.height / this.width),
      new THREE.MeshBasicMaterial({ map: this.texture, toneMapped: false, side: THREE.DoubleSide }));
    this.mesh.name = 'VR game panel'; this.mesh.visible = false; this.scene.add(this.mesh);
  }
  toggle(camera: THREE.Camera) {
    this.release(); this.mesh.visible = !this.mesh.visible;
    if (this.mesh.visible) {
      camera.getWorldPosition(this.mesh.position); camera.getWorldQuaternion(this.mesh.quaternion);
      this.mesh.position.add(new THREE.Vector3(0, 0, -2.3).applyQuaternion(this.mesh.quaternion));
      this.mesh.updateMatrixWorld(true); this.lastPaint = -Infinity;
    }
  }
  hide() { this.release(); this.mesh.visible = false; }
  show(camera: THREE.Camera) {
    this.focusContents = true;
    if (!this.mesh.visible) this.toggle(camera);
    this.lastPaint = -Infinity;
  }
  paint(time: number) {
    if (!this.mesh.visible || time - this.lastPaint < 1000 / 20) return;
    this.lastPaint = time; flushCanvasRenders();
    const ctx = this.ctx; ctx.fillStyle = '#10151c'; ctx.fillRect(0, 0, this.width, this.height);
    const screenHeight = this.height - (this.keyboard ? 300 : 80);
    this.hits = [];
    for (const canvas of document.querySelectorAll('canvas')) {
      if (canvas === this.worldCanvas || canvas === this.canvas || !canvas.width || !canvas.height) continue;
      const rect = canvas.getBoundingClientRect();
      if (!rect.width || !rect.height || !canvas.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
      let z = 0;
      for (let element: HTMLElement | null = canvas; element; element = element.parentElement) {
        z = Math.max(z, Number.parseInt(getComputedStyle(element).zIndex) || 0);
      }
      this.hits.push({ canvas, rect, z });
    }
    this.hits.sort((a, b) => a.z - b.z);
    this.viewport = { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight };
    if (this.focusContents && !this.keyboard) {
      const panels = this.hits.filter(h => h.canvas.closest('[data-frame-id], #wow-character-frame, #wow-container-layer, #wow-gossip-frame, #wow-loot-frame, #wow-quest-frame, #wow-bank-frame, .wow-esc-layer'));
      if (panels.length) {
        const x = Math.min(...panels.map(h => h.rect.left)) - 12, y = Math.min(...panels.map(h => h.rect.top)) - 12;
        let width = Math.max(...panels.map(h => h.rect.right)) - x + 12, height = Math.max(...panels.map(h => h.rect.bottom)) - y + 12;
        const scale = Math.min(this.width / width, screenHeight / height);
        width = this.width / scale; height = screenHeight / scale;
        this.viewport = { x, y, width, height }; this.hits = panels;
      }
    }
    const sx = this.width / this.viewport.width, sy = screenHeight / this.viewport.height;
    for (const { canvas, rect } of this.hits) {
      ctx.drawImage(canvas, (rect.x - this.viewport.x) * sx, (rect.y - this.viewport.y) * sy, rect.width * sx, rect.height * sy);
    }
    ctx.font = '22px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    toolbar.forEach((label, i) => {
      ctx.fillStyle = '#293649'; ctx.fillRect(i * 192 + 4, this.height - 72, 184, 64);
      ctx.fillStyle = '#ffda78'; ctx.fillText(label, i * 192 + 96, this.height - 40);
    });
    if (this.keyboard) {
      const rows = this.keyboardRows();
      rows.forEach((row, r) => row.forEach((label, c) => {
        const w = this.width / row.length;
        ctx.fillStyle = '#344356'; ctx.fillRect(c * w + 3, screenHeight + r * 54 + 3, w - 6, 48);
        ctx.fillStyle = '#fff'; ctx.fillText(label, c * w + w / 2, screenHeight + r * 54 + 27);
      }));
    }
    this.texture.needsUpdate = true;
  }
  private keyboardRows() {
    return ['1234567890', 'qwertyuiop', 'asdfghjkl'].map(row => [...(this.shift ? row.toUpperCase() : row)])
      .concat([['Shift', ...[...(this.shift ? 'ZXCVBNM' : 'zxcvbnm')], 'Space', 'Back', 'Send']]);
  }
  private type(label: string) {
    if (label === 'Shift') { this.shift = !this.shift; return; }
    const key = label === 'Send' ? 'Enter' : label === 'Back' ? 'Backspace' : label === 'Space' ? ' ' : label;
    const target = document.activeElement;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      if (key.length === 1 || key === 'Backspace') {
        const type = key === 'Backspace' ? 'deleteContentBackward' : 'insertText';
        const before = new InputEvent('beforeinput', { inputType: type, data: key.length === 1 ? key : null, bubbles: true, cancelable: true });
        if (target.dispatchEvent(before)) {
          const start = target.selectionStart ?? target.value.length, end = target.selectionEnd ?? start;
          target.setRangeText(key === 'Backspace' ? '' : key, key === 'Backspace' && start === end ? Math.max(0, start - 1) : start, end, 'end');
          target.dispatchEvent(new Event('input', { bubbles: true }));
        }
      } else xrKey(key, key);
    } else xrKey(key === ' ' ? 'Space' : key, key);
  }
  /** Returns true whenever the ray hits UI, even without a click, to suppress weapon gestures. */
  pointer(ray: THREE.Ray, down: boolean, up: boolean): boolean {
    if (!this.mesh.visible) return false;
    this.raycaster.ray.copy(ray); this.rayHits.length = 0;
    this.raycaster.intersectObject(this.mesh, false, this.rayHits);
    const uv = this.rayHits[0]?.uv;
    if (!uv) { if (up) this.release(); return false; }
    const x = uv.x * this.width, y = (1 - uv.y) * this.height;
    const screenHeight = this.height - (this.keyboard ? 300 : 80);
    if (y >= this.height - 80) {
      if (down) {
        const index = Math.min(7, Math.floor(x / 192));
        if (index === 5) this.keyboard = !this.keyboard;
        if (index === 5) xrKey('Enter', 'Enter');
        else if (index > 0 && index < 5) xrGameAction(toolbar[index]);
        else if (index === 7) this.hide();
        else this.action(toolbar[index]);
      }
    } else if (this.keyboard && y >= screenHeight) {
      if (down) {
        const row = this.keyboardRows()[Math.floor((y - screenHeight) / 54)];
        if (row) this.type(row[Math.min(row.length - 1, Math.floor(x / this.width * row.length))]);
      }
    } else {
      const clientX = this.viewport.x + x / this.width * this.viewport.width, clientY = this.viewport.y + y / screenHeight * this.viewport.height;
      const hit = [...this.hits].reverse().find(h => clientX >= h.rect.left && clientX < h.rect.right && clientY >= h.rect.top && clientY < h.rect.bottom);
      if (this.hover?.canvas !== hit?.canvas) this.hover?.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 91 }));
      this.hover = hit;
      if (hit) {
        this.emit(this.pressed?.hit ?? hit, 'pointermove', clientX, clientY, !!this.pressed);
        if (down) { this.pressed = { hit, x: clientX, y: clientY }; this.emit(hit, 'pointerdown', clientX, clientY, true); }
        if (up && this.pressed) { this.emit(this.pressed.hit, 'pointerup', clientX, clientY, false); this.pressed = undefined; }
      }
    }
    if (up && this.pressed) this.release();
    return true;
  }
  private emit(hit: CanvasHit, type: string, clientX: number, clientY: number, held: boolean) {
    dispatchXrPointer(hit.canvas, new PointerEvent(type, { pointerId: 91, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: held ? 1 : 0, clientX, clientY, bubbles: true, cancelable: true }));
  }
  release() {
    if (this.pressed) this.emit(this.pressed.hit, 'pointercancel', this.pressed.x, this.pressed.y, false);
    this.pressed = undefined;
    this.hover?.canvas.dispatchEvent(new PointerEvent('pointerleave', { pointerId: 91 })); this.hover = undefined;
  }
  dispose() { this.hide(); this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mesh.material.dispose(); this.texture.dispose(); }
}
