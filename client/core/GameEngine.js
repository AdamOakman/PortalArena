import * as THREE from 'three';
import { EventBus } from './EventBus.js';
import { EntityManager } from '../entities/EntityManager.js';
import { PlayerController } from '../entities/PlayerController.js';
import { WeaponManager } from '../weapons/WeaponManager.js';
import { MatchStateMachine } from '../state/MatchStateMachine.js';
import { WorldManager } from '../world/WorldManager.js';
import { PortalManager } from '../portals/PortalManager.js';
import { InputManager } from '../input/InputManager.js';
import { NetworkManager } from '../network/NetworkManager.js';
import { RenderManager } from '../rendering/RenderManager.js';
import { HUDController } from '../ui/HUDController.js';
import { AudioController, AudioSys } from '../audio/AudioController.js';
import { PortalGun } from '../weapons/PortalGun.js';
import { RocketLauncher } from '../weapons/RocketLauncher.js';
import { InstagibRifle } from '../weapons/InstagibRifle.js';
import { CFG, PORT } from '../../shared/constants.js';

const _flatVx = new THREE.Vector3();
const _flatVy = new THREE.Vector3();
const _flatVz = new THREE.Vector3();
const _flatAxes = [
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3(),
  new THREE.Vector3()
];
const _flatQAlign = new THREE.Quaternion();
const _flatTargetQ = new THREE.Quaternion();
const _flatUp = new THREE.Vector3(0, 1, 0);

function alignCubeToFlatSurface(currentQuat, normal = _flatUp, blendFactor = 1.0) {
  _flatVx.set(1, 0, 0).applyQuaternion(currentQuat);
  _flatVy.set(0, 1, 0).applyQuaternion(currentQuat);
  _flatVz.set(0, 0, 1).applyQuaternion(currentQuat);

  _flatAxes[0].copy(_flatVx);
  _flatAxes[1].copy(_flatVx).negate();
  _flatAxes[2].copy(_flatVy);
  _flatAxes[3].copy(_flatVy).negate();
  _flatAxes[4].copy(_flatVz);
  _flatAxes[5].copy(_flatVz).negate();

  let bestAxis = _flatAxes[0];
  let bestDot = -Infinity;
  for (let i = 0; i < 6; i++) {
    const d = _flatAxes[i].dot(normal);
    if (d > bestDot) {
      bestDot = d;
      bestAxis = _flatAxes[i];
    }
  }

  _flatQAlign.setFromUnitVectors(bestAxis, normal);
  _flatTargetQ.copy(_flatQAlign).multiply(currentQuat);
  currentQuat.slerp(_flatTargetQ, blendFactor);
}

/**
 * GameEngine — Central OOP Composition Root, loop coordinator, and lifecycle manager.
 */
export class GameEngine {
  constructor(canvas, context = null) {
    this.canvas = canvas;
    this.context = context;
    if (context) {
      context.engine = this;
    }
    this.eventBus = new EventBus();
    this.renderManager = context?.renderManager || new RenderManager(canvas);
    this.audioController = context?.audioController || new AudioController(this);
    this.hudController = context?.hudController || new HUDController(this);

    this.entityManager = new EntityManager(this);
    if (context) {
      context.entityManager = this.entityManager;
    }
    this.player = context?.playerController || new PlayerController(this);
    this.entityManager.spawn(this.player);
    if (context?.remotePlayers) {
      for (const pid in context.remotePlayers) {
        this.entityManager.spawn(context.remotePlayers[pid]);
      }
    }

    this.worldManager = context?.worldManager || new WorldManager(this);
    this.portalManager = context?.portalManager || new PortalManager(this);
    this.inputManager = context?.inputManager || new InputManager(this, canvas, context);
    this.network = context?.network || context?.Network || new NetworkManager(this);
    this.weaponManager = context?.weaponManager || new WeaponManager(this.eventBus, this);
    if (this.weaponManager) {
      if (!this.weaponManager.engine) this.weaponManager.engine = this;
      if (!this.weaponManager.eventBus) this.weaponManager.eventBus = this.eventBus;
    }
    this.matchState = new MatchStateMachine(this);

    // Register weapon strategies into slots
    this.weaponManager.register(1, new PortalGun(this));
    this.weaponManager.register(2, new RocketLauncher(this));
    this.weaponManager.register(3, new InstagibRifle(this));

    this.isRunning = false;
    this.lastFrameTime = performance.now();
    this.rafId = null;

    // Performance & FPS tracking
    this.fpsFrames = 0;
    this.lastFpsUpdate = performance.now();
    this.fpsValEl = null;

    this.SPEC_RADIUS = 0.35;

    this._setupWindowListeners();
  }

  _setupWindowListeners() {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    window.addEventListener('resize', () => {
      const G = this.context;
      if (!G || !G.renderer || !G.camera) return;
      G.renderer.setSize(window.innerWidth, window.innerHeight);
      G.camera.aspect = window.innerWidth / window.innerHeight;
      G.camera.updateProjectionMatrix();
      if (G.makeRTs) G.makeRTs();
    });

    document.addEventListener('visibilitychange', () => {
      const G = this.context;
      if (document.hidden && G && G.rockets) {
        for (let i = G.rockets.length - 1; i >= 0; i--) {
          if (!G.rockets[i].isLocal) {
            G.scene.remove(G.rockets[i].mesh);
            G.rockets[i].mesh.traverse(o => {
              if (o.material) o.material.dispose();
              if (o.geometry) o.geometry.dispose();
            });
            G.rockets.splice(i, 1);
          }
        }
      }
    });
  }

  /**
   * Start the main engine loop and load the initial map.
   */
  start() {
    this.isRunning = true;
    this.lastFrameTime = performance.now();
    const G = this.context;
    if (G && G.loadMap) {
      G.loadMap(String(Math.floor(Math.random() * 1e9)));
    }
    this.rafId = requestAnimationFrame(this.tick);
  }

