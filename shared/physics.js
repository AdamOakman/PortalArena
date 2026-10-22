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
    // A slope is any grounded face more than ~8° from horizontal. Slopes use
    // gentler friction so a downhill slide settles at a real terminal speed
    // (G*sin(theta)/SLOPE_FR); flat ground keeps the strong FR for snappy
    // stops. The WALK stop floor applies only on flat ground — on slopes the
    // stop is SLOPE_STOP so slow slides stay sustainable. On a slope the full
    // 3-D tangential velocity is damped (it carries a y component); on flat
    // ground y is 0 while grounded, so damping x/z is exact there.
    const isSlope = pl.groundNormal.y < 0.99;
    const fr = isSlope ? CFG.SLOPE_FR : CFG.FR;
    const stop = isSlope ? CFG.SLOPE_STOP : CFG.WALK;
    const v = pl.vel;
    const speed = isSlope ? v.length() : Math.hypot(v.x, v.z);
    if (speed < 0.02) { v.x = 0; v.z = 0; if (isSlope) v.y = 0; return; }
    const drop = Math.max(speed, stop) * fr * dt;
    const f = Math.max(0, speed - drop) / speed;
    v.x *= f; v.z *= f;
    if (isSlope) v.y *= f;
  }

  function playerHeight(crouchT) {
    return CFG.H - (CFG.H - CFG.CROUCH_H) * (crouchT || 0);
  }

  function capsuleSamples(pos, crouchT) {
    const h = playerHeight(crouchT);
    return [pos.y + CFG.R, pos.y + h * 0.5, pos.y + h - CFG.R];
  }

  function smootherstep(u) {
    return u * u * u * (u * (u * 6 - 15) + 10);
  }

  function smootherstepDeriv(u) {
    return 30 * u * u * (1 - u) * (1 - u);
  }

  function findUForSmootherstep(target) {
    if (target <= 0) return 0;
    if (target >= 1) return 1;
    let lo = 0, hi = 1;
    for (let it = 0; it < 5; it++) {
      const mid = (lo + hi) * 0.5;
      const sm = mid * mid * mid * (mid * (mid * 6 - 15) + 10);
      if (sm < target) lo = mid;
      else hi = mid;
    }
    return (lo + hi) * 0.5;
  }

  function collidePlayerWithRamp(pl, obb, events) {
    const ramp = obb.ramp;
    if (!ramp) return;
    const { cx, cz, dir, len, rise, width, y0 } = ramp;
    const T = ramp.T || 0.3;

    let fwdX = 1, fwdZ = 0, rightX = 0, rightZ = 1;
    if (dir === 1) { fwdX = 0; fwdZ = 1; rightX = -1; rightZ = 0; }
    else if (dir === 2) { fwdX = -1; fwdZ = 0; rightX = 0; rightZ = -1; }
    else if (dir === 3) { fwdX = 0; fwdZ = -1; rightX = 1; rightZ = 0; }

    const p = pl.pos;
    const dx = p.x - cx;
    const dz = p.z - cz;
    const s = dx * fwdX + dz * fwdZ;
    const w = dx * rightX + dz * rightZ;

    const hl = len * 0.5;
    const hw = width * 0.5;
    const R = CFG.R;
    const h = playerHeight(pl.crouchT);

    // Broadphase check
    if (s < -hl - R || s > hl + R || Math.abs(w) > hw + R) return;

    // Side collision (player is off the left or right edge of the ramp)
    if (Math.abs(w) > hw) {
      const sC = Math.max(-hl, Math.min(hl, s));
      const u = (sC + hl) / len;
      const yTop = y0 + rise * smootherstep(u);
      const yBot = yTop - T;
      const sideBottomY = (yBot - y0 < 2.2) ? y0 : yBot;
      if (p.y < yTop && p.y + h > sideBottomY) {
        const signW = Math.sign(w) || 1;
        const nx = rightX * signW;
        const nz = rightZ * signW;
        const depth = hw + R - Math.abs(w);
        if (depth > 0) {
          p.x += nx * (depth + 0.0005);
          p.z += nz * (depth + 0.0005);
          const vn = pl.vel.x * nx + pl.vel.z * nz;
          if (vn < 0) {
            pl.vel.x -= nx * vn;
            pl.vel.z -= nz * vn;
          }
        }
      }
      return;
    }

    // Longitudinal bounds check
    if (s < -hl || s > hl) return;

    const u = (s + hl) / len;
    const yTop = y0 + rise * smootherstep(u);
    const yBot = yTop - T;

    const dyDs = (rise / len) * smootherstepDeriv(u);
    const theta = Math.atan2(dyDs, 1);
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    // Top surface normal (pointing up and back along the ramp)
    const nxTop = -fwdX * sinTheta;
    const nyTop = cosTheta;
    const nzTop = -fwdZ * sinTheta;

    // Case 1: Player is on top of the ramp (walking / landing)
    if (p.y >= yBot - 0.15) {
      const penY = yTop - p.y;
      if (penY > -0.01) {
        p.y = yTop + 0.0005;

        const vn = pl.vel.x * nxTop + pl.vel.y * nyTop + pl.vel.z * nzTop;
        if (vn < 0 && pl.vel.y < 0) {
          pl.vel.x -= nxTop * vn;
          pl.vel.y -= nyTop * vn;
          pl.vel.z -= nzTop * vn;
        }

        if (!pl.grounded && vn < -6 && events && events.onLand) events.onLand(Math.min(1, -vn / 24));
        pl.grounded = true;
        pl.groundNormal.set(nxTop, nyTop, nzTop);
      } else if (penY >= -0.15 && pl.grounded) {
        p.y = yTop + 0.0005;
        pl.groundNormal.set(nxTop, nyTop, nzTop);
      }
      return;
    }

    // Case 2: Player is UNDERNEATH the ramp
    const yHead = p.y + h;
    if (yHead > yBot) {
      if (pl.vel.y > 0) {
        pl.vel.y = 0;
      }

      // Enforce crouch if standing head would intersect ceiling and player can fit crouched
      const maxAllowedH = yBot - p.y;
      if (maxAllowedH < CFG.H - 0.05 && maxAllowedH >= CFG.CROUCH_H - 0.1) {
        const minRequiredCrouchT = Math.min(1, Math.max(0, (CFG.H - maxAllowedH) / (CFG.H - CFG.CROUCH_H)));
        if ((pl.crouchT || 0) < minRequiredCrouchT) {
          pl.crouchT = minRequiredCrouchT;
        }
      }

      // Recalculate effective height with crouch
      const effH = playerHeight(pl.crouchT);
      const minSafeClearance = Math.max(effH, 1.8);
      const targetS = (p.y + minSafeClearance + T - y0) / rise;
      const uFit = findUForSmootherstep(targetS);
      const sFit = uFit * len - hl;

      // Stop horizontal movement into low-clearance wedge without pushing grounded player into the floor
      if (s < sFit + R) {
        const deltaS = (sFit + R) - s;
        if (deltaS > 0) {
          p.x += fwdX * (deltaS + 0.0005);
          p.z += fwdZ * (deltaS + 0.0005);
          const vfwd = pl.vel.x * fwdX + pl.vel.z * fwdZ;
          if (vfwd < 0) {
            pl.vel.x -= fwdX * vfwd;
            pl.vel.z -= fwdZ * vfwd;
          }
        }
      }

      if (!pl.grounded && p.y > yBot - effH) {
        p.y = yBot - effH - 0.0005;
      }
    }
  }

  function collide(pl, obbs, portals, grabCubes, grabbedCube, events) {
    pl.grounded = false;
    const p = pl.pos;
    const hs = capsuleSamples(p, pl.crouchT);
    const fwdX = -Math.sin(pl.yaw || 0), fwdZ = -Math.cos(pl.yaw || 0);
    const pitchCos = Math.max(0, Math.cos(pl.pitch || 0));
    const weaponLen = CFG.WEAPON_LEN || 1.35;

    for (const obb of obbs) {
      if (obb.kind === 'ramp') {
        collidePlayerWithRamp(pl, obb, events);
        continue;
      }
      const maxR = obb.rad + weaponLen;
      if ((p.x - obb.c.x) ** 2 + (p.y - obb.c.y) ** 2 + (p.z - obb.c.z) ** 2 > maxR * maxR) continue;
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
          let rMargin = CFG.R;
          if (obb.kind === 'wall' && n.y <= 0.1) {
            const hLen = Math.hypot(n.x, n.z);
            if (hLen > 0.001) {
              const facing = -(fwdX * (n.x / hLen) + fwdZ * (n.z / hLen)) * pitchCos;
              if (facing > 0) rMargin += (weaponLen - CFG.R) * facing;
            }
          }
          depth = obb.he[kBest] - Math.abs(lc[kBest]) + rMargin;
        } else {
          const q = new V3();
          for (let k = 0; k < 3; k++) q.addScaledVector(obb.ax[k], Math.max(-obb.he[k], Math.min(obb.he[k], lc[k])));
          const cp = obb.c.clone().add(q);
          const dvec = new V3(p.x - cp.x, sy - cp.y, p.z - cp.z);
          const dist = dvec.length();
          if (dist < 1e-7) continue;
          const candidateN = dvec.clone().divideScalar(dist);
          let rMargin = CFG.R;
          if (obb.kind === 'wall' && candidateN.y <= 0.1) {
            const hLen = Math.hypot(candidateN.x, candidateN.z);
            if (hLen > 0.001) {
              const facing = -(fwdX * (candidateN.x / hLen) + fwdZ * (candidateN.z / hLen)) * pitchCos;
              if (facing > 0) rMargin += (weaponLen - CFG.R) * facing;
            }
          }
          if (dist >= rMargin) continue;
          n = candidateN;
          depth = rMargin - dist;
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
          // Absorb the normal component only: the surface cancels it. The
          // tangential part (including its y component on a slope) survives,
          // so ramps can be walked up at any speed with no running start —
          // and no energy is injected on landing, sliding, or hopping.
          pl.vel.addScaledVector(n, -vn);
        }
        // Any face within 84° of horizontal grounds the player (friction,
        // jumping, coyote time all apply); only near-vertical walls (n.y
        // < 0.1) count as air contacts.
        if (n.y > 0.1) {
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

  function teleportCheck(pl, prevPos, prevCamPos, dt, p0, p1, R_AB, R_BA, tpState, events) {
    if (!(p0.placed && p1.placed)) return;
    const curH = playerHeight(pl.crouchT);
    const camPosNow = new V3(pl.pos.x, pl.pos.y + curH - 0.12, pl.pos.z);
    for (let pi = 0; pi < 2; pi++) {
      const P = pi === 0 ? p0 : p1, Q = pi === 0 ? p1 : p0;
      if (tpState.tpGracePortal === P && tpState.nowT - tpState.tpGraceT < 0.12) continue;

      const R = pi === 0 ? R_AB : R_BA;

      // 1. Camera plane crossing (standard for wall portals or dives)
      const a_cam = (prevCamPos.x - P.c.x) * P.n.x + (prevCamPos.y - P.c.y) * P.n.y + (prevCamPos.z - P.c.z) * P.n.z;
      const b_cam = (camPosNow.x - P.c.x) * P.n.x + (camPosNow.y - P.c.y) * P.n.y + (camPosNow.z - P.c.z) * P.n.z;

      if ((a_cam > 0) !== (b_cam > 0)) {
        const t = Math.max(0, Math.min(1, a_cam / (a_cam - b_cam)));
        const cx = prevCamPos.x + (camPosNow.x - prevCamPos.x) * t;
        const cy = prevCamPos.y + (camPosNow.y - prevCamPos.y) * t;
        const cz = prevCamPos.z + (camPosNow.z - prevCamPos.z) * t;

        const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
        const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
        if (du <= PORT.hw && dv <= PORT.hh) {
          doTeleport(pl, R, P, Q, t, dt, tpState, events);
          return;
        }
      }

      // 2. Feet / base entry (for floor portals exiting to wall or ground)
      if (P.n.y > 0.4 && Q.n.y >= -0.4 && prevPos) {
        const prevFeet = new V3(prevPos.x, prevPos.y + 0.15, prevPos.z);
        const currFeet = new V3(pl.pos.x, pl.pos.y + 0.15, pl.pos.z);
        const a_feet = (prevFeet.x - P.c.x) * P.n.x + (prevFeet.y - P.c.y) * P.n.y + (prevFeet.z - P.c.z) * P.n.z;
        const b_feet = (currFeet.x - P.c.x) * P.n.x + (currFeet.y - P.c.y) * P.n.y + (currFeet.z - P.c.z) * P.n.z;

        const feetCrossed = a_feet > 0 && b_feet <= 0;
        const inShaft = pl.pos.y <= P.c.y + 0.1 && pl.pos.y >= P.c.y - 1.8 && pl.vel.y < 0;

        if (feetCrossed || inShaft) {
          const t = feetCrossed ? Math.max(0, Math.min(1, a_feet / (a_feet - b_feet))) : 0.5;
          const cx = feetCrossed ? prevFeet.x + (currFeet.x - prevFeet.x) * t : pl.pos.x;
          const cy = P.c.y;
          const cz = feetCrossed ? prevFeet.z + (currFeet.z - prevFeet.z) * t : pl.pos.z;

          const du = Math.abs((cx - P.c.x) * P.r.x + (cy - P.c.y) * P.r.y + (cz - P.c.z) * P.r.z);
          const dv = Math.abs((cx - P.c.x) * P.u.x + (cy - P.c.y) * P.u.y + (cz - P.c.z) * P.u.z);
          if (du <= PORT.hw && dv <= PORT.hh) {
            doTeleportFromFeet(pl, R, P, Q, cx, cy, cz, dt, tpState, events);
            return;
          }
        }
      }
    }
  }

  function doTeleportFromFeet(pl, R, P, Q, cx, cy, cz, dt, tpState, events) {
    pl.vel.applyMatrix4(R);

    const offsetOnP = new V3(cx - P.c.x, cy - P.c.y, cz - P.c.z);
    const relExit = offsetOnP.clone().applyMatrix4(R);

    if (Math.abs(Q.n.y) < 0.4) {
      // Exit portal is on a vertical wall: place player standing in front of Q at floor level
      const bottomY = Q.c.y - PORT.hh;
      pl.pos.set(Q.c.x, bottomY + 0.05, Q.c.z)
        .addScaledVector(Q.r, relExit.dot(Q.r))
        .addScaledVector(Q.n, CFG.R + 0.25);

      // Ensure minimal outward fling speed so player clears the exit portal
      const outSpeed = pl.vel.dot(Q.n);
      if (outSpeed < 6.0) {
        pl.vel.addScaledVector(Q.n, 6.0 - outSpeed);
      }
    } else if (Q.n.y < -0.4) {
      // Exit portal is on ceiling: place player completely below ceiling
      const curH = playerHeight(pl.crouchT);
      pl.pos.copy(Q.c).add(relExit).addScaledVector(Q.n, curH + 0.2);
      const outSpeed = pl.vel.dot(Q.n);
      if (outSpeed < 6.0) {
        pl.vel.addScaledVector(Q.n, 6.0 - outSpeed);
      }
    } else {
      // Exit portal is on floor: place player exiting along Q.n
      pl.pos.copy(Q.c).add(relExit).addScaledVector(Q.n, 0.2);
      const outSpeed = pl.vel.dot(Q.n);
      if (outSpeed < 6.0) {
        pl.vel.addScaledVector(Q.n, 6.0 - outSpeed);
      }
    }

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
    pl.prevYaw = pl.yaw;

    tpState.tpGracePortal = Q;
    tpState.tpGraceT = tpState.nowT;
    if (events && events.onTeleport) events.onTeleport(pl, R, P, Q);
  }

  function doTeleport(pl, R, P, Q, t, dt, tpState, events) {
    pl.vel.applyMatrix4(R);

    const eyeOffset = new V3(0, playerHeight(pl.crouchT) - 0.12, 0);
    const camPos = new V3().addVectors(pl.pos, eyeOffset);
    const relCam = new V3().subVectors(camPos, P.c).applyMatrix4(R);
    pl.pos.copy(Q.c).add(relCam).sub(eyeOffset);

    if (Q.n.y < -0.4) {
      // Exit portal is on ceiling: place player completely below ceiling
      const curH = playerHeight(pl.crouchT);
      if (pl.pos.y > Q.c.y - curH - 0.2) {
        pl.pos.y = Q.c.y - curH - 0.2;
      }
    }

    const outSpeed = pl.vel.dot(Q.n);
    if (outSpeed < 6.0) {
      pl.vel.addScaledVector(Q.n, 6.0 - outSpeed);
    }

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
    pl.prevYaw = pl.yaw;

    tpState.tpGracePortal = Q;
    tpState.tpGraceT = tpState.nowT;
    if (events && events.onTeleport) events.onTeleport(pl, R, P, Q);
  }

  function physStep(pl, keys, autohop, dt, obbs, portals, grabCubes, grabbedCube, tpState, events, otherPlayers) {
    if (pl.grounded) pl.groundT = tpState.nowT;
    // Yaw change since the previous step; gates air-strafing (the mouse must
    // be turning with the held strafe key).
    let dyaw = pl.yaw - (pl.prevYaw ?? pl.yaw);
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;
    pl.prevYaw = pl.yaw;
    const wish = wishDir(keys, pl.yaw);
    applyFriction(pl, dt);
    const wantWalk = keys.ShiftLeft || keys.ShiftRight;
    const crouchScale = 1 - (pl.crouchT || 0) * 0.5;
    if (pl.grounded) {
      // On a slope, drive along the surface: project the (horizontal) wish
      // onto the tangent plane of the ground normal so GACC builds tangential
      // speed the surface can sustain. Flat ground (normal = +y) projects to
      // the identity, so flat behavior is unchanged.
      let gw = wish;
      if (wish) {
        const dot = wish.dot(pl.groundNormal);
        if (Math.abs(dot) > 1e-4) {
          gw = wish.clone().addScaledVector(pl.groundNormal, -dot);
          if (gw.lengthSq() < 1e-6) gw = null;
          else gw.normalize();
        }
      }
      accelerate(pl.vel, gw, CFG.GACC, (wantWalk ? CFG.WALK : CFG.GMAX) * crouchScale, dt);
    }
    else if (wish) {
      // Air acceleration is the strafe reward: it applies only while a
      // strafe key (A/D) is held, where the wish carries a lateral component
      // and accelerate() builds speed toward AIRCAP as the strafe rotates
      // the heading off the velocity. Straight W/S in the air adds no speed,
      // so a straight bunnyhop preserves its launch speed for free.
      if (keys.KeyA || keys.KeyD) {
        accelerate(pl.vel, wish, CFG.AACC, CFG.AIRCAP, dt);
      }
      if (!keys.KeyA && !keys.KeyD && (keys.KeyW || keys.KeyS)) {
        // Forward glide: W/S alone curves the path without losing speed,
        // with subtle acceleration up to the speed threshold (~60 m/s).
        const linearSpeed = pl.vel.length();
        if (linearSpeed < (CFG.AIR_FORWARD_CAP || 60)) {
          accelerate(pl.vel, wish, CFG.AIR_FORWARD_ACC || 0.35, CFG.AIR_FORWARD_CAP || 60, dt);
        }
        const horizSpeed = Math.hypot(pl.vel.x, pl.vel.z);
        if (horizSpeed > 1.0) {
          const vDir = new V3(pl.vel.x, 0, pl.vel.z).normalize();
          const dot = vDir.dot(wish);
          if (dot > 0) {
            vDir.lerp(wish, 4.0 * dt).normalize();
            pl.vel.x = vDir.x * horizSpeed;
            pl.vel.z = vDir.z * horizSpeed;
          }
        }
      } else if (!keys.KeyW && !keys.KeyS && (keys.KeyA || keys.KeyD)) {
        // Air-strafe: release forward key, hold A/D, and turn mouse with strafe.
        // Heading smoothly curves in the direction of the strafe turn with clamped
        // rate limit and softened follow ratio to prevent aggressive snappy jerks.
        const turningWithStrafe = (keys.KeyA && !keys.KeyD && dyaw > 0) || (keys.KeyD && !keys.KeyA && dyaw < 0);
        if (turningWithStrafe) {
          const speed = Math.hypot(pl.vel.x, pl.vel.z);
          if (speed > 1.0) {
            const vx = pl.vel.x / speed, vz = pl.vel.z / speed;
            const fwdX = -Math.sin(pl.yaw), fwdZ = -Math.cos(pl.yaw);
            const fwdDot = vx * fwdX + vz * fwdZ;
            if (fwdDot > -0.2) {
              const turnDir = keys.KeyD ? 1 : -1;
              const mouseTurn = Math.abs(dyaw);
              const follow = CFG.STRAFE_FOLLOW ?? 0.5;
              const maxTurnRate = CFG.STRAFE_MAX_TURN ?? 3.5;
              const turn = Math.min(mouseTurn * follow, maxTurnRate * dt);
              const sa = turnDir * turn;
              pl.vel.x = speed * (vx * Math.cos(sa) - vz * Math.sin(sa));
              pl.vel.z = speed * (vx * Math.sin(sa) + vz * Math.cos(sa));
            }
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
    const prevPos = pl.pos.clone();
    const prevCamPos = new V3(pl.pos.x, pl.pos.y + curH - 0.12, pl.pos.z);
    pl.pos.addScaledVector(pl.vel, dt);
    collide(pl, obbs, portals, grabCubes, grabbedCube, events);
    if (otherPlayers) {
      collidePlayerWithPlayers(pl, otherPlayers);
    }

    teleportCheck(pl, prevPos, prevCamPos, dt, portals[0], portals[1], tpState.R_AB[0], tpState.R_BA[0], tpState, events);
    if (portals.length > 2) {
      teleportCheck(pl, prevPos, prevCamPos, dt, portals[2], portals[3], tpState.R_AB[1], tpState.R_BA[1], tpState, events);
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

  const _otherPlayersList = [];
  function collidePlayerWithPlayers(pl, otherPlayers) {
    if (!otherPlayers || pl.isDead) return;
    _otherPlayersList.length = 0;
    if (Array.isArray(otherPlayers)) {
      for (let i = 0; i < otherPlayers.length; i++) _otherPlayersList.push(otherPlayers[i]);
    } else {
      for (const k in otherPlayers) _otherPlayersList.push(otherPlayers[k]);
    }
    if (_otherPlayersList.length === 0) return;

    const D = CFG.R * 2;
    const D2 = D * D;
    const h = playerHeight(pl.crouchT);
    const myY0 = pl.pos.y;
    const myY1 = pl.pos.y + h;

    for (let i = 0; i < _otherPlayersList.length; i++) {
      const other = _otherPlayersList[i];
      if (!other || other === pl || other.isDead) continue;
      const ox = Array.isArray(other.pos) ? other.pos[0] : other.pos.x;
      const oy = Array.isArray(other.pos) ? other.pos[1] : other.pos.y;
      const oz = Array.isArray(other.pos) ? other.pos[2] : other.pos.z;
      const otherH = playerHeight(other.crouchT);
      const otherY0 = oy;
      const otherY1 = oy + otherH;

      // Vertical overlap check
      if (myY0 >= otherY1 || otherY0 >= myY1) {
        // Landing on top of another player's head:
        if (myY0 >= otherY1 - 0.25 && myY0 <= otherY1 + 0.15) {
          const dx = pl.pos.x - ox, dz = pl.pos.z - oz;
          if (dx * dx + dz * dz < D2) {
            pl.pos.y = otherY1 + 0.001;
            if (pl.vel.y < 0) pl.vel.y = 0;
            pl.grounded = true;
            pl.groundNormal.set(0, 1, 0);
          }
        }
        continue;
      }

      // Horizontal capsule collision
      const dx = pl.pos.x - ox;
      const dz = pl.pos.z - oz;
      const distSq = dx * dx + dz * dz;
      if (distSq < D2) {
        const dist = Math.sqrt(distSq);
        const nx = dist > 1e-5 ? dx / dist : 1;
        const nz = dist > 1e-5 ? dz / dist : 0;
        const depth = D - dist;

        pl.pos.x += nx * (depth + 0.001);
        pl.pos.z += nz * (depth + 0.001);

        const vn = pl.vel.x * nx + pl.vel.z * nz;
        if (vn < 0) {
          pl.vel.x -= nx * vn;
          pl.vel.z -= nz * vn;
        }
      }
    }
  }

  const _resolveList = [];
  function resolvePlayerCollisions(players) {
    if (!players) return;
    _resolveList.length = 0;
    if (Array.isArray(players)) {
      for (let i = 0; i < players.length; i++) _resolveList.push(players[i]);
    } else {
      for (const k in players) _resolveList.push(players[k]);
    }
    const len = _resolveList.length;
    if (len < 2) return;
    const D = CFG.R * 2;
    const D2 = D * D;

    for (let i = 0; i < len; i++) {
      const pA = _resolveList[i];
      if (!pA || pA.isDead) continue;
      const pAx = Array.isArray(pA.pos) ? pA.pos[0] : pA.pos.x;
      const pAy = Array.isArray(pA.pos) ? pA.pos[1] : pA.pos.y;
      const pAz = Array.isArray(pA.pos) ? pA.pos[2] : pA.pos.z;
      const hA = playerHeight(pA.crouchT);
      const yA0 = pAy, yA1 = pAy + hA;

      for (let j = i + 1; j < len; j++) {
        const pB = _resolveList[j];
        if (!pB || pB.isDead) continue;
        const pBx = Array.isArray(pB.pos) ? pB.pos[0] : pB.pos.x;
        const pBy = Array.isArray(pB.pos) ? pB.pos[1] : pB.pos.y;
        const pBz = Array.isArray(pB.pos) ? pB.pos[2] : pB.pos.z;
        const hB = playerHeight(pB.crouchT);
        const yB0 = pBy, yB1 = pBy + hB;

        // Vertical overlap check
        if (yA0 >= yB1 || yB0 >= yA1) {
          const dx = pAx - pBx, dz = pAz - pBz;
          if (dx * dx + dz * dz < D2) {
            if (yA0 >= yB1 - 0.25 && yA0 <= yB1 + 0.15) {
              if (Array.isArray(pA.pos)) pA.pos[1] = yB1 + 0.001; else pA.pos.y = yB1 + 0.001;
              if (pA.vel) {
                if (Array.isArray(pA.vel)) { if (pA.vel[1] < 0) pA.vel[1] = 0; }
                else if (pA.vel.y < 0) pA.vel.y = 0;
              }
              pA.grounded = true;
              if (pA.groundNormal) pA.groundNormal.set(0, 1, 0);
            } else if (yB0 >= yA1 - 0.25 && yB0 <= yA1 + 0.15) {
              if (Array.isArray(pB.pos)) pB.pos[1] = yA1 + 0.001; else pB.pos.y = yA1 + 0.001;
              if (pB.vel) {
                if (Array.isArray(pB.vel)) { if (pB.vel[1] < 0) pB.vel[1] = 0; }
                else if (pB.vel.y < 0) pB.vel.y = 0;
              }
              pB.grounded = true;
              if (pB.groundNormal) pB.groundNormal.set(0, 1, 0);
            }
          }
          continue;
        }

        // Horizontal capsule collision
        const dx = pAx - pBx;
        const dz = pAz - pBz;
        const distSq = dx * dx + dz * dz;
        if (distSq < D2) {
          const dist = Math.sqrt(distSq);
          const nx = dist > 1e-5 ? dx / dist : 1;
          const nz = dist > 1e-5 ? dz / dist : 0;
          const depth = D - dist;

          const push = (depth + 0.001) * 0.5;
          if (Array.isArray(pA.pos)) { pA.pos[0] += nx * push; pA.pos[2] += nz * push; }
          else { pA.pos.x += nx * push; pA.pos.z += nz * push; }

          if (Array.isArray(pB.pos)) { pB.pos[0] -= nx * push; pB.pos[2] -= nz * push; }
          else { pB.pos.x -= nx * push; pB.pos.z -= nz * push; }

          const vAx = pA.vel ? (Array.isArray(pA.vel) ? pA.vel[0] : pA.vel.x) : 0;
          const vAz = pA.vel ? (Array.isArray(pA.vel) ? pA.vel[2] : pA.vel.z) : 0;
          const vBx = pB.vel ? (Array.isArray(pB.vel) ? pB.vel[0] : pB.vel.x) : 0;
          const vBz = pB.vel ? (Array.isArray(pB.vel) ? pB.vel[2] : pB.vel.z) : 0;

          const rvx = vAx - vBx;
          const rvz = vAz - vBz;
          const vn = rvx * nx + rvz * nz;
          if (vn < 0) {
            const j = vn * 0.5;
            if (pA.vel) {
              if (Array.isArray(pA.vel)) { pA.vel[0] -= nx * j; pA.vel[2] -= nz * j; }
              else { pA.vel.x -= nx * j; pA.vel.z -= nz * j; }
            }
            if (pB.vel) {
              if (Array.isArray(pB.vel)) { pB.vel[0] += nx * j; pB.vel[2] += nz * j; }
              else { pB.vel.x += nx * j; pB.vel.z += nz * j; }
            }
          }
        }
      }
    }
  }

  function isPortalCoveredByRamp(c, n, r, u, hw, hh, ramp) {
    const { cx, cz, dir, len, rise, width, y0 } = ramp;
    const T = ramp.T || 0.3;

    let fwdX = 1, fwdZ = 0, rightX = 0, rightZ = 1;
    if (dir === 1) { fwdX = 0; fwdZ = 1; rightX = -1; rightZ = 0; }
    else if (dir === 2) { fwdX = -1; fwdZ = 0; rightX = 0; rightZ = -1; }
    else if (dir === 3) { fwdX = 0; fwdZ = -1; rightX = 1; rightZ = 0; }

    const hl = len * 0.5;
    const hwRamp = width * 0.5;

    // Portal center in ramp's 2D horizontal frame
    const dx = c.x - cx;
    const dz = c.z - cz;
    const sc = dx * fwdX + dz * fwdZ;
    const wc = dx * rightX + dz * rightZ;

    // Portal extents in ramp's frame
    const extS = hw * Math.abs(r.x * fwdX + r.z * fwdZ) + hh * Math.abs(u.x * fwdX + u.z * fwdZ);
    const extW = hw * Math.abs(r.x * rightX + r.z * rightZ) + hh * Math.abs(u.x * rightX + u.z * rightZ);
    const extY = hw * Math.abs(r.y) + hh * Math.abs(u.y);

    const margin = 0.04;

    // 1. Horizontal bounding box check in ramp's local (s, w) space
    if (sc + extS < -hl + margin || sc - extS > hl - margin) return false;
    if (Math.abs(wc) > hwRamp + extW - margin) return false;

    // 2. Vertical bounding box check
    const portalMinY = c.y - extY;
    const portalMaxY = c.y + extY;
    if (portalMaxY < y0 - 0.1 || portalMinY > y0 + rise + 0.1) return false;

    // 3. Curved surface profile check
    const sNear = Math.max(-hl, Math.min(hl, sc));
    const sMin = Math.max(-hl, Math.min(hl, sc - extS));
    const sMax = Math.max(-hl, Math.min(hl, sc + extS));

    const uNear = (sNear + hl) / len;
    const uMin = (sMin + hl) / len;
    const uMax = (sMax + hl) / len;

    const yTopNear = y0 + rise * smootherstep(uNear);
    const yTopMin = y0 + rise * smootherstep(uMin);
    const yTopMax = y0 + rise * smootherstep(uMax);

    const maxYTop = Math.max(yTopNear, yTopMin, yTopMax);
    const minYTop = Math.min(yTopNear, yTopMin, yTopMax);
    const minYBot = (minYTop - y0 < 1.8) ? y0 : (minYTop - T);

    if (portalMinY > maxYTop - margin) return false;
    if (portalMaxY < minYBot + margin) return false;

    // 4. Face-specific checks:
    // Portal on FLOOR (n.y > 0.8)
    if (n.y > 0.8) {
      if (minYBot - y0 < 2.0 && portalMinY < maxYTop + 0.1) {
        return true;
      }
      return false;
    }

    // Portal on CEILING (n.y < -0.8)
    if (n.y < -0.8) {
      if (portalMaxY > minYBot - 0.1) return true;
      return false;
    }

    // Portal on WALL (|n.y| < 0.2)
    if (Math.abs(n.y) < 0.2) {
      const dn = (cx - c.x) * n.x + (cz - c.z) * n.z;
      const hen = hl * Math.abs(fwdX * n.x + fwdZ * n.z) + hwRamp * Math.abs(rightX * n.x + rightZ * n.z);
      if (dn + hen <= 0.02 || dn - hen >= 0.4) {
        return false;
      }
      return true;
    }

    return false;
  }

  function isPortalPlacementBlocked(c, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls) {
    const hw = PORT.hw;
    const hh = PORT.hh;

    // 1. Check face boundaries if hitObb is provided
    if (hitObb) {
      if (hitObb.noPortal || hitObb.destroyed || hitObb.kind === 'ramp') {
        return true;
      }
      for (let k = 0; k < 3; k++) {
        const ax = hitObb.ax[k];
        if (Math.abs(n.dot(ax)) > 0.99) continue; // Face normal axis
        const ext = hw * Math.abs(r.dot(ax)) + hh * Math.abs(u.dot(ax));
        const limit = hitObb.he[k] - ext - 0.02;
        if (limit < 0) return true; // Face too small for portal
        const proj = (c.x - hitObb.c.x) * ax.x + (c.y - hitObb.c.y) * ax.y + (c.z - hitObb.c.z) * ax.z;
        if (proj > limit + 0.01 || proj < -limit - 0.01) return true;
      }
    }

    // 2. Check obstacles covering the portal (other OBBs in front of or intersecting the surface)
    if (obbs) {
      for (let i = 0; i < obbs.length; i++) {
        const obb = obbs[i];
        if (hitObb && (obb === hitObb || (obb.id && obb.id === hitObb.id))) continue;

        if (obb.kind === 'ramp' && obb.ramp) {
          if (isPortalCoveredByRamp(c, n, r, u, hw, hh, obb.ramp)) {
            return true;
          }
          continue;
        }

        const dx = c.x - obb.c.x;
        const dy = c.y - obb.c.y;
        const dz = c.z - obb.c.z;

        // Obstacle distance along face normal n (n points outward from surface into room)
        const dn = (obb.c.x - c.x) * n.x + (obb.c.y - c.y) * n.y + (obb.c.z - c.z) * n.z;
        const hen = obb.he[0] * Math.abs(obb.ax[0].dot(n)) +
                    obb.he[1] * Math.abs(obb.ax[1].dot(n)) +
                    obb.he[2] * Math.abs(obb.ax[2].dot(n));

        // If the obstacle is completely behind the surface face, it cannot cover the portal
        if (dn + hen <= 0.02) continue;
        // If the obstacle is floating far out in front of the wall (> 0.4m from surface), it does not cover the wall surface
        if (dn - hen >= 0.4) continue;

        // Check overlap along obb's 3 axes
        let separated = false;
        for (let j = 0; j < 3; j++) {
          const ax = obb.ax[j];
          const projD = Math.abs(dx * ax.x + dy * ax.y + dz * ax.z);
          const extJ = hw * Math.abs(r.dot(ax)) + hh * Math.abs(u.dot(ax)) + 0.05 * Math.abs(n.dot(ax));
          if (projD > obb.he[j] + extJ - 0.02) {
            separated = true;
            break;
          }
        }
        if (separated) continue;

        // Check overlap along portal's tangent axes r and u
        const projR = Math.abs(dx * r.x + dy * r.y + dz * r.z);
        const extR = obb.he[0] * Math.abs(obb.ax[0].dot(r)) +
                     obb.he[1] * Math.abs(obb.ax[1].dot(r)) +
                     obb.he[2] * Math.abs(obb.ax[2].dot(r));
        if (projR > hw + extR - 0.02) continue;

        const projU = Math.abs(dx * u.x + dy * u.y + dz * u.z);
        const extU = obb.he[0] * Math.abs(obb.ax[0].dot(u)) +
                     obb.he[1] * Math.abs(obb.ax[1].dot(u)) +
                     obb.he[2] * Math.abs(obb.ax[2].dot(u));
        if (projU > hh + extU - 0.02) continue;

        return true;
      }
    }

    // 3. Check destroyed wall OBBs
    if (destroyedWallObbs) {
      for (let i = 0; i < destroyedWallObbs.length; i++) {
        const dob = destroyedWallObbs[i];
        const dx = c.x - dob.c.x, dy = c.y - dob.c.y, dz = c.z - dob.c.z;
        const u0 = Math.abs(dx * dob.ax[0].x + dy * dob.ax[0].y + dz * dob.ax[0].z);
        const u1 = Math.abs(dx * dob.ax[1].x + dy * dob.ax[1].y + dz * dob.ax[1].z);
        const u2 = Math.abs(dx * dob.ax[2].x + dy * dob.ax[2].y + dz * dob.ax[2].z);
        const ext0 = hw * Math.abs(r.dot(dob.ax[0])) + hh * Math.abs(u.dot(dob.ax[0]));
        const ext1 = hw * Math.abs(r.dot(dob.ax[1])) + hh * Math.abs(u.dot(dob.ax[1]));
        const ext2 = hw * Math.abs(r.dot(dob.ax[2])) + hh * Math.abs(u.dot(dob.ax[2]));
        if (u0 <= dob.he[0] + ext0 + 0.2 &&
            u1 <= dob.he[1] + ext1 + 0.2 &&
            u2 <= dob.he[2] + ext2 + 0.2) {
          return true;
        }
      }
    }

    // 4. Check destroyed wall blast centers
    if (destroyedWalls) {
      for (let i = 0; i < destroyedWalls.length; i++) {
        const dw = destroyedWalls[i];
        if (dw.point) {
          const px = dw.point.x !== undefined ? dw.point.x : dw.point[0];
          const py = dw.point.y !== undefined ? dw.point.y : dw.point[1];
          const pz = dw.point.z !== undefined ? dw.point.z : dw.point[2];
          const dSq = (c.x - px) * (c.x - px) + (c.y - py) * (c.y - py) + (c.z - pz) * (c.z - pz);
          if (dSq < 5.4 * 5.4) return true;
        }
        if (dw.wallCenter) {
          const wx = dw.wallCenter.x !== undefined ? dw.wallCenter.x : dw.wallCenter[0];
          const wy = dw.wallCenter.y !== undefined ? dw.wallCenter.y : dw.wallCenter[1];
          const wz = dw.wallCenter.z !== undefined ? dw.wallCenter.z : dw.wallCenter[2];
          const dSq = (c.x - wx) * (c.x - wx) + (c.y - wy) * (c.y - wy) + (c.z - wz) * (c.z - wz);
          if (dSq < 4.5 * 4.5) return true;
        }
      }
    }

    // 5. Check lava pools
    if (lava) {
      for (let i = 0; i < lava.length; i++) {
        const L = lava[i];
        const dx = c.x - L.x, dz = c.z - L.z;
        const minSafeDist = L.r + hw + 0.3;
        if (dx * dx + dz * dz < minSafeDist * minSafeDist && c.y <= (L.y || 0.1) + hh + 0.3) {
          return true;
        }
      }
    }

    // 6. Check overlap with other placed portals
    if (portals) {
      for (let i = 0; i < portals.length; i++) {
        if (i === pi) continue;
        const Q = portals[i];
        if (!Q || !Q.placed) continue;

        const dotN = Math.abs(n.dot(Q.n));
        const qcx = Q.c.x !== undefined ? Q.c.x : Q.c[0];
        const qcy = Q.c.y !== undefined ? Q.c.y : Q.c[1];
        const qcz = Q.c.z !== undefined ? Q.c.z : Q.c[2];
        const dx = c.x - qcx, dy = c.y - qcy, dz = c.z - qcz;

        if (dotN > 0.98) {
          const planeDist = Math.abs(dx * n.x + dy * n.y + dz * n.z);
          if (planeDist < 0.2) {
            const du = Math.abs(dx * r.x + dy * r.y + dz * r.z);
            const dv = Math.abs(dx * u.x + dy * u.y + dz * u.z);
            if (du < hw * 2 + 0.4 && dv < hh * 2 + 0.4) {
              return true;
            }
          }
        }

        const distSq = dx * dx + dy * dy + dz * dz;
        const maxExt = Math.max(hw, hh) * 1.5;
        if (distSq < maxExt * maxExt) {
          return true;
        }
      }
    }

    return false;
  }

  function findClosestValidPortalPos(hitPoint, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls) {
    if (!hitObb || hitObb.noPortal || hitObb.destroyed || hitObb.kind === 'ramp') {
      return null;
    }

    const hw = PORT.hw;
    const hh = PORT.hh;
    const R_MAX = PORT.hh; // Portal radius (2.0m)

    // Compute normal axis of hitObb
    let normalAxis = -1;
    let normalSign = 1;
    for (let k = 0; k < 3; k++) {
      const dot = n.dot(hitObb.ax[k]);
      if (Math.abs(dot) > 0.99) {
        normalAxis = k;
        normalSign = Math.sign(dot);
        break;
      }
    }
    if (normalAxis === -1) return null;

    const limits = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (k === normalAxis) continue;
      const ax = hitObb.ax[k];
      const ext = hw * Math.abs(r.dot(ax)) + hh * Math.abs(u.dot(ax));
      limits[k] = hitObb.he[k] - ext - 0.02;
      if (limits[k] < 0) return null; // Face physically too small
    }

    // Project hitPoint onto the face plane
    const dvec = new V3().subVectors(hitPoint, hitObb.c);
    const dNormal = hitObb.he[normalAxis] * normalSign;
    const dproj = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      if (k === normalAxis) {
        dproj[k] = dNormal;
      } else {
        dproj[k] = dvec.dot(hitObb.ax[k]);
      }
    }

    const cOrig = new V3().copy(hitObb.c);
    for (let k = 0; k < 3; k++) {
      cOrig.addScaledVector(hitObb.ax[k], dproj[k]);
    }
    cOrig.addScaledVector(n, 0.02);

    // Face-clamped point
    const cClamped = new V3().copy(hitObb.c);
    for (let k = 0; k < 3; k++) {
      if (k === normalAxis) {
        cClamped.addScaledVector(hitObb.ax[k], dNormal);
      } else {
        const clamped = Math.max(-limits[k], Math.min(limits[k], dproj[k]));
        cClamped.addScaledVector(hitObb.ax[k], clamped);
      }
    }
    cClamped.addScaledVector(n, 0.02);

    // 1. Check if cOrig is within bounds and not blocked
    const origInBounds = (
      Math.abs(dproj[(normalAxis + 1) % 3]) <= limits[(normalAxis + 1) % 3] + 0.001 &&
      Math.abs(dproj[(normalAxis + 2) % 3]) <= limits[(normalAxis + 2) % 3] + 0.001
    );

    if (origInBounds && !isPortalPlacementBlocked(cOrig, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls)) {
      return { c: cOrig, autoFixed: false };
    }

    // 2. Check if cClamped is within R_MAX and not blocked
    const clampDist = cClamped.distanceTo(cOrig);
    if (clampDist <= R_MAX && !isPortalPlacementBlocked(cClamped, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls)) {
      return { c: cClamped, autoFixed: clampDist > 0.01 };
    }

    // 3. Search for the closest valid placement on the flat surface to cOrig
    let bestCandidate = null;
    let bestDistSq = R_MAX * R_MAX;

    const NUM_ANGLES = 32;
    const DIST_STEP = 0.1;
    const MAX_STEPS = Math.ceil(R_MAX / DIST_STEP);

    const testPos = new V3();
    const dirVec = new V3();

    for (let step = 1; step <= MAX_STEPS; step++) {
      const d = Math.min(step * DIST_STEP, R_MAX);
      if (d * d > bestDistSq + 0.01) break;

      for (let a = 0; a < NUM_ANGLES; a++) {
        const angle = (a * 2 * Math.PI) / NUM_ANGLES;
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);

        dirVec.copy(r).multiplyScalar(d * cosA).addScaledVector(u, d * sinA);
        testPos.addVectors(cClamped, dirVec);

        const distToOrigSq = testPos.distanceToSquared(cOrig);
        if (distToOrigSq > bestDistSq) continue;

        if (!isPortalPlacementBlocked(testPos, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls)) {
          // Refine along dirVec with binary search
          let low = Math.max(0, d - DIST_STEP);
          let high = d;
          let refinedPos = testPos.clone();
          const unitDir = dirVec.clone().normalize();

          for (let b = 0; b < 3; b++) {
            const mid = (low + high) * 0.5;
            const midPos = new V3().addVectors(cClamped, unitDir.clone().multiplyScalar(mid));
            if (!isPortalPlacementBlocked(midPos, n, r, u, hitObb, pi, obbs, portals, lava, destroyedWallObbs, destroyedWalls)) {
              high = mid;
              refinedPos.copy(midPos);
            } else {
              low = mid;
            }
          }

          const refinedDistSq = refinedPos.distanceToSquared(cOrig);
          if (refinedDistSq < bestDistSq) {
            bestDistSq = refinedDistSq;
            bestCandidate = refinedPos.clone();
          }
        }
      }
    }

    if (bestCandidate && Math.sqrt(bestDistSq) <= R_MAX + 0.001) {
      return { c: bestCandidate, autoFixed: true };
    }

    return null;
  }

  return {
    physStep,
    collideCube,
    resolveCubeCollisions,
    raycast,
    teleportCube,
    collidePlayerWithPlayers,
    resolvePlayerCollisions,
    isPortalPlacementBlocked,
    findClosestValidPortalPos
  };
}














