import * as THREE from 'three';
import { Entity } from '../entities/Entity.js';

/**
 * RocketProjectile — Entity representing a live rocket projectile in flight.
 */
export class RocketProjectile extends Entity {
  constructor(position, velocity, shooterId, isLocal = false) {
    super('rocket');
    this.position.copy(position);
    this.velocity.copy(velocity);
    this.shooterId = shooterId;
    this.isLocal = isLocal;
    this.life = 5.0; // 5 seconds lifetime max

    this.mesh = this._createMesh();
    this.mesh.position.copy(this.position);
    if (this.velocity.lengthSq() > 0.001) {
      this.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.velocity.clone().normalize());
    }
  }

  _createMesh() {
    const group = new THREE.Group();
    const bodyGeo = new THREE.CylinderGeometry(0.06, 0.06, 0.4, 8);
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x222222 });
    const body = new THREE.Mesh(bodyGeo, bodyMat);

    const tipGeo = new THREE.ConeGeometry(0.06, 0.2, 8);
    const tipMat = new THREE.MeshStandardMaterial({ color: 0xff0000 });
    const tip = new THREE.Mesh(tipGeo, tipMat);
    tip.position.y = 0.3;

    group.add(body, tip);
    return group;
  }

  update(dt) {
    this.life -= dt;
    if (this.life <= 0) {
      this.destroy();
      return;
    }

    this.position.addScaledVector(this.velocity, dt);
    if (this.mesh) {
      this.mesh.position.copy(this.position);
    }
  }
}