  /**
   * Stop the main engine loop.
   */
  stop() {
    this.isRunning = false;
    if (this.rafId && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Main per-frame animation tick.
   * @param {number} [now=performance.now()]
   */
  tick = (now = performance.now()) => {
    if (!this.isRunning) return;

    this.rafId = requestAnimationFrame(this.tick);
    const elapsed = (now - this.lastFrameTime) / 1000;
    const dt = Math.min(0.05, elapsed);
    this.lastFrameTime = now;

    this.update(dt, now, elapsed);
    this.render(now);
  };

  /**
   * Update engine state, physics, audio, spectator, and entities.
   * @param {number} dt
   * @param {number} now
   * @param {number} elapsed
   */
  update(dt, now, elapsed = dt) {
    const G = this.context;
    this.eventBus.emit('ENGINE_TICK', { dt });

    if (this.matchState) this.matchState.update(dt);
    if (this.weaponManager) this.weaponManager.update(dt);

    if (!G) {
      if (this.inputManager && this.player) {
        this.player.stepPhysics(dt, this.inputManager.keys, this.context);
      }
      this.entityManager.update(dt, 0, null);
      return;
    }

    // FPS counter
    this.fpsFrames++;
    if (now - this.lastFpsUpdate >= 250) {
      if (!this.fpsValEl && typeof document !== 'undefined') {
        this.fpsValEl = document.getElementById('fpsval');
      }
      if (this.fpsValEl) {
        this.fpsValEl.textContent = Math.round((this.fpsFrames * 1000) / (now - this.lastFpsUpdate));
      }
      this.fpsFrames = 0;
      this.lastFpsUpdate = now;
    }

    // Lag spike rocket cleanup
    if (elapsed > 0.25 && G.rockets) {
      for (let i = G.rockets.length - 1; i >= 0; i--) {
        if (!G.rockets[i].isLocal) {
          G.scene.remove(G.rockets[i].mesh);
          G.rockets[i].mesh.traverse(o => {
            if (o.material) o.material.dispose();
            if (o.geometry) o.geometry.dispose();
          });
          G.rockets.splice(i, 1);
        }
      }
    }

    // Audio listener orientation
    if (G.isSpectator) {
      AudioSys.listenerPos = G.camera.position;
      AudioSys.listenerYaw = (G.spectatorMode === 'follow' && G.spectateTargetPid && G.remotePlayers?.[G.spectateTargetPid])
        ? G.remotePlayers[G.spectateTargetPid].yaw
        : G.specYaw;
    } else if (G.pl) {
      AudioSys.listenerPos = G.pl.pos;
      AudioSys.listenerYaw = G.pl.yaw;
    }
    G.nowT += dt;

    // Ping sync
    if (G.started && G.isConnected && G.localPlayerId != null && G.nowT >= G.nextPingT) {
      if (G.Network?.send) {
        G.Network.send({ type: 'ping', t: performance.now(), ping: G.lastPingMs });
      }
      G.nextPingT = G.nowT + 5;
    }

    // Movement & camera updates
    const isVictoryOrbit = G.won || (G.menuController && G.menuController.isVictoryOpen());
    if (!G.started || isVictoryOrbit) {
      const t = now * 0.00012;
      G.camera.position.set(Math.cos(t) * 20, 17, Math.sin(t) * 20);
      G.camera.lookAt(0, 2.5, 0);
      if (G.gun) G.gun.visible = false;
      if (G.rocketGun) G.rocketGun.visible = false;
      if (G.instagibGun) G.instagibGun.visible = false;
      if (G.playerModel) G.playerModel.visible = false;
      if (G.playerCloneModel) G.playerCloneModel.visible = false;
      if (G.remotePlayers) {
        for (const pid in G.remotePlayers) {
          const rp = G.remotePlayers[pid];
          if (rp?.mesh) rp.mesh.visible = false;
          if (rp?.cloneMesh) rp.cloneMesh.visible = false;
        }
      }
    } else if (G.isSpectator) {
      this._updateSpectator(dt);
      if (G.playerModel) G.playerModel.visible = false;
      if (G.playerCloneModel) G.playerCloneModel.visible = false;
      this.entityManager.updateRemotePlayers(dt, G.nowT, G);
    } else if (!G.won) {
      let activeKeys = G.pointerLocked ? G.keys : { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false, KeyC: false, ControlLeft: false };
      if (G.countdownActive || (G.match && G.match.phase === 'countdown')) {
        activeKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false, KeyC: false, ControlLeft: false };
        if (G.pl) G.pl.vel.set(0, 0, 0);
      }
      const isCrouching = activeKeys.KeyC || activeKeys.ControlLeft;
      if (G.pl) {
        G.pl.crouchT = Math.max(0, Math.min(1, G.pl.crouchT + (isCrouching ? dt * 10 : -dt * 10)));
      }

      if (G.localPlayerId != null && G.Network?.send && G.pl) {
        G.Network.send({
          type: 'input',
          dt,
          keys: {
            KeyW: activeKeys.KeyW,
            KeyA: activeKeys.KeyA,
            KeyS: activeKeys.KeyS,
            KeyD: activeKeys.KeyD,
            Space: activeKeys.Space,
            ShiftLeft: activeKeys.ShiftLeft
          },
          yaw: G.pl.yaw,
          pitch: G.pl.pitch,
          autohop: G.autohop,
          crouch: isCrouching,
          crouchT: G.pl.crouchT,
          jumpBuf: G.pl.jumpBuf,
          pos: G.pl.pos.toArray(),
          vel: G.pl.vel.toArray(),
          activeWeapon: G.activeWeapon,
          isDead: G.isDead,
          grabbedCubeIdx: G.grabbedCube ? G.grabCubes.indexOf(G.grabbedCube) : undefined,
          grabbedCubePos: G.grabbedCube ? G.grabbedCube.pos.toArray() : undefined,
          grabbedCubeVel: G.grabbedCube ? G.grabbedCube.vel.toArray() : undefined
        });
      }

      let rem = G.isConnected ? dt : 0;
      while (rem > 1e-4) {
        const s = Math.min(rem, 1 / 120);
        if (G.physStep) G.physStep(s, activeKeys);
        rem -= s;
      }

      this.entityManager.updateRemotePlayers(dt, G.nowT, G);
    }

    // Portal shader uniforms
    if (G.quadMats) {
      for (let i = 0; i < 4; i++) {
        if (G.quadMats[i]?.uniforms?.uTime) {
          G.quadMats[i].uniforms.uTime.value = now * 0.001;
        }
      }
    }

    // Viewmodels recoil & animation
    this._updateViewmodelAnimation(dt);

    // Beams & projectiles
    this._updateProjectilesAndBeams(dt);

    // Local player view & camera
    if (!isVictoryOrbit) {
      if (G.updateLocalView) {
        G.updateLocalView(dt, now);
      } else if (this.player) {
        this.player.updateLocalView(dt, now, G);
      }
    }

    // Grab cubes
    this._updateGrabCubes(dt);

    // Portal sparkle & lighting
    this._updatePortalVisuals(dt);

    // Dynamic scene animation objects
    this._updateAnimObjects(dt, now);

    // HUD & crosshair raycasting
    this._updateHUDState();
  }

  _updateSpectator(dt) {
    const G = this.context;
    const { TH, V3 } = G;
    const activeKeys = G.pointerLocked ? G.keys : { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false, KeyC: false, ControlLeft: false };

    if (G.spectatorMode === 'freefly') {
      const fwd = new V3(0, 0, -1).applyEuler(new TH.Euler(G.specPitch, G.specYaw, 0, 'YXZ')).normalize();
      const right = new V3(Math.cos(G.specYaw), 0, -Math.sin(G.specYaw)).normalize();
      const move = new V3();
      if (activeKeys.KeyW) move.add(fwd);
      if (activeKeys.KeyS) move.sub(fwd);
      if (activeKeys.KeyD) move.add(right);
      if (activeKeys.KeyA) move.sub(right);
      if (activeKeys.Space) move.y += 1;
      if (activeKeys.KeyC || activeKeys.ControlLeft) move.y -= 1;
      if (move.lengthSq() > 0) move.normalize();
      const speed = (activeKeys.ShiftLeft ? 32 : 16);

      const moveDist = move.length() * speed * dt;
      if (moveDist > 0) {
        const numSteps = Math.min(6, Math.max(1, Math.ceil(moveDist / 0.15)));
        const stepVec = move.clone().multiplyScalar((speed * dt) / numSteps);
        for (let s = 0; s < numSteps; s++) {
          const prevPos = G.specPos.clone();
          G.specPos.add(stepVec);
          const teleported = this._teleportSpectator(prevPos, G.specPos);
          if (teleported) break;
          this._collideSpectator(G.specPos);
        }
      } else {
        this._collideSpectator(G.specPos);
      }

      G.camera.position.copy(G.specPos);
      G.camera.rotation.order = 'YXZ';
      G.camera.quaternion.setFromEuler(new TH.Euler(G.specPitch, G.specYaw, 0, 'YXZ'));
    } else if (G.spectatorMode === 'follow') {
      const pids = Object.keys(G.remotePlayers || {});
      if (pids.length === 0) {
        G.spectatorMode = 'freefly';
        G.spectateTargetPid = null;
      } else {
        if (!G.spectateTargetPid || !G.remotePlayers[G.spectateTargetPid]) {
          G.spectateTargetPid = pids[0];
        }
        const rp = G.remotePlayers[G.spectateTargetPid];
        if (rp) {
          if (rp.isDead) {
            if (!rp.deathCamPos) {
              const deadPos = new V3(rp.pos[0], rp.pos[1], rp.pos[2]);
              let shotOrigin = rp.lastShotOrigin || null;
              const killerId = rp.lastKillerId;
              if (!shotOrigin && killerId) {
                if (killerId === G.localPlayerId) {
                  shotOrigin = new V3(G.pl.pos.x, G.pl.pos.y + 1.5, G.pl.pos.z);
                } else if (G.remotePlayers[killerId] && G.remotePlayers[killerId].pos) {
                  const kp = G.remotePlayers[killerId];
                  shotOrigin = new V3(kp.pos[0], kp.pos[1] + 1.5, kp.pos[2]);
                }
              }
              if (shotOrigin) {
                const eyePos = new V3(deadPos.x, deadPos.y + 1.5, deadPos.z);
                const toShot = new V3().subVectors(shotOrigin, eyePos);
                const shotDist = toShot.length();
                const shotDir = shotDist > 0.01 ? toShot.clone().normalize() : new V3(-Math.sin(rp.yaw || 0), 0, -Math.cos(rp.yaw || 0));
                const pullDist = 4.2;
                const backDir = shotDir.clone().negate();
                const rayHit = G.raycast ? G.raycast(eyePos, backDir, pullDist + 0.3) : null;
                const actualPull = rayHit ? Math.max(0.4, rayHit.distance - 0.3) : pullDist;
                rp.deathCamPos = eyePos.clone().addScaledVector(backDir, actualPull);
                rp.deathCamPos.y += Math.min(2.0, 1.0 + actualPull * 0.35);

                const shotHorizDist = Math.hypot(shotDir.x, shotDir.z);
                if (shotHorizDist > 0.01) {
                  const horizX = shotDir.x / shotHorizDist;
                  const horizZ = shotDir.z / shotHorizDist;
                  const currentPitch = Math.atan2(shotDir.y, shotHorizDist);
                  const targetPitch = Math.max(-0.85, Math.min(-0.25, currentPitch - 0.65));
                  const lookDir = new V3(
                    horizX * Math.cos(targetPitch),
                    Math.sin(targetPitch),
                    horizZ * Math.cos(targetPitch)
                  ).normalize();
                  rp.deathCamTarget = rp.deathCamPos.clone().addScaledVector(lookDir, Math.max(10, shotDist));
                } else {
                  rp.deathCamTarget = deadPos.clone().add(new V3(0, 0.3, 0));
                }
              } else {
                const offset = new V3(0, 2.8, 4.8).applyAxisAngle(new V3(0, 1, 0), rp.yaw || 0);
                const backDir = offset.clone().normalize();
                const rayHit = G.raycast ? G.raycast(deadPos, backDir, offset.length() + 0.3) : null;
                const camDist = rayHit ? Math.max(0.6, rayHit.distance - 0.3) : offset.length();
                rp.deathCamPos = deadPos.clone().addScaledVector(backDir, camDist);
                rp.deathCamTarget = deadPos.clone().add(new V3(0, 0.2, 0));
              }
            }
            G.camera.position.lerp(rp.deathCamPos, Math.min(1, dt * 5));
            const lookMat = new TH.Matrix4().lookAt(G.camera.position, rp.deathCamTarget, new THREE.Vector3(0, 1, 0));
            G.camera.quaternion.slerp(new TH.Quaternion().setFromRotationMatrix(lookMat), Math.min(1, dt * 5));
            G.specPos.copy(G.camera.position);
            const euler = new TH.Euler().setFromQuaternion(G.camera.quaternion, 'YXZ');
            G.specYaw = euler.y;
            G.specPitch = euler.x;
          } else {
            rp.deathCamPos = null;
            rp.deathCamTarget = null;
            if (G.followPerspective === 'pov') {
              const crouchOffset = (CFG.H - (CFG.H - CFG.CROUCH_H) * (rp.crouchT || 0)) - 0.12;
              G.camera.position.set(rp.pos[0], rp.pos[1] + crouchOffset, rp.pos[2]);
              G.camera.rotation.order = 'YXZ';
              G.camera.quaternion.setFromEuler(new TH.Euler(rp.pitch, rp.yaw, 0, 'YXZ'));
              if (rp.viewOffset) {
                const id = new TH.Quaternion();
                rp.viewOffset.slerp(id, Math.min(1, dt * 5));
                if (rp.viewOffset.angleTo(id) < 0.001) {
                  rp.viewOffset = null;
                } else {
                  G.camera.quaternion.multiply(rp.viewOffset);
                }
              }
              G.specPos.copy(G.camera.position);
              G.specYaw = rp.yaw;
              G.specPitch = rp.pitch;
            } else {
              const targetPos = new V3(rp.pos[0], rp.pos[1] + 1.5, rp.pos[2]);
              const backDir = new V3(Math.sin(rp.yaw), 0.35, Math.cos(rp.yaw)).normalize();
              const camPos = targetPos.clone().addScaledVector(backDir, 3.8);
              const rayHit = G.raycast ? G.raycast(targetPos, backDir, 3.8) : null;
              if (rayHit) {
                camPos.copy(targetPos).addScaledVector(backDir, Math.max(0.5, rayHit.distance - 0.3));
              }
              G.camera.position.copy(camPos);
              G.camera.lookAt(targetPos);
              G.specPos.copy(G.camera.position);
            }
          }
        }
      }
    }
  }

  _collideSpectator(pos) {
    const G = this.context;
    if (!G?.obbs) return;
    const { V3 } = G;
    const r = this.SPEC_RADIUS;
    for (let iter = 0; iter < 3; iter++) {
      let collided = false;
      for (const obb of G.obbs) {
        if (!obb || obb.destroyed) continue;
        const dx0 = pos.x - obb.c.x, dy0 = pos.y - obb.c.y, dz0 = pos.z - obb.c.z;
        if (dx0 * dx0 + dy0 * dy0 + dz0 * dz0 > (obb.rad + r) * (obb.rad + r)) continue;

        const lc = [
          dx0 * obb.ax[0].x + dy0 * obb.ax[0].y + dz0 * obb.ax[0].z,
          dx0 * obb.ax[1].x + dy0 * obb.ax[1].y + dz0 * obb.ax[1].z,
          dx0 * obb.ax[2].x + dy0 * obb.ax[2].y + dz0 * obb.ax[2].z
        ];

        const inside = Math.abs(lc[0]) < obb.he[0] && Math.abs(lc[1]) < obb.he[1] && Math.abs(lc[2]) < obb.he[2];
        let n, depth;
        if (inside) {
          let kBest = 0, best = -Infinity;
          for (let k = 0; k < 3; k++) {
            const over = Math.abs(lc[k]) - obb.he[k];
            if (over > best) {
              best = over;
              kBest = k;
            }
          }
          const lcVal = kBest === 0 ? lc[0] : (kBest === 1 ? lc[1] : lc[2]);
          n = obb.ax[kBest].clone().multiplyScalar(Math.sign(lcVal) || 1);
          depth = obb.he[kBest] - Math.abs(lcVal) + r;
        } else {
          const q = new V3();
          for (let k = 0; k < 3; k++) {
            q.addScaledVector(obb.ax[k], Math.max(-obb.he[k], Math.min(obb.he[k], lc[k])));
          }
          const cp = obb.c.clone().add(q);
          const dvec = new V3(pos.x - cp.x, pos.y - cp.y, pos.z - cp.z);
          const dist = dvec.length();
          if (dist >= r || dist < 1e-7) continue;
          n = dvec.divideScalar(dist);
          depth = r - dist;
        }

        let hole = false;
        if (G.portals) {
          for (let i = 0; i < G.portals.length; i += 2) {
            if (!G.portals[i].placed || !G.portals[i + 1].placed) continue;
            for (const P of [G.portals[i], G.portals[i + 1]]) {
              if (Math.abs(n.dot(P.n)) < 0.8) continue;
              const du = Math.abs((pos.x - P.c.x) * P.r.x + (pos.y - P.c.y) * P.r.y + (pos.z - P.c.z) * P.r.z);
              const dv = Math.abs((pos.x - P.c.x) * P.u.x + (pos.y - P.c.y) * P.u.y + (pos.z - P.c.z) * P.u.z);
              const dn = Math.abs((pos.x - P.c.x) * P.n.x + (pos.y - P.c.y) * P.n.y + (pos.z - P.c.z) * P.n.z);
              if (du < PORT.hw && dv < PORT.hh && dn < 2.0) {
                hole = true;
                break;
              }
            }
            if (hole) break;
          }
        }
        if (hole) continue;

        pos.addScaledVector(n, depth + 0.001);
        collided = true;
      }

      if (G.grabCubes) {
        const ch = 0.75;
        for (const c of G.grabCubes) {
          const dx = pos.x - c.pos.x, dy = pos.y - c.pos.y, dz = pos.z - c.pos.z;
          if (Math.abs(dx) > ch + r || Math.abs(dy) > ch + r || Math.abs(dz) > ch + r) continue;
          const insideC = Math.abs(dx) < ch && Math.abs(dy) < ch && Math.abs(dz) < ch;
          let cn, cdepth;
          if (insideC) {
            const ox = ch - Math.abs(dx) + r;
            const oy = ch - Math.abs(dy) + r;
            const oz = ch - Math.abs(dz) + r;
            if (ox < oy && ox < oz) {
              cn = new V3(Math.sign(dx) || 1, 0, 0);
              cdepth = ox;
            } else if (oz < oy) {
              cn = new V3(0, 0, Math.sign(dz) || 1);
              cdepth = oz;
            } else {
              cn = new V3(0, Math.sign(dy) || 1, 0);
              cdepth = oy;
            }
          } else {
            const qx = Math.max(-ch, Math.min(ch, dx));
            const qy = Math.max(-ch, Math.min(ch, dy));
            const qz = Math.max(-ch, Math.min(ch, dz));
            const dvec = new V3(dx - qx, dy - qy, dz - qz);
            const dist = dvec.length();
            if (dist >= r || dist < 1e-7) continue;
            cn = dvec.divideScalar(dist);
            cdepth = r - dist;
          }
          pos.addScaledVector(cn, cdepth + 0.001);
          collided = true;
        }
      }

      if (!collided) break;
    }
  }

  _teleportSpectator(prevPos, nextPos) {
    const G = this.context;
    if (!G?.portals || !G.R_AB || !G.R_BA) return false;
    const { TH, V3 } = G;

    for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
      const offset = pairIdx * 2;
      const p0 = G.portals[offset], p1 = G.portals[offset + 1];
      if (p0 && p1 && p0.placed && p1.placed) {
        for (let pi = 0; pi < 2; pi++) {
          const P = pi === 0 ? p0 : p1, Q = pi === 0 ? p1 : p0;
          if (G.specGracePortal === P && G.nowT - (G.specGraceT || 0) < 0.25) continue;

          const a = (prevPos.x - P.c.x) * P.n.x + (prevPos.y - P.c.y) * P.n.y + (prevPos.z - P.c.z) * P.n.z;
          const b = (nextPos.x - P.c.x) * P.n.x + (nextPos.y - P.c.y) * P.n.y + (nextPos.z - P.c.z) * P.n.z;
          if ((a > 0) !== (b > 0)) {
            const t = Math.max(0, Math.min(1, a / (a - b)));
            const cx = prevPos.x + (nextPos.x - prevPos.x) * t;
            const cy = prevPos.y + (nextPos.y - prevPos.y) * t;
            const cz = prevPos.z + (nextPos.z - prevPos.z) * t;
            const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
            const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
            if (du <= PORT.hw && dv <= PORT.hh) {
              const R = pi === 0 ? G.R_AB[pairIdx] : G.R_BA[pairIdx];
              const cross = new V3(cx, cy, cz);
              const rel = cross.clone().sub(P.c).applyMatrix4(R);
              nextPos.copy(Q.c).add(rel).addScaledVector(Q.n, 0.45);

              const curDir = new V3(0, 0, -1).applyEuler(new TH.Euler(G.specPitch, G.specYaw, 0, 'YXZ'));
              const newDir = curDir.clone().applyMatrix4(R).normalize();
              G.specYaw = Math.atan2(-newDir.x, -newDir.z);
              G.specPitch = Math.asin(Math.max(-0.99, Math.min(0.99, newDir.y)));

              G.specGracePortal = Q;
              G.specGraceT = G.nowT;
              return true;
            }
          }
        }
      }
    }
    return false;
  }

