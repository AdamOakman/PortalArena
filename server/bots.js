/**
 * Server-side bot AI.
 *
 * Bots are regular entries in gameState.players with { isBot: true }.
 * Their movement is computed here each server tick by producing a fake
 * "keys + yaw/pitch" packet, then letting the standard physics step run
 * on them (so collision, portals, etc. all work identically).
 *
 * Behaviour (no rocket launcher, no instagib):
 *   - Wander around the map, preferring higher platforms
 *   - Jump whenever a platform edge or low obstacle is ahead, and on jumppads
 *   - Navigate smartly around tall walls without getting stuck or jumping in place
 *   - Fire a non-overlapping portal pair from time to time, then walk through them
 */

import * as TH from 'three';
import { CFG, TICK_RATE } from '../shared/constants.js';
import { mapData, obbs, gameState, isPortalOnDestroyedWall } from './gamestate.js';

// ------------------------------------------------------------------ constants

const DT = 1 / TICK_RATE;
const THINK_INTERVAL_MS = 350;               // how often to re-pick a goal
const PORTAL_COOLDOWN_S = 4.5;               // minimum seconds between portal shots
const PORTAL_CHANCE     = 0.55;              // probability to fire portals on a think tick
const JUMP_COOLDOWN_S   = 0.35;              // minimum gap between jumps
const ROCKET_COOLDOWN_S = 8.0;               // cooldown between bot rocket shots
const INSTAGIB_COOLDOWN_S = 6.0;             // cooldown between bot instagib shots
const INSTAGIB_HIT_CHANCE = 0.20;            // 20% hit chance for bot instagib shots

// ------------------------------------------------------------------ per-bot state

const botState = new Map(); // botId -> { ... }

function ensureState(pid) {
  if (!botState.has(pid)) {
    botState.set(pid, {
      targetPos: null,         // Vector3 we're walking toward
      lastThinkT: 0,
      lastPortalT: -999,
      lastJumpT: -999,
      lastRocketT: -999,
      lastRocketJumpT: -999,
      rocketJumpPhase: 'none',
      rocketJumpT: 0,
      lastInstagibT: -999,
      lastWeaponSwapT: 0,
      weaponHoldUntilT: 0,
      portalPhase: 'none',     // 'none'|'aim_blue'|'aim_orange'|'walk_thru'
      walkThruT: 0,
      stuckT: 0,               // time we've been moving very slowly
      prevPos: null,
      lastTickPos: null,
      avoidUntilT: 0,
      avoidYaw: 0,
      aimOrangeYaw: 0,
      orangeAimT: 0,
      unstuckUntilT: 0,
      strafeDir: null,
      instagibTargetPid: null,
      instagibAimStartT: 0,
      lastUnstuckT: 0,
      waypoints: [],
    });
  }
  return botState.get(pid);
}

// ------------------------------------------------------------------ helpers

function getRampEndpoints(rm) {
  // dir: 0 = +x, 1 = +z, 2 = -x, 3 = -z
  let fwdX = 1, fwdZ = 0;
  if (rm.dir === 1) { fwdX = 0; fwdZ = 1; }
  else if (rm.dir === 2) { fwdX = -1; fwdZ = 0; }
  else if (rm.dir === 3) { fwdX = 0; fwdZ = -1; }

  const hl = rm.len * 0.5;
  const lowX = rm.cx - fwdX * hl;
  const lowZ = rm.cz - fwdZ * hl;
  const highX = rm.cx + fwdX * hl;
  const highZ = rm.cz + fwdZ * hl;

  return {
    low: new TH.Vector3(lowX, rm.y0, lowZ),
    high: new TH.Vector3(highX, rm.y0 + rm.rise, highZ),
    fwd: new TH.Vector3(fwdX, 0, fwdZ)
  };
}

export function getRampUnderState(pos) {
  const ramps = mapData.ramps || [];
  for (const rm of ramps) {
    let fwdX = 1, fwdZ = 0, rightX = 0, rightZ = 1;
    if (rm.dir === 1) { fwdX = 0; fwdZ = 1; rightX = -1; rightZ = 0; }
    else if (rm.dir === 2) { fwdX = -1; fwdZ = 0; rightX = 0; rightZ = -1; }
    else if (rm.dir === 3) { fwdX = 0; fwdZ = -1; rightX = 1; rightZ = 0; }

    const dx = pos.x - rm.cx;
    const dz = pos.z - rm.cz;
    const s = dx * fwdX + dz * fwdZ;
    const w = dx * rightX + dz * rightZ;

    const hl = rm.len * 0.5;
    const hw = rm.width * 0.5;

    if (s >= -hl - 0.2 && s <= hl + 0.2 && Math.abs(w) <= hw + 0.2) {
      const u = Math.max(0, Math.min(1, (s + hl) / rm.len));
      const u2 = u * u, u3 = u2 * u;
      const smooth = u3 * (u * (u * 6 - 15) + 10);
      const yTop = rm.y0 + rm.rise * smooth;
      const yBot = yTop - (rm.T || 0.6);

      if (pos.y < yBot - 0.05) {
        return { rm, s, w, hl, hw, fwdX, fwdZ, rightX, rightZ, yTop, yBot, clearance: yBot - pos.y };
      }
    }
  }
  return null;
}

