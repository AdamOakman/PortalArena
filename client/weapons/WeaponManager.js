import * as THREE from 'three';
import { AudioSys } from '../audio/AudioController.js';
import { CFG, PORT } from '../../shared/constants.js';
import { ObjectPool } from '../core/ObjectPool.js';
import { RocketProjectile } from '../projectiles/RocketProjectile.js';

/**
 * WeaponManager — Coordinates active weapons, delegates fire requests, and manages
 * visual beam, scorch, gib, and projectile pools.
 */
export class WeaponManager {
  constructor(eventBus = null, engine = null) {
    this.eventBus = eventBus;
    this.engine = engine;
    this.weapons = new Map();
    this.activeSlot = 1;

    this.activeBeams = [];
    this.rockets = [];
    this.muzzleT = 0;
    this.landingThump = 0;
    this.lastPortalTime = -999;
    this.lastRocketTime = -999;
    this.lastInstagibTime = -999;

    this.SCORCH_LIFE = 30;
    this.SCORCH_FADE = 0.5;

    // Pools & geometries initialized via initPools
    this._gibGeo = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    this._instagibCoreGeo = (() => {
      const g = new THREE.CylinderGeometry(0.015, 0.015, 1, 8);
      g.translate(0, 0.5, 0);
      g.rotateX(Math.PI / 2);
      return g;
    })();
    this._instagibGlowGeo = (() => {
      const g = new THREE.CylinderGeometry(0.08, 0.08, 1, 8);
      g.translate(0, 0.5, 0);
      g.rotateX(Math.PI / 2);
      return g;
    })();

    this.beamGeo = new THREE.CylinderGeometry(0.04, 0.04, 1, 8);
    this.beamGeo.translate(0, 0.5, 0);
    this.beamGeo.rotateX(Math.PI / 2);

    this.helixGeo = new THREE.BufferGeometry();
    const helixPts = [];
    const hSegs = 150, hTurns = 12;
    for (let i = 0; i <= hSegs; i++) {
      const t = i / hSegs;
      const ang = t * Math.PI * 2 * hTurns;
      const r = 0.14;
      helixPts.push(Math.cos(ang) * r, Math.sin(ang) * r, t);
    }
    this.helixGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(helixPts), 3));
    this.helixGeo.computeBoundingSphere();

    this._ibPool = null;
    this._scorchPool = null;
    this._gibPool = null;
    this._smokePool = null;
    this._gibScratch = new THREE.Vector3();
  }

  /**
   * Initialize shared object pools in the THREE.js scene.
   * @param {THREE.Scene} scene
   */
  initPools(scene) {
    const IB_MAX_PTS = 150;
    this._ibPool = new ObjectPool(() => {
      const group = new THREE.Group();
      const core = new THREE.Mesh(this._instagibCoreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 }));
      group.add(core);
      const glow = new THREE.Mesh(this._instagibGlowGeo, new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.6, blending: THREE.AdditiveBlending, depthWrite: false }));
      group.add(glow);
      const pGeo = new THREE.BufferGeometry();
      const pPos = new Float32Array(IB_MAX_PTS * 3);
      pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
      pGeo.setDrawRange(0, 0);
      pGeo.computeBoundingSphere();
      const points = new THREE.Points(pGeo, new THREE.PointsMaterial({ color: 0xff6666, size: 0.08, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false }));
      group.add(points);
      const vel = [];
      for (let i = 0; i < IB_MAX_PTS; i++) vel.push(new THREE.Vector3());
      group.visible = false;
      scene.add(group);
      return { busy: false, group, core, glow, points, pPos, vel };
    }, null, 16);

    const _scorchTex = (() => {
      if (typeof document === 'undefined') return null;
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const rad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
      rad.addColorStop(0, 'rgba(8, 5, 3, 0.98)');
      rad.addColorStop(0.4, 'rgba(14, 9, 5, 0.8)');
      rad.addColorStop(0.7, 'rgba(22, 13, 7, 0.4)');
      rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      g.fillStyle = rad;
      g.fillRect(0, 0, 128, 128);
      g.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 26; i++) {
        const ang = Math.random() * Math.PI * 2;
        const r = 40 + Math.random() * 22;
        g.globalAlpha = 0.3 + Math.random() * 0.5;
        g.beginPath();
        g.arc(64 + Math.cos(ang) * r, 64 + Math.sin(ang) * r, 3 + Math.random() * 9, 0, Math.PI * 2);
        g.fill();
      }
      const t = new THREE.CanvasTexture(c);
      if ('colorSpace' in t) t.colorSpace = THREE.SRGBColorSpace;
      return t;
    })();

    const _scorchGeo = new THREE.PlaneGeometry(1, 1);
    this._scorchPool = new ObjectPool(() => {
      const mesh = new THREE.Mesh(_scorchGeo, new THREE.MeshBasicMaterial({
        map: _scorchTex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
      }));
      mesh.visible = false;
      scene.add(mesh);
      return { busy: false, mesh, life: 0 };
    }, null, 64);

    this._gibPool = new ObjectPool(() => {
      const mat = new THREE.MeshStandardMaterial({ color: 0xaa0000, transparent: true, opacity: 1.0 });
      const mesh = new THREE.Mesh(this._gibGeo, mat);
      mesh.visible = false;
      scene.add(mesh);
      return { busy: false, mesh, mat, vel: new THREE.Vector3() };
    }, null, 80);

    const SMOKE_POOL_SIZE = 80;
    this._smokePool = new ObjectPool(() => {
      const _smesh = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, 0.3, 0.3),
        new THREE.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.8 })
      );
      _smesh.visible = false;
      scene.add(_smesh);
      return { mesh: _smesh, active: false };
    }, (s) => {
      s.active = false;
      s.mesh.visible = false;
    }, SMOKE_POOL_SIZE);
  }

  _acquireSmoke() {
    const s = this._smokePool.acquire();
    s.active = true;
    s.mesh.visible = true;
    return s;
  }

  _releaseSmoke(s) {
    this._smokePool.release(s);
  }

  /**
   * Register a weapon into a slot.
   * @param {number} slot
   * @param {import('./Weapon.js').Weapon} weapon
   */
  register(slot, weapon) {
    this.weapons.set(slot, weapon);
  }

  get activeWeapon() {
    return this.weapons.get(this.activeSlot) || null;
  }

  select(slot) {
    if (!this.weapons.has(slot)) return;

    if (this.activeWeapon) {
      this.activeWeapon.unequip();
    }

    this.activeSlot = slot;
    const nextWeapon = this.activeWeapon;
    if (nextWeapon) {
      nextWeapon.equip();
    }

    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G) {
      G.activeWeapon = slot;
      if (G.gun) G.gun.visible = (slot === 1);
      if (G.rocketGun) G.rocketGun.visible = (slot === 2);
      if (G.instagibGun) G.instagibGun.visible = (slot === 3);
    }

    if (this.eventBus) {
      this.eventBus.emit('WEAPON_CHANGED', { slot, weapon: nextWeapon });
    }
  }

  update(dt) {
    for (const weapon of this.weapons.values()) {
      weapon.update(dt);
    }
  }

  firePrimary() {
    const weapon = this.activeWeapon;
    if (weapon && weapon.canFire()) {
      weapon.firePrimary();
    }
  }

  fireSecondary(active = true) {
    const weapon = this.activeWeapon;
    if (weapon) {
      weapon.fireSecondary(active);
    }
  }

  spawnBeam(colorHex, start, end, scene = null) {
    const sc = scene || this.engine?.context?.scene || window.__GAME_CONTEXT__?.scene;
    if (!sc || !start || !end) return;
    if (isNaN(start.x) || isNaN(start.y) || isNaN(start.z) || isNaN(end.x) || isNaN(end.y) || isNaN(end.z)) return;

    const dist = start.distanceTo(end);
    if (dist < 0.001 || isNaN(dist)) return;

    const coreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false });
    const coreMesh = new THREE.Mesh(this.beamGeo, coreMat);
    coreMesh.position.copy(start);
    coreMesh.lookAt(end);
    coreMesh.scale.set(0.6, 0.6, dist);
    sc.add(coreMesh);

    const hMat = new THREE.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
    const hMesh = new THREE.Line(this.helixGeo, hMat);
    hMesh.position.copy(start);
    hMesh.lookAt(end);
    hMesh.scale.set(1, 1, dist);
    sc.add(hMesh);

    const pCount = 50;
    const pGeo = new THREE.BufferGeometry();
    const pos = new Float32Array(pCount * 3);
    const vel = [];
    for (let i = 0; i < pCount; i++) {
      const t = Math.random();
      const p = new THREE.Vector3().lerpVectors(start, end, t);
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      vel.push(new THREE.Vector3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
    }
    pGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    pGeo.computeBoundingSphere();
    const pMat = new THREE.PointsMaterial({ color: colorHex, size: 0.04, transparent: true, opacity: 1.0, blending: THREE.AdditiveBlending, depthWrite: false });
    const points = new THREE.Points(pGeo, pMat);
    sc.add(points);

    const activeBeams = this.engine?.context?.activeBeams || this.activeBeams;
    activeBeams.push({ coreMesh, hMesh, points, vel, life: 1.0 });
  }

  spawnScorch(pos, n, animObjects = null) {
    if (!this._scorchPool) return;
    const slot = this._scorchPool.acquire();
    if (!slot) return;
    const m = slot.mesh;
    m.position.copy(pos).addScaledVector(n, 0.02);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(0.6 + Math.random() * 0.5);
    m.material.opacity = 1;
    m.visible = true;
    slot.life = this.SCORCH_LIFE;

    const anims = animObjects || this.engine?.context?.animObjects || window.__GAME_CONTEXT__?.animObjects;
    if (anims) {
      anims.push({ type: 'scorch', obj: m, slot, life: this.SCORCH_LIFE });
    }
  }

  spawnInstagibBeam(start, end, animObjects = null) {
    const d = end.clone().sub(start);
    const len = d.length();
    if (len < 0.001 || !this._ibPool) return;
    const slot = this._ibPool.acquire();
    if (!slot) return;
    const { group, core, glow, points, pPos, vel } = slot;
    group.position.copy(start);
    group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.normalize());
    core.scale.z = len;
    glow.scale.z = len;
    const IB_MAX_PTS = 150;
    const pCount = Math.min(IB_MAX_PTS, Math.floor(len * 3));
    for (let i = 0; i < pCount; i++) {
      const t = Math.random() * len;
      pPos[i * 3] = 0;
      pPos[i * 3 + 1] = 0;
      pPos[i * 3 + 2] = t;
      const ang = Math.random() * Math.PI * 2;
      const speed = Math.random() * 8 + 4;
      vel[i].set(Math.cos(ang) * speed, Math.sin(ang) * speed, (Math.random() - 0.5) * 8);
    }
    points.geometry.setDrawRange(0, pCount);
    points.geometry.attributes.position.needsUpdate = true;
    core.material.opacity = 1.0;
    glow.material.opacity = 0.6;
    points.material.opacity = 1.0;
    group.visible = true;

    const anims = animObjects || this.engine?.context?.animObjects || window.__GAME_CONTEXT__?.animObjects;
    if (anims) {
      anims.push({ type: 'instagib_beam2', obj: group, core, glow, points, vel, pCount, slot, life: 1.0 });
    }
  }

  spawnDeathAnimation(pos, color, animObjects = null, blowDir = null) {
    let anims = animObjects;
    let bDir = blowDir;
    if (animObjects && (animObjects.isVector3 || (Array.isArray(animObjects) && typeof animObjects[0] === 'number'))) {
      bDir = animObjects;
      anims = null;
    }
    anims = anims || this.context?.animObjects || this.engine?.context?.animObjects || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__?.animObjects : null);
    if (!this._gibPool) return;
    const gibColor = color || 0xaa0000;
    AudioSys.tone(200, 500, 0.5, 'square', 0.1);

    let normBlow = null;
    if (bDir) {
      if (bDir.isVector3 && Number.isFinite(bDir.x) && Number.isFinite(bDir.y) && Number.isFinite(bDir.z)) {
        if (bDir.lengthSq() > 0.0001) {
          normBlow = bDir.clone().normalize();
        }
      } else if (Array.isArray(bDir) && bDir.length >= 3 && typeof bDir[0] === 'number' && typeof bDir[1] === 'number' && typeof bDir[2] === 'number') {
        const v = new THREE.Vector3(bDir[0], bDir[1], bDir[2]);
        if (v.lengthSq() > 0.0001) {
          normBlow = v.normalize();
        }
      }
    }

    const basePos = pos && pos.isVector3 ? pos : (Array.isArray(pos) ? new THREE.Vector3(...pos) : new THREE.Vector3());

    let spawned = 0;
    while (spawned < 20) {
      const slot = this._gibPool.acquire();
      if (!slot) break;
      slot.mesh.visible = true;
      slot.mat.color.setHex(gibColor);
      slot.mat.opacity = 1.0;
      slot.mesh.scale.setScalar(1.0);
      slot.mesh.position.copy(basePos).add(this._gibScratch.set((Math.random() - 0.5) * 0.6, Math.random() * 1.5, (Math.random() - 0.5) * 0.6));
      slot.mesh.rotation.set(
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2,
        Math.random() * Math.PI * 2
      );
      const rotVel = new THREE.Vector3(
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14,
        (Math.random() - 0.5) * 14
      );
      if (normBlow) {
        slot.vel.set((Math.random() - 0.5) * 8, Math.random() * 5 + 3, (Math.random() - 0.5) * 8);
        slot.vel.addScaledVector(normBlow, 4.0 + Math.random() * 3.0);
      } else {
        slot.vel.set((Math.random() - 0.5) * 10, Math.random() * 6 + 2, (Math.random() - 0.5) * 10);
      }
      if (anims) {
        anims.push({ type: 'gib', obj: slot.mesh, vel: slot.vel, rotVel, slot, life: 3.0 });
      }
      spawned++;
    }
  }

  muzzleFlash(pi, G) {
    G.muzzleT = 1;
    this.muzzleT = 1;
    const hex = G.portals[pi].color;
    G.gun.userData.core.material.emissive.setHex(hex);
    G.gun.userData.ring.material.emissive.setHex(hex);
  }

  traceCrosshairSightline(startPos, startDir, maxDist = 140, G = null) {
    const curPos = startPos.clone();
    const curDir = startDir.clone();
    let remaining = maxDist;
    let totalVirtualDist = 0;
    let firstPortalIdx = -1;

    for (let iter = 0; iter < 4; iter++) {
      const hit = G.raycast ? G.raycast(curPos, curDir, remaining) : null;
      let bestT = hit ? hit.distance : remaining;
      let hitPortal = -1;

      for (let i = 0; i < G.portals.length; i++) {
        const P = G.portals[i];
        const Q = G.portals[i ^ 1];
        if (!P || !P.placed || P.closing || !Q || !Q.placed || Q.closing) continue;
        const denom = curDir.dot(P.n);
        if (denom >= -0.001) continue;
        const pt = P.c.clone().sub(curPos).dot(P.n) / denom;
        if (pt > 0.01 && pt < bestT + 0.05) {
          const hitPt = curPos.clone().addScaledVector(curDir, pt);
          const d = hitPt.clone().sub(P.c);
          const du = Math.abs(d.dot(P.r));
          const dv = Math.abs(d.dot(P.u));
          if (du < PORT.hw && dv < PORT.hh) {
            bestT = pt;
            hitPortal = i;
          }
        }
      }

      let hitPlayerT = bestT;
      for (const pid in G.remotePlayers) {
        const rp = G.remotePlayers[pid];
        if (!rp || rp.isDead) continue;
        const box = new THREE.Box3();
        const rpPos = new THREE.Vector3().fromArray(rp.pos);
        box.min.copy(rpPos).add(new THREE.Vector3(-0.45, 0, -0.45));
        box.max.copy(rpPos).add(new THREE.Vector3(0.45, CFG.H, 0.45));
        const ray = new THREE.Ray(curPos, curDir);
        const pt = ray.intersectBox(box, new THREE.Vector3());
        if (pt) {
          const d = curPos.distanceTo(pt);
          if (d < hitPlayerT) {
            hitPlayerT = d;
            hitPortal = -1;
          }
        }
      }

      if (hitPlayerT < bestT) {
        totalVirtualDist += hitPlayerT;
        break;
      }

      if (hitPortal !== -1) {
        if (iter === 0) {
          firstPortalIdx = hitPortal;
        }
        totalVirtualDist += bestT;
        remaining -= bestT;
        if (remaining <= 0.1) break;

        const P = G.portals[hitPortal];
        const pairIdx = Math.floor(hitPortal / 2);
        const R = (hitPortal % 2 === 0) ? G.R_AB[pairIdx] : G.R_BA[pairIdx];
        const Q = G.portals[hitPortal ^ 1];
        const hitPt = curPos.clone().addScaledVector(curDir, bestT);
        const rel = hitPt.clone().sub(P.c).applyMatrix4(R);
        curPos.copy(Q.c).add(rel).addScaledVector(Q.n, 0.02);
        curDir.applyMatrix4(R).normalize();
        continue;
      }

      totalVirtualDist += bestT;
      break;
    }

    return {
      firstPortalIdx,
      totalVirtualDist,
      targetPtVirtual: startPos.clone().addScaledVector(startDir, totalVirtualDist)
    };
  }

  firePortal(pi, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!G) return;
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    const t = performance.now() / 1000;
    if (t - this.lastPortalTime < 0.2) return;
    this.lastPortalTime = t;
    G.lastPortalTime = t;

    G.camera.updateMatrixWorld(true);
    const dir = new THREE.Vector3();
    G.camera.getWorldDirection(dir);
    const hit = G.raycast(G.camera.position.clone(), dir, 140);

    G.gun.updateMatrixWorld(true);
    const gunPos = new THREE.Vector3(0, 0.02, -0.45).applyMatrix4(G.gun.matrixWorld);
    const target = hit ? hit.point : G.camera.position.clone().addScaledVector(dir, 140);
    this.spawnBeam(G.portals[pi].color, gunPos, target, G.scene);
    G.Network.send({ type: 'fire_beam', pi, start: gunPos.toArray(), end: target.toArray() });

    this.muzzleFlash(pi, G);
    if (!hit) {
      AudioSys.tone(180, 90, 0.1, 'square', 0.05);
      return;
    }
    G.tryPlace(pi, hit);
  }

  fireRocket(context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!G) return;
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    const t = performance.now() / 1000;
    if (t - this.lastRocketTime < 0.5) return;
    G.muzzleT = 1;
    this.muzzleT = 1;
    this.lastRocketTime = t;
    G.lastRocketTime = t;

    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1);
    G.camera.updateMatrixWorld(true);
    G.rocketGun.updateMatrixWorld(true);

    const muzzlePos = new THREE.Vector3(0, 0, -0.6).applyMatrix4(G.rocketGun.matrixWorld);
    const camPos = G.camera.getWorldPosition(new THREE.Vector3());
    const aimDir = new THREE.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();

    const trace = this.traceCrosshairSightline(camPos, aimDir, 140, G);
    const targetPtVirtual = trace.targetPtVirtual;

    let spawnPos = muzzlePos.clone();
    let rocketDir;

    if (trace.firstPortalIdx !== -1) {
      rocketDir = targetPtVirtual.clone().sub(spawnPos).normalize();
      const P = G.portals[trace.firstPortalIdx];
      const denomR = rocketDir.dot(P.n);
      if (denomR < -0.001) {
        const tR = P.c.clone().sub(spawnPos).dot(P.n) / denomR;
        if (tR > 0) {
          const entryPt = spawnPos.clone().addScaledVector(rocketDir, tR);
          const d = entryPt.clone().sub(P.c);
          const du = Math.abs(d.dot(P.r));
          const dv = Math.abs(d.dot(P.u));
          const maxU = PORT.hw - 0.1;
          const maxV = PORT.hh - 0.1;
          if (du > maxU || dv > maxV) {
            const maxRatio = Math.max(du / maxU, dv / maxV);
            const lerpFactor = Math.min(1.0, (maxRatio - 1.0) / maxRatio + 0.15);
            spawnPos.lerp(camPos, lerpFactor);
            rocketDir = targetPtVirtual.clone().sub(spawnPos).normalize();
          }
        }
      }
    } else {
      if (trace.totalVirtualDist < 1.5) {
        rocketDir = aimDir.clone();
      } else {
        rocketDir = targetPtVirtual.clone().sub(spawnPos).normalize();
        if (rocketDir.dot(aimDir) < 0.2) rocketDir = aimDir.clone();
      }
    }

    const vel = rocketDir.clone().multiplyScalar(70);
    const rocket = new RocketProjectile(spawnPos, vel, G.localPlayerId, true);
    G.scene.add(rocket.mesh);

    this.rockets.push(rocket);
    if (G && G.rockets && G.rockets !== this.rockets) G.rockets.push(rocket);
    G.Network.send({ type: 'fire_rocket', pos: spawnPos.toArray(), vel: vel.toArray() });
  }

  fireInstagib(context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!G) return;
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    if (G.nowT - this.lastInstagibTime < 1.0) return;
    G.muzzleT = 1;
    this.muzzleT = 1;
    this.lastInstagibTime = G.nowT;
    G.lastInstagibTime = G.nowT;
    AudioSys.instagibShot(G.camera.position);
    G.camera.updateMatrixWorld(true);
    G.instagibGun.updateMatrixWorld(true);

    let curPos = G.camera.position.clone();
    let curDir = new THREE.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
    let remaining = 300;
    const pts = [];
    let scorchMsg = null;
    let curStart = new THREE.Vector3(0, 0, -0.4).applyMatrix4(G.instagibGun.matrixWorld);

    for (let iter = 0; iter < 6; iter++) {
      const hit = G.raycast(curPos, curDir, remaining);
      let bestPortal = null, bestT = hit ? hit.distance : remaining;

      for (let i = 0; i < G.portals.length; i++) {
        const P = G.portals[i];
        if (!P.placed) continue;
        const denom = curDir.dot(P.n);
        if (denom < -0.001) {
          const pt = P.c.clone().sub(curPos).dot(P.n) / denom;
          if (pt > 0.01 && pt < bestT) {
            const hitPt = curPos.clone().addScaledVector(curDir, pt);
            const d = hitPt.clone().sub(P.c);
            if (Math.abs(d.dot(P.r)) < PORT.hw && Math.abs(d.dot(P.u)) < PORT.hh) {
              bestT = pt;
              bestPortal = i;
            }
          }
        }
      }

      let hitPlayerId = null;
      let hitPlayerT = bestT;
      for (const id in G.remotePlayers) {
        const rp = G.remotePlayers[id];
        const rpPos = new THREE.Vector3().fromArray(rp.pos);
        const box = new THREE.Box3();
        box.min.copy(rpPos).add(new THREE.Vector3(-0.4, 0, -0.4));
        box.max.copy(rpPos).add(new THREE.Vector3(0.4, CFG.H, 0.4));
        const ray = new THREE.Ray(curPos, curDir);
        const playerHit = ray.intersectBox(box, new THREE.Vector3());
        if (playerHit) {
          const dist = curPos.distanceTo(playerHit);
          if (dist < hitPlayerT) {
            hitPlayerT = dist;
            hitPlayerId = id;
          }
        }
      }

      if (iter > 0 && !G.won && !G.isDead) {
        const box = new THREE.Box3();
        box.min.copy(G.pl.pos).add(new THREE.Vector3(-0.4, 0, -0.4));
        box.max.copy(G.pl.pos).add(new THREE.Vector3(0.4, CFG.H, 0.4));
        const ray = new THREE.Ray(curPos, curDir);
        const playerHit = ray.intersectBox(box, new THREE.Vector3());
        if (playerHit) {
          const dist = curPos.distanceTo(playerHit);
          if (dist < hitPlayerT) {
            hitPlayerT = dist;
            hitPlayerId = G.localPlayerId;
          }
        }
      }

      if (hitPlayerId !== null) {
        bestT = hitPlayerT;
        const trueHitPt = curPos.clone().addScaledVector(curDir, bestT);
        pts.push(curStart, trueHitPt);
        G.Network.send({ type: 'fire_instagib', pts: pts.map(p => p.toArray()), hitPlayerId });
        const shotOrigin = pts && pts.length >= 2 ? pts[pts.length - 2].clone() : curStart.clone();
        const beamDir = curDir.clone();
        if (hitPlayerId === G.localPlayerId) {
          G.die(G.localPlayerId, true, 'instagib', shotOrigin, beamDir);
        } else if (G.remotePlayers[hitPlayerId]) {
          G.remotePlayers[hitPlayerId].isDead = true;
          G.remotePlayers[hitPlayerId].predictedDeadUntil = G.nowT + 3.0;
          G.remotePlayers[hitPlayerId].lastShotOrigin = shotOrigin;
          G.remotePlayers[hitPlayerId].lastKillerId = G.localPlayerId;
          G.remotePlayers[hitPlayerId].lastBeamDir = beamDir;
        }
        AudioSys.tone(600, 600, 0.5, 'sine', 0.3);
        if (G.remotePlayerMeshes[hitPlayerId]) {
          G.remotePlayerMeshes[hitPlayerId].visible = false;
          if (G.remotePlayerMeshes[hitPlayerId].userData?.cloneMesh) {
            G.remotePlayerMeshes[hitPlayerId].userData.cloneMesh.visible = false;
          }
        }
        for (let i = 0; i < pts.length; i += 2) this.spawnInstagibBeam(pts[i], pts[i + 1], G.animObjects);
        return;
      }

      const hitPt = curPos.clone().addScaledVector(curDir, bestT);
      pts.push(curStart, hitPt);

      if (bestPortal !== null) {
        const other = G.portals[bestPortal ^ 1];
        if (other.placed) {
          const local = hitPt.clone().sub(G.portals[bestPortal].c);
          const lx = local.dot(G.portals[bestPortal].r), ly = local.dot(G.portals[bestPortal].u);
          curPos = other.c.clone().addScaledVector(other.r, -lx).addScaledVector(other.u, ly).addScaledVector(other.n, 0.02);

          const m = new THREE.Matrix4().makeBasis(G.portals[bestPortal].r, G.portals[bestPortal].u, G.portals[bestPortal].n);
          const inv = m.clone().invert();
          const om = new THREE.Matrix4().makeBasis(other.r.clone().negate(), other.u, other.n.clone().negate());
          curDir.applyMatrix4(inv).applyMatrix4(om).normalize();
          curStart = curPos.clone();
          remaining -= bestT;
          continue;
        }
      }
      if (hit) {
        AudioSys.zap(hitPt, G.camera.position.distanceTo(hitPt) / 343);
        const sn = hit.normal.clone().normalize();
        this.spawnScorch(hitPt, sn, G.animObjects);
        scorchMsg = { pos: hitPt.toArray(), n: sn.toArray() };
      }
      break;
    }

    for (let i = 0; i < pts.length; i += 2) this.spawnInstagibBeam(pts[i], pts[i + 1], G.animObjects);
    G.Network.send({ type: 'fire_instagib', pts: pts.map(p => p.toArray()), scorch: scorchMsg });
  }

  explosion(pos, isLocal, context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!G) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    AudioSys.tone(100, 40, 0.4, 'square', 0.2, 0, pos);
    const expl = new THREE.Mesh(new THREE.SphereGeometry(3.5, 16, 16), new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1 }));
    expl.position.copy(pos);
    G.scene.add(expl);
    G.animObjects.push({ type: 'expl', obj: expl, life: 1.0 });

    const pCenter = G.pl.pos.clone();
    pCenter.y += CFG.H / 2;
    const dvec = new THREE.Vector3().subVectors(pCenter, pos);
    const dist = dvec.length();

    if (dist < 12) {
      if (dvec.y < 0.2) dvec.y = 0.2;
      dvec.normalize();
      const force = (12 - dist) * 2.25;
      G.pl.vel.add(dvec.multiplyScalar(force));
      G.pl.grounded = false;
    }

    for (const pid in G.remotePlayers) {
      const rp = G.remotePlayers[pid];
      if (rp && !rp.isDead) {
        const rpCenter = new THREE.Vector3(rp.pos[0], rp.pos[1] + CFG.H / 2, rp.pos[2]);
        const rpdvec = new THREE.Vector3().subVectors(rpCenter, pos);
        const rpDist = rpdvec.length();
        if (rpDist < 12) {
          if (rpdvec.y < 0.2) rpdvec.y = 0.2;
          rpdvec.normalize();
          const rForce = (12 - rpDist) * 2.25;
          rp.vel[0] += rpdvec.x * rForce;
          rp.vel[1] += rpdvec.y * rForce;
          rp.vel[2] += rpdvec.z * rForce;
        }
      }
    }

    const blasted = [];
    for (let i = 0; i < G.grabCubes.length; i++) {
      const c = G.grabCubes[i];
      if (c === G.grabbedCube) continue;
      const v = c.pos.clone().sub(pos);
      const cd = v.length();
      if (cd < 15.0) {
        const force = (15.0 - cd) * 1.5;
        c.vel.add(v.normalize().multiplyScalar(force));
        c.vel.y += force * 0.4;
        c.rotVel.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(force);
        if (isLocal) {
          blasted.push({ idx: i, vel: c.vel.toArray(), rotVel: c.rotVel.toArray() });
        }
      }
    }
    if (isLocal && blasted.length > 0) {
      G.Network.send({ type: 'blast_cubes', cubes: blasted });
    }
    if (isLocal) {
      G.Network.send({ type: 'rocket_explosion', pos: pos.toArray() });
    }
  }

  prewarmFX(context = null) {
    const G = context || this.engine?.context || window.__GAME_CONTEXT__;
    if (!G) return;
    G.camera.updateMatrixWorld();
    const camPos = new THREE.Vector3();
    const camDir = new THREE.Vector3();
    G.camera.getWorldPosition(camPos);
    G.camera.getWorldDirection(camDir);
    if (camDir.lengthSq() < 0.1) camDir.set(0, 0, -1);

    G.portals.forEach(p => {
      p.placed = true;
      p.c.copy(camPos).addScaledVector(camDir, 2);
      p.n.copy(camDir).negate();
      const f = G.frameFor(p.n);
      p.r.copy(f.r);
      p.u.copy(f.u);
    });
    G.updatePair();
    G.placePortalVisuals();
    G.quads.forEach(q => { q.visible = true; });

    const pmPos = G.playerModel ? G.playerModel.position.clone() : new THREE.Vector3();
    const pmVis = G.playerModel ? G.playerModel.visible : false;
    if (G.playerModel) {
      G.playerModel.visible = true;
      G.playerModel.position.copy(camPos).addScaledVector(camDir, 3);
    }

    const IB_MAX_PTS = 150;
    if (this._gibPool && this._gibPool.items) {
      for (const g of this._gibPool.items) {
        if (g && g.mesh) {
          g.mesh.visible = true;
          g.mesh.position.set(0, -9999, 0);
          g.mesh.frustumCulled = false;
        }
      }
    }
    if (this._ibPool && this._ibPool.items) {
      for (const b of this._ibPool.items) {
        if (b && b.group) {
          b.group.visible = true;
          b.group.position.set(0, -9999, 0);
          if (b.core) b.core.frustumCulled = false;
          if (b.glow) b.glow.frustumCulled = false;
          if (b.points) {
            b.points.frustumCulled = false;
            if (b.points.geometry) b.points.geometry.setDrawRange(0, IB_MAX_PTS);
          }
        }
      }
    }

    const _ws = (this._scorchPool && this._scorchPool.items) ? this._scorchPool.items[0] : null;
    if (_ws && _ws.mesh) {
      _ws.mesh.visible = true;
      _ws.mesh.position.set(0, -9999, 0);
      _ws.mesh.frustumCulled = false;
    }

    const _preRT = new THREE.WebGLRenderTarget(64, 64);
    G.renderer.setRenderTarget(_preRT);
    if (G.renderPortalViews) G.renderPortalViews();
    G.renderer.setRenderTarget(_preRT);
    G.renderer.render(G.scene, G.camera);
    G.renderer.setRenderTarget(null);
    _preRT.dispose();

    if (G.portals) {
      G.portals.forEach(p => {
        p.placed = false;
        p.closing = false;
      });
    }
    if (G.placePortalVisuals) G.placePortalVisuals();
    if (G.quads) G.quads.forEach(q => { if (q) q.visible = false; });
    if (G.playerModel) {
      G.playerModel.position.copy(pmPos);
      G.playerModel.visible = pmVis;
    }
    if (this._gibPool && this._gibPool.items) {
      for (const g of this._gibPool.items) {
        if (g && g.mesh) {
          g.mesh.visible = false;
          g.mesh.frustumCulled = true;
        }
      }
    }
    if (this._ibPool && this._ibPool.items) {
      for (const b of this._ibPool.items) {
        if (b && b.group) {
          b.group.visible = false;
          if (b.core) b.core.frustumCulled = true;
          if (b.glow) b.glow.frustumCulled = true;
          if (b.points) {
            b.points.frustumCulled = true;
            if (b.points.geometry) b.points.geometry.setDrawRange(0, 0);
          }
        }
      }
    }
    if (_ws && _ws.mesh) {
      _ws.mesh.visible = false;
      _ws.mesh.frustumCulled = true;
    }
  }
}

