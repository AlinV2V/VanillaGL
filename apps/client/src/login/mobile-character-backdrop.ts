import * as THREE from 'three';

/** Static mobile presentation: one cached texture, without additional scene assets or effects. */
export class MobileCharacterBackdrop {
  private readonly canvas = document.createElement('canvas');
  private texture?: THREE.CanvasTexture;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly size = new THREE.Vector2();
  private aspect = 0;

  render(renderer: THREE.WebGLRenderer) {
    const size = renderer.getSize(this.size), aspect = size.x / Math.max(1, size.y);
    if (Math.abs(aspect - this.aspect) > 0.005) {
      this.aspect = aspect;
      this.paint(aspect);
    }
    renderer.render(this.scene, this.camera);
  }

  private paint(aspect: number) {
    const h = this.canvas.height = Math.round(Math.min(1024, 1024 / aspect));
    const w = this.canvas.width = Math.round(h * aspect);
    const ctx = this.canvas.getContext('2d')!;
    const portrait = aspect < 1;
    const cx = w * (portrait ? 0.5 : 0.36), cy = h * (portrait ? 0.25 : 0.4);
    const floor = h * (portrait ? 0.46 : 0.81);
    const base = ctx.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, '#080811');
    base.addColorStop(0.4, '#181525');
    base.addColorStop(1, '#08090f');
    ctx.fillStyle = base; ctx.fillRect(0, 0, w, h);

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w * 0.55, floor));
    glow.addColorStop(0, 'rgba(103,85,142,0.38)');
    glow.addColorStop(0.5, 'rgba(48,42,72,0.2)');
    glow.addColorStop(1, 'rgba(8,8,17,0)');
    ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

    // Quiet architectural framing, fading into the edges rather than a hard horizon.
    ctx.strokeStyle = 'rgba(147,136,166,0.08)'; ctx.lineWidth = Math.max(1, w / 600);
    for (const side of [-1, 1]) {
      const x = cx + side * w * (portrait ? 0.4 : 0.28);
      ctx.beginPath(); ctx.moveTo(x, floor); ctx.lineTo(x, h * 0.14);
      ctx.quadraticCurveTo(x, h * 0.04, cx, h * 0.015); ctx.stroke();
    }
    ctx.save(); ctx.translate(cx, floor); ctx.scale(1, 0.17);
    const radius = w * (portrait ? 0.39 : 0.26);
    const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    pool.addColorStop(0, 'rgba(119,111,143,0.19)');
    pool.addColorStop(0.7, 'rgba(63,58,77,0.12)');
    pool.addColorStop(1, 'rgba(12,12,20,0)');
    ctx.fillStyle = pool; ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
    ctx.restore();
    // Texture dimensions are immutable once uploaded; replace it after orientation changes.
    this.texture?.dispose();
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.generateMipmaps = false;
    this.texture.minFilter = THREE.LinearFilter;
    this.scene.background = this.texture;
  }

  destroy() { this.texture?.dispose(); }
}