function pickBotTargetAndRoute(curPos, portals) {
  const pos = curPos || new TH.Vector3();
  const underAtPick = getRampUnderState(pos);
  if (underAtPick && underAtPick.clearance < 2.5) {
    const toCenter = new TH.Vector3(-pos.x, 0, -pos.z).normalize();
    const escTarget = pos.clone().addScaledVector(toCenter, 8.0);
    escTarget.y = 0;
    return {
      target: escTarget,
      waypoints: []
    };
  }

  // 25% chance to intentionally walk through an active portal pair if placed
  if (portals && Math.random() < 0.25) {
    const pairs = [];
    if (portals[0] && portals[1] && portals[0].placed && portals[1].placed) pairs.push([portals[0], portals[1]]);
    if (portals[2] && portals[3] && portals[2].placed && portals[3].placed) pairs.push([portals[2], portals[3]]);
    if (pairs.length > 0) {
      const pair = pairs[Math.floor(Math.random() * pairs.length)];
      const entry = Math.random() < 0.5 ? pair[0] : pair[1];
      const exit = (entry === pair[0]) ? pair[1] : pair[0];
      const portalTarget = entry.c.clone().addScaledVector(entry.n, -0.6);
      const exitTarget = exit.c.clone().addScaledVector(exit.n, 2.0);
      return {
        target: portalTarget,
        waypoints: [exitTarget]
      };
    }
  }

  const ramps = mapData.ramps || [];
  // 35% chance to try to reach the top of a platform via a ramp
  if (ramps.length > 0 && Math.random() < 0.35) {
    const rm = ramps[Math.floor(Math.random() * ramps.length)];
    const ep = getRampEndpoints(rm);

    // Find elevated platform near the top of this ramp
    const elevated = (mapData.slabs || []).filter(s => s.kind === 'plat' && Math.hypot(s.c[0] - ep.high.x, s.c[2] - ep.high.z) < 14 && s.c[1] >= ep.high.y - 1.5);
    let finalTarget = ep.high.clone();
    if (elevated.length > 0) {
      const plat = elevated[Math.floor(Math.random() * elevated.length)];
      finalTarget = new TH.Vector3(plat.c[0], plat.c[1] + plat.s[1] * 0.5, plat.c[2]);
    }

    if (pos.y < ep.high.y - 1.0) {
      // Approach point 2.0m before the low end, aligned with ramp centerline
      const approachLow = ep.low.clone().addScaledVector(ep.fwd, -2.0);
      // Entrance point 1.5m onto the ramp along centerline to ensure clean ramp entry
      const startRamp = ep.low.clone().addScaledVector(ep.fwd, 1.5);
      const midRamp = new TH.Vector3(rm.cx, rm.y0 + rm.rise * 0.5, rm.cz);
      return {
        target: approachLow,
        waypoints: [startRamp, midRamp, ep.high.clone(), finalTarget]
      };
    } else {
      return {
        target: finalTarget,
        waypoints: []
      };
    }
  }

  const spawns = (mapData.spawns || []).filter(sp => {
    const u = getRampUnderState(new TH.Vector3(sp.x, sp.y, sp.z));
    return !u || u.clearance >= 2.2;
  });
  const validSpawns = spawns.length > 0 ? spawns : mapData.spawns;

  const elevated = (mapData.slabs || []).filter(s => s.kind === 'plat' && s.c[1] > 0.5);
  if (elevated.length > 0 && Math.random() < 0.25) {
    const plat = elevated[Math.floor(Math.random() * elevated.length)];
    return {
      target: new TH.Vector3(plat.c[0], plat.c[1] + plat.s[1] * 0.5, plat.c[2]),
      waypoints: []
    };
  }
  const sp = validSpawns[Math.floor(Math.random() * validSpawns.length)];
  return {
    target: new TH.Vector3(sp.x, sp.y, sp.z),
    waypoints: []
  };
}

// Simple raycast downward to see if there's ground nearby ahead of the bot
function hasGroundAhead(pos, yaw, obbs_) {
  const ahead = new TH.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const checkPos = pos.clone().addScaledVector(ahead, 0.8);
  checkPos.y += 0.5;
  const downDir = new TH.Vector3(0, -1, 0);
  // Check if ground exists 1.5 m below the step-ahead position
  for (const obb of obbs_) {
    if (obb.kind === 'lava') continue;
    const dx = checkPos.x - obb.c.x, dy = checkPos.y - obb.c.y, dz = checkPos.z - obb.c.z;
    if (Math.abs(dx) > obb.rad + 1 || Math.abs(dy) > obb.rad + 1 || Math.abs(dz) > obb.rad + 1) continue;
    const origin = checkPos.clone();
    const maxD = 1.5;
    const ox = origin.x - obb.c.x, oy = origin.y - obb.c.y, oz = origin.z - obb.c.z;
    let tmin = -1e9, tmax = 1e9, par = false;
    for (let k = 0; k < 3; k++) {
      const a = obb.ax[k];
      const o = ox * a.x + oy * a.y + oz * a.z;
      const vd = downDir.dot(a);
      if (Math.abs(vd) < 1e-7) { if (Math.abs(o) > obb.he[k]) { par = true; break; } }
      else {
        let t0 = (-obb.he[k] - o) / vd, t1 = (obb.he[k] - o) / vd;
        if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
        if (t0 > tmin) tmin = t0;
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) { par = true; break; }
      }
    }
    if (!par && tmin <= maxD && tmax >= 0) return true;
  }
  return false;
}

// ------------------------------------------------------------------ wall raycast

function isLavaBlocked(c, PORT_) {
  if (!mapData.lava) return false;
  const hw = PORT_ ? PORT_.hw : 1.44;
  const hh = PORT_ ? PORT_.hh : 2.0;
  for (const L of mapData.lava) {
    const dx = c.x - L.x;
    const dz = c.z - L.z;
    const minSafeDist = L.r + hw + 0.3;
    if (dx * dx + dz * dz < minSafeDist * minSafeDist && c.y <= (L.y || 0.1) + hh + 0.3) {
      return true;
    }
  }
  return false;
}