/**
 * Procedural backward compatibility wrapper for weapons.
 * @param {Object} G - Game state context
 */
export function initWeapons(G) {
  const manager = G.weaponManager || new WeaponManager(G.engine?.eventBus || null, G.engine || null);
  manager.context = G;
  G.weaponManager = manager;
  manager.initPools(G.scene);

  G.muzzleT = 0;
  G.activeBeams = manager.activeBeams;
  G.rockets = manager.rockets;
  G.landingThump = manager.landingThump;
  G.lastPortalTime = manager.lastPortalTime;
  G.lastRocketTime = manager.lastRocketTime;
  G.lastInstagibTime = manager.lastInstagibTime;

  G._ibPool = manager._ibPool;
  G._scorchPool = manager._scorchPool;
  G._gibPool = manager._gibPool;
  G._smokePool = manager._smokePool;
  G._acquireSmoke = () => manager._acquireSmoke();
  G._releaseSmoke = (s) => manager._releaseSmoke(s);

  G.SCORCH_LIFE = manager.SCORCH_LIFE;
  G.SCORCH_FADE = manager.SCORCH_FADE;

  G.spawnBeam = (color, s, e) => manager.spawnBeam(color, s, e, G.scene);
  G.spawnScorch = (pos, n) => manager.spawnScorch(pos, n, G.animObjects);
  G.spawnInstagibBeam = (s, e) => manager.spawnInstagibBeam(s, e, G.animObjects);
  G.spawnDeathAnimation = (pos, color, blowDir = null) => manager.spawnDeathAnimation(pos, color, G.animObjects, blowDir);
  G.firePortal = (pi) => manager.firePortal(pi, G);
  G.fireRocket = () => manager.fireRocket(G);
  G.fireInstagib = () => manager.fireInstagib(G);
  G.explosion = (pos, isLocal) => manager.explosion(pos, isLocal, G);
  G.prewarmFX = () => manager.prewarmFX(G);

  return manager;
}
