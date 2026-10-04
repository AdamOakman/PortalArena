export function initPhysics(TH, CFG, PORT) {
  const V3 = TH.Vector3;

  function wishDir(keys, yaw) {
    const f = (keys.KeyW ? 1 : 0) - (keys.KeyS ? 1 : 0);
    const s = (keys.KeyD ? 1 : 0) - (keys.KeyA ? 1 : 0);
    if (!f && !s) return null;
    const fwd = new V3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new V3(-fwd.z, 0, fwd.x);
    const w = fwd.multiplyScalar(f).add(right.multiplyScalar(s));
    if (w.lengthSq() < 1e-6) return null;
    return w.normalize();
  }

  function accelerate(v, wish, acc, maxs, dt) {
    if (!wish) return;
    const cur = v.dot(wish);
    const add = Math.max(0, maxs - cur);
    if (add <= 0) return;
    v.addScaledVector(wish, Math.min(add, acc * dt));
  }

  function applyFriction(pl, dt) {
    if (!pl.grounded) return;
    const speed = Math.hypot(pl.vel.x, pl.vel.z);
    if (speed < 0.02) { pl.vel.x = 0; pl.vel.z = 0; return; }
    // Slopes use gentler friction so a downhill slide settles at a real
    // terminal speed (G*sin(theta)/SLOPE_FR) instead of running away; flat
    // ground keeps the strong FR for snappy stops.
    const fr = pl.groundNormal.y < 0.99 ? CFG.SLOPE_FR : CFG.FR;
    const drop = Math.max(speed, CFG.WALK) * fr * dt;
    const f = Math.max(0, speed - drop) / speed;
    pl.vel.x *= f; pl.vel.z *= f;
  }

  function playerHeight(crouchT) {
    return CFG.H - (CFG.H - CFG.CROUCH_H) * (crouchT || 0);
  }

  function capsuleSamples(pos, crouchT) {
    const h = playerHeight(crouchT);
    return [pos.y + CFG.R, pos.y + h * 0.5, pos.y + h - CFG.R];
  }

  function collide(pl, obbs, portals, grabCubes, grabbedCube, events) {
    pl.grounded = false;
    const p = pl.pos;
    const hs = capsuleSamples(p, pl.crouchT);
    for (const obb of obbs) {
      if ((p.x - obb.c.x) ** 2 + (p.y - obb.c.y) ** 2 + (p.z - obb.c.z) ** 2 > obb.rad * obb.rad) continue;
      for (let si = 0; si < 3; si++) {
        const sy = hs[si];
        const dx = p.x - obb.c.x, dy = sy - obb.c.y, dz = p.z - obb.c.z;
        const lc = [dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z,
                    dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z,
                    dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z];
        const inside = Math.abs(lc[0]) < obb.he[0] && Math.abs(lc[1]) < obb.he[1] && Math.abs(lc[2]) < obb.he[2];
        let n, depth;
        if (inside) {
          let kBest = 0, best = -Infinity;
          for (let k = 0; k < 3; k++) { const over = Math.abs(lc[k]) - obb.he[k]; if (over > best) { best = over; kBest = k; } }
          n = obb.ax[kBest].clone().multiplyScalar(Math.sign(lc[kBest]) || 1);
          depth = obb.he[kBest] - Math.abs(lc[kBest]) + CFG.R;
        } else {
          const q = new V3();
          for (let k = 0; k < 3; k++) q.addScaledVector(obb.ax[k], Math.max(-obb.he[k], Math.min(obb.he[k], lc[k])));
          const cp = obb.c.clone().add(q);
          const dvec = new V3(p.x - cp.x, sy - cp.y, p.z - cp.z);
          const dist = dvec.length();
          if (dist >= CFG.R || dist < 1e-7) continue;
          n = dvec.divideScalar(dist);
          depth = CFG.R - dist;
        }
        
        let hole = false;
        for (let i = 0; i < portals.length; i += 2) {
          if (!portals[i].placed || !portals[i+1].placed) continue;
          for (const P of [portals[i], portals[i+1]]) {
            if (Math.abs(n.dot(P.n)) < 0.8) continue;
            const du = Math.abs((p.x - P.c.x) * P.r.x + (sy - P.c.y) * P.r.y + (p.z - P.c.z) * P.r.z);
            const dv = Math.abs((p.x - P.c.x) * P.u.x + (sy - P.c.y) * P.u.y + (p.z - P.c.z) * P.u.z);
            const dn = Math.abs((p.x - P.c.x) * P.n.x + (sy - P.c.y) * P.n.y + (p.z - P.c.z) * P.n.z);
            if (du < PORT.hw - 0.12 && dv < PORT.hh - 0.12 && dn < 2.2) { hole = true; break; }
          }
          if (hole) break;
        }
        if (hole) continue;
        if (obb.kind === 'jumppad') {
          pl.vel.y = 38;
          pl.grounded = false;
          if (events && events.onJumppad) events.onJumppad();
          continue;
        }
        
        p.addScaledVector(n, depth + 0.0005);
        const vn = pl.vel.dot(n);
        if (vn < 0) {
          const oldSpd = pl.vel.length();
          pl.vel.addScaledVector(n, -vn);
          // Slopes (8°..84° from horizontal) always preserve the player's
          // momentum so ramps can be walked up at any speed — no running start.
          if (n.y > 0.1 && n.y < 0.99) {
            const newSpd = pl.vel.length();
            if (newSpd > 0.001) pl.vel.multiplyScalar(oldSpd / newSpd);
          }
        }
        if (n.y > 0.5) {
          if (!pl.grounded && vn < -6 && events && events.onLand) events.onLand(Math.min(1, -vn / 24));
          pl.grounded = true;
          pl.groundNormal.copy(n);
        }
      }
    }

    for (const c of grabCubes) {
      if (c === grabbedCube) continue;
      if (Math.abs(p.x - c.pos.x) > 2.0 || Math.abs(p.z - c.pos.z) > 2.0 || Math.abs(p.y - c.pos.y) > 3.0) continue;
      for (let si = 0; si < 3; si++) {
        const sy = hs[si];
        const dx = p.x - c.pos.x, dy = sy - c.pos.y, dz = p.z - c.pos.z;
        if (Math.abs(dx) < 0.75 && Math.abs(dy) < 0.75 && Math.abs(dz) < 0.75) {
            const ox = 0.75 - Math.abs(dx) + CFG.R, oy = 0.75 - Math.abs(dy) + CFG.R, oz = 0.75 - Math.abs(dz) + CFG.R;
            let n = new V3(0, 1, 0), depth = oy;
            if (ox < oy && ox < oz) { n.set(Math.sign(dx)||1, 0, 0); depth = ox; }
            else if (oz < oy) { n.set(0, 0, Math.sign(dz)||1); depth = oz; }
            else { n.set(0, Math.sign(dy)||1, 0); }
            p.addScaledVector(n, depth + 0.0005);
            const vn = pl.vel.dot(n);
            if (vn < 0) pl.vel.addScaledVector(n, -vn);
            if (n.y > 0.5) {
              if (!pl.grounded && vn < -6 && events && events.onLand) events.onLand(Math.min(1, -vn/24));
              pl.grounded = true; pl.groundNormal.copy(n);
            }
        } else {
            const cx = Math.max(-0.75, Math.min(0.75, dx));
            const cy = Math.max(-0.75, Math.min(0.75, dy));
            const cz = Math.max(-0.75, Math.min(0.75, dz));
            const dvec = new V3(dx - cx, dy - cy, dz - cz);
            const dist = dvec.length();
            if (dist >= CFG.R || dist < 1e-7) continue;
            const n = dvec.divideScalar(dist);
            p.addScaledVector(n, CFG.R - dist + 0.0005);
            const vn = pl.vel.dot(n);
            if (vn < 0) pl.vel.addScaledVector(n, -vn);
            if (n.y > 0.5) {
              if (!pl.grounded && vn < -6 && events && events.onLand) events.onLand(Math.min(1, -vn/24));
              pl.grounded = true; pl.groundNormal.copy(n);
            }
        }
      }
    }
  }

  function teleportCheck(pl, prevCamPos, dt, p0, p1, R_AB, R_BA, tpState, events) {
    
    if (!(p0.placed && p1.placed)) return;
    const camPosNow = new V3(pl.pos.x, pl.pos.y + playerHeight(pl.crouchT) - 0.12, pl.pos.z);
    for (let pi = 0; pi < 2; pi++) {
      const P = pi === 0 ? p0 : p1, Q = pi === 0 ? p1 : p0;
      if (tpState.tpGracePortal === P && tpState.nowT - tpState.tpGraceT < 0.12) continue;
      
      const a = (prevCamPos.x - P.c.x) * P.n.x + (prevCamPos.y - P.c.y) * P.n.y + (prevCamPos.z - P.c.z) * P.n.z;
      const b = (camPosNow.x - P.c.x) * P.n.x + (camPosNow.y - P.c.y) * P.n.y + (camPosNow.z - P.c.z) * P.n.z;
      
      if ((a > 0) !== (b > 0)) {
        const t = Math.max(0, Math.min(1, a / (a - b)));
        const cx = prevCamPos.x + (camPosNow.x - prevCamPos.x) * t;
        const cy = prevCamPos.y + (camPosNow.y - prevCamPos.y) * t;
        const cz = prevCamPos.z + (camPosNow.z - prevCamPos.z) * t;
        
        const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
        const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
        if (du <= PORT.hw - 0.05 && dv <= PORT.hh - 0.05) {
          doTeleport(pl, pi === 0 ? R_AB : R_BA, P, Q, t, dt, tpState, events);
          return;
        }
      }
    }
  }

  function doTeleport(pl, R, P, Q, t, dt, tpState, events) {
    pl.vel.applyMatrix4(R);

    const eyeOffset = new V3(0, playerHeight(pl.crouchT) - 0.12, 0);
    const camPos = new V3().addVectors(pl.pos, eyeOffset);
    const relCam = new V3().subVectors(camPos, P.c).applyMatrix4(R);
    pl.pos.copy(Q.c).add(relCam).sub(eyeOffset);
    
    const baseQ = new TH.Quaternion().setFromEuler(new TH.Euler(pl.pitch, pl.yaw, 0, 'YXZ'));
    if (pl.viewOffset) baseQ.multiply(pl.viewOffset);
    
    const R_quat = new TH.Quaternion().setFromRotationMatrix(R);
    const Q_new = R_quat.multiply(baseQ);
    
    const playerUp = new V3(0, 1, 0).applyMatrix4(R);
    if (playerUp.y > 0.99) {
       const e = new TH.Euler().setFromQuaternion(Q_new, 'YXZ');
       pl.pitch = e.x;
       pl.yaw = e.y;
       pl.viewOffset = null;
    } else {
       const fwd = new V3(0, 0, -1).applyQuaternion(Q_new);
       pl.yaw = Math.atan2(-fwd.x, -fwd.z);
       pl.pitch = 0;
       const targetBaseQ = new TH.Quaternion().setFromEuler(new TH.Euler(pl.pitch, pl.yaw, 0, 'YXZ'));
       pl.viewOffset = targetBaseQ.invert().multiply(Q_new);
    }

    tpState.tpGracePortal = Q;
    tpState.tpGraceT = tpState.nowT;
    if (events && events.onTeleport) events.onTeleport();
  }

  function physStep(pl, keys, autohop, dt, obbs, portals, grabCubes, grabbedCube, tpState, events) {
    if (pl.grounded) pl.groundT = tpState.nowT;
    const wish = wishDir(keys, pl.yaw);
    applyFriction(pl, dt);
    const wantWalk = keys.ShiftLeft || keys.ShiftRight;
    const crouchScale = 1 - (pl.crouchT || 0) * 0.5;
    if (pl.grounded) accelerate(pl.vel, wish, CFG.GACC, (wantWalk ? CFG.WALK : CFG.GMAX) * crouchScale, dt);
    else if (wish) {
      accelerate(pl.vel, wish, CFG.AACC, CFG.AIRCAP, dt);
      if (!keys.KeyA && !keys.KeyD && (keys.KeyW || keys.KeyS)) {
        const speed = Math.hypot(pl.vel.x, pl.vel.z);
        if (speed > 1.0) {
          const vDir = new V3(pl.vel.x, 0, pl.vel.z).normalize();
          const dot = vDir.dot(wish);
          if (dot > 0) {
            vDir.lerp(wish, 4.0 * dt).normalize();
            pl.vel.x = vDir.x * speed;
            pl.vel.z = vDir.z * speed;
          }
        }
      }
    }

    const canJump = pl.grounded || (tpState.nowT - pl.groundT) < CFG.COYOTE;
    const buffered = pl.jumpBuf >= 0 && (tpState.nowT - pl.jumpBuf) < CFG.BUFFER;
    const holdJump = autohop && keys.Space && pl.grounded;
    if ((buffered || holdJump) && canJump) {
      pl.vel.y = Math.max(pl.vel.y, CFG.JUMPV);
      pl.grounded = false; pl.groundT = -1; pl.jumpBuf = -1;
      if (events && events.onJump) events.onJump();
    }

    pl.vel.y -= CFG.G * dt;
    if (pl.vel.y < -60) pl.vel.y = -60;

    const curH = playerHeight(pl.crouchT);
    const prevCamPos = new V3(pl.pos.x, pl.pos.y + curH - 0.12, pl.pos.z);
    pl.pos.addScaledVector(pl.vel, dt);
    collide(pl, obbs, portals, grabCubes, grabbedCube, events);
    
    teleportCheck(pl, prevCamPos, dt, portals[0], portals[1], tpState.R_AB[0], tpState.R_BA[0], tpState, events);
    if (portals.length > 2) {
      teleportCheck(pl, prevCamPos, dt, portals[2], portals[3], tpState.R_AB[1], tpState.R_BA[1], tpState, events);
    }


    const sp = Math.hypot(pl.vel.x, pl.vel.z);
    if (sp > pl.maxSpeed) pl.maxSpeed = sp;
  }

  function collideCube(c, obbs, portals, radius) {
    for (const obb of obbs) {
      if ((c.pos.x - obb.c.x)**2 + (c.pos.y - obb.c.y)**2 + (c.pos.z - obb.c.z)**2 > (obb.rad + radius)**2) continue;
      const dx = c.pos.x - obb.c.x, dy = c.pos.y - obb.c.y, dz = c.pos.z - obb.c.z;
      const lc = [dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z,
                  dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z,
                  dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z];
      const inside = Math.abs(lc[0]) < obb.he[0] && Math.abs(lc[1]) < obb.he[1] && Math.abs(lc[2]) < obb.he[2];
      let n, depth;
      if (inside) {
        let kBest = 0, best = -Infinity;
        for (let k = 0; k < 3; k++) { const over = Math.abs(lc[k]) - obb.he[k]; if (over > best) { best = over; kBest = k; } }
        n = obb.ax[kBest].clone().multiplyScalar(Math.sign(lc[kBest]) || 1);
        depth = obb.he[kBest] - Math.abs(lc[kBest]) + radius;
      } else {
        const q = new V3();
        for (let k = 0; k < 3; k++) q.addScaledVector(obb.ax[k], Math.max(-obb.he[k], Math.min(obb.he[k], lc[k])));
        const cp = obb.c.clone().add(q);
        const dvec = new V3(c.pos.x - cp.x, c.pos.y - cp.y, c.pos.z - cp.z);
        const dist = dvec.length();
        if (dist >= radius || dist < 1e-7) continue;
        n = dvec.divideScalar(dist);
        depth = radius - dist;
      }
      
      let hole = false;
      for (let i = 0; i < portals.length; i += 2) {
        if (!portals[i].placed || !portals[i+1].placed) continue;
        for (const P of [portals[i], portals[i+1]]) {
          if (Math.abs(n.dot(P.n)) < 0.8) continue;
          const du = Math.abs((c.pos.x - P.c.x) * P.r.x + (c.pos.y - P.c.y) * P.r.y + (c.pos.z - P.c.z) * P.r.z);
          const dv = Math.abs((c.pos.x - P.c.x) * P.u.x + (c.pos.y - P.c.y) * P.u.y + (c.pos.z - P.c.z) * P.u.z);
          const dn = Math.abs((c.pos.x - P.c.x) * P.n.x + (c.pos.y - P.c.y) * P.n.y + (c.pos.z - P.c.z) * P.n.z);
          if (du < PORT.hw && dv < PORT.hh && dn < 2.2) { hole = true; break; }
        }
        if (hole) break;
      }
      if (hole) continue;
      
      c.pos.addScaledVector(n, depth + 0.001);
      const vn = c.vel.dot(n);
      if (vn < 0) {
        c.vel.addScaledVector(n, -vn * 1.5);
        c.vel.x *= 0.8; c.vel.z *= 0.8;
      }
    }
  }

  function resolveCubeCollisions(grabCubes, grabbedCube) {
    const cDia = 1.5;
    const len = grabCubes.length;
    const MAX_ITER = 10;
    for (let iter = 0; iter < MAX_ITER; iter++) {
      for (let i = 0; i < len; i++) {
        const cA = grabCubes[i];
        for (let j = i + 1; j < len; j++) {
          const cB = grabCubes[j];
          const dx = cB.pos.x - cA.pos.x;
          if (Math.abs(dx) > cDia - 0.001) continue;
          const dy = cB.pos.y - cA.pos.y;
          if (Math.abs(dy) > cDia - 0.001) continue;
          const dz = cB.pos.z - cA.pos.z;
          if (Math.abs(dz) > cDia - 0.001) continue;
          
          const ox = cDia - Math.abs(dx);
          const oy = cDia - Math.abs(dy);
          const oz = cDia - Math.abs(dz);
          
          let nx = 0, ny = 0, nz = 0, push;
          if (ox < oy && ox < oz) { nx = Math.sign(dx)||1; push = ox; }
          else if (oz < oy) { nz = Math.sign(dz)||1; push = oz; }
          else { ny = Math.sign(dy)||1; push = oy; }
          
          const aGrab = (cA === grabbedCube), bGrab = (cB === grabbedCube);
          if (aGrab && bGrab) continue;
          
          let pushA = aGrab ? 0 : (bGrab ? push : push * 0.5);
          let pushB = bGrab ? 0 : (aGrab ? push : push * 0.5);
          if (!aGrab && !bGrab) {
             if (ny > 0) { pushA = 0; pushB = push; }
             else if (ny < 0) { pushA = push; pushB = 0; }
          }
          
          cA.pos.x -= nx * pushA; cA.pos.y -= ny * pushA; cA.pos.z -= nz * pushA;
          cB.pos.x += nx * pushB; cB.pos.y += ny * pushB; cB.pos.z += nz * pushB;
          
          if (iter === MAX_ITER - 1) {
             const rvx = cB.vel.x - cA.vel.x;
             const rvy = cB.vel.y - cA.vel.y;
             const rvz = cB.vel.z - cA.vel.z;
             const velAlong = rvx*nx + rvy*ny + rvz*nz;
             if (velAlong < 0) {
               let jA = -(1.2) * velAlong / ((aGrab ? 0 : 1) + (bGrab ? 0 : 1));
               let jB = jA;
               if (!aGrab && !bGrab) {
                  if (ny > 0) { jA = 0; jB = -(1.2) * velAlong; }
                  else if (ny < 0) { jA = -(1.2) * velAlong; jB = 0; }
               }
               if (!aGrab) { cA.vel.x -= nx * jA; cA.vel.y -= ny * jA; cA.vel.z -= nz * jA; }
               if (!bGrab) { cB.vel.x += nx * jB; cB.vel.y += ny * jB; cB.vel.z += nz * jB; }
             }
             if (Math.abs(ny) > 0.5) {
                cA.vel.x = cA.vel.x * 0.9 + cB.vel.x * 0.1;
                cB.vel.x = cB.vel.x * 0.9 + cA.vel.x * 0.1;
                cA.vel.z = cA.vel.z * 0.9 + cB.vel.z * 0.1;
                cB.vel.z = cB.vel.z * 0.9 + cA.vel.z * 0.1;
             }
          }
        }
      }
    }
  }

  function raycast(origin, dir, maxDist, obbs, minDist = 0.02) {
    let best = null, bestT = maxDist;
    for (const obb of obbs) {
      if (origin.distanceTo(obb.c) - obb.rad > maxDist) continue;
      const ox = origin.x - obb.c.x, oy = origin.y - obb.c.y, oz = origin.z - obb.c.z;
      let tmin = -1e9, tmax = 1e9, hitAxis = -1, hitSign = 0, par = false;
      for (let k = 0; k < 3; k++) {
        const a = obb.ax[k];
        const o = ox * a.x + oy * a.y + oz * a.z;
        const vd = dir.dot(a);
        if (Math.abs(vd) < 1e-7) {
          if (Math.abs(o) > obb.he[k]) { par = true; break; }
        } else {
          let t0 = (-obb.he[k] - o) / vd, t1 = (obb.he[k] - o) / vd;
          if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
          if (t0 > tmin) { tmin = t0; hitAxis = k; hitSign = Math.sign(vd); }
          if (t1 < tmax) tmax = t1;
          if (tmin > tmax) { par = true; break; }
        }
      }
      if (par || hitAxis < 0 || tmax < minDist) continue;
      if (tmin < 0) tmin = 0; // Ray origin is inside the OBB
      if (tmin < minDist || tmin > bestT) continue;
      
      const point = origin.clone().addScaledVector(dir, tmin);
      const normal = obb.ax[hitAxis].clone().multiplyScalar(-hitSign);
      best = { point, normal, obb, distance: tmin }; bestT = tmin;
    }
    return best;
  }

  function teleportCube(c, dt, portals, R_AB, R_BA) {
    let teleported = false;
    const step = c.vel.clone().multiplyScalar(dt);
    for (let pairIdx = 0; pairIdx < 2; pairIdx++) {
      if (teleported) break;
      const offset = pairIdx * 2;
      if (portals[offset].placed && portals[offset+1].placed) {
        const nextPos = c.pos.clone().add(step);
        for (let idx = 0; idx < 2; idx++) {
          const pi = offset + idx;
          const P = portals[pi], Q = portals[offset + (1 - idx)];
          const a = (c.pos.x - P.c.x) * P.n.x + (c.pos.y - P.c.y) * P.n.y + (c.pos.z - P.c.z) * P.n.z;
          const b = (nextPos.x - P.c.x) * P.n.x + (nextPos.y - P.c.y) * P.n.y + (nextPos.z - P.c.z) * P.n.z;
          if ((a > 0) !== (b > 0)) {
            const t = Math.max(0, Math.min(1, a / (a - b)));
            const cx = c.pos.x + (nextPos.x - c.pos.x) * t;
            const cy = c.pos.y + (nextPos.y - c.pos.y) * t;
            const cz = c.pos.z + (nextPos.z - c.pos.z) * t;
            const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
            const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
            if (du <= PORT.hw && dv <= PORT.hh) {
              const R = idx === 0 ? R_AB[pairIdx] : R_BA[pairIdx];
              c.vel.applyMatrix4(R);
              const rel = new V3(cx, cy, cz).sub(P.c).applyMatrix4(R);
              c.pos.copy(Q.c).add(rel).addScaledVector(c.vel, dt * (1 - t));
              teleported = true;
              break;
            }
          }
        }
      }
    }
    return teleported;
  }

  return {
    physStep,
    collideCube,
    resolveCubeCollisions,
    raycast,
    teleportCube
  };
}