  _updateViewmodelAnimation(dt) {
    const G = this.context;
    if (!G) return;

    G.muzzleT = Math.max(0, (G.muzzleT || 0) - dt * 6);
    const mt = G.muzzleT;
    const scale = 1 + mt * 0.12;
    const lZ = -0.5 + mt * 0.2;
    const lRot = mt * 0.4;

    const isFollowPOV = G.isSpectator && G.spectatorMode === 'follow' && G.followPerspective === 'pov' && G.spectateTargetPid && G.remotePlayers?.[G.spectateTargetPid];
    const targetPl = isFollowPOV ? G.remotePlayers[G.spectateTargetPid] : null;

    if (!G.isSpectator) {
      if (G.gun) { G.gun.scale.setScalar(1); G.gun.position.z = -0.5; G.gun.rotation.x = 0; }
      if (G.rocketGun) { G.rocketGun.scale.setScalar(1); G.rocketGun.position.z = -0.5; G.rocketGun.rotation.x = 0; }
      if (G.instagibGun) { G.instagibGun.scale.setScalar(1); G.instagibGun.position.z = -0.5; G.instagibGun.rotation.x = 0; }

      const pM = G.playerModel?.userData;
      if (pM) {
        if (pM.mirrorGun) { pM.mirrorGun.scale.setScalar(1); pM.mirrorGun.position.z = -0.5; pM.mirrorGun.rotation.x = 0; }
        if (pM.mirrorRocketGun) { pM.mirrorRocketGun.scale.setScalar(1); pM.mirrorRocketGun.position.z = -0.5; pM.mirrorRocketGun.rotation.x = 0; }
        if (pM.mirrorInstagibGun) { pM.mirrorInstagibGun.scale.setScalar(1); pM.mirrorInstagibGun.position.z = -0.5; pM.mirrorInstagibGun.rotation.x = 0; }
      }

      const aw = G.activeWeapon || 1;
      const actHUD = aw === 1 ? G.gun : (aw === 2 ? G.rocketGun : G.instagibGun);
      const actMir = pM ? (aw === 1 ? pM.mirrorGun : (aw === 2 ? pM.mirrorRocketGun : pM.mirrorInstagibGun)) : null;

      if (actHUD) {
        actHUD.scale.setScalar(scale);
        actHUD.position.z = lZ;
        actHUD.rotation.x = lRot;
      }
      if (aw === 1 && G.gun?.userData?.core) {
        G.gun.userData.core.material.emissiveIntensity = 2.2 + mt * 6;
      }
      if (actMir) {
        actMir.scale.setScalar(1 + mt * 0.12);
        actMir.position.z = -0.5 + mt * 0.15;
        actMir.rotation.x = mt * 0.3;
      }
    } else if (targetPl && !targetPl.isDead) {
      if (G.gun) { G.gun.scale.setScalar(1); G.gun.position.z = -0.5; G.gun.rotation.x = 0; }
      if (G.rocketGun) { G.rocketGun.scale.setScalar(1); G.rocketGun.position.z = -0.5; G.rocketGun.rotation.x = 0; }
      if (G.instagibGun) { G.instagibGun.scale.setScalar(1); G.instagibGun.position.z = -0.5; G.instagibGun.rotation.x = 0; }

      const aw = targetPl.activeWeapon || 1;
      if (G.gun) G.gun.visible = (aw === 1);
      if (G.rocketGun) G.rocketGun.visible = (aw === 2);
      if (G.instagibGun) G.instagibGun.visible = (aw === 3);
      if (G.playerModel) G.playerModel.visible = false;
      if (G.playerCloneModel) G.playerCloneModel.visible = false;

      if (aw === 1 && G.gun?.userData?.core && G.portals) {
        let tIdx = (targetPl.playerIndex !== undefined) ? targetPl.playerIndex : (G.match && G.match.players[G.spectateTargetPid] ? G.match.players[G.spectateTargetPid].index : 0);
        if (tIdx < 0) tIdx = 0;
        const pCol = G.portals[tIdx * 2] ? G.portals[tIdx * 2].color : 0x0affff;
        G.gun.userData.core.material.emissive.setHex(pCol);
        if (G.gun.userData.ring) G.gun.userData.ring.material.emissive.setHex(pCol);
      }

      const actHUD = aw === 1 ? G.gun : (aw === 2 ? G.rocketGun : G.instagibGun);
      if (actHUD) {
        actHUD.scale.setScalar(scale);
        actHUD.position.z = lZ;
        actHUD.rotation.x = lRot;
      }
      if (aw === 1 && G.gun?.userData?.core) {
        G.gun.userData.core.material.emissiveIntensity = 2.2 + mt * 6;
      }
    } else {
      if (G.gun) G.gun.visible = false;
      if (G.rocketGun) G.rocketGun.visible = false;
      if (G.instagibGun) G.instagibGun.visible = false;
      if (G.playerModel) G.playerModel.visible = false;
      if (G.playerCloneModel) G.playerCloneModel.visible = false;
    }
  }

