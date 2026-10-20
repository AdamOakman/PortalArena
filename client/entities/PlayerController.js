import * as THREE from 'three';
import { Entity } from './Entity.js';
import { AudioSys } from '../audio/AudioController.js';
import { CFG } from '../../shared/constants.js';

/**
 * PlayerController — Entity encapsulating the local player's Quake movement physics,
 * view angles, spectator states, camera updates, grab mechanics, and lifecycle.
 */
export class PlayerController extends Entity {
  constructor(engine = null) {
    super('player_local');
    this.engine = engine;

    // Movement & orientation
    this.yaw = 0;
    this.pitch = 0;
    this.viewOffset = null;
    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundT = -1;
    this.jumpBuf = -1;
    this.cp = new THREE.Vector3();
    this.maxSpeed = 0;
    this.crouchT = 0;
    this.autohop = true;

    // Lifecycle state
    this.isDead = false;
    this.isSpectator = true;
    this.spectatorMode = 'freefly'; // 'freefly' | 'follow'
    this.followPerspective = 'pov';  // 'pov' | 'chase'
    this.spectateTargetPid = null;

    // Freefly spectator camera
    this.specPos = new THREE.Vector3(0, 10, 20);
    this.specYaw = 0;
    this.specPitch = -0.2;

    // Teleport grace state
    this.tpGracePortal = null;
    this.tpGraceT = -1;

    // Death camera targets
    this.deathCamPos = new THREE.Vector3();
    this.deathCamTarget = new THREE.Vector3();

    this.playerModel = null;
    this.playerClipPlane = null;
  }

