import * as THREE from 'three';
import { packWmoTextureLayers, textureKey } from './wmo-material-family';
import { admitTextureUpload, texturePayloadBytes } from './texture-upload-admission';

type Page = { textures: THREE.CompressedTexture[]; array: THREE.CompressedArrayTexture; bytes: number; refs: number; ready: Promise<void> };
export type FamilyTextureLease = { array: THREE.CompressedArrayTexture; textures: THREE.CompressedTexture[]; release: () => void };
type Upload = (texture: THREE.CompressedArrayTexture) => Promise<void>;

/** Share immutable compressed pages across rooms, with one upload and explicit ownership. */
export class WmoFamilyTexturePool {
  private pages = new Set<Page>();
  private owners = new Map<THREE.Object3D, Set<THREE.CompressedTexture>>();
  private bytes = 0;
  private peakBytes = 0;
  private reused = 0;
  constructor(readonly budget = 32 * 1024 * 1024, private upload: Upload = texture => admitTextureUpload(texture, 'wmo-shared-family-array', {
    validate: renderer => { const gl = renderer.getContext(); if (gl.getError() !== gl.NO_ERROR) throw new Error('WMO shared page upload failed'); },
  })) {}

  register(owner: THREE.Object3D, textures: THREE.CompressedTexture[]): void {
    const known = this.owners.get(owner) ?? new Set<THREE.CompressedTexture>();
    textures.forEach(texture => known.add(texture)); this.owners.set(owner, known);
  }

  unregister(group: THREE.Object3D): void {
    for (const owner of this.owners.keys()) {
      let node: THREE.Object3D | null = owner;
      while (node && node !== group) node = node.parent;
      if (node) this.owners.delete(owner);
    }
  }

  async acquire(requested: THREE.CompressedTexture[]): Promise<FamilyTextureLease | null> {
    if (!requested.length || requested.length > 64) return null;
    const key = textureKey(requested[0]);
    if (requested.some(texture => textureKey(texture) !== key)) return null;
    let page = [...this.pages].find(candidate => requested.every(texture => candidate.textures.includes(texture)));
    if (page) this.reused++;
    else {
      const textures = [...new Set(requested)];
      let size = textures.reduce((sum, texture) => sum + texturePayloadBytes(texture), 0);
      if (this.bytes + size > this.budget) return null;
      const known = [...new Set([...this.owners.values()].flatMap(value => [...value]))].sort((a, b) => a.id - b.id);
      for (const texture of known) {
        if (textures.includes(texture) || textureKey(texture) !== key || textures.length >= 64) continue;
        const extra = texturePayloadBytes(texture); if (this.bytes + size + extra > this.budget) continue;
        textures.push(texture); size += extra;
      }
      const array = packWmoTextureLayers(textures);
      page = { textures, array, bytes: size, refs: 0, ready: Promise.resolve() };
      this.pages.add(page); this.bytes += size; this.peakBytes = Math.max(this.bytes, this.peakBytes);
      const created = page;
      // Publish before uploading, so concurrent requests join the same admission job.
      page.ready = Promise.resolve().then(() => this.upload(array)).catch(error => { this.discard(created); throw error; });
    }
    const held = page; held.refs++;
    try { await held.ready; }
    catch (error) { held.refs--; throw error; }
    let released = false;
    return { array: held.array, textures: held.textures, release: () => {
      if (released) return; released = true;
      if (--held.refs === 0) this.discard(held);
    } };
  }

  private discard(page: Page): void {
    if (!this.pages.delete(page)) return;
    this.bytes -= page.bytes; page.array.dispose();
  }

  stats() { return { pages: this.pages.size, bytes: this.bytes, peakBytes: this.peakBytes, budget: this.budget, reused: this.reused, owners: this.owners.size }; }
  texturesFor(array: THREE.CompressedArrayTexture): readonly THREE.CompressedTexture[] | undefined {
    for (const page of this.pages) if (page.array === array) return page.textures;
  }
}

export const wmoFamilyTexturePool = new WmoFamilyTexturePool();
