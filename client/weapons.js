import { AudioSys } from './audio.js';
import { CFG, PORT } from '../shared/constants.js';

/* ============================================================================
   WEAPONS — portal gun, rocket launcher, instagib: firing logic, shared
   beam/scorch/gib/smoke FX pools, and the renderer pre-warm.
   ============================================================================ */
export function initWeapons(G) {
  const { TH, V3 } = G;

  /* ------------------------------------------------------------- beams */
  G.activeBeams = [];
  const beamGeo = new TH.CylinderGeometry(0.04, 0.04, 1, 8);
  beamGeo.translate(0, 0.5, 0);
  beamGeo.rotateX(Math.PI / 2);

  const helixGeo = new TH.BufferGeometry();
  const helixPts = [];
  const hSegs = 150, hTurns = 12;
  for (let i = 0; i <= hSegs; i++) {
    const t = i / hSegs;
    const ang = t * Math.PI * 2 * hTurns;
    const r = 0.14;
    helixPts.push(Math.cos(ang) * r, Math.sin(ang) * r, t);
  }
  helixGeo.setAttribute('position', new TH.BufferAttribute(new Float32Array(helixPts), 3));

  // --- Pre-allocated shared geometry (avoids per-event GPU buffer upload & shader compile stalls) ---
  const _gibGeo = new TH.BoxGeometry(0.2, 0.2, 0.2);
  // Unit-length instagib beam cylinders — scaled per beam rather than rebuilt each shot
  const _instagibCoreGeo = (() => { const g = new TH.CylinderGeometry(0.015, 0.015, 1, 8); g.translate(0, 0.5, 0); g.rotateX(Math.PI / 2); return g; })();
  const _instagibGlowGeo = (() => { const g = new TH.CylinderGeometry(0.08, 0.08, 1, 8); g.translate(0, 0.5, 0); g.rotateX(Math.PI / 2); return g; })();

  // --- Kill-FX object pools ---
  // Spawning gibs/beams used to build new Mesh + BufferGeometry + BufferAttribute
  // + Material at kill time, which allocates fresh GPU VBOs/VAOs and hitches the
  // frame on EVERY kill. Pools pre-allocate all of it once and only reset it.
  function makePool(n, factory) {
    const items = [];
    for (let i = 0; i < n; i++) items.push(factory(i));
    return {
      items,
      acquire() { for (const it of items) if (!it.busy) { it.busy = true; return it; } return null; },
      release(it) { it.busy = false; },
      releaseAll() { for (const it of items) it.busy = false; }
    };
  }

  // Instagib beam pool: group + core/glow (shared geo) + point geometry (fixed 150
  // pts, drawn via setDrawRange) + fixed velocity array, all pre-allocated.
  const IB_MAX_PTS = 150;
  G._ibPool = makePool(16, () => {
    const group = new TH.Group();
    const core = new TH.Mesh(_instagibCoreGeo, new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 1.0 }));
    group.add(core);
    const glow = new TH.Mesh(_instagibGlowGeo, new TH.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.6, blending: TH.AdditiveBlending, depthWrite: false }));
    group.add(glow);
    const pGeo = new TH.BufferGeometry();
    const pPos = new Float32Array(IB_MAX_PTS * 3);
    pGeo.setAttribute('position', new TH.BufferAttribute(pPos, 3));
    pGeo.setDrawRange(0, 0);
    const points = new TH.Points(pGeo, new TH.PointsMaterial({ color: 0xff6666, size: 0.08, transparent: true, opacity: 1.0, blending: TH.AdditiveBlending, depthWrite: false }));
    group.add(points);
    const vel = [];
    for (let i = 0; i < IB_MAX_PTS; i++) vel.push(new V3());
    group.visible = false;
    G.scene.add(group);
    return { busy: false, group, core, glow, points, pPos, vel };
  });

  // --- Instagib scorch marks: dark burnt decals where a beam struck a wall.
  // Pooled textured planes that stick to the hit surface for SCORCH_LIFE seconds,
  // then fade out fluently over SCORCH_FADE. They live in the scene, so they are
  // visible to every player — including through the portals.
  const SCORCH_LIFE = 30, SCORCH_FADE = 0.5;
  const _scorchTex = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const rad = g.createRadialGradient(64, 64, 2, 64, 64, 64);
    rad.addColorStop(0, 'rgba(8, 5, 3, 0.98)');
    rad.addColorStop(0.4, 'rgba(14, 9, 5, 0.8)');
    rad.addColorStop(0.7, 'rgba(22, 13, 7, 0.4)');
    rad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    g.fillStyle = rad; g.fillRect(0, 0, 128, 128);
    // Rough up the edge with random notches so the mark looks burnt, not stamped
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 26; i++) {
      const ang = Math.random() * Math.PI * 2;
      const r = 40 + Math.random() * 22;
      g.globalAlpha = 0.3 + Math.random() * 0.5;
      g.beginPath();
      g.arc(64 + Math.cos(ang) * r, 64 + Math.sin(ang) * r, 3 + Math.random() * 9, 0, Math.PI * 2);
      g.fill();
    }
    const t = new TH.CanvasTexture(c);
    if ('colorSpace' in t) t.colorSpace = TH.SRGBColorSpace;
    return t;
  })();
  const _scorchGeo = new TH.PlaneGeometry(1, 1);
  G._scorchPool = makePool(64, () => {
    const mesh = new TH.Mesh(_scorchGeo, new TH.MeshBasicMaterial({
      map: _scorchTex, transparent: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1
    }));
    mesh.visible = false;
    G.scene.add(mesh);
    return { busy: false, mesh, life: 0 };
  });
  G.SCORCH_LIFE = SCORCH_LIFE;
  G.SCORCH_FADE = SCORCH_FADE;
  function spawnScorch(pos, n) {
    const slot = G._scorchPool.acquire();
    if (!slot) return; // pool exhausted — silently drop this mark
    const m = slot.mesh;
    m.position.copy(pos).addScaledVector(n, 0.02);
    m.quaternion.setFromUnitVectors(new V3(0, 0, 1), n);
    m.rotateZ(Math.random() * Math.PI * 2);
    m.scale.setScalar(0.6 + Math.random() * 0.5);
    m.material.opacity = 1;
    m.visible = true;
    slot.life = SCORCH_LIFE;
    G.animObjects.push({ type: 'scorch', obj: m, slot, life: SCORCH_LIFE });
  }

  // Gib pool: death meshes share one geometry; each slot has its own material so
  // fading/coloring one death effect never makes other gibs invisible.
  const _gibScratch = new V3();
  G._gibPool = makePool(80, () => {
    const mat = new TH.MeshStandardMaterial({ color: 0xaa0000, transparent: true, opacity: 1.0 });
    const mesh = new TH.Mesh(_gibGeo, mat);
    mesh.visible = false;
    G.scene.add(mesh);
    return { busy: false, mesh, mat, vel: new V3() };
  });

  function spawnBeam(colorHex, start, end) {
    const dist = start.distanceTo(end);

    const coreMat = new TH.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, blending: TH.AdditiveBlending, depthWrite: false });
    const coreMesh = new TH.Mesh(beamGeo, coreMat);
    coreMesh.position.copy(start); coreMesh.lookAt(end);
    coreMesh.scale.set(0.6, 0.6, dist);
    G.scene.add(coreMesh);

    const hMat = new TH.LineBasicMaterial({ color: colorHex, transparent: true, opacity: 0.8, blending: TH.AdditiveBlending, depthWrite: false });
    const hMesh = new TH.Line(helixGeo, hMat);
    hMesh.position.copy(start); hMesh.lookAt(end);
    hMesh.scale.set(1, 1, dist);
    G.scene.add(hMesh);

    const pCount = 50;
    const pGeo = new TH.BufferGeometry();
    const pos = new Float32Array(pCount * 3);
    const vel = [];
    for (let i = 0; i < pCount; i++) {
      const t = Math.random();
      const p = new V3().lerpVectors(start, end, t);
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      vel.push(new V3((Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 6));
    }
    pGeo.setAttribute('position', new TH.BufferAttribute(new Float32Array(pos), 3));
    const pMat = new TH.PointsMaterial({ color: colorHex, size: 0.04, transparent: true, opacity: 1.0, blending: TH.AdditiveBlending, depthWrite: false });
    const points = new TH.Points(pGeo, pMat);
    G.scene.add(points);

    G.activeBeams.push({ coreMesh, hMesh, points, vel, life: 1.0 });
  }

  /* ------------------------------------------------------ portal gun */
  G.muzzleT = 0;
  G.lastPortalTime = -999;
  function muzzleFlash(pi) {
    G.muzzleT = 1;
    const hex = G.portals[pi].color;
    G.gun.userData.core.material.emissive.setHex(hex);
    G.gun.userData.ring.material.emissive.setHex(hex);
  }

  function firePortal(pi) {
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    const t = performance.now() / 1000;
    if (t - G.lastPortalTime < 0.2) return;
    G.lastPortalTime = t;

    G.camera.updateMatrixWorld(true);
    const dir = new V3(); G.camera.getWorldDirection(dir);
    const hit = G.raycast(G.camera.position.clone(), dir, 140);

    G.gun.updateMatrixWorld(true);
    const gunPos = new V3(0, 0.02, -0.45).applyMatrix4(G.gun.matrixWorld);
    const target = hit ? hit.point : G.camera.position.clone().addScaledVector(dir, 140);
    spawnBeam(G.portals[pi].color, gunPos, target);
    G.Network.send({ type: 'fire_beam', pi, start: gunPos.toArray(), end: target.toArray() });

    muzzleFlash(pi);
    if (!hit) { AudioSys.tone(180, 90, 0.1, 'square', 0.05); return; }
    G.tryPlace(pi, hit);
  }

  /* ------------------------------------------------ rocket launcher */
  G.rockets = [];
  G.lastRocketTime = -999;

  // --- Pre-allocated smoke particle pool (avoids per-frame Mesh/Geometry/Material allocation) ---
  const SMOKE_POOL_SIZE = 80;
  const _smokePool = [];
  for (let si = 0; si < SMOKE_POOL_SIZE; si++) {
    const _smesh = new TH.Mesh(
      new TH.BoxGeometry(0.3, 0.3, 0.3),
      new TH.MeshBasicMaterial({ color: 0x888888, transparent: true, opacity: 0.8 })
    );
    _smesh.visible = false;
    G.scene.add(_smesh);
    _smokePool.push({ mesh: _smesh, active: false });
  }
  function _acquireSmoke() {
    for (const s of _smokePool) { if (!s.active) { s.active = true; s.mesh.visible = true; return s; } }
    return null; // pool exhausted — silently skip this smoke puff
  }
  function _releaseSmoke(s) { s.active = false; s.mesh.visible = false; }
  G._acquireSmoke = _acquireSmoke;
  G._releaseSmoke = _releaseSmoke;
  G._smokePool = _smokePool;

  function traceCrosshairSightline(startPos, startDir, maxDist = 140) {
    const curPos = startPos.clone();
    const curDir = startDir.clone();
    let remaining = maxDist;
    let totalVirtualDist = 0;
    let firstPortalIdx = -1;

    for (let iter = 0; iter < 4; iter++) {
      const hit = G.raycast ? G.raycast(curPos, curDir, remaining) : null;
      let bestT = hit ? hit.distance : remaining;
      let hitPortal = -1;

      // Check portals
      for (let i = 0; i < G.portals.length; i++) {
        const P = G.portals[i];
        const Q = G.portals[i ^ 1];
        if (!P || !P.placed || P.closing || !Q || !Q.placed || Q.closing) continue;
        const denom = curDir.dot(P.n);
        if (denom >= -0.001) continue; // Ray must face towards the front of the portal
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

      // Check remote players
      let hitPlayerT = bestT;
      for (const pid in G.remotePlayers) {
        const rp = G.remotePlayers[pid];
        if (!rp || rp.isDead) continue;
        const box = new TH.Box3();
        const rpPos = new TH.Vector3().fromArray(rp.pos);
        box.min.copy(rpPos).add(new TH.Vector3(-0.45, 0, -0.45));
        box.max.copy(rpPos).add(new TH.Vector3(0.45, CFG.H, 0.45));
        const ray = new TH.Ray(curPos, curDir);
        const pt = ray.intersectBox(box, new TH.Vector3());
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

  function fireRocket() {
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    const t = performance.now() / 1000;
    if (t - G.lastRocketTime < 0.5) return;
    G.muzzleT = 1;
    G.lastRocketTime = t;

    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1);
    G.camera.updateMatrixWorld(true);
    G.rocketGun.updateMatrixWorld(true);

    const muzzlePos = new TH.Vector3(0, 0, -0.6).applyMatrix4(G.rocketGun.matrixWorld);
    const camPos = G.camera.getWorldPosition(new TH.Vector3());
    const aimDir = new TH.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();

    const trace = traceCrosshairSightline(camPos, aimDir, 140);
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

    const rMesh = new TH.Group();
    const bGeo = new TH.CylinderGeometry(0.06, 0.06, 0.4, 8);
    const bMat = new TH.MeshStandardMaterial({ color: 0x222222 });
    const body = new TH.Mesh(bGeo, bMat);
    const tGeo = new TH.ConeGeometry(0.06, 0.2, 8);
    const tMat = new TH.MeshStandardMaterial({ color: 0xff0000 });
    const tip = new TH.Mesh(tGeo, tMat);
    tip.position.y = 0.3;
    rMesh.add(body, tip);

    rMesh.quaternion.setFromUnitVectors(new TH.Vector3(0, 1, 0), rocketDir);
    rMesh.position.copy(spawnPos);
    G.scene.add(rMesh);

    G.rockets.push({ pos: spawnPos.clone(), vel, mesh: rMesh, life: 5, isLocal: true, shooterId: G.localPlayerId });
    G.Network.send({ type: 'fire_rocket', pos: spawnPos.toArray(), vel: vel.toArray() });
  }

  /* ------------------------------------------------------ instagib */
  function spawnInstagibBeam(start, end) {
    const d = end.clone().sub(start);
    const len = d.length();
    if (len < 0.001) return;
    const slot = G._ibPool.acquire();
    if (!slot) return; // pool exhausted — drop this beam's particles
    const { group, core, glow, points, pPos, vel } = slot;
    group.position.copy(start);
    group.quaternion.setFromUnitVectors(new TH.Vector3(0, 0, 1), d.normalize());
    core.scale.z = len;
    glow.scale.z = len;
    const pCount = Math.min(IB_MAX_PTS, Math.floor(len * 3));
    for (let i = 0; i < pCount; i++) {
       const t = Math.random() * len;
       pPos[i*3] = 0; pPos[i*3+1] = 0; pPos[i*3+2] = t;
       const ang = Math.random() * Math.PI * 2;
       const speed = Math.random() * 8 + 4;
       vel[i].set(Math.cos(ang) * speed, Math.sin(ang) * speed, (Math.random()-0.5) * 8);
    }
    points.geometry.setDrawRange(0, pCount);
    points.geometry.attributes.position.needsUpdate = true;
    core.material.opacity = 1.0;
    glow.material.opacity = 0.6;
    points.material.opacity = 1.0;
    group.visible = true;
    G.animObjects.push({ type: 'instagib_beam2', obj: group, core, glow, points, vel, pCount, slot, life: 1.0 });
  }

  G.lastInstagibTime = -999;
  function fireInstagib() {
    if (G.countdownActive || (G.match && G.match.phase === 'countdown')) return;
    if (G.nowT - G.lastInstagibTime < 1.0) return;
    G.muzzleT = 1;
    G.lastInstagibTime = G.nowT;
    AudioSys.instagibShot(G.camera.position);
    G.camera.updateMatrixWorld(true);
    G.instagibGun.updateMatrixWorld(true);

    let curPos = G.camera.position.clone();
    let curDir = new TH.Vector3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
    let remaining = 300;
    const pts = [];
    let scorchMsg = null; // set when the beam ends on a wall
    let curStart = new TH.Vector3(0, 0, -0.4).applyMatrix4(G.instagibGun.matrixWorld);

    // The beam may pass through portals up to 5 times (6 trace segments:
    // 5 portal passages + 1 final). A wall or player hit stops it sooner.
    for (let iter = 0; iter < 6; iter++) {
        let hit = G.raycast(curPos, curDir, remaining);
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
            const rpPos = new TH.Vector3().fromArray(rp.pos);
            const box = new TH.Box3();
            box.min.copy(rpPos).add(new TH.Vector3(-0.4, 0, -0.4));
            box.max.copy(rpPos).add(new TH.Vector3(0.4, CFG.H, 0.4));
            const ray = new TH.Ray(curPos, curDir);
            const playerHit = ray.intersectBox(box, new TH.Vector3());
            if (playerHit) {
               const dist = curPos.distanceTo(playerHit);
               if (dist < hitPlayerT) {
                   hitPlayerT = dist;
                   hitPlayerId = id;
               }
            }
        }

        if (iter > 0 && !G.won && !G.isDead) {
            const box = new TH.Box3();
            box.min.copy(G.pl.pos).add(new TH.Vector3(-0.4, 0, -0.4));
            box.max.copy(G.pl.pos).add(new TH.Vector3(0.4, CFG.H, 0.4));
            const ray = new TH.Ray(curPos, curDir);
            const playerHit = ray.intersectBox(box, new TH.Vector3());
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
            if (hitPlayerId === G.localPlayerId) { G.die(G.localPlayerId, true); } else if (G.remotePlayers[hitPlayerId]) {
               G.remotePlayers[hitPlayerId].isDead = true;
               G.remotePlayers[hitPlayerId].predictedDeadUntil = G.nowT + 3.0;
            }
            AudioSys.tone(600, 600, 0.5, 'sine', 0.3);
            if (G.remotePlayerMeshes[hitPlayerId]) G.remotePlayerMeshes[hitPlayerId].visible = false;
            for (let i = 0; i < pts.length; i += 2) spawnInstagibBeam(pts[i], pts[i+1]);
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

              const m = new TH.Matrix4().makeBasis(G.portals[bestPortal].r, G.portals[bestPortal].u, G.portals[bestPortal].n);
              const inv = m.clone().invert();
              const om = new TH.Matrix4().makeBasis(other.r.clone().negate(), other.u, other.n.clone().negate());
              curDir.applyMatrix4(inv).applyMatrix4(om).normalize();
              curStart = curPos.clone();
              remaining -= bestT;
              continue;
           }
        }
        if (hit) {
           // Beam ended on a wall: zap at the impact point + burnt scorch mark.
           // The crack is delayed by the sound travel time so it lands after
           // the trigger instead of overlapping it.
           AudioSys.zap(hitPt, G.camera.position.distanceTo(hitPt) / 343);
           const sn = hit.normal.clone().normalize();
           spawnScorch(hitPt, sn);
           scorchMsg = { pos: hitPt.toArray(), n: sn.toArray() };
        }
        break;
    }

    for (let i = 0; i < pts.length; i += 2) spawnInstagibBeam(pts[i], pts[i+1]);

    G.Network.send({ type: 'fire_instagib', pts: pts.map(p => p.toArray()), scorch: scorchMsg });
  }

  /* ------------------------------------------------------ death FX */
  function spawnDeathAnimation(pos, color) {
    const gibColor = color || 0xaa0000;
    AudioSys.tone(200, 500, 0.5, 'square', 0.1);
    let spawned = 0;
    while (spawned < 20) {
       const slot = G._gibPool.acquire();
       if (!slot) break; // pool exhausted — stop here
       slot.mesh.visible = true;
       slot.mat.color.setHex(gibColor);
       slot.mat.opacity = 1.0;
       slot.mesh.scale.setScalar(1.0);
       slot.mesh.position.copy(pos).add(_gibScratch.set((Math.random()-0.5)*0.6, Math.random()*1.5, (Math.random()-0.5)*0.6));
       slot.vel.set((Math.random()-0.5)*10, Math.random()*6+2, (Math.random()-0.5)*10);
       G.animObjects.push({ type: 'gib', obj: slot.mesh, vel: slot.vel, slot, life: 3.0 });
       spawned++;
    }
  }

  function explosion(pos, isLocal) {
    if (typeof document !== 'undefined' && document.hidden) return;
    AudioSys.tone(100, 40, 0.4, 'square', 0.2, 0, pos);
    const expl = new TH.Mesh(new TH.SphereGeometry(3.5, 16, 16), new TH.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 1 }));
    expl.position.copy(pos);
    G.scene.add(expl);
    G.animObjects.push({ type: 'expl', obj: expl, life: 1.0 });

    const pCenter = G.pl.pos.clone(); pCenter.y += CFG.H / 2;
    const dvec = new TH.Vector3().subVectors(pCenter, pos);
    const dist = dvec.length();

    if (dist < 12) {
       if (dvec.y < 0.2) dvec.y = 0.2;
       dvec.normalize();
       const force = (12 - dist) * 2.25;
       G.pl.vel.add(dvec.multiplyScalar(force));
       G.pl.grounded = false;
    }

    // Also apply local visual impulse to remote players / bots
    for (const pid in G.remotePlayers) {
      const rp = G.remotePlayers[pid];
      if (rp && !rp.isDead) {
        const rpCenter = new TH.Vector3(rp.pos[0], rp.pos[1] + CFG.H / 2, rp.pos[2]);
        const rpdvec = new TH.Vector3().subVectors(rpCenter, pos);
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

    // Blast cubes
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
        c.rotVel.set(Math.random()-0.5, Math.random()-0.5, Math.random()-0.5).multiplyScalar(force);
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

  /* ------------------------------------------- renderer pre-warm (FX) */
  G.landingThump = 0;

  /* Pre-warm the renderer after every map load.
     three.js keys each lit shader program by the scene's point-light count,
     and every map gets a random number of torch/brazier PointLights, so
     swapping maps invalidates every compiled program. Programs of objects
     that are not drawn in the first frame of the new map (the pooled kill
     FX, the layer-1 player model that is only drawn through portal views)
     would otherwise compile on first use — a visible hitch on the first
     kill and on the first portal pair. One offscreen frame with all of
     them visible compiles everything up front. */
  function prewarmFX() {
    G.camera.updateMatrixWorld();
    const camPos = new TH.Vector3();
    const camDir = new TH.Vector3();
    G.camera.getWorldPosition(camPos);
    G.camera.getWorldDirection(camDir);
    if (camDir.lengthSq() < 0.1) camDir.set(0, 0, -1);

    // Two portal pairs 2 units ahead of the camera: compiles the portal
    // shaders, sparkles and the render-target passes.
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
    G.quads.forEach(q => q.visible = true);

    // The local player model is on layer 1 — only drawn by the portal
    // views — so park it just past the pre-warm portals, inside the portal
    // camera's frustum, to compile its locally-clipped program now.
    const pmPos = G.playerModel.position.clone();
    const pmVis = G.playerModel.visible;
    G.playerModel.visible = true;
    G.playerModel.position.copy(camPos).addScaledVector(camDir, 3);

    // Pooled kill FX: gibs + every instagib beam slot (a kill beam through a
    // portal spans 2-4 segments; each slot's particle geometry allocates its
    // VBO/VAO on first render, so all slots must be drawn once).
    for (const g of G._gibPool.items) { g.mesh.visible = true; g.mesh.position.set(0, -9999, 0); g.mesh.frustumCulled = false; }
    for (const b of G._ibPool.items) {
      b.group.visible = true; b.group.position.set(0, -9999, 0);
      b.core.frustumCulled = false; b.glow.frustumCulled = false; b.points.frustumCulled = false;
      b.points.geometry.setDrawRange(0, IB_MAX_PTS);
    }

    // One scorch mark: its MeshBasicMaterial(map) program would otherwise
    // compile on the first instagib wall hit.
    const _ws = G._scorchPool.items[0];
    _ws.mesh.visible = true; _ws.mesh.position.set(0, -9999, 0); _ws.mesh.frustumCulled = false;

    // Render to a throwaway target so the pre-warm frame never flashes on
    // screen.
    const _preRT = new TH.WebGLRenderTarget(64, 64);
    G.renderer.setRenderTarget(_preRT);
    G.renderPortalViews();
    G.renderer.setRenderTarget(_preRT);
    G.renderer.render(G.scene, G.camera);
    G.renderer.setRenderTarget(null);
    _preRT.dispose();

    // Tear the pre-warm state back down.
    G.portals.forEach(p => { p.placed = false; p.closing = false; });
    G.placePortalVisuals();
    G.quads.forEach(q => q.visible = false);
    G.playerModel.position.copy(pmPos);
    G.playerModel.visible = pmVis;
    for (const g of G._gibPool.items) { g.mesh.visible = false; g.mesh.frustumCulled = true; }
    for (const b of G._ibPool.items) {
      b.group.visible = false;
      b.core.frustumCulled = true; b.glow.frustumCulled = true; b.points.frustumCulled = true;
      b.points.geometry.setDrawRange(0, 0);
    }
    _ws.mesh.visible = false; _ws.mesh.frustumCulled = true;
  }

  G.spawnBeam = spawnBeam;
  G.spawnScorch = spawnScorch;
  G.spawnInstagibBeam = spawnInstagibBeam;
  G.spawnDeathAnimation = spawnDeathAnimation;
  G.firePortal = firePortal;
  G.fireRocket = fireRocket;
  G.fireInstagib = fireInstagib;
  G.explosion = explosion;
  G.prewarmFX = prewarmFX;
}