function raycastWall(origin, dir, maxDist, obbs_) {
  let bestT = maxDist;
  let best = null;

  for (const obb of obbs_) {
    if (origin.distanceTo(obb.c) - obb.rad > maxDist) continue;

    const ox = origin.x - obb.c.x, oy = origin.y - obb.c.y, oz = origin.z - obb.c.z;
    let tmin = -1e9, tmax = 1e9, hitAxis = -1, hitSign = 0, par = false;
    for (let k = 0; k < 3; k++) {
      const a = obb.ax[k];
      const o = ox * a.x + oy * a.y + oz * a.z;
      const vd = dir.dot(a);
      if (Math.abs(vd) < 1e-7) { if (Math.abs(o) > obb.he[k]) { par = true; break; } }
      else {
        let t0 = (-obb.he[k] - o) / vd, t1 = (obb.he[k] - o) / vd;
        if (t0 > t1) { const tt = t0; t0 = t1; t1 = tt; }
        if (t0 > tmin) { tmin = t0; hitAxis = k; hitSign = Math.sign(vd); }
        if (t1 < tmax) tmax = t1;
        if (tmin > tmax) { par = true; break; }
      }
    }
    if (par || hitAxis < 0 || tmax < 0.05 || tmin < 0.05 || tmin > bestT) continue;

    const point = origin.clone().addScaledVector(dir, tmin);
    const normal = obb.ax[hitAxis].clone().multiplyScalar(-hitSign);
    best = { point, normal, obb, distance: tmin, hitAxis, hitSign };
    bestT = tmin;
  }
  return best;
}

// ------------------------------------------------------------------ portal overlap check

/**
 * Checks whether placing a portal at (c, n, r, u) overlaps with any existing placed portal.
 */
export function checkPortalOverlap(c, n, r, u, portals, excludeIdx, PORT_) {
  for (let i = 0; i < portals.length; i++) {
    if (i === excludeIdx) continue;
    const Q = portals[i];
    if (!Q || !Q.placed) continue;

    // Check same plane/face
    const dotN = Math.abs(n.dot(Q.n));
    if (dotN > 0.98) {
      const planeDist = Math.abs(c.clone().sub(Q.c).dot(n));
      if (planeDist < 0.2) {
        const d = c.clone().sub(Q.c);
        const du = Math.abs(d.dot(r));
        const dv = Math.abs(d.dot(u));
        if (du < PORT_.hw * 2 + 0.4 && dv < PORT_.hh * 2 + 0.4) {
          return true;
        }
      }
    }

    // Direct 3D distance between portal centers
    if (c.distanceTo(Q.c) < Math.max(PORT_.hw, PORT_.hh) * 1.5) {
      return true;
    }
  }
  return false;
}

// ------------------------------------------------------------------ portal placement helper

/**
 * Try to shoot a portal at a flat wall in the direction the bot is facing.
 * Returns { c, n, r, u, eyePos } or null if no valid non-overlapping surface found.
 */
function findPortalSurfaceAtPitch(pos, yaw, pitch, obbs_, portals, PORT_, currentPi) {
  const dir = new TH.Vector3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  ).normalize();

  const eyePos = pos.clone();
  eyePos.y += CFG.H - 0.12;

  const hit = raycastWall(eyePos, dir, 35, obbs_);
  if (!hit) return null;
  if (hit.obb.destroyed || hit.obb.noPortal || hit.obb.kind === 'ramp' || hit.obb.kind === 'lava') return null;
  if (gameState.destroyedWallObbs && gameState.destroyedWallObbs.some(dob => dob.id === hit.obb.id)) return null;

  const { point, normal, obb, hitAxis, hitSign } = hit;

  // Build tangent frame for the portal
  const ref = Math.abs(normal.y) > 0.98 ? new TH.Vector3(0, 0, 1) : new TH.Vector3(0, 1, 0);
  const r = new TH.Vector3().crossVectors(ref, normal).normalize();
  if (r.lengthSq() < 1e-8) return null;
  const u = new TH.Vector3().crossVectors(normal, r);

  // Check the face is big enough and clamp mouth inside face boundaries
  const ax1 = (hitAxis + 1) % 3;
  const ax2 = (hitAxis + 2) % 3;
  const ext1 = PORT_.hw * Math.abs(r.dot(obb.ax[ax1])) + PORT_.hh * Math.abs(u.dot(obb.ax[ax1]));
  const ext2 = PORT_.hw * Math.abs(r.dot(obb.ax[ax2])) + PORT_.hh * Math.abs(u.dot(obb.ax[ax2]));
  const limit1 = obb.he[ax1] - ext1 - 0.02;
  const limit2 = obb.he[ax2] - ext2 - 0.02;
  if (limit1 < 0 || limit2 < 0) return null;

  const dvec = point.clone().sub(obb.c);
  let p1 = dvec.dot(obb.ax[ax1]);
  p1 = Math.max(-limit1, Math.min(limit1, p1));
  let p2 = dvec.dot(obb.ax[ax2]);
  p2 = Math.max(-limit2, Math.min(limit2, p2));

  // If wall is vertical, adjust portal height so portal base sits near floor level (pos.y + 0.05)
  if (Math.abs(normal.y) < 0.2) {
    const targetCenterY = pos.y + PORT_.hh + 0.05;
    if (Math.abs(obb.ax[ax1].y) > 0.8) {
      const desiredOffset = (targetCenterY - obb.c.y) * Math.sign(obb.ax[ax1].y);
      p1 = Math.max(-limit1, Math.min(limit1, desiredOffset));
    } else if (Math.abs(obb.ax[ax2].y) > 0.8) {
      const desiredOffset = (targetCenterY - obb.c.y) * Math.sign(obb.ax[ax2].y);
      p2 = Math.max(-limit2, Math.min(limit2, desiredOffset));
    }
  }

  const adjustedC = obb.c.clone()
    .addScaledVector(obb.ax[hitAxis], obb.he[hitAxis] * -hitSign)
    .addScaledVector(obb.ax[ax1], p1)
    .addScaledVector(obb.ax[ax2], p2)
    .addScaledVector(normal, 0.02);

  // Reject placement in or under lava pools
  if (isLavaBlocked(adjustedC, PORT_)) {
    return null;
  }

  // Reject placement on any destroyed wall or fragment
  if (isPortalOnDestroyedWall(adjustedC, normal, r, u, PORT_)) {
    return null;
  }

  // Reject overlapping placement with any existing placed portal
  if (checkPortalOverlap(adjustedC, normal, r, u, portals, currentPi, PORT_)) {
    return null;
  }

  return { c: adjustedC, n: normal, r, u, eyePos };
}