  _updateProjectilesAndBeams(dt) {
    const G = this.context;
    if (!G) return;
    const { V3 } = G;

    // Railgun / instagib beams
    if (G.activeBeams) {
      for (let i = G.activeBeams.length - 1; i >= 0; i--) {
        const b = G.activeBeams[i];
        b.life -= dt;
        if (b.life <= 0) {
          G.scene.remove(b.coreMesh);
          G.scene.remove(b.hMesh);
          G.scene.remove(b.points);
          b.coreMesh.material.dispose();
          b.hMesh.material.dispose();
          b.points.material.dispose();
          b.points.geometry.dispose();
          G.activeBeams.splice(i, 1);
          continue;
        }
        b.coreMesh.material.opacity = b.life * 0.9;
        b.coreMesh.scale.x = b.life * 0.6;
        b.coreMesh.scale.y = b.life * 0.6;
        b.hMesh.material.opacity = b.life * 0.8;
        b.hMesh.rotateZ(dt * 15);
        b.points.material.opacity = b.life;
        const pos = b.points.geometry.attributes.position.array;
        for (let j = 0; j < b.vel.length; j++) {
          pos[j * 3] += b.vel[j].x * dt;
          pos[j * 3 + 1] += b.vel[j].y * dt;
          pos[j * 3 + 2] += b.vel[j].z * dt;
        }
        b.points.geometry.attributes.position.needsUpdate = true;
      }
    }

    // Rocket projectiles
    if (G.rockets) {
      for (let i = G.rockets.length - 1; i >= 0; i--) {
        const r = G.rockets[i];
        r.life -= dt;
        const step = r.vel.clone().multiplyScalar(dt);

        let teleported = false;
        for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
          if (teleported) break;
          const offset = pairIdx * 2;
          if (G.portals[offset].placed && G.portals[offset + 1].placed) {
            const nextPos = r.pos.clone().add(step);
            for (let idx = 0; idx < 2; idx++) {
              const pi = offset + idx;
              const P = G.portals[pi], Q = G.portals[offset + (1 - idx)];
              const a = (r.pos.x - P.c.x) * P.n.x + (r.pos.y - P.c.y) * P.n.y + (r.pos.z - P.c.z) * P.n.z;
              const b = (nextPos.x - P.c.x) * P.n.x + (nextPos.y - P.c.y) * P.n.y + (nextPos.z - P.c.z) * P.n.z;
              if ((a > 0) !== (b > 0)) {
                const t = Math.max(0, Math.min(1, a / (a - b)));
                const cx = r.pos.x + (nextPos.x - r.pos.x) * t;
                const cy = r.pos.y + (nextPos.y - r.pos.y) * t;
                const cz = r.pos.z + (nextPos.z - r.pos.z) * t;
                const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
                const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
                if (du <= PORT.hw && dv <= PORT.hh) {
                  const R = idx === 0 ? G.R_AB[pairIdx] : G.R_BA[pairIdx];
                  r.vel.applyMatrix4(R);
                  const rel = new V3(cx, cy, cz).sub(P.c).applyMatrix4(R);
                  r.pos.copy(Q.c).add(rel).addScaledVector(r.vel, dt * (1 - t));
                  const newDir = r.vel.clone().normalize();
                  if (newDir.lengthSq() > 0.001) {
                    r.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), newDir);
                  }
                  teleported = true;
                  break;
                }
              }
            }
          }
        }

