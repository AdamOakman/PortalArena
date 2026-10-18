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
    this.playerIndex = data.playerIndex != null ? data.playerIndex : 0;
    this.isBot = !!data.isBot;
    this.isDead = !!data.isDead;
    this.activeWeapon = data.activeWeapon || 1;
    this.crouchT = data.crouchT || 0;
    this.yaw = data.yaw || 0;
    this.pitch = data.pitch || 0;

    this.pos = data.pos ? [...data.pos] : [0, 0, 0];
    this.vel = data.vel ? [...data.vel] : [0, 0, 0];
    this.position.set(this.pos[0], this.pos[1], this.pos[2]);
    this.velocity.set(this.vel[0], this.vel[1], this.vel[2]);

    this.targetPos = new THREE.Vector3().copy(this.position);
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;
    this.mesh = null;

    this.deathCamPos = null;
    this.deathCamTarget = null;
    this.lastShotOrigin = null;
    this.lastKillerId = null;
    this.predictedDeadUntil = null;

    if (data.viewOffset) {
      const vo = data.viewOffset;
      this.viewOffset = new THREE.Quaternion(vo[0], vo[1], vo[2], vo[3]);
    } else {
      this.viewOffset = null;
    }
  }

  /**
   * Update remote player from a network state snapshot.
   * @param {object} snapshot
   * @param {object} [match]
   */
  updateFromSnapshot(snapshot, match = null) {
    if (!snapshot) return;

    if (snapshot.name) {
      this.name = snapshot.name;
    } else if (match && match.players && match.players[this.pid] && match.players[this.pid].name) {
      this.name = match.players[this.pid].name;
    }

    if (snapshot.playerIndex != null) this.playerIndex = snapshot.playerIndex;
    if (snapshot.isBot != null) this.isBot = !!snapshot.isBot;
    if (snapshot.activeWeapon != null) this.activeWeapon = snapshot.activeWeapon;
    if (snapshot.crouchT != null) this.crouchT = snapshot.crouchT;

    if (snapshot.pos) {
      this.pos[0] = snapshot.pos[0];
      this.pos[1] = snapshot.pos[1];
      this.pos[2] = snapshot.pos[2];
      this.targetPos.set(...snapshot.pos);
      this.position.set(...snapshot.pos);
    }
    if (snapshot.vel) {
      this.vel[0] = snapshot.vel[0];
      this.vel[1] = snapshot.vel[1];
      this.vel[2] = snapshot.vel[2];
      this.velocity.set(...snapshot.vel);
    }
    if (snapshot.yaw != null) {
      this.yaw = snapshot.yaw;
      this.targetYaw = snapshot.yaw;
    }
    if (snapshot.pitch != null) {
      this.pitch = snapshot.pitch;
      this.targetPitch = snapshot.pitch;
    }

    if (snapshot.isDead) {
      this.isDead = true;
    } else {
      this.isDead = false;
      this.deathCamPos = null;
      this.deathCamTarget = null;
      this.lastShotOrigin = null;
      this.lastKillerId = null;
      this.predictedDeadUntil = null;
    }

    if (!this.viewOffset && snapshot.viewOffset) {
      const vo = snapshot.viewOffset;
      this.viewOffset = new THREE.Quaternion(vo[0], vo[1], vo[2], vo[3]);
    }
  }

  /**
   * Smoothly interpolate position and orientation towards target.
   * @param {number} dt
   */
  update(dt) {
    const lerpFactor = Math.min(1.0, dt * 20);
    this.position.lerp(this.targetPos, lerpFactor);
    this.pos[0] = this.position.x;
    this.pos[1] = this.position.y;
    this.pos[2] = this.position.z;

    if (this.mesh) {
      this.mesh.position.copy(this.position);
      this.mesh.rotation.y = this.targetYaw;
    }
  }

  destroy() {
    super.destroy();
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    this.mesh = null;
  }
}