function findPortalSurface(pos, yaw, obbs_, portals, PORT_, currentPi) {
  const testPitches = [0.1, 0.0, 0.2, -0.1];
  for (const p of testPitches) {
    const res = findPortalSurfaceAtPitch(pos, yaw, p, obbs_, portals, PORT_, currentPi);
    if (res) return { surface: res, pitch: p };
  }
  return null;
}

// ------------------------------------------------------------------ destructible wall & opponent targeting

function findDestructibleWall(eyePos, fwdDir, maxDist = 20) {
  let best = null;
  let bestScore = -1e9;
  for (const obb of obbs) {
    if (obb.kind !== 'wall' || obb.boundary || obb.destroyed) continue;
    if (gameState.destroyedWallObbs && gameState.destroyedWallObbs.some(dob => dob.id === obb.id)) continue;
    const uIdx = obb.he[0] >= obb.he[2] ? 0 : 2;
    const tIdx = uIdx === 0 ? 2 : 0;
    if (obb.he[tIdx] > 2.5) continue; // must be thin destructible wall

    const toCenter = obb.c.clone().sub(eyePos);
    const dist = toCenter.length();
    if (dist > maxDist || dist < 2.0) continue;

    const dir = toCenter.clone().normalize();
    const hit = raycastWall(eyePos, dir, dist + 1.0, obbs);
    if (!hit || hit.obb !== obb) continue;

    const dot = fwdDir.dot(dir);
    const score = dot * 10 - dist * 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = { obb, point: hit.point, normal: hit.normal, dir, dist };
    }
  }
  return best;
}

function findOpponent(pid, eyePos, maxDist = 45) {
  let best = null;
  let bestDist = maxDist;
  for (const id in gameState.players) {
    if (id === pid) continue;
    const pl = gameState.players[id];
    if (!pl || pl.isDead) continue;
    const oppPos = pl.pos.clone();
    oppPos.y += CFG.H * 0.6;
    const toOpp = oppPos.clone().sub(eyePos);
    const dist = toOpp.length();
    if (dist < bestDist) {
      const dir = toOpp.clone().normalize();
      const hit = raycastWall(eyePos, dir, dist, obbs);
      const lineOfSight = !hit || hit.distance >= dist - 0.5;
      if (lineOfSight) {
        bestDist = dist;
        best = { id, player: pl, pos: oppPos, dir, dist };
      }
    }
  }
  return best;
}

// ------------------------------------------------------------------ main tick

/**
 * Called once per physics tick for every bot player.
 * Mutates pl.yaw, pl.pitch, and returns a keys object for physStep.
 */
