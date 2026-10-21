import * as THREE from 'three';
import { Entity } from './Entity.js';
import { CFG } from '../../shared/constants.js';
import { updatePortalTransition } from '../portals/PortalManager.js';

/**
 * RemotePlayer — Entity representing an opponent human or bot in the arena.
 */
export class RemotePlayer extends Entity {
  constructor(pid, data = {}) {
    super(pid || 'remote_player');
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
    this.cloneMesh = null;
    this.clipPlane = null;
    this.cloneClipPlane = null;

    this.deathCamPos = null;
    this.deathCamTarget = null;
    this.lastShotOrigin = null;
    this.lastKillerId = null;
    this.lastBeamDir = null;
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
      this.lastBeamDir = null;
      this.predictedDeadUntil = null;
    }

    if (!this.viewOffset && snapshot.viewOffset) {
      const vo = snapshot.viewOffset;
      this.viewOffset = new THREE.Quaternion(vo[0], vo[1], vo[2], vo[3]);
    }
  }

  /**
   * Smoothly interpolate position and orientation towards target, and synchronize visual mesh.
   * @param {number} dt
   * @param {number} [nowT=0]
   * @param {Object} [context=null]
   */
  update(dt, nowT = 0, context = null) {
    const lerpFactor = Math.min(1.0, dt * 20);
    this.position.lerp(this.targetPos, lerpFactor);
    this.pos[0] = this.position.x;
    this.pos[1] = this.position.y;
    this.pos[2] = this.position.z;

    this.updateVisuals(dt, nowT, context);
  }

  /**
   * Synchronize 3D player mesh, head rotation, weapon viewmodel visibility, and animations.
   * @param {number} dt
   * @param {number} nowT
   * @param {Object} [context=null]
   */
  updateVisuals(dt, nowT = 0, context = null) {
    const G = context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (!G) return;

    if (!this.mesh) {
      let remoteIndex = (this.playerIndex !== undefined)
        ? this.playerIndex
        : (G.match && G.match.players[this.pid] ? G.match.players[this.pid].index : (1 - G.localPlayerIndex));
      if (remoteIndex < 0) remoteIndex = 0;
      const remoteColor = remoteIndex === 0 ? 0x33ff33 : 0xff3333;

      this.clipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
      const mesh = G.createPlayerModel(remoteColor, 0, this.clipPlane);
      G.scene.add(mesh);
      if (G.remotePlayerMeshes) G.remotePlayerMeshes[this.pid] = mesh;
      this.mesh = mesh;

      this.cloneClipPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 1e6);
      const cloneMesh = G.createPlayerModel(remoteColor, 0, this.cloneClipPlane);
      cloneMesh.visible = false;
      G.scene.add(cloneMesh);
      this.cloneMesh = cloneMesh;
      mesh.userData.cloneMesh = cloneMesh;
    }

    const m = this.mesh;
    if (this.predictedDeadUntil && nowT < this.predictedDeadUntil) {
      this.isDead = true;
    }

    const isTargetFollowPOV = G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === this.pid && G.followPerspective === 'pov' && !this.isDead;
    if (!isTargetFollowPOV && this.viewOffset) {
      const id = new THREE.Quaternion();
      this.viewOffset.slerp(id, Math.min(1, dt * 5));
      if (this.viewOffset.angleTo(id) < 0.001) this.viewOffset = null;
    }

    m.visible = !this.isDead && !isTargetFollowPOV;
    m.position.set(this.pos[0], this.pos[1], this.pos[2]);
    m.quaternion.setFromEuler(new THREE.Euler(0, this.yaw, 0, 'YXZ'));
    if (this.viewOffset) {
      m.quaternion.multiply(this.viewOffset);
    }

    const rpCT = this.crouchT || 0;
    if (m.userData.smoothCrouchT === undefined) {
      m.userData.smoothCrouchT = rpCT;
    } else {
      m.userData.smoothCrouchT += (rpCT - m.userData.smoothCrouchT) * Math.min(1, dt * 14);
    }

    const cT = m.userData.smoothCrouchT;
    const rpBody = m.children.find(c => c.name === 'bodyMesh');
    if (rpBody) {
      rpBody.scale.y = 1 - cT * 0.4;
      rpBody.position.y = -cT * 0.25;
    }

    if (m.userData.headGroup) {
      m.userData.headGroup.rotation.x = this.pitch;
      m.userData.headGroup.position.y = (CFG.H - (CFG.H - CFG.CROUCH_H) * cT) - 0.12;
    }

    if (m.userData.mirrorGun) {
      m.userData.mirrorGun.visible = (this.activeWeapon === 1 || !this.activeWeapon);
      m.userData.mirrorRocketGun.visible = (this.activeWeapon === 2);
      if (m.userData.mirrorInstagibGun) m.userData.mirrorInstagibGun.visible = (this.activeWeapon === 3);
    }

    if (m.userData.muzzleT !== undefined) {
      m.userData.muzzleT = Math.max(0, m.userData.muzzleT - dt * 6);
      const mt = m.userData.muzzleT;
      const rScale = 1 + mt * 0.12;
      const rZ = -0.5 + mt * 0.15;
      const rRot = mt * 0.3;
      m.userData.mirrorGun.scale.setScalar(1);
      m.userData.mirrorGun.position.z = -0.5;
      m.userData.mirrorGun.rotation.x = 0;
      m.userData.mirrorRocketGun.scale.setScalar(1);
      m.userData.mirrorRocketGun.position.z = -0.5;
      m.userData.mirrorRocketGun.rotation.x = 0;
      if (m.userData.mirrorInstagibGun) {
        m.userData.mirrorInstagibGun.scale.setScalar(1);
        m.userData.mirrorInstagibGun.position.z = -0.5;
        m.userData.mirrorInstagibGun.rotation.x = 0;
      }
      const aw = this.activeWeapon || 1;
      const activeMir = aw === 1 ? m.userData.mirrorGun : (aw === 2 ? m.userData.mirrorRocketGun : m.userData.mirrorInstagibGun);
      if (activeMir) {
        activeMir.scale.setScalar(rScale);
        activeMir.position.z = rZ;
        activeMir.rotation.x = rRot;
      }
    } else {
      m.userData.muzzleT = 0;
    }

    if (this.mesh && this.cloneMesh && this.clipPlane && this.cloneClipPlane) {
      updatePortalTransition(
        this.mesh,
        this.cloneMesh,
        this.clipPlane,
        this.cloneClipPlane,
        this.pos,
        G.portals,
        G.R_AB,
        G.R_BA
      );
    }
  }

  destroy() {
    super.destroy();
    if (this.mesh && this.mesh.parent) {
      this.mesh.parent.remove(this.mesh);
    }
    if (this.cloneMesh && this.cloneMesh.parent) {
      this.cloneMesh.parent.remove(this.cloneMesh);
    }
    this.mesh = null;
    this.cloneMesh = null;
    this.clipPlane = null;
    this.cloneClipPlane = null;
  }
}
