import { AudioSys } from './audio.js';
import { CFG, PORT } from '../shared/constants.js';

/* ============================================================================
   LOOP — the main animation frame: input/physics stepping, weapon & beam
   updates, grab cubes, portal visuals, animated FX objects, HUD, and render.
   ============================================================================ */
export function initLoop(G) {
  const { TH, V3 } = G;

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = Math.min(0.05, (now - last) / 1000); last = now;
    AudioSys.listenerPos = G.pl.pos;
    AudioSys.listenerYaw = G.pl.yaw;
    G.nowT += dt;
    if (G.started && G.isConnected && G.localPlayerId != null && G.nowT >= G.nextPingT) {
      G.Network.send({ type: 'ping', t: performance.now(), ping: G.lastPingMs });
      G.nextPingT = G.nowT + 5;
    }

    if (!G.started) { // idle preview orbit while at menu — close, centered on the arena
      // radius 20 < 25 keeps the camera inside the boundary walls for the whole orbit
      const t = now * 0.00012;
      G.camera.position.set(Math.cos(t) * 20, 17, Math.sin(t) * 20);
      G.camera.lookAt(0, 2.5, 0);
    } else if (!G.won) {

      const activeKeys = G.pointerLocked ? G.keys : { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false, KeyC: false, ControlLeft: false };
      const isCrouching = activeKeys.KeyC || activeKeys.ControlLeft;
      G.pl.crouchT = Math.max(0, Math.min(1, G.pl.crouchT + (isCrouching ? dt * 10 : -dt * 10)));

        if (G.localPlayerId != null) { G.Network.send({
          type: 'input',
          dt: dt,
          keys: {
            KeyW: activeKeys.KeyW, KeyA: activeKeys.KeyA, KeyS: activeKeys.KeyS, KeyD: activeKeys.KeyD, Space: activeKeys.Space, ShiftLeft: activeKeys.ShiftLeft
          },
          yaw: G.pl.yaw,
          pitch: G.pl.pitch,
          autohop: G.autohop, crouch: isCrouching, crouchT: G.pl.crouchT,
          jumpBuf: G.pl.jumpBuf,
          pos: G.pl.pos.toArray(),
          vel: G.pl.vel.toArray(),
          activeWeapon: G.activeWeapon,
          isDead: G.isDead, grabbedCubeIdx: G.grabbedCube ? G.grabCubes.indexOf(G.grabbedCube) : undefined, grabbedCubePos: G.grabbedCube ? G.grabbedCube.pos.toArray() : undefined, grabbedCubeVel: G.grabbedCube ? G.grabbedCube.vel.toArray() : undefined });
      }

      let rem = G.isConnected ? dt : 0;
      while (rem > 1e-4) { const s = Math.min(rem, 1 / 120); G.physStep(s, activeKeys); rem -= s; }

      // Render remote players
      G.updateRemotePlayers(dt, G.nowT);
    }

    for (let i = 0; i < 4; i++) {
      G.quadMats[i].uniforms.uTime.value = now * 0.001;
    }
    G.placePortalVisuals();
    G.renderPortalViews();

    G.muzzleT = Math.max(0, G.muzzleT - dt * 6);
    const mt = G.muzzleT;
    const scale = 1 + mt * 0.12;
    const lZ = -0.5 + mt * 0.2;
    const lRot = mt * 0.4;

    G.gun.scale.setScalar(1); G.gun.position.z = -0.5; G.gun.rotation.x = 0;
    G.rocketGun.scale.setScalar(1); G.rocketGun.position.z = -0.5; G.rocketGun.rotation.x = 0;
    G.instagibGun.scale.setScalar(1); G.instagibGun.position.z = -0.5; G.instagibGun.rotation.x = 0;

    const pM = G.playerModel.userData;
    if (pM.mirrorGun) { pM.mirrorGun.scale.setScalar(1); pM.mirrorGun.position.z = -0.4; pM.mirrorGun.rotation.x = 0; }
    if (pM.mirrorRocketGun) { pM.mirrorRocketGun.scale.setScalar(1); pM.mirrorRocketGun.position.z = -0.4; pM.mirrorRocketGun.rotation.x = 0; }
    if (pM.mirrorInstagibGun) { pM.mirrorInstagibGun.scale.setScalar(1); pM.mirrorInstagibGun.position.z = -0.4; pM.mirrorInstagibGun.rotation.x = 0; }

    const aw = G.activeWeapon || 1;
    const actHUD = aw === 1 ? G.gun : (aw === 2 ? G.rocketGun : G.instagibGun);
    const actMir = aw === 1 ? pM.mirrorGun : (aw === 2 ? pM.mirrorRocketGun : pM.mirrorInstagibGun);

    actHUD.scale.setScalar(scale); actHUD.position.z = lZ; actHUD.rotation.x = lRot;
    if (aw === 1 && G.gun.userData.core) G.gun.userData.core.material.emissiveIntensity = 2.2 + mt * 6;
    if (actMir) { actMir.scale.setScalar(1 + mt * 0.12); actMir.position.z = -0.4 + mt * 0.15; actMir.rotation.x = mt * 0.3; }

    for (let i = G.activeBeams.length - 1; i >= 0; i--) {
      const b = G.activeBeams[i];
      b.life -= dt;
      if (b.life <= 0) {
        G.scene.remove(b.coreMesh); G.scene.remove(b.hMesh); G.scene.remove(b.points);
        b.coreMesh.material.dispose(); b.hMesh.material.dispose(); b.points.material.dispose();
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
        pos[j*3] += b.vel[j].x * dt;
        pos[j*3+1] += b.vel[j].y * dt;
        pos[j*3+2] += b.vel[j].z * dt;
      }
      b.points.geometry.attributes.position.needsUpdate = true;
    }

    for (let i = G.rockets.length - 1; i >= 0; i--) {
      const r = G.rockets[i];
      r.life -= dt;
      const step = r.vel.clone().multiplyScalar(dt);

      let teleported = false;
      for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
         if (teleported) break;
         const offset = pairIdx * 2;
         if (G.portals[offset].placed && G.portals[offset+1].placed) {
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
                  if (du <= PORT.hw - 0.2 && dv <= PORT.hh - 0.2) {
                     const R = idx === 0 ? G.R_AB[pairIdx] : G.R_BA[pairIdx];
                     r.vel.applyMatrix4(R);
                     const rel = new V3(cx, cy, cz).sub(P.c).applyMatrix4(R);
                     r.pos.copy(Q.c).add(rel).addScaledVector(r.vel, dt * (1 - t));
                     r.mesh.quaternion.setFromRotationMatrix(R).multiply(r.mesh.quaternion);
                     teleported = true;
                     break;
                  }
               }
            }
         }
      }

      if (!teleported) {
        const hit = G.raycast(r.pos, r.vel.clone().normalize(), step.length(), 0.0);
        if (hit || r.life <= 0) {
          G.explosion(hit ? hit.point : r.pos, r.isLocal);
          if (hit) G.destroyWall(hit.obb, hit.point, hit.normal);
          G.scene.remove(r.mesh);
          r.mesh.traverse(o => { if(o.material) o.material.dispose(); if(o.geometry) o.geometry.dispose(); });
          G.rockets.splice(i, 1);
          continue;
        }
        r.pos.add(step);
      }
      r.mesh.position.copy(r.pos);

      // Use pre-allocated smoke pool slot (avoids new Mesh+Geometry+Material every frame)
      const _ss = G._acquireSmoke();
      if (_ss) {
        _ss.mesh.position.copy(r.pos);
        _ss.mesh.rotation.set(Math.random(), Math.random(), Math.random());
        _ss.mesh.scale.setScalar(1.5);
        _ss.mesh.material.opacity = 0.4;
        G.animObjects.push({ type: 'smoke', obj: _ss.mesh, slot: _ss, life: 1.0 });
      }
    }

    G.updateLocalView(dt, now);

    for (const c of G.grabCubes) {
       if (c === G.grabbedCube) {
          const t = new V3(0.5, -0.4, -1.2).applyQuaternion(G.camera.quaternion);
          const wantPos = G.camera.position.clone().add(t);
          if (c.pos.distanceTo(wantPos) > 5.0) c.pos.copy(wantPos); // snap if teleported
          else c.pos.lerp(wantPos, dt * 15);
          c.vel.set(0, 0, 0);
          const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(dt * 2, dt * 3, 0));
          c.quat.multiply(qSpin);
       } else {
          c.vel.y -= CFG.G * dt;
          const step = c.vel.clone().multiplyScalar(dt);

          const teleported = G.physics.teleportCube(c, dt, G.portals, G.R_AB, G.R_BA);
          if (!teleported) {
             c.pos.add(step);
             G.collideCube(c, c.rad);
             if (c.vel.lengthSq() < 0.001) {
                c.vel.set(0, 0, 0); // sleep when very slow
                c.rotVel.multiplyScalar(0.8);
                const eu = new TH.Euler().setFromQuaternion(c.quat);
                const snap = Math.PI / 2;
                c.rotVel.x += (Math.round(eu.x / snap) * snap - eu.x) * dt * 30;
                c.rotVel.y += (Math.round(eu.y / snap) * snap - eu.y) * dt * 30;
                c.rotVel.z += (Math.round(eu.z / snap) * snap - eu.z) * dt * 30;
             }

             const qSpin = new TH.Quaternion().setFromEuler(new TH.Euler(c.rotVel.x * dt, c.rotVel.y * dt, c.rotVel.z * dt));
             c.quat.multiply(qSpin);
          }
       }
    }

    if (G.instCubeMesh) {
      G.resolveCubeCollisions();
      // Update mesh positions again after resolution
      const dummy = new TH.Object3D();
      for (const c of G.grabCubes) {
         dummy.position.copy(c.pos);
         dummy.quaternion.copy(c.quat);
         dummy.updateMatrix();
         G.instCubeMesh.setMatrixAt(c.id, dummy.matrix);
         G.instCubeEdges.setMatrixAt(c.id, dummy.matrix);
      }
      G.instCubeMesh.instanceMatrix.needsUpdate = true;
      G.instCubeEdges.instanceMatrix.needsUpdate = true;
    }

    for (let i = 0; i < 4; i++) {
       const P = G.portals[i];
       const sp = G.sparkles[i];
       if (!sp.mesh.visible) continue;

       let scl;
       if (P.closing) {
           // Closing: inverse of the opening bounce — same 0.5 s duration
           // and wobble, collapsing to zero.
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
           // overshoot elastic bounce
           if (age < 0.5) {
               const t = age / 0.5;
               scl = 1.0 + Math.sin(t * Math.PI * 3.0) * (1.0 - t) * 0.3;
           } else {
               scl = 1.0 + Math.sin(age * 3.0) * 0.02; // breathing
           }
       }

       G.quads[i].scale.setScalar(scl);
       G.frames[i].scale.set((PORT.hw + 0.05) * scl, (PORT.hh + 0.05) * scl, 1);
       G.glowLights[i].intensity = 5.0 * scl;

       for (let j = 0; j < 100; j++) {
          if (sp.life[j] <= 0) {
             if (Math.random() < 0.2) {
                const ang = Math.random() * Math.PI * 2;
                const ex = Math.cos(ang) * PORT.hw;
                const ey = Math.sin(ang) * PORT.hh;
                sp.pos[j*3] = ex; sp.pos[j*3+1] = ey; sp.pos[j*3+2] = (Math.random() - 0.5) * 0.2;
                sp.vel[j].set(ex, ey, 0).normalize().multiplyScalar(Math.random() * 2.0 + 1.0);
                sp.vel[j].z = (Math.random() - 0.5) * 3.0;
                sp.life[j] = 0.5 + Math.random() * 1.0;
             }
          } else {
             sp.life[j] -= dt * 1.2;
             sp.pos[j*3] += sp.vel[j].x * dt;
             sp.pos[j*3+1] += sp.vel[j].y * dt;
             sp.pos[j*3+2] += sp.vel[j].z * dt;
          }
       }
       sp.mesh.geometry.attributes.position.needsUpdate = true;
       sp.mesh.geometry.attributes.life.needsUpdate = true;
    }

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
           a.obj.material.dispose(); a.obj.geometry.dispose();
           G.animObjects.splice(i, 1);
        } else {
           a.obj.scale.setScalar(1 + (1 - a.life) * 1.5);
           a.obj.material.opacity = Math.max(0, a.life);
        }
      } else if (a.type === 'smoke') {
        a.life -= dt * 2.5;
        if (a.life <= 0) {
           G._releaseSmoke(a.slot); // return to pool — no scene.remove/dispose needed
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
           G._ibPool.release(a.slot);
           G.animObjects.splice(i, 1);
        } else {
           a.core.material.opacity = a.life;
           a.glow.material.opacity = a.life * 0.6;
           a.points.material.opacity = a.life;
           const posAttr = a.points.geometry.attributes.position;
           for (let j = 0; j < a.pCount; j++) {
             posAttr.array[j*3] += a.vel[j].x * dt;
             posAttr.array[j*3+1] += a.vel[j].y * dt;
             posAttr.array[j*3+2] += a.vel[j].z * dt;
             a.vel[j].multiplyScalar(0.9);
           }
           posAttr.needsUpdate = true;
        }
      } else if (a.type === 'scorch') {
        a.life -= dt;
        if (a.life <= 0) {
           a.obj.visible = false;
           G._scorchPool.release(a.slot);
           G.animObjects.splice(i, 1);
        } else {
           a.obj.material.opacity = a.life < G.SCORCH_FADE ? a.life / G.SCORCH_FADE : 1;
        }
      } else if (a.type === 'gib') {
        a.life -= dt;
        if (a.life <= 0) {
           a.obj.visible = false;
           G._gibPool.release(a.slot);
           G.animObjects.splice(i, 1);
        } else {
           a.vel.y -= 25.0 * dt; // gravity CFG.G is usually ~25
           a.obj.position.addScaledVector(a.vel, dt);
           if (a.obj.position.y < 0.15 && a.vel.y < 0) {
              a.obj.position.y = 0.15;
              a.vel.y *= -0.6;
              a.vel.x *= 0.8;
              a.vel.z *= 0.8;
           }
           if (a.life < 1.5) {
              a.obj.material.opacity = a.life / 1.5;
              a.obj.scale.setScalar(0.5 + (a.life / 3.0) * 0.5);
           }
        }
      } else if (a.type === 'debris') {
        a.life -= dt;
        if (a.life <= 0) {
           G.scene.remove(a.obj);
           a.obj.traverse(o => { if (o.geometry) o.geometry.dispose(); });
           G.animObjects.splice(i, 1);
        } else {
           a.vel.y -= CFG.G * dt; // Gravity
           a.obj.position.addScaledVector(a.vel, dt);
           a.obj.rotation.x += a.rot.x * dt;
           a.obj.rotation.y += a.rot.y * dt;
           a.obj.rotation.z += a.rot.z * dt;

           // Floor bounce
           if (a.obj.position.y < -0.1 && a.vel.y < 0) {
              a.obj.position.y = -0.1;
              a.vel.y *= -0.5;
              a.vel.x *= 0.6;
              a.vel.z *= 0.6;
              a.rot.multiplyScalar(0.5);
           }

           // Fade out at end
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

    let msg = '';
    if (G.match && G.match.phase === 'warmup') {
      msg = G.localReady ? 'READY — WAITING FOR OPPONENT' : 'PRESS R TO READY UP';
    } else if (G.match && G.match.phase === 'waiting' && Object.keys(G.match.players).length < 2) {
      msg = 'WAITING FOR OPPONENT — PRESS R WHEN READY';
    }
    if (!msg) {
      for (const h of G.hintZones) {
         if (G.pl.pos.x >= h.min.x && G.pl.pos.x <= h.max.x && G.pl.pos.y >= h.min.y && G.pl.pos.y <= h.max.y && G.pl.pos.z >= h.min.z && G.pl.pos.z <= h.max.z) {
            msg = h.msg;
            break;
         }
      }
    }
    G.camera.updateMatrixWorld(true);
    const aimDir = new V3(0, 0, -1).applyQuaternion(G.camera.quaternion).normalize();
    const hit = G.raycast(G.camera.getWorldPosition(new V3()), aimDir, 140);

    G.updateHUD({ pl: G.pl, CFG, currentSeed: G.currentSeed, hit, msg: !G.isConnected ? "RECONNECTING..." : msg, match: G.match, localReady: G.localReady, localIndex: G.localPlayerIndex, statsOpen: G.statsOpen, localPid: G.localPlayerId });
    G.skyGroup.position.copy(G.camera.position);
    G.updateSky(G.nowT);
    G.renderer.setRenderTarget(null);
    G.renderer.render(G.scene, G.camera);
  }

  window.addEventListener('resize', () => {
    G.renderer.setSize(innerWidth, innerHeight);
    G.camera.aspect = innerWidth / innerHeight; G.camera.updateProjectionMatrix();
    G.makeRTs();
  });

  function start() {
    /* first map (preview behind menu) — loadMap() runs the renderer pre-warm */
    G.loadMap(String(Math.floor(Math.random() * 1e9)));
    requestAnimationFrame(frame);
  }

  return { start };
}
