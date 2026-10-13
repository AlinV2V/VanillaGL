import type * as THREE from 'three';

/** Only restore visibility that the follow camera itself took away. */
export class FirstPersonVisibility {
  private hidden = false;
  update(root: THREE.Object3D, firstPerson: boolean) {
    if (firstPerson) {
      if (!this.hidden && root.visible) { this.hidden = true; root.visible = false; }
    } else if (this.hidden) { this.hidden = false; root.visible = true; }
  }
}