export function tickBot(pid, pl, nowT, portals, PORT_, actions) {
  const onPortalPlaced = typeof actions === 'function' ? actions : (actions && actions.onPortalPlaced);
  const onFireRocket = actions && actions.onFireRocket;
  const onFireInstagib = actions && actions.onFireInstagib;

  const st = ensureState(pid);

  const eyePos = pl.pos.clone();
  eyePos.y += CFG.H - 0.15;
  const fwdDir = new TH.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));

  // ---- weapon swapping & tactical usage
  if (st.portalPhase !== 'none') {
    pl.activeWeapon = 1;
  } else if (nowT >= st.weaponHoldUntilT) {
    const destWall = findDestructibleWall(eyePos, fwdDir, 16.0);
    const opp = findOpponent(pid, eyePos, 35.0);

    if (destWall && nowT - st.lastRocketT > ROCKET_COOLDOWN_S && Math.random() < 0.45) {
      pl.activeWeapon = 2; // Swap to rocket launcher to blow up wall!
      st.weaponHoldUntilT = nowT + 2.0;
    } else if (opp && nowT - st.lastInstagibT > INSTAGIB_COOLDOWN_S && Math.random() < 0.45) {
      pl.activeWeapon = 3; // Swap to instagib to take a shot!
      st.weaponHoldUntilT = nowT + 1.8;
    } else if (nowT - st.lastWeaponSwapT > 5.0) {
      st.lastWeaponSwapT = nowT;
      const r = Math.random();
      if (r < 0.5) pl.activeWeapon = 1;
      else if (r < 0.75) pl.activeWeapon = 2;
      else pl.activeWeapon = 3;
      st.weaponHoldUntilT = nowT + 3.0 + Math.random() * 3.0;
    }
  }

  // ---- tactical weapon firing & rocket jump
  const distToTarget = st.targetPos ? Math.hypot(st.targetPos.x - pl.pos.x, st.targetPos.z - pl.pos.z) : 0;
  const heightDiffToTarget = st.targetPos ? (st.targetPos.y - pl.pos.y) : 0;
  if (
    pl.activeWeapon === 2 &&
    st.rocketJumpPhase === 'none' &&
    pl.grounded &&
    nowT - st.lastRocketJumpT > 10.0 &&
    (distToTarget > 5.0 || heightDiffToTarget > 1.0) &&
    Math.random() < 0.2
  ) {
    st.rocketJumpPhase = 'aim_down';
    st.rocketJumpT = nowT;
    st.lastRocketJumpT = nowT;
    st.weaponHoldUntilT = nowT + 3.0;
  } else if (pl.activeWeapon === 2 && nowT - st.lastRocketT > ROCKET_COOLDOWN_S && onFireRocket && st.rocketJumpPhase === 'none') {
    const destWall = findDestructibleWall(eyePos, fwdDir, 18.0);
    if (destWall) {
      st.lastRocketT = nowT;
      pl.pitch = Math.asin(Math.max(-0.99, Math.min(0.99, destWall.dir.y)));
      onFireRocket(eyePos, destWall.dir.clone().multiplyScalar(70), destWall);
      st.weaponHoldUntilT = nowT + 1.5;
    }
  } else if (pl.activeWeapon === 3) {
    const opp = findOpponent(pid, eyePos, 40.0);
    if (opp) {
      if (st.instagibTargetPid !== opp.id) {
        st.instagibTargetPid = opp.id;
        st.instagibAimStartT = nowT;
      }

      // Smooth aim convergence: yaw and pitch smoothly track opponent direction
      const targetYaw = Math.atan2(-opp.dir.x, -opp.dir.z);
      const targetPitch = Math.asin(Math.max(-0.99, Math.min(0.99, opp.dir.y)));

      let oppDyaw = targetYaw - pl.yaw;
      while (oppDyaw > Math.PI) oppDyaw -= Math.PI * 2;
      while (oppDyaw < -Math.PI) oppDyaw += Math.PI * 2;

      // Allow shooting only when bot has smoothly aimed onto the target (aiming time > 0.28s and close angle)
      const aimAligned = Math.abs(oppDyaw) < 0.12 && Math.abs(targetPitch - pl.pitch) < 0.14;
      const aimDwellOk = (nowT - st.instagibAimStartT) > 0.28;

      if (nowT - st.lastInstagibT > INSTAGIB_COOLDOWN_S && onFireInstagib && aimAligned && aimDwellOk) {
        // Re-verify line of sight right at the moment of firing
        const losHit = raycastWall(eyePos, opp.dir, opp.dist, obbs);
        const hasClearLOS = !losHit || losHit.distance >= opp.dist - 0.5;

        if (hasClearLOS) {
          st.lastInstagibT = nowT;

          // EXACT 5% CHANCE TO HIT OPPONENT
          const willHit = Math.random() < INSTAGIB_HIT_CHANCE;
          if (willHit) {
            const pts = [eyePos.clone(), opp.pos.clone()];
            onFireInstagib(pts, opp.id, null);
          } else {
            // 95% intentional near-miss that scorches surrounding environment
            const right = new TH.Vector3(-Math.cos(pl.yaw), 0, Math.sin(pl.yaw));
            const up = new TH.Vector3(0, 1, 0);
            const randAng = Math.random() * Math.PI * 2;
            const offsetMag = 0.08 + Math.random() * 0.12;
            const missDir = opp.dir.clone()
              .addScaledVector(right, Math.cos(randAng) * offsetMag)
              .addScaledVector(up, Math.sin(randAng) * offsetMag)
              .normalize();
            const hit = raycastWall(eyePos, missDir, 80, obbs);
            const endPt = hit ? hit.point : eyePos.clone().addScaledVector(missDir, 50);
            const scorch = hit ? { pos: endPt.toArray(), n: hit.normal.toArray() } : null;
            const pts = [eyePos.clone(), endPt];
            onFireInstagib(pts, null, scorch);
          }
          st.weaponHoldUntilT = nowT + 1.2;
        }
      }
    } else {
      st.instagibTargetPid = null;
    }
  }

  // ---- advance waypoint along route
  if (st.waypoints && st.waypoints.length > 0) {
    if (pl.pos.distanceTo(st.targetPos) < 2.2) {
      st.targetPos = st.waypoints.shift();
    }
  }

  // ---- think: re-pick goal every THINK_INTERVAL_MS
  if (nowT - st.lastThinkT > THINK_INTERVAL_MS / 1000) {
    st.lastThinkT = nowT;

    const needNewTarget = !st.targetPos
      || (pl.pos.distanceTo(st.targetPos) < 1.5 && (!st.waypoints || st.waypoints.length === 0))
      || st.stuckT > 1.8;

    if (needNewTarget) {
      if (st.waypoints && st.waypoints.length > 0) {
        st.targetPos = st.waypoints.shift();
      } else {
        const route = pickBotTargetAndRoute(pl.pos, portals);
        st.targetPos = route.target;
        st.waypoints = route.waypoints;
      }
      st.stuckT = 0;
      st.avoidUntilT = 0;
      st.unstuckUntilT = 0;
    }

    // Attempt portal shot occasionally (only when portal gun active)
    if (
      st.portalPhase === 'none' &&
      pl.activeWeapon === 1 &&
      nowT - st.lastPortalT > PORTAL_COOLDOWN_S &&
      Math.random() < PORTAL_CHANCE
    ) {
      st.portalPhase = 'aim_blue';
    }
  }

  if (!st.targetPos) {
    return { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
  }

  const dx = st.targetPos.x - pl.pos.x;
  const dz = st.targetPos.z - pl.pos.z;
  const dist = Math.hypot(dx, dz);

  let desiredYaw = Math.atan2(-dx, -dz);

  // ---- multi-whisker wall detection & smart obstacle avoidance
  const waistPos = new TH.Vector3(pl.pos.x, pl.pos.y + 0.65, pl.pos.z);
  const kneePos = new TH.Vector3(pl.pos.x, pl.pos.y + 0.25, pl.pos.z);
  const curFwd = new TH.Vector3(-Math.sin(pl.yaw), 0, -Math.cos(pl.yaw));
  const curRight = new TH.Vector3(-Math.cos(pl.yaw), 0, Math.sin(pl.yaw));

  const leftWaist = waistPos.clone().addScaledVector(curRight, -0.32);
  const rightWaist = waistPos.clone().addScaledVector(curRight, 0.32);

  const hitCenter = raycastWall(waistPos, curFwd, 2.2, obbs);
  const hitLeft = raycastWall(leftWaist, curFwd, 1.8, obbs);
  const hitRight = raycastWall(rightWaist, curFwd, 1.8, obbs);
  const hitLow = raycastWall(kneePos, curFwd, 1.6, obbs);

  let closestHit = hitCenter;
  for (const h of [hitLeft, hitRight, hitLow]) {
    if (h && (!closestHit || h.distance < closestHit.distance)) {
      closestHit = h;
    }
  }

  let isTallWall = false;
  let canStepOver = false;

  if (closestHit) {
    if (closestHit.obb.kind === 'ramp') {
      const contactHeight = closestHit.point.y - pl.pos.y;
      if (contactHeight < 0.85 || (closestHit.normal.y > 0.35 && contactHeight < 1.2)) {
        // Walkable ramp slope ahead - do not treat as wall!
        isTallWall = false;
        canStepOver = false;
        closestHit = null;
      } else if (contactHeight > 1.35) {
        isTallWall = true;
      }
    } else {
      const maxY = closestHit.obb.c.y
        + Math.abs(closestHit.obb.ax[0].y * closestHit.obb.he[0])
        + Math.abs(closestHit.obb.ax[1].y * closestHit.obb.he[1])
        + Math.abs(closestHit.obb.ax[2].y * closestHit.obb.he[2]);
      const stepHeight = maxY - pl.pos.y;
      isTallWall = stepHeight > 1.35;
      canStepOver = stepHeight > 0.35 && stepHeight <= 1.35;
    }

    if (isTallWall) {
      const toTarget = new TH.Vector3(dx, 0, dz).normalize();
      const testAngles = [
        0.45, -0.45, 0.9, -0.9, 1.35, -1.35, 1.8, -1.8, 2.3, -2.3, Math.PI
      ];
      let bestAngleYaw = null;
      let bestScore = -1e9;

      for (const ang of testAngles) {
        const testYaw = pl.yaw + ang;
        const testDir = new TH.Vector3(-Math.sin(testYaw), 0, -Math.cos(testYaw));
        const lTest = waistPos.clone().addScaledVector(new TH.Vector3(-Math.cos(testYaw), 0, Math.sin(testYaw)), -0.28);
        const rTest = waistPos.clone().addScaledVector(new TH.Vector3(-Math.cos(testYaw), 0, Math.sin(testYaw)), 0.28);

        const chH = raycastWall(waistPos, testDir, 2.0, obbs);
        const lH = raycastWall(lTest, testDir, 1.6, obbs);
        const rH = raycastWall(rTest, testDir, 1.6, obbs);

        const isRampWalkable = (h) => h && h.obb.kind === 'ramp' && ((h.point.y - pl.pos.y < 0.85) || (h.normal.y > 0.35));
        const chBlocked = chH && !isRampWalkable(chH);
        const lBlocked = lH && !isRampWalkable(lH);
        const rBlocked = rH && !isRampWalkable(rH);

        const testNextPos = pl.pos.clone().addScaledVector(testDir, 1.6);
        const testUnder = getRampUnderState(testNextPos);
        const underBlocked = testUnder && testUnder.clearance < 2.2;

        if (!chBlocked && !lBlocked && !rBlocked && !underBlocked && hasGroundAhead(pl.pos, testYaw, obbs)) {
          const dot = testDir.dot(toTarget);
          const score = dot - Math.abs(ang) * 0.15;
          if (score > bestScore) {
            bestScore = score;
            bestAngleYaw = testYaw;
          }
        }
      }

      if (bestAngleYaw !== null) {
        st.avoidYaw = bestAngleYaw;
        st.avoidUntilT = nowT + 0.65;
      } else if (closestHit && closestHit.normal) {
        const nx = closestHit.normal.x, nz = closestHit.normal.z;
        const nLen = Math.hypot(nx, nz);
        if (nLen > 0.05) {
          const tLeft = new TH.Vector3(-nz / nLen, 0, nx / nLen);
          const tRight = new TH.Vector3(nz / nLen, 0, -nx / nLen);
          const chosen = (tLeft.dot(toTarget) >= tRight.dot(toTarget)) ? tLeft : tRight;
          st.avoidYaw = Math.atan2(-chosen.x, -chosen.z);
          st.avoidUntilT = nowT + 0.65;
        }
      }
    }
  }

  // Priority steering: instagib tracking > wall avoidance > orange portal aim > navigation
  let activeOpp = null;
  if (pl.activeWeapon === 3 && st.instagibTargetPid && gameState.players[st.instagibTargetPid] && !gameState.players[st.instagibTargetPid].isDead) {
    const oppPl = gameState.players[st.instagibTargetPid];
    const oppHead = oppPl.pos.clone();
    oppHead.y += CFG.H * 0.6;
    const toOpp = oppHead.sub(eyePos);
    activeOpp = { dir: toOpp.clone().normalize(), dist: toOpp.length() };
  }

  const underNow = getRampUnderState(pl.pos);

  if (activeOpp) {
    desiredYaw = Math.atan2(-activeOpp.dir.x, -activeOpp.dir.z);
  } else if (underNow && underNow.clearance < 2.5) {
    const toCenter = new TH.Vector3(-pl.pos.x, 0, -pl.pos.z).normalize();
    const escX = underNow.fwdX * 0.6 + toCenter.x * 0.8;
    const escZ = underNow.fwdZ * 0.6 + toCenter.z * 0.8;
    desiredYaw = Math.atan2(-escX, -escZ);
    st.avoidYaw = desiredYaw;
    st.avoidUntilT = nowT + 0.6;
    isTallWall = false;
    canStepOver = false;
  } else if (nowT < st.avoidUntilT && st.portalPhase !== 'aim_orange') {
    desiredYaw = st.avoidYaw;
  } else if (st.portalPhase === 'aim_orange') {
    desiredYaw = st.aimOrangeYaw;
  }

  // Smooth yaw rotation
  let dyaw = desiredYaw - pl.yaw;
  while (dyaw > Math.PI) dyaw -= Math.PI * 2;
  while (dyaw < -Math.PI) dyaw += Math.PI * 2;

  const maxTurn = (activeOpp ? 4.2 : 4.8) * DT;
  if (Math.abs(dyaw) > maxTurn) {
    pl.yaw += Math.sign(dyaw) * maxTurn;
  } else {
    pl.yaw += dyaw;
  }
  while (pl.yaw > Math.PI) pl.yaw -= Math.PI * 2;
  while (pl.yaw < -Math.PI) pl.yaw += Math.PI * 2;

  // Smooth pitch: default to horizontal level gaze (pitch 0) rather than looking up at platforms
  const targetPitch = activeOpp
    ? Math.asin(Math.max(-0.99, Math.min(0.99, activeOpp.dir.y)))
    : Math.max(-0.25, Math.min(0.25, ((st.targetPos.y - pl.pos.y) - 1.5) * 0.04));

  if (st.rocketJumpPhase === 'aim_down') {
    const rjPitch = -1.35;
    pl.pitch += (rjPitch - pl.pitch) * Math.min(1, 14.0 * DT);

    if (pl.pitch <= -1.15 || nowT - st.rocketJumpT > 0.22) {
      pl.jumpBuf = nowT;
      const rjPos = pl.pos.clone();
      rjPos.y += 0.35;
      const rjDir = new TH.Vector3(-Math.sin(pl.yaw) * 0.15, -0.98, -Math.cos(pl.yaw) * 0.15).normalize();
      const rjHit = { point: pl.pos.clone(), normal: new TH.Vector3(0, 1, 0) };
      if (onFireRocket) {
        onFireRocket(rjPos, rjDir.multiplyScalar(70), rjHit);
      }
      st.lastRocketT = nowT;
      st.rocketJumpPhase = 'recover';
      st.rocketJumpT = nowT;
    }
  } else if (st.rocketJumpPhase === 'recover') {
    pl.pitch += (targetPitch - pl.pitch) * Math.min(1, 8.0 * DT);
    if (nowT - st.rocketJumpT > 0.4) {
      st.rocketJumpPhase = 'none';
    }
  } else {
    pl.pitch += (targetPitch - pl.pitch) * Math.min(1, (activeOpp ? 4.5 : 6.0) * DT);
  }

  // ---- stuck tracking & active unstuck
  if (st.lastTickPos) {
    const dMoved = pl.pos.distanceTo(st.lastTickPos);
    if (dist > 0.8 && dMoved < 0.02) {
      st.stuckT += DT;
    } else if (dMoved > 0.05) {
      st.stuckT = Math.max(0, st.stuckT - DT * 3.0);
    }
  }
  st.lastTickPos = pl.pos.clone();

  // If blocked for > 0.3s:
  if (st.stuckT > 0.3) {
    if (!underNow && (canStepOver || (closestHit && closestHit.distance < 1.2 && pl.grounded))) {
      pl.jumpBuf = nowT;
    }
    if (isTallWall) {
      const destWall = findDestructibleWall(eyePos, curFwd, 6.0);
      if (destWall && nowT - st.lastRocketT > 5.0 && onFireRocket) {
        pl.activeWeapon = 2;
        st.lastRocketT = nowT;
        st.weaponHoldUntilT = nowT + 1.5;
        onFireRocket(eyePos, destWall.dir.clone().multiplyScalar(70), destWall);
      }
      if (nowT > st.unstuckUntilT && nowT - st.lastUnstuckT > 0.8) {
        st.unstuckUntilT = nowT + 0.45;
        st.lastUnstuckT = nowT;
        st.strafeDir = Math.random() < 0.5 ? 'KeyA' : 'KeyD';
      }
    }
  }

  let keys = {
    KeyW: st.portalPhase !== 'aim_orange' && Math.abs(dyaw) < 1.1 && (dist > 0.6 || st.portalPhase === 'walk_thru' || underNow != null),
    KeyA: false,
    KeyS: false,
    KeyD: false,
    Space: false,
    ShiftLeft: false
  };

  if (underNow && underNow.clearance < 2.2) {
    keys.Space = false;
    keys.KeyW = true;
    keys.KeyS = false;
  }

  if (st.rocketJumpPhase === 'aim_down' || st.rocketJumpPhase === 'recover') {
    keys.KeyW = true;
    if (st.rocketJumpPhase === 'aim_down' && (pl.pitch <= -1.15 || nowT - st.rocketJumpT > 0.2)) {
      keys.Space = true;
    }
  }

  // If in unstuck maneuver: back up and strafe
  if (nowT < st.unstuckUntilT) {
    keys.KeyW = false;
    keys.KeyS = true;
    if (st.strafeDir) keys[st.strafeDir] = true;
  }

  // If stuck for over 1.0s: pick new target, turn around, and jump
  if (st.stuckT > 1.0) {
    const route = pickBotTargetAndRoute(pl.pos, portals);
    st.targetPos = route.target;
    st.waypoints = route.waypoints;
    if (underNow) {
      const toCenter = new TH.Vector3(-pl.pos.x, 0, -pl.pos.z).normalize();
      st.avoidYaw = Math.atan2(-toCenter.x, -toCenter.z);
    } else {
      st.avoidYaw = pl.yaw + Math.PI * (0.8 + Math.random() * 0.4);
      pl.jumpBuf = nowT;
    }
    st.avoidUntilT = nowT + 0.9;
    st.stuckT = 0;
    st.unstuckUntilT = 0;
  }

  // ---- portal logic
  const botPortalBase = getBotPortalBase(pl);

  if (st.portalPhase === 'aim_blue') {
    const hitRes = findPortalSurface(pl.pos, pl.yaw, obbs, portals, PORT_, botPortalBase);
    if (hitRes && !isPortalOnDestroyedWall(hitRes.surface.c, hitRes.surface.n, hitRes.surface.r, hitRes.surface.u, PORT_)) {
      const surface = hitRes.surface;
      pl.pitch = hitRes.pitch;
      const P = portals[botPortalBase];
      P.placed = true;
      P.c.copy(surface.c);
      P.n.copy(surface.n);
      P.r.copy(surface.r);
      P.u.copy(surface.u);

      if (onPortalPlaced) onPortalPlaced(botPortalBase, surface, surface.eyePos);

      st.portalPhase = 'aim_orange';
      const turnDir = Math.random() < 0.5 ? 1 : -1;
      st.aimOrangeYaw = pl.yaw + turnDir * (Math.PI * 0.55 + Math.random() * 0.4);
      while (st.aimOrangeYaw > Math.PI) st.aimOrangeYaw -= Math.PI * 2;
      while (st.aimOrangeYaw < -Math.PI) st.aimOrangeYaw += Math.PI * 2;
      st.orangeAimT = nowT;
    } else {
      st.portalPhase = 'none';
      st.lastPortalT = nowT + 3.0;
    }
  } else if (st.portalPhase === 'aim_orange') {
    const yawDiff = Math.abs(st.aimOrangeYaw - pl.yaw);
    if (yawDiff < 0.4 || (nowT - st.orangeAimT > 0.8)) {
      const pIdx = botPortalBase + 1;
      const hitRes = findPortalSurface(pl.pos, pl.yaw, obbs, portals, PORT_, pIdx);
      if (hitRes && !isPortalOnDestroyedWall(hitRes.surface.c, hitRes.surface.n, hitRes.surface.r, hitRes.surface.u, PORT_)) {
        const surface = hitRes.surface;
        pl.pitch = hitRes.pitch;
        const P = portals[pIdx];
        P.placed = true;
        P.c.copy(surface.c);
        P.n.copy(surface.n);
        P.r.copy(surface.r);
        P.u.copy(surface.u);

        if (onPortalPlaced) onPortalPlaced(pIdx, surface, surface.eyePos);

        st.portalPhase = 'walk_thru';
        st.lastPortalT = nowT;
        st.walkThruT = nowT;
      } else if (nowT - st.orangeAimT > 2.2) {
        st.portalPhase = 'none';
        st.lastPortalT = nowT + 3.0;
      }
    }
  } else if (st.portalPhase === 'walk_thru') {
    const bluePortal = portals[botPortalBase];
    const orangePortal = portals[botPortalBase + 1];

    if (bluePortal.placed) {
      st.targetPos = bluePortal.c.clone().addScaledVector(bluePortal.n, -0.6);
      const portalBottomY = bluePortal.c.y - PORT_.hh;
      if (pl.pos.distanceTo(bluePortal.c) < 2.5 && portalBottomY > pl.pos.y + 0.35) {
        pl.jumpBuf = nowT;
      }
    }

    const passedThrough = orangePortal.placed && pl.pos.distanceTo(orangePortal.c) < 2.5 && (nowT - st.walkThruT > 0.25);
    const reachedBlue = bluePortal.placed && pl.pos.distanceTo(bluePortal.c) < 0.9;
    const timedOut = nowT - st.walkThruT > 6.0;

    if (passedThrough || reachedBlue || timedOut) {
      st.portalPhase = 'none';
      const route = pickBotTargetAndRoute(pl.pos, portals);
      st.targetPos = route.target;
      st.waypoints = route.waypoints;
      st.lastPortalT = nowT;
    }
  }

  // ---- jump decision:
  const jumpForLedge = heightDiffToTarget > 0.4 && heightDiffToTarget < 1.6 && dist < 3.5;
  const shouldJump = pl.grounded && !isTallWall && (
    canStepOver ||
    jumpForLedge ||
    !hasGroundAhead(pl.pos, pl.yaw, obbs)
  );

  if (shouldJump && nowT - st.lastJumpT > JUMP_COOLDOWN_S) {
    pl.jumpBuf = nowT;
    st.lastJumpT = nowT;
  }

  if (dist < 0.5 && st.portalPhase !== 'walk_thru') {
    keys.KeyW = false;
  }

  return keys;
}