        if (!teleported) {
          const rDir = r.vel.clone().normalize();
          const stepLen = step.length();
          const wallHit = G.raycast ? G.raycast(r.pos, rDir, stepLen, 0.0) : null;

          let targetHit = null;
          let bestDist = wallHit ? wallHit.distance : stepLen;

          for (const pid in G.remotePlayers) {
            if (r.shooterId && String(pid) === String(r.shooterId)) continue;
            const rp = G.remotePlayers[pid];
            if (!rp || rp.isDead) continue;
            const box = new THREE.Box3();
            const rpPos = new THREE.Vector3().fromArray(rp.pos);
            box.min.copy(rpPos).add(new THREE.Vector3(-0.45, 0, -0.45));
            box.max.copy(rpPos).add(new THREE.Vector3(0.45, CFG.H, 0.45));
            const ray = new THREE.Ray(r.pos, rDir);
            const pt = ray.intersectBox(box, new THREE.Vector3());
            if (pt) {
              const d = r.pos.distanceTo(pt);
              if (d < bestDist) {
                bestDist = d;
                targetHit = { point: pt, isWall: false };
              }
            }
          }

          if (!r.isLocal && !G.isDead && (!r.shooterId || String(r.shooterId) !== String(G.localPlayerId))) {
            const box = new THREE.Box3();
            box.min.copy(G.pl.pos).add(new THREE.Vector3(-0.45, 0, -0.45));
            box.max.copy(G.pl.pos).add(new THREE.Vector3(0.45, CFG.H, 0.45));
            const ray = new THREE.Ray(r.pos, rDir);
            const pt = ray.intersectBox(box, new THREE.Vector3());
            if (pt) {
              const d = r.pos.distanceTo(pt);
              if (d < bestDist) {
                targetHit = { point: pt, isWall: false };
              }
            }
          }

          if (!targetHit && wallHit) {
            targetHit = { point: wallHit.point, isWall: true, obb: wallHit.obb, normal: wallHit.normal };
          }

          if (targetHit || r.life <= 0) {
            const explPos = targetHit ? targetHit.point : r.pos;
            if (typeof document === 'undefined' || !document.hidden) {
              if (G.explosion) G.explosion(explPos, r.isLocal);
            }
            if (targetHit && targetHit.isWall && G.destroyWall) {
              const spawnDebris = (typeof document === 'undefined' || !document.hidden);
              G.destroyWall(targetHit.obb, targetHit.point, targetHit.normal, r.isLocal, spawnDebris);
            }
            G.scene.remove(r.mesh);
            r.mesh.traverse(o => {
              if (o.material) o.material.dispose();
              if (o.geometry) o.geometry.dispose();
            });
            G.rockets.splice(i, 1);
            continue;
          }
          r.pos.add(step);
        }
        r.mesh.position.copy(r.pos);

