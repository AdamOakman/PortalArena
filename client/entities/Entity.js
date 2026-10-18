import * as THREE from 'three';

/**
 * Entity — Abstract base class for interactive game world objects.
 */
export class Entity {
  static _nextId = 1;

  constructor(type = 'entity') {
    this.id = Entity._nextId++;
    this.type = type;
    this.position = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.active = true;
    this.mesh = null;
  }

  /**
   * Called on each frame step.
   * @param {number} _dt - Delta time in seconds
   */
  update() {}

  /**
   * Cleanup resources when removed from the world.
   */
  destroy() {
    this.active = false;
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
  }
}
