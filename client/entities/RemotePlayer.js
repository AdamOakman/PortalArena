import * as THREE from 'three';
import { Entity } from './Entity.js';

/**
 * RemotePlayer — Entity representing an opponent human or bot in the arena.
 */
export class RemotePlayer extends Entity {
  constructor(pid, data = {}) {
    super('remote_player');
    this.pid = pid;
    this.name = data.name || 'Player';
    this.playerIndex = data.playerIndex || 0;
    this.isBot = !!data.isBot;
    this.isDead = false;
    this.activeWeapon = 1;

    this.targetPos = new THREE.Vector3();
    this.targetYaw = 0;
    this.targetPitch = 0;
    this.mesh = null;

    if (data.pos) {
      this.position.set(...data.pos);
      this.targetPos.copy(this.position);
    }
  }

  /**
   * Update remote player from a network state snapshot.
   * @param {object} snapshot
   */
  updateFromSnapshot(snapshot) {
    if (!snapshot) return;
    if (snapshot.pos) this.targetPos.set(...snapshot.pos);
    if (snapshot.vel) this.velocity.set(...snapshot.vel);
    if (snapshot.yaw != null) this.targetYaw = snapshot.yaw;
    if (snapshot.pitch != null) this.targetPitch = snapshot.pitch;
    if (snapshot.name) this.name = snapshot.name;
    if (snapshot.activeWeapon != null) this.activeWeapon = snapshot.activeWeapon;
    this.isDead = !!snapshot.isDead;
  }

  /**
   * Smoothly interpolate position and orientation towards target.
   * @param {number} dt
   */
  update(dt) {
    const lerpFactor = Math.min(1.0, dt * 20);
    this.position.lerp(this.targetPos, lerpFactor);

    if (this.mesh) {
      this.mesh.position.copy(this.position);
      this.mesh.rotation.y = this.targetYaw;
    }
  }
}