        if (G._acquireSmoke) {
          const _ss = G._acquireSmoke();
          if (_ss) {
            _ss.mesh.position.copy(r.pos);
            _ss.mesh.rotation.set(Math.random(), Math.random(), Math.random());
            _ss.mesh.scale.setScalar(1.5);
            _ss.mesh.material.opacity = 0.4;
            G.animObjects.push({ type: 'smoke', obj: _ss.mesh, slot: _ss, life: 1.0 });
          }
        }
      }
    }
  }

  _updateGrabCubes(dt) {
    const G = this.context;
    if (!G?.grabCubes) return;
    const { TH, V3 } = G;

    for (const c of G.grabCubes) {
      if (c === G.grabbedCube) {
        const t = new V3(0.5, -0.4, -1.2).applyQuaternion(G.camera.quaternion);
        const wantPos = G.camera.position.clone().add(t);
        if (c.pos.distanceTo(wantPos) > 5.0) c.pos.copy(wantPos);
        else c.pos.lerp(wantPos, dt * 15);
        c.vel.set(0, 0, 0);
        const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(dt * 2, dt * 3, 0));
        c.quat.multiply(qSpin);
      } else {
        c.vel.y -= CFG.G * dt;
        const step = c.vel.clone().multiplyScalar(dt);

        const teleported = G.physics?.teleportCube ? G.physics.teleportCube(c, dt, G.portals, G.R_AB, G.R_BA) : false;
        if (!teleported) {
          c.pos.add(step);
          if (G.collideCube) G.collideCube(c, c.rad);

          const speedSq = c.vel.lengthSq();
          if (speedSq < 0.001) {
            c.vel.set(0, 0, 0);
          }

          const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(c.rotVel.x * dt, c.rotVel.y * dt, c.rotVel.z * dt));
          c.quat.multiply(qSpin);

          // Tend to land on flat surfaces after bouncing:
          // As a cube loses speed or settles near ground, natural restoring torque tips it flat.
          if (speedSq < 0.1) {
            c.rotVel.multiplyScalar(Math.max(0, 1 - dt * 8));
            alignCubeToFlatSurface(c.quat, _flatUp, Math.min(1.0, dt * 15));
          } else if (speedSq < 4.0) {
            c.rotVel.multiplyScalar(Math.max(0, 1 - dt * 3));
            alignCubeToFlatSurface(c.quat, _flatUp, Math.min(1.0, dt * 6));
          }
        }
      }
    }

    if (G.instCubeMesh && G.resolveCubeCollisions) {
      G.resolveCubeCollisions();
      const dummy = new THREE.Object3D();
      for (const c of G.grabCubes) {
        dummy.position.copy(c.pos);
        dummy.quaternion.copy(c.quat);
        dummy.updateMatrix();
        G.instCubeMesh.setMatrixAt(c.id, dummy.matrix);
        if (G.instCubeEdges) G.instCubeEdges.setMatrixAt(c.id, dummy.matrix);
      }
      G.instCubeMesh.instanceMatrix.needsUpdate = true;
      if (G.instCubeEdges) G.instCubeEdges.instanceMatrix.needsUpdate = true;
    }
  }

  _updatePortalVisuals(dt) {
    const G = this.context;
    if (!G?.portals || !G.quads || !G.frames || !G.glowLights || !G.sparkles) return;

    for (let i = 0; i < 4; i++) {
      const P = G.portals[i];
      if (!P.placed && !P.closing) continue;

      let scl;
      if (P.closing) {
        const cAge = (performance.now() / 1000) - P.closeTime;
        if (cAge >= 0.5) {
          P.closing = false;
          scl = 0;
        } else {
          const t = cAge / 0.5;
          scl = 1.0 - t + Math.sin(t * Math.PI * 3.0) * (1.0 - t) * 0.3;
        }
      } else {
        const age = (performance.now() / 1000) - (P.openTime || 0);
        if (age < 0.5) {
          const t = age / 0.5;
          scl = 1.0 + Math.sin(t * Math.PI * 3.0) * (1.0 - t) * 0.3;
        } else {
          scl = 1.0 + Math.sin(age * 3.0) * 0.02;
        }
      }

      const camPos = G.camera.position;
      const dot = (camPos.x - P.c.x) * P.n.x + (camPos.y - P.c.y) * P.n.y + (camPos.z - P.c.z) * P.n.z;
      const isFacing = dot > 0.05;

      G.quads[i].scale.setScalar(scl);
      G.frames[i].scale.set((PORT.hw + 0.05) * scl, (PORT.hh + 0.05) * scl, 1);
      G.frames[i].visible = isFacing;
      const pulse = 1.0 + 0.12 * Math.sin(G.nowT * 2.8 + i * 1.7) + 0.06 * Math.cos(G.nowT * 5.3 + i * 2.3);
      G.glowLights[i].intensity = isFacing ? (13.0 * scl * pulse) : 0;
      G.glowLights[i].color.setHex(P.color);

      const sp = G.sparkles[i];
      sp.mesh.visible = isFacing;
      if (!isFacing) continue;

      for (let j = 0; j < 100; j++) {
        if (sp.life[j] <= 0) {
          if (Math.random() < 0.2) {
            const ang = Math.random() * Math.PI * 2;
            const ex = Math.cos(ang) * PORT.hw;
            const ey = Math.sin(ang) * PORT.hh;
            sp.pos[j * 3] = ex;
            sp.pos[j * 3 + 1] = ey;
            sp.pos[j * 3 + 2] = (Math.random() - 0.5) * 0.2;
            sp.vel[j].set(ex, ey, 0).normalize().multiplyScalar(Math.random() * 2.0 + 1.0);
            sp.vel[j].z = (Math.random() - 0.5) * 3.0;
            sp.life[j] = 0.5 + Math.random() * 1.0;
          }
        } else {
          sp.life[j] -= dt * 1.2;
          sp.pos[j * 3] += sp.vel[j].x * dt;
          sp.pos[j * 3 + 1] += sp.vel[j].y * dt;
          sp.pos[j * 3 + 2] += sp.vel[j].z * dt;
        }
      }
      sp.mesh.geometry.attributes.position.needsUpdate = true;
      sp.mesh.geometry.attributes.life.needsUpdate = true;
    }
  }

  _updateAnimObjects(dt, now) {
    const G = this.context;
    if (!G?.animObjects) return;

    for (let i = G.animObjects.length - 1; i >= 0; i--) {
      const a = G.animObjects[i];
      if (a.type === 'lantern') {
        a.obj.position.y += Math.sin(G.nowT * 2 + a.phase) * 0.01;
        a.obj.rotation.y += dt * 0.5;
      } else if (a.type === 'holo') {
        a.obj.rotation.x += dt * 0.8;
        a.obj.rotation.y += dt * 1.2;
      } else if (a.type === 'core') {
        a.ring.rotation.z -= dt * 2;
        a.ring2.rotation.z += dt * 3;
      } else if (a.type === 'expl') {
        a.life -= dt * 3;
        if (a.life <= 0) {
          G.scene.remove(a.obj);
          a.obj.material.dispose();
          a.obj.geometry.dispose();
          G.animObjects.splice(i, 1);
        } else {
          a.obj.scale.setScalar(1 + (1 - a.life) * 1.5);
          a.obj.material.opacity = Math.max(0, a.life);
        }
      } else if (a.type === 'smoke') {
        a.life -= dt * 2.5;
        if (a.life <= 0) {
          if (G._releaseSmoke) G._releaseSmoke(a.slot);
          G.animObjects.splice(i, 1);
        } else {
          a.obj.scale.setScalar(a.life * 1.5);
          a.obj.material.opacity = a.life * 0.4;
          a.obj.position.y += dt * 0.5;
          a.obj.rotation.x += dt;
          a.obj.rotation.y += dt;
        }
      } else if (a.type === 'instagib_beam2') {
        a.life -= dt * 2.5;
        if (a.life <= 0) {
          a.obj.visible = false;
          a.points.geometry.setDrawRange(0, 0);
          if (G._ibPool) G._ibPool.release(a.slot);
          G.animObjects.splice(i, 1);
        } else {
          a.core.material.opacity = a.life;
          a.glow.material.opacity = a.life * 0.6;
          a.points.material.opacity = a.life;
          const posAttr = a.points.geometry.attributes.position;
          for (let j = 0; j < a.pCount; j++) {
            posAttr.array[j * 3] += a.vel[j].x * dt;
            posAttr.array[j * 3 + 1] += a.vel[j].y * dt;
            posAttr.array[j * 3 + 2] += a.vel[j].z * dt;
            a.vel[j].multiplyScalar(0.9);
          }
          posAttr.needsUpdate = true;
        }
      } else if (a.type === 'scorch') {
        a.life -= dt;
        if (a.life <= 0) {
          a.obj.visible = false;
          if (G._scorchPool) G._scorchPool.release(a.slot);
          G.animObjects.splice(i, 1);
        } else {
          a.obj.material.opacity = a.life < G.SCORCH_FADE ? a.life / G.SCORCH_FADE : 1;
        }
      } else if (a.type === 'gib') {
        a.life -= dt;
        if (a.life <= 0) {
          a.obj.visible = false;
          if (G._gibPool) G._gibPool.release(a.slot);
          G.animObjects.splice(i, 1);
        } else {
          a.vel.y -= 25.0 * dt;

          const gibProxy = a.proxy || (a.proxy = { pos: a.obj.position, vel: a.vel });
          gibProxy.pos = a.obj.position;
          gibProxy.vel = a.vel;

          let teleported = false;
          if (G.physics && G.physics.teleportCube && G.portals && G.R_AB && G.R_BA) {
            teleported = G.physics.teleportCube(gibProxy, dt, G.portals, G.R_AB, G.R_BA);
          }

          if (!teleported) {
            a.obj.position.addScaledVector(a.vel, dt);
            const gibRad = 0.12;
            if (G.collideCube && G.obbs) {
              G.collideCube(gibProxy, gibRad);
            } else if (G.physics && G.physics.collideCube && G.obbs) {
              G.physics.collideCube(gibProxy, G.obbs, G.portals || [], gibRad);
            }
          }

          // Bounce off other collidable objects: grabCubes
          if (G.grabCubes) {
            const gibRad = 0.12;
            for (let j = 0; j < G.grabCubes.length; j++) {
              const cube = G.grabCubes[j];
              if (!cube || !cube.pos) continue;
              const cRad = cube.rad || 0.75;
              const totalRad = cRad + gibRad;
              const dx = a.obj.position.x - cube.pos.x;
              const dy = a.obj.position.y - cube.pos.y;
              const dz = a.obj.position.z - cube.pos.z;
              const dSq = dx * dx + dy * dy + dz * dz;
              if (dSq < totalRad * totalRad && dSq > 1e-6) {
                const dist = Math.sqrt(dSq);
                const nx = dx / dist, ny = dy / dist, nz = dz / dist;
                const depth = totalRad - dist;
                a.obj.position.x += nx * (depth + 0.002);
                a.obj.position.y += ny * (depth + 0.002);
                a.obj.position.z += nz * (depth + 0.002);
                const vn = a.vel.x * nx + a.vel.y * ny + a.vel.z * nz;
                if (vn < 0) {
                  const bounce = -vn * 1.5;
                  a.vel.x += nx * bounce;
                  a.vel.y += ny * bounce;
                  a.vel.z += nz * bounce;
                  a.vel.x *= 0.8;
                  a.vel.z *= 0.8;
                  if (a.rotVel) a.rotVel.multiplyScalar(0.7);
                }
              }
            }
          }

          // Floor bounce
          let onFloor = false;
          if (a.obj.position.y < 0.15) {
            a.obj.position.y = 0.15;
            if (a.vel.y < 0) {
              if (Math.abs(a.vel.y) < 0.8) {
                a.vel.y = 0;
              } else {
                a.vel.y *= -0.6;
              }
            }
            a.vel.x *= 0.75;
            a.vel.z *= 0.75;
            onFloor = true;
          }

          // Tumbling rotation via quaternion
          if (a.rotVel) {
            const qSpin = new THREE.Quaternion().setFromEuler(
              new THREE.Euler(a.rotVel.x * dt, a.rotVel.y * dt, a.rotVel.z * dt)
            );
            a.obj.quaternion.multiply(qSpin);
          }

          // Tend to land on flat surfaces after bouncing:
          // Smoothly align the closest cube face with the ground as speed decays
          const speedSq = a.vel.lengthSq();
          if (onFloor || speedSq < 3.0) {
            const alignRate = onFloor ? (speedSq < 0.1 ? 16.0 : 8.0) : 4.0;
            alignCubeToFlatSurface(a.obj.quaternion, _flatUp, Math.min(1.0, dt * alignRate));
            if (a.rotVel) {
              a.rotVel.multiplyScalar(Math.max(0, 1 - dt * (onFloor ? 8.0 : 3.0)));
            }
          }

          if (a.life < 1.5) {
            a.obj.material.opacity = a.life / 1.5;
          }
        }
      } else if (a.type === 'debris') {
        a.life -= dt;
        if (a.life <= 0) {
          G.scene.remove(a.obj);
          a.obj.traverse(o => {
            if (o.geometry) o.geometry.dispose();
          });
          G.animObjects.splice(i, 1);
        } else {
          a.vel.y -= CFG.G * dt;
          a.obj.position.addScaledVector(a.vel, dt);
          a.obj.rotation.x += a.rot.x * dt;
          a.obj.rotation.y += a.rot.y * dt;
          a.obj.rotation.z += a.rot.z * dt;

          if (a.obj.position.y < -0.1 && a.vel.y < 0) {
            a.obj.position.y = -0.1;
            a.vel.y *= -0.5;
            a.vel.x *= 0.6;
            a.vel.z *= 0.6;
            a.rot.multiplyScalar(0.5);
          }

          if (a.life < 1.0) {
            a.obj.scale.setScalar(a.life);
          }
        }
      } else if (a.type === 'flame') {
        const f = 1 + 0.15 * Math.sin(now * 0.02 + a.phase) + 0.07 * Math.sin(now * 0.053 + a.phase * 2);
        a.obj.scale.set(f, 0.85 + 0.2 * f, f);
      } else if (a.type === 'torchlight') {
        a.obj.intensity = 12 + 3.5 * Math.sin(now * 0.017 + a.phase) + 2 * Math.sin(now * 0.041 + a.phase * 3);
      }
    }
  }

  _updateHUDState() {
    const G = this.context;
    if (!G) return;
    const { V3 } = G;

    let specSpeed = 0;
    if (G.isSpectator && G.spectatorMode !== 'freefly') {
      if (G.remotePlayers?.[G.spectateTargetPid]?.vel) {
        const v = G.remotePlayers[G.spectateTargetPid].vel;
        specSpeed = Math.hypot(v[0], v[2]);
      }
    }
    G.camera.updateMatrixWorld(true);
    const aimDir = new V3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
    const hit = G.raycast ? G.raycast(G.camera.getWorldPosition(new V3()), aimDir, 140) : null;

    if (G.updateHUD) {
      G.updateHUD({
        started: G.started,
        pl: G.pl,
        CFG,
        currentSeed: G.currentSeed,
        hit,
        match: G.match,
        localReady: G.localReady,
        localIndex: G.localPlayerIndex,
        statsOpen: G.statsOpen,
        localPid: G.localPlayerId,
        isSpectator: G.isSpectator,
        spectatorSpeed: specSpeed,
        spectatorMode: G.spectatorMode,
        spectateTargetPid: G.spectateTargetPid,
        followPerspective: G.followPerspective,
        isTargetDead: !!(G.spectateTargetPid && G.remotePlayers?.[G.spectateTargetPid] && G.remotePlayers[G.spectateTargetPid].isDead),
        remotePlayers: G.remotePlayers
      });
    }
  }

  /**
   * Render portal camera views and active scene.
   */
  render() {
    const G = this.context;
    if (G) {
      if (G.placePortalVisuals) G.placePortalVisuals();
      if (G.renderPortalViews) G.renderPortalViews();
      if (G.skyGroup && G.camera) G.skyGroup.position.copy(G.camera.position);
      if (G.updateSky) G.updateSky(G.nowT);
      if (G.renderer && G.scene && G.camera) {
        G.renderer.setRenderTarget(null);

        const hasViewmodel = (
          !G.isSpectator && G.started && !G.isDead && (
            (G.gun && G.gun.visible) || (G.rocketGun && G.rocketGun.visible) || (G.instagibGun && G.instagibGun.visible)
          )
        ) || (
          G.isSpectator && G.spectatorMode === 'follow' && G.followPerspective === 'pov' && (
            (G.gun && G.gun.visible) || (G.rocketGun && G.rocketGun.visible) || (G.instagibGun && G.instagibGun.visible)
          )
        );

        if (hasViewmodel) {
          G.renderer.autoClear = false;
          G.renderer.clear();

          // Pass 1: Render world and entities (excluding 1st-person viewmodels on layer 2)
          G.camera.layers.disable(2);
          G.renderer.render(G.scene, G.camera);

          // Pass 2: Render 1st-person viewmodels with cleared depth without redrawing scene background
          const savedBg = G.scene.background;
          G.scene.background = null;
          G.renderer.clearDepth();
          G.camera.layers.set(2);
          G.renderer.render(G.scene, G.camera);
          G.scene.background = savedBg;

          // Restore default camera layers (world layer 0 and viewmodel layer 2)
          G.camera.layers.enable(0);
          G.camera.layers.enable(2);
        } else {
          G.renderer.autoClear = true;
          G.camera.layers.enable(0);
          G.camera.layers.enable(2);
          G.renderer.render(G.scene, G.camera);
        }
      }
    } else if (this.renderManager) {
      this.renderManager.render();
    }
    this.eventBus.emit('ENGINE_RENDER');
  }

  /**
   * Cleanup and dispose engine resources.
   */
  destroy() {
    this.stop();
    this.entityManager.clear();
    this.eventBus.clear();
  }
}