// ------------------------------------------------------------------ bot portal base index

/**
 * Returns the portal pair base index (0 or 2) for the given bot.
 * playerIndex 0 uses pair 0 (portals 0 and 1), playerIndex 1 uses pair 1 (portals 2 and 3).
 */
export function getBotPortalBase(pl) {
  return (pl && pl.playerIndex === 0) ? 0 : 2;
}

// ------------------------------------------------------------------ cleanup & reset

export function resetBotState(pid) {
  const st = botState.get(pid);
  if (st) {
    st.targetPos = null;
    st.portalPhase = 'none';
    st.rocketJumpPhase = 'none';
    st.lastPortalT = Date.now() / 1000;
    st.lastRocketT = -999;
    st.lastRocketJumpT = -999;
    st.lastInstagibT = -999;
    st.lastWeaponSwapT = 0;
    st.weaponHoldUntilT = 0;
    st.stuckT = 0;
    st.prevPos = null;
    st.lastTickPos = null;
    st.avoidUntilT = 0;
    st.avoidYaw = 0;
    st.unstuckUntilT = 0;
    st.strafeDir = null;
    st.instagibTargetPid = null;
    st.instagibAimStartT = 0;
    st.lastUnstuckT = 0;
    st.waypoints = [];
  }
  if (gameState.players[pid]) {
    gameState.players[pid].crouchT = 0;
  }
}

export function removeBot(pid) {
  botState.delete(pid);
}

export function cleanupBotPortals(pid, pl, portals) {
  const base = getBotPortalBase(pl);
  if (portals[base]) portals[base].placed = false;
  if (portals[base + 1]) portals[base + 1].placed = false;
}