  /**
   * Reset player to a spawn point.
   * @param {THREE.Vector3|number[]} spawnPos
   */
  respawn(spawnPos) {
    this.isDead = false;
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G) G.isDead = false;
    if (Array.isArray(spawnPos)) {
      this.position.fromArray(spawnPos);
    } else {
      this.position.copy(spawnPos);
    }
    this.velocity.set(0, 0, 0);
    this.viewOffset = null;
    this.grounded = false;
    this.crouchT = 0;
    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('PLAYER_RESPAWNED', { position: this.position });
    }
  }

  /**
   * Handle player death with directional death camera placement.
   */
  die(killerId = null, viaPortal = false, cause = 'generic', shotOrigin = null, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (G && (!G.started || G.won || G.isDead)) return;
    this.isDead = true;
    if (G) G.isDead = true;

    const myColor = (G && G.localPlayerIndex === 0) ? 0x33ff33 : 0xff3333;
    if (G && G.Network && G.Network.send) {
      G.Network.send({
        type: 'player_died',
        pos: this.position.toArray(),
        color: myColor,
        killerId: killerId || null,
        viaPortal: !!viaPortal,
        cause: cause || null
      });
    }

    if (G && G.spawnDeathAnimation) {
      G.spawnDeathAnimation(this.position, myColor);
    }

    if (G) {
      if (G.gun) G.gun.visible = false;
      if (G.rocketGun) G.rocketGun.visible = false;
      if (G.instagibGun) G.instagibGun.visible = false;
      if (G.playerModel) G.playerModel.visible = false;
    }

    const isSuicide = !killerId || (G && killerId === G.localPlayerId) || cause === 'lava' || cause === 'void';

    if (isSuicide) {
      const offset = new THREE.Vector3(0, 2, 4).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      this.deathCamPos.copy(this.position).add(offset);
      this.deathCamTarget.copy(this.position);
    } else {
      if (!shotOrigin && killerId && G && G.remotePlayers && G.remotePlayers[killerId]) {
        const kp = G.remotePlayers[killerId];
        if (kp && kp.pos) {
          shotOrigin = new THREE.Vector3(kp.pos[0], kp.pos[1] + 1.5, kp.pos[2]);
        }
      }

      if (shotOrigin) {
        const eyeH = (CFG.H - (CFG.H - CFG.CROUCH_H) * this.crouchT) - 0.12;
        const eyePos = new THREE.Vector3(this.position.x, this.position.y + eyeH, this.position.z);
        const toShot = new THREE.Vector3().subVectors(shotOrigin, eyePos);
        const shotDist = toShot.length();
        const shotDir = shotDist > 0.01 ? toShot.clone().normalize() : new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));

        const pullDist = 2.0;
        const backDir = shotDir.clone().negate();
        const rayHit = G && G.raycast ? G.raycast(eyePos, backDir, pullDist + 0.3) : null;
        const actualPull = rayHit ? Math.max(0.1, rayHit.distance - 0.3) : pullDist;

        this.deathCamPos.copy(eyePos).addScaledVector(backDir, actualPull);
        this.deathCamPos.y += Math.min(0.35, actualPull * 0.25);
        this.deathCamTarget.copy(shotOrigin);
      } else {
        const offset = new THREE.Vector3(0, 2, 4).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
        this.deathCamPos.copy(this.position).add(offset);
        this.deathCamTarget.copy(this.position);
      }
    }

    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('PLAYER_DIED', {
        position: this.position.clone(),
        killerId,
        cause
      });
    }
  }

  /**
   * Execute physical movement step for the frame.
   * @param {number} dt
   * @param {Record<string, boolean>} activeKeys
   * @param {Object} context
   */
  stepPhysics(dt, activeKeys, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    const isDead = G ? G.isDead : this.isDead;
    this.isDead = isDead;
    if (isDead || (G && (G.isSpectator || !G.started))) return;

    const k = isDead ? {} : (activeKeys || (G ? G.keys : {}));
    const world = this.engine ? this.engine.worldManager : null;
    const portals = this.engine ? this.engine.portalManager : null;
    const physics = G?.physics || this.engine?.physics;

    if (!physics) return;

    const obbs = G?.obbs || world?.obbs || [];
    const portalList = G?.portals || portals?.portals || [];
    const grabCubes = G?.grabCubes || [];
    const grabbedCube = G?.grabbedCube || null;
    const remotePlayers = G?.remotePlayers || {};

    const tpState = {
      nowT: G?.nowT ?? 0,
      tpGracePortal: this.tpGracePortal,
      tpGraceT: this.tpGraceT,
      R_AB: G?.R_AB || portals?.R_AB,
      R_BA: G?.R_BA || portals?.R_BA
    };

    const _tpFlash = G?.dom ? G.dom('tpflash') : (typeof document !== 'undefined' ? document.getElementById('tpflash') : null);

    const events = {
      onJump: () => {
        if (typeof AudioSys.jump === 'function') {
          AudioSys.jump();
        } else {
          AudioSys.tone(340, 520, 0.06, 'triangle', 0.04);
        }
        if (this.engine?.eventBus) {
          this.engine.eventBus.emit('PLAYER_JUMPED');
          this.engine.eventBus.emit('SOUND_JUMP');
        }
      },
      onLand: (spd) => {
        const vol = Math.min(1.0, spd / 18);
        if (typeof AudioSys.land === 'function') {
          AudioSys.land(spd);
        } else {
          AudioSys.tone(90, 45, 0.12, 'sine', vol);
        }
        if (G) G.landingThump = vol;
        if (this.engine?.eventBus) {
          this.engine.eventBus.emit('PLAYER_LANDED', { speed: spd });
          this.engine.eventBus.emit('SOUND_LAND', { volume: vol });
        }
      },
      onJumppad: () => {
        if (typeof AudioSys.jumppad === 'function') {
          AudioSys.jumppad();
        } else {
          AudioSys.tone(200, 600, 0.4, 'sine', 0.15);
        }
        if (this.engine?.eventBus) {
          this.engine.eventBus.emit('SOUND_JUMPPAD');
        }
      },
      onTeleport: () => {
        if (_tpFlash) {
          _tpFlash.classList.remove('fadeflash');
          void _tpFlash.offsetWidth;
          _tpFlash.classList.add('fadeflash');
        }
        const net = G?.Network || this.engine?.network;
        if (net && net.send) {
          net.send({
            type: 'teleport',
            viewOffset: this.viewOffset ? [
              this.viewOffset.x,
              this.viewOffset.y,
              this.viewOffset.z,
              this.viewOffset.w
            ] : null
          });
        }
        if (this.engine?.eventBus) {
          this.engine.eventBus.emit('PLAYER_TELEPORTED', { viewOffset: this.viewOffset });
        }
      }
    };

    const plState = G?.pl || {
      pos: this.position,
      vel: this.velocity,
      yaw: this.yaw,
      pitch: this.pitch,
      viewOffset: this.viewOffset,
      grounded: this.grounded,
      groundNormal: this.groundNormal,
      groundT: this.groundT,
      jumpBuf: this.jumpBuf,
      cp: this.cp,
      maxSpeed: this.maxSpeed,
      crouchT: this.crouchT
    };

    physics.physStep(
      plState,
      k,
      G?.autohop ?? this.autohop,
      dt,
      obbs,
      portalList,
      grabCubes,
      grabbedCube,
      tpState,
      events,
      remotePlayers
    );

    this.tpGracePortal = tpState.tpGracePortal;
    this.tpGraceT = tpState.tpGraceT;
    this.viewOffset = plState.viewOffset;
    this.grounded = plState.grounded;
    if (plState.groundNormal) this.groundNormal.copy(plState.groundNormal);
    if (plState.groundT !== undefined) this.groundT = plState.groundT;
    if (plState.jumpBuf !== undefined) this.jumpBuf = plState.jumpBuf;
    if (plState.cp) this.cp.copy(plState.cp);
    this.maxSpeed = plState.maxSpeed;
    this.crouchT = plState.crouchT;
    this.yaw = plState.yaw;
    this.pitch = plState.pitch;
    this.position.copy(plState.pos);
    this.velocity.copy(plState.vel);

    // Void and lava death checks
    if (this.position.y < -40.5) {
      this.die(null, false, 'void', null, G);
    } else {
      const lavaPools = G?.lavaPools || world?.lavaPools || [];
      for (const L of lavaPools) {
        const dx = this.position.x - L.x, dz = this.position.z - L.z;
        if (dx * dx + dz * dz < L.r * L.r && this.position.y < L.y + 0.6) {
          this.die(null, false, 'lava', null, G);
          break;
        }
      }
    }
  }

  /**
   * Instantiate and configure the local player 3D mesh and clipping plane.
   * @param {Object} [context=null]
   */
  initModel(context = null) {
    const G = context || this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (!G) return;
    const { TH, V3, scene } = G;

    const playerClipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);
    const playerModel = G.createPlayerModel(0x4a86e8, 1, playerClipPlane);
    scene.add(playerModel);

    if (typeof window !== 'undefined') {
      window.playerClipPlane = playerClipPlane;
    }

    this.playerModel = playerModel;
    this.playerClipPlane = playerClipPlane;
    G.playerModel = playerModel;
    G.playerClipPlane = playerClipPlane;
  }

  /**
   * Update local camera transform, view bobbing, player model alignment, clipping plane, and interaction raycast.
   * @param {number} dt
   * @param {number} now
   * @param {Object} [context=null]
   */
  updateLocalView(dt, now, context = null) {
    const G = context || this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (!G || !G.started || G.isSpectator) return;

    const { TH, camera } = G;
    const sp = Math.hypot(this.velocity.x, this.velocity.z);

    if (this.isDead || G.isDead) {
      camera.position.lerp(this.deathCamPos, Math.min(1, dt * 5));
      const m = new TH.Matrix4().lookAt(camera.position, this.deathCamTarget, new TH.Vector3(0, 1, 0));
      camera.quaternion.slerp(new TH.Quaternion().setFromRotationMatrix(m), Math.min(1, dt * 5));
    } else {
      camera.position.copy(this.position);
      camera.position.y += (CFG.H - (CFG.H - CFG.CROUCH_H) * this.crouchT) - 0.12;
      let bob = 0;
      if (this.grounded && sp > 1) {
        bob = Math.sin(now * 0.012 * Math.min(2, sp / 7)) * 0.03 * Math.min(1, sp / CFG.GMAX);
      }
      if (G.landingThump !== undefined) {
        G.landingThump = Math.max(0, G.landingThump - dt * 4);
        camera.position.y += bob - G.landingThump * 0.18;
      } else {
        camera.position.y += bob;
      }
      camera.rotation.order = 'YXZ';
      camera.quaternion.setFromEuler(new TH.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    }

    if (this.playerModel) {
      this.playerModel.position.copy(this.position);
      this.playerModel.rotation.set(0, this.yaw, 0, 'YXZ');
      const cBody = this.playerModel.children.find(c => c.name === 'bodyMesh');
      if (cBody) {
        cBody.scale.y = 1 - this.crouchT * 0.4;
        cBody.position.y = -this.crouchT * 0.25;
      }
      if (this.playerModel.userData?.headGroup) {
        this.playerModel.userData.headGroup.rotation.x = this.pitch;
        this.playerModel.userData.headGroup.position.y = (CFG.H - (CFG.H - CFG.CROUCH_H) * this.crouchT) - 0.12;
      }
      if (this.playerModel.userData?.mirrorGun) {
        this.playerModel.userData.mirrorGun.visible = (G.activeWeapon === 1);
        this.playerModel.userData.mirrorRocketGun.visible = (G.activeWeapon === 2);
        if (this.playerModel.userData.mirrorInstagibGun) {
          this.playerModel.userData.mirrorInstagibGun.visible = (G.activeWeapon === 3);
        }
      }
    }

    if (this.playerClipPlane && G.portals) {
      let closestPortal = -1, minDist = 3.5;
      for (let i = 0; i < 4; i++) {
        if (!G.portals[i] || !G.portals[i].placed) continue;
        const d = this.position.distanceTo(G.portals[i].c);
        if (d < minDist) {
          minDist = d;
          closestPortal = i;
        }
      }
      if (closestPortal !== -1) {
        const P = G.portals[closestPortal];
        this.playerClipPlane.normal.copy(P.n);
        this.playerClipPlane.constant = -P.n.dot(P.c);
      } else {
        this.playerClipPlane.normal.set(0, 1, 0);
        this.playerClipPlane.constant = 1e6;
      }
    }

    if (this.viewOffset) {
      const id = new TH.Quaternion();
      this.viewOffset.slerp(id, Math.min(1, dt * 5));
      if (this.viewOffset.angleTo(id) < 0.001) this.viewOffset = null;
      else camera.quaternion.multiply(this.viewOffset);
    }

    const zoomHeld = !(this.isDead || G.isDead) && (G.keys?.['KeyZ'] || G.keys?.['ShiftLeft'] || (G.isZooming && (G.activeWeapon === 2 || G.activeWeapon === 3)));
    if (zoomHeld) {
      G.zoomAmt = Math.min(1.0, (G.zoomAmt || 0) + dt / 0.1);
    } else {
      G.zoomAmt = Math.max(0.0, (G.zoomAmt || 0) - dt / 0.1);
    }
    const baseFov = G.baseFov || 115;
    const spFov = Math.min(baseFov + 16, baseFov + Math.max(0, (sp - CFG.GMAX) * 0.5));
    const zoomedFov = baseFov * 0.4;
    const wantFov = spFov * (1 - G.zoomAmt) + zoomedFov * G.zoomAmt;
    if (Math.abs(camera.fov - wantFov) > 0.05) {
      camera.fov = wantFov;
      camera.updateProjectionMatrix();
    }

    let canGrab = false;
    if (!G.grabbedCube && G.grabCubes) {
      camera.updateMatrixWorld(true);
      const pos = camera.getWorldPosition(new TH.Vector3());
      const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
      for (const cb of G.grabCubes) {
        const v = cb.pos.clone().sub(pos);
        const dist = v.length();
        if (dist < 7.0 && v.normalize().dot(dir) > 0.9) {
          canGrab = true;
          break;
        }
      }
    }
    const ch = G.dom ? G.dom('crosshair') : (typeof document !== 'undefined' ? document.getElementById('crosshair') : null);
    if (ch) {
      if (canGrab) ch.classList.add('grab');
      else ch.classList.remove('grab');
    }
  }

  get eyeHeight() {
    return (CFG.H - (CFG.H - CFG.CROUCH_H) * this.crouchT) - 0.12;
  }
}
