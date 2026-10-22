/**
 * Server-side bot AI and Agent representation.
 */

import * as TH from 'three';
import { CFG, PORT, TICK_RATE } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

const physics = initPhysics(TH, CFG, PORT);

// ------------------------------------------------------------------ constants

const DT = 1 / TICK_RATE;
const THINK_INTERVAL_MS = 350;
const PORTAL_COOLDOWN_S = 4.5;
const PORTAL_CHANCE = 0.55;
const JUMP_COOLDOWN_S = 0.35;
const ROCKET_COOLDOWN_S = 8.0;
const INSTAGIB_COOLDOWN_S = 6.0;
const INSTAGIB_HIT_CHANCE = 0.20;

export const FUNNY_BOT_NAMES = [
  'SirLagALot', 'AimBot9000', 'PotatoAim', 'GibMagnet', 'RocketClown',
  'GlitchyMcFly', 'ToastLord', 'NoScopeGrandpa', 'OopsAllPortals', 'CampyMcCampface',
  'CtrlAltDefeat', 'ByteMe', 'LavaEnthusiast', 'PanicJumper', 'YeetMaster',
  'RoombaWithAGun', 'RubberBander', 'FragBait', 'DizzieRascal', 'WallHugger',
  'PixelPusher', 'CaptainWhiff', 'SpawnCamper', 'BogoSort', 'Error404Skill',
  'QuantumNoob', 'ClickHappy', 'Overclocker', 'PacketLoss', 'TriggerTroll'
];

// ------------------------------------------------------------------ pure helpers

function getRampEndpoints(rm) {
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

function getRampUnderState(pos, mapData) {
  const ramps = mapData?.ramps || [];
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

function getRampAtPos(pos, mapData) {
  const ramps = mapData?.ramps || [];
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

    if (s >= -hl - 0.6 && s <= hl + 0.6 && Math.abs(w) <= hw + 0.6) {
      const u = Math.max(0, Math.min(1, (s + hl) / rm.len));
      const u2 = u * u, u3 = u2 * u;
      const smooth = u3 * (u * (u * 6 - 15) + 10);
      const yTop = rm.y0 + rm.rise * smooth;
      const yBot = yTop - (rm.T || 0.6);

      const onRamp = (pos.y >= yBot - 0.25 && pos.y <= yTop + 1.25);
      const nearRamp = (pos.y >= rm.y0 - 0.6 && pos.y <= rm.y0 + rm.rise + 1.6);
      return { rm, s, w, hl, hw, fwdX, fwdZ, rightX, rightZ, yTop, yBot, onRamp, nearRamp, u };
    }
  }
  return null;
}

function pickBotTargetAndRoute(curPos, portals, mapData) {
  const pos = curPos || new TH.Vector3();
  const underAtPick = getRampUnderState(pos, mapData);
  if (underAtPick && underAtPick.clearance < 2.5) {
    const toCenter = new TH.Vector3(-pos.x, 0, -pos.z).normalize();
    const escTarget = pos.clone().addScaledVector(toCenter, 8.0);
    escTarget.y = 0;
    return {
      target: escTarget,
      waypoints: []
    };
  }

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

  const ramps = mapData?.ramps || [];
  if (ramps.length > 0 && Math.random() < 0.35) {
    const rm = ramps[Math.floor(Math.random() * ramps.length)];
    const ep = getRampEndpoints(rm);

    const elevated = (mapData.slabs || []).filter(s => s.kind === 'plat' && Math.hypot(s.c[0] - ep.high.x, s.c[2] - ep.high.z) < 14 && s.c[1] >= ep.high.y - 1.5);
    let finalTarget = ep.high.clone();
    if (elevated.length > 0) {
      const plat = elevated[Math.floor(Math.random() * elevated.length)];
      finalTarget = new TH.Vector3(plat.c[0], plat.c[1] + plat.s[1] * 0.5, plat.c[2]);
    }

    if (pos.y < ep.high.y - 1.0) {
      const approachLow = ep.low.clone().addScaledVector(ep.fwd, -2.0);
      const startRamp = ep.low.clone().addScaledVector(ep.fwd, 1.5);
      const midRamp = new TH.Vector3(rm.cx, rm.y0 + rm.rise * 0.5, rm.cz);

      const dToLow = pos.distanceTo(ep.low);
      const dotFwd = pos.clone().sub(ep.low).dot(ep.fwd);
      if (dotFwd > 0.5 && dToLow < rm.len) {
        return {
          target: midRamp,
          waypoints: [ep.high.clone(), finalTarget]
        };
      } else if (dToLow < 2.5) {
        return {
          target: startRamp,
          waypoints: [midRamp, ep.high.clone(), finalTarget]
        };
      } else {
        return {
          target: approachLow,
          waypoints: [startRamp, midRamp, ep.high.clone(), finalTarget]
        };
      }
    } else {
      return {
        target: finalTarget,
        waypoints: []
      };
    }
  }

  const spawns = (mapData?.spawns || []).filter(sp => {
    const u = getRampUnderState(new TH.Vector3(sp.x, sp.y, sp.z), mapData);
    return !u || u.clearance >= 2.2;
  });
  const validSpawns = spawns.length > 0 ? spawns : (mapData?.spawns || []);

  const elevated = (mapData?.slabs || []).filter(s => s.kind === 'plat' && s.c[1] > 0.5);
  if (elevated.length > 0 && Math.random() < 0.25) {
    const plat = elevated[Math.floor(Math.random() * elevated.length)];
    return {
      target: new TH.Vector3(plat.c[0], plat.c[1] + plat.s[1] * 0.5, plat.c[2]),
      waypoints: []
    };
  }
  const sp = validSpawns[Math.floor(Math.random() * validSpawns.length)] || { x: 0, y: 0, z: 0 };
  return {
    target: new TH.Vector3(sp.x, sp.y, sp.z),
    waypoints: []
  };
}

function hasGroundAhead(pos, yaw, obbs_) {
  const ahead = new TH.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const checkPos = pos.clone().addScaledVector(ahead, 0.8);
  checkPos.y += 0.5;
  const downDir = new TH.Vector3(0, -1, 0);

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
      if (Math.abs(vd) < 1e-7) {
        if (Math.abs(o) > obb.he[k]) { par = true; break; }
      } else {
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
    if (par || hitAxis < 0 || tmax < 0.05 || tmin < 0.05 || tmin > bestT) continue;

    const point = origin.clone().addScaledVector(dir, tmin);
    const normal = obb.ax[hitAxis].clone().multiplyScalar(-hitSign);
    best = { point, normal, obb, distance: tmin, hitAxis, hitSign };
    bestT = tmin;
  }
  return best;
}

function checkPortalOverlap(c, n, r, u, portals, excludeIdx, PORT_) {
  for (let i = 0; i < portals.length; i++) {
    if (i === excludeIdx) continue;
    const Q = portals[i];
    if (!Q || !Q.placed) continue;

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

    if (c.distanceTo(Q.c) < Math.max(PORT_.hw, PORT_.hh) * 1.5) {
      return true;
    }
  }
  return false;
}

function findPortalSurfaceAtPitch(pos, yaw, pitch, obbs_, portals, PORT_, currentPi, session) {
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
  if (session?.gameState?.destroyedWallObbs && session.gameState.destroyedWallObbs.some(dob => dob.id === hit.obb.id)) return null;

  const { point, normal, obb, hitAxis, hitSign } = hit;

  const ref = Math.abs(normal.y) > 0.98 ? new TH.Vector3(0, 0, 1) : new TH.Vector3(0, 1, 0);
  const r = new TH.Vector3().crossVectors(ref, normal).normalize();
  if (r.lengthSq() < 1e-8) return null;
  const u = new TH.Vector3().crossVectors(normal, r);

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

  const valid = physics.findClosestValidPortalPos(
    adjustedC, normal, r, u, obb, currentPi,
    obbs_, portals, session?.mapData?.lava, session?.gameState?.destroyedWallObbs, session?.gameState?.destroyedWalls
  );
  if (!valid) {
    return null;
  }

  return { c: valid.c, n: normal, r, u, eyePos };
}

function findPortalSurfaceInCone(pos, baseYaw, obbs_, portals, PORT_, currentPi, session) {
  const yawOffsets = [0, -0.25, 0.25, -0.5, 0.5];
  const testPitches = [0.05, 0.15, -0.05, 0.25, -0.15];
  for (const yOff of yawOffsets) {
    const y = baseYaw + yOff;
    for (const p of testPitches) {
      const res = findPortalSurfaceAtPitch(pos, y, p, obbs_, portals, PORT_, currentPi, session);
      if (res && (!session || !session.isPortalOnDestroyedWall(res.c, res.n, res.r, res.u, PORT_))) {
        const eyePos = pos.clone();
        eyePos.y += CFG.H - 0.12;
        const toSpot = res.c.clone().sub(eyePos);
        const aimYaw = Math.atan2(-toSpot.x, -toSpot.z);
        const aimPitch = Math.asin(Math.max(-0.99, Math.min(0.99, toSpot.y / toSpot.length())));
        return { surface: res, aimYaw, aimPitch };
      }
    }
  }
  return null;
}

function findSecondaryPortalSurface(pos, primaryN, obbs_, portals, PORT_, currentPi, session) {
  const angleSpreads = [Math.PI * 0.5, -Math.PI * 0.5, Math.PI * 0.8, -Math.PI * 0.8, Math.PI, 0];
  const testPitches = [0.05, 0.2, -0.05, 0.35, -0.15];
  const baseAngle = Math.atan2(primaryN.x, primaryN.z);
  for (const ang of angleSpreads) {
    const y = baseAngle + ang;
    for (const p of testPitches) {
      const res = findPortalSurfaceAtPitch(pos, y, p, obbs_, portals, PORT_, currentPi, session);
      if (res && (!session || !session.isPortalOnDestroyedWall(res.c, res.n, res.r, res.u, PORT_))) {
        if (checkPortalOverlap(res.c, res.n, res.r, res.u, portals, currentPi, PORT_)) continue;
        const eyePos = pos.clone();
        eyePos.y += CFG.H - 0.12;
        const toSpot = res.c.clone().sub(eyePos);
        const aimYaw = Math.atan2(-toSpot.x, -toSpot.z);
        const aimPitch = Math.asin(Math.max(-0.99, Math.min(0.99, toSpot.y / toSpot.length())));
        return { surface: res, aimYaw, aimPitch };
      }
    }
  }
  return null;
}

function findDestructibleWall(eyePos, fwdDir, obbs, session, maxDist = 20) {
  let best = null;
  let bestScore = -1e9;
  for (const obb of obbs) {
    if (obb.kind !== 'wall' || obb.boundary || obb.destroyed) continue;
    if (session?.gameState?.destroyedWallObbs && session.gameState.destroyedWallObbs.some(dob => dob.id === obb.id)) continue;
    const uIdx = obb.he[0] >= obb.he[2] ? 0 : 2;
    const tIdx = uIdx === 0 ? 2 : 0;
    if (obb.he[tIdx] > 2.5) continue;

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

function findOpponent(pid, eyePos, players, obbs, maxDist = 45) {
  let best = null;
  let bestDist = maxDist;
  for (const id in players) {
    if (id === pid) continue;
    const pl = players[id];
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

/**
 * BotAgent — Encapsulates an authoritative AI bot combatant and its steering/combat behaviors.
 */
export class BotAgent {
  static _nextBotId = 0;

  static generateName(existingNames = new Set()) {
    const available = FUNNY_BOT_NAMES.filter(n => !existingNames.has(n));
    const pool = available.length > 0 ? available : FUNNY_BOT_NAMES;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * @param {Object|number} [arg1]
   * @param {Object} [arg2]
   * @param {Set<string>} [arg3]
   */
  constructor(arg1, arg2, arg3) {
    let botId, playerIndex, name, spawn, spawnIdx;
    if (typeof arg1 === 'object' && arg1 !== null && ('botId' in arg1 || 'spawn' in arg1)) {
      ({ botId, playerIndex = 0, name = '', spawn = { x: 0, y: 0, z: 0 }, spawnIdx = null } = arg1);
      if (!botId) botId = 'bot_' + (BotAgent._nextBotId++);
      if (!name) name = BotAgent.generateName();
    } else {
      playerIndex = arg1 || 0;
      spawn = arg2 || { x: 0, y: 0, z: 0 };
      const existingNames = arg3 instanceof Set ? arg3 : new Set();
      botId = 'bot_' + (BotAgent._nextBotId++);
      name = BotAgent.generateName(existingNames);
      spawnIdx = null;
    }

    this.botId = botId;
    this.isBot = true;
    this.playerIndex = playerIndex;
    this.name = name;
    this.ws = null;

    this.pos = new TH.Vector3(spawn.x, spawn.y, spawn.z);
    this.vel = new TH.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.grounded = false;
    this.groundNormal = new TH.Vector3(0, 1, 0);
    this.groundT = -1;
    this.jumpBuf = -1;
    this.maxSpeed = 0;
    this.ping = 0;
    this.shots = 0;
    this.hits = 0;
    this.inputBuffer = [];
    this.spawnIdx = spawnIdx;
    this.activeWeapon = 1;
    this.crouchT = 0;
    this.isDead = false;
    this.viewOffset = null;

    this.aiState = this._createInitialAIState();
  }

  get portalBaseIndex() {
    return this.playerIndex === 0 ? 0 : 2;
  }

  _createInitialAIState() {
    return {
      targetPos: null,
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
      portalPhase: 'none',
      walkThruT: 0,
      stuckT: 0,
      prevPos: null,
      lastTickPos: null,
      avoidUntilT: 0,
      avoidYaw: 0,
      primarySurface: null,
      primaryAimYaw: 0,
      primaryAimPitch: 0,
      primaryAimT: 0,
      secondarySurface: null,
      secondaryAimYaw: 0,
      secondaryAimPitch: 0,
      secondaryAimT: 0,
      secondaryDelayUntil: 0,
      unstuckUntilT: 0,
      strafeDir: null,
      instagibTargetPid: null,
      instagibAimStartT: 0,
      lastUnstuckT: 0,
      waypoints: []
    };
  }

  resetAI() {
    this.aiState = this._createInitialAIState();
    this.aiState.lastPortalT = Date.now() / 1000;
    this.crouchT = 0;
  }

  cleanupPortals(portals) {
    const base = this.portalBaseIndex;
    if (portals[base]) portals[base].placed = false;
    if (portals[base + 1]) portals[base + 1].placed = false;
  }

  /**
   * Execute bot decision-making, aiming, weapon selection, and steering.
   * @param {number} nowT - Server timestamp in seconds
   * @param {import('../match/MatchSession.js').MatchSession} session - Active match session
   * @param {Object} [actions={}] - Callbacks for actions (portal, rocket, instagib)
   * @param {Object} [PORT_=PORT] - Portal sizing configuration
   * @returns {Record<string, boolean>} Active keys for this tick
   */
  tick(nowT, session, actions = {}, PORT_ = PORT) {
    const onPortalPlaced = typeof actions === 'function' ? actions : (actions && actions.onPortalPlaced);
    const onFireRocket = actions && actions.onFireRocket;
    const onFireInstagib = actions && actions.onFireInstagib;

    const st = this.aiState;
    const obbs = session?.obbs || [];
    const portals = session?.gameState?.portals || [];
    const players = session?.gameState?.players || {};
    const mapData = session?.mapData;

    const eyePos = this.pos.clone();
    eyePos.y += CFG.H - 0.15;
    const fwdDir = new TH.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));

    if (st.portalPhase !== 'none') {
      this.activeWeapon = 1;
    } else if (nowT >= st.weaponHoldUntilT) {
      const destWall = findDestructibleWall(eyePos, fwdDir, obbs, session, 16.0);
      const opp = findOpponent(this.botId, eyePos, players, obbs, 35.0);

      if (destWall && nowT - st.lastRocketT > ROCKET_COOLDOWN_S && Math.random() < 0.45) {
        this.activeWeapon = 2;
        st.weaponHoldUntilT = nowT + 2.0;
      } else if (opp && nowT - st.lastInstagibT > INSTAGIB_COOLDOWN_S && Math.random() < 0.45) {
        this.activeWeapon = 3;
        st.weaponHoldUntilT = nowT + 1.8;
      } else if (nowT - st.lastWeaponSwapT > 5.0) {
        st.lastWeaponSwapT = nowT;
        const r = Math.random();
        if (r < 0.5) this.activeWeapon = 1;
        else if (r < 0.75) this.activeWeapon = 2;
        else this.activeWeapon = 3;
        st.weaponHoldUntilT = nowT + 3.0 + Math.random() * 3.0;
      }
    }

    const distToTarget = st.targetPos ? Math.hypot(st.targetPos.x - this.pos.x, st.targetPos.z - this.pos.z) : 0;
    const heightDiffToTarget = st.targetPos ? (st.targetPos.y - this.pos.y) : 0;
    if (
      this.activeWeapon === 2 &&
      st.rocketJumpPhase === 'none' &&
      this.grounded &&
      nowT - st.lastRocketJumpT > 10.0 &&
      (distToTarget > 5.0 || heightDiffToTarget > 1.0) &&
      Math.random() < 0.2
    ) {
      st.rocketJumpPhase = 'aim_down';
      st.rocketJumpT = nowT;
      st.lastRocketJumpT = nowT;
      st.weaponHoldUntilT = nowT + 3.0;
    } else if (this.activeWeapon === 2 && nowT - st.lastRocketT > ROCKET_COOLDOWN_S && onFireRocket && st.rocketJumpPhase === 'none') {
      const destWall = findDestructibleWall(eyePos, fwdDir, obbs, session, 18.0);
      if (destWall) {
        st.lastRocketT = nowT;
        this.pitch = Math.asin(Math.max(-0.99, Math.min(0.99, destWall.dir.y)));
        onFireRocket(eyePos, destWall.dir.clone().multiplyScalar(70), destWall);
        st.weaponHoldUntilT = nowT + 1.5;
      }
    } else if (this.activeWeapon === 3) {
      const opp = findOpponent(this.botId, eyePos, players, obbs, 40.0);
      if (opp) {
        if (st.instagibTargetPid !== opp.id) {
          st.instagibTargetPid = opp.id;
          st.instagibAimStartT = nowT;
        }

        const targetYaw = Math.atan2(-opp.dir.x, -opp.dir.z);
        const targetPitch = Math.asin(Math.max(-0.99, Math.min(0.99, opp.dir.y)));

        let oppDyaw = targetYaw - this.yaw;
        while (oppDyaw > Math.PI) oppDyaw -= Math.PI * 2;
        while (oppDyaw < -Math.PI) oppDyaw += Math.PI * 2;

        const aimAligned = Math.abs(oppDyaw) < 0.12 && Math.abs(targetPitch - this.pitch) < 0.14;
        const aimDwellOk = (nowT - st.instagibAimStartT) > 0.28;

        if (nowT - st.lastInstagibT > INSTAGIB_COOLDOWN_S && onFireInstagib && aimAligned && aimDwellOk) {
          const losHit = raycastWall(eyePos, opp.dir, opp.dist, obbs);
          const hasClearLOS = !losHit || losHit.distance >= opp.dist - 0.5;

          if (hasClearLOS) {
            st.lastInstagibT = nowT;
            const willHit = Math.random() < INSTAGIB_HIT_CHANCE;
            if (willHit) {
              const pts = [eyePos.clone(), opp.pos.clone()];
              onFireInstagib(pts, opp.id, null);
            } else {
              const right = new TH.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
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

    if (st.waypoints && st.waypoints.length > 0) {
      const hDist = Math.hypot(st.targetPos.x - this.pos.x, st.targetPos.z - this.pos.z);
      if (hDist < 1.3 && Math.abs(st.targetPos.y - this.pos.y) < 1.8) {
        st.targetPos = st.waypoints.shift();
        st.stuckT = 0;
        st.avoidUntilT = 0;
        st.unstuckUntilT = 0;
      }
    }

    if (nowT - st.lastThinkT > THINK_INTERVAL_MS / 1000) {
      st.lastThinkT = nowT;

      const hDistToTarget = st.targetPos ? Math.hypot(st.targetPos.x - this.pos.x, st.targetPos.z - this.pos.z) : 0;
      const reachedTarget = st.targetPos && (hDistToTarget < 1.3 && Math.abs(st.targetPos.y - this.pos.y) < 1.8);

      const needNewTarget = !st.targetPos
        || (reachedTarget && (!st.waypoints || st.waypoints.length === 0))
        || st.stuckT > 1.8;

      if (needNewTarget) {
        if (st.waypoints && st.waypoints.length > 0) {
          st.targetPos = st.waypoints.shift();
        } else {
          const route = pickBotTargetAndRoute(this.pos, portals, mapData);
          st.targetPos = route.target;
          st.waypoints = route.waypoints;
        }
        st.stuckT = 0;
        st.avoidUntilT = 0;
        st.unstuckUntilT = 0;
      }

      if (
        st.portalPhase === 'none' &&
        this.activeWeapon === 1 &&
        nowT - st.lastPortalT > PORTAL_COOLDOWN_S &&
        Math.random() < PORTAL_CHANCE
      ) {
        const botPortalBase = this.portalBaseIndex;
        const primaryFound = findPortalSurfaceInCone(this.pos, this.yaw, obbs, portals, PORT_, botPortalBase, session);
        if (primaryFound) {
          st.primarySurface = primaryFound.surface;
          st.primaryAimYaw = primaryFound.aimYaw;
          st.primaryAimPitch = primaryFound.aimPitch;
          st.primaryAimT = nowT;
          st.portalPhase = 'aim_primary';
        } else {
          st.lastPortalT = nowT + 2.0;
        }
      }
    }

    if (!st.targetPos) {
      return { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
    }

    const dx = st.targetPos.x - this.pos.x;
    const dz = st.targetPos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);

    let desiredYaw = Math.atan2(-dx, -dz);

    const waistPos = new TH.Vector3(this.pos.x, this.pos.y + 0.65, this.pos.z);
    const kneePos = new TH.Vector3(this.pos.x, this.pos.y + 0.25, this.pos.z);
    const curFwd = new TH.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const curRight = new TH.Vector3(-Math.cos(this.yaw), 0, Math.sin(this.yaw));

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
        isTallWall = false;
        canStepOver = false;
        closestHit = null;
      } else {
        const maxY = closestHit.obb.c.y
          + Math.abs(closestHit.obb.ax[0].y * closestHit.obb.he[0])
          + Math.abs(closestHit.obb.ax[1].y * closestHit.obb.he[1])
          + Math.abs(closestHit.obb.ax[2].y * closestHit.obb.he[2]);
        const stepHeight = maxY - this.pos.y;
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
          const testYaw = this.yaw + ang;
          const testDir = new TH.Vector3(-Math.sin(testYaw), 0, -Math.cos(testYaw));
          const lTest = waistPos.clone().addScaledVector(new TH.Vector3(-Math.cos(testYaw), 0, Math.sin(testYaw)), -0.28);
          const rTest = waistPos.clone().addScaledVector(new TH.Vector3(-Math.cos(testYaw), 0, Math.sin(testYaw)), 0.28);

          const chH = raycastWall(waistPos, testDir, 2.0, obbs);
          const lH = raycastWall(lTest, testDir, 1.6, obbs);
          const rH = raycastWall(rTest, testDir, 1.6, obbs);

          const isRampWalkable = (h) => h && h.obb.kind === 'ramp';
          const chBlocked = chH && !isRampWalkable(chH);
          const lBlocked = lH && !isRampWalkable(lH);
          const rBlocked = rH && !isRampWalkable(rH);

          const testNextPos = this.pos.clone().addScaledVector(testDir, 1.6);
          const testUnder = getRampUnderState(testNextPos, mapData);
          const underBlocked = testUnder && testUnder.clearance < 2.2;

          if (!chBlocked && !lBlocked && !rBlocked && !underBlocked && hasGroundAhead(this.pos, testYaw, obbs)) {
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

    let activeOpp = null;
    if (this.activeWeapon === 3 && st.instagibTargetPid && players[st.instagibTargetPid] && !players[st.instagibTargetPid].isDead) {
      const oppPl = players[st.instagibTargetPid];
      const oppHead = oppPl.pos.clone();
      oppHead.y += CFG.H * 0.6;
      const toOpp = oppHead.sub(eyePos);
      activeOpp = { dir: toOpp.clone().normalize(), dist: toOpp.length() };
    }

    const underNow = getRampUnderState(this.pos, mapData);
    const rampState = getRampAtPos(this.pos, mapData);
    const onRamp = rampState && rampState.onRamp;

    if (activeOpp) {
      desiredYaw = Math.atan2(-activeOpp.dir.x, -activeOpp.dir.z);
    } else if (underNow && underNow.clearance < 2.5) {
      const toCenter = new TH.Vector3(-this.pos.x, 0, -this.pos.z).normalize();
      const escX = underNow.fwdX * 0.6 + toCenter.x * 0.8;
      const escZ = underNow.fwdZ * 0.6 + toCenter.z * 0.8;
      desiredYaw = Math.atan2(-escX, -escZ);
      st.avoidYaw = desiredYaw;
      st.avoidUntilT = nowT + 0.6;
      isTallWall = false;
      canStepOver = false;
    } else if (st.portalPhase === 'aim_primary') {
      desiredYaw = st.primaryAimYaw;
    } else if (st.portalPhase === 'delay_secondary' || st.portalPhase === 'aim_secondary') {
      desiredYaw = st.secondaryAimYaw;
    } else if (nowT < st.avoidUntilT) {
      desiredYaw = st.avoidYaw;
    }

    let dyaw = desiredYaw - this.yaw;
    while (dyaw > Math.PI) dyaw -= Math.PI * 2;
    while (dyaw < -Math.PI) dyaw += Math.PI * 2;

    const isPortalAiming = st.portalPhase === 'aim_primary' || st.portalPhase === 'delay_secondary' || st.portalPhase === 'aim_secondary';
    const maxTurn = (isPortalAiming ? 3.8 : (activeOpp ? 4.2 : 4.8)) * DT;
    if (Math.abs(dyaw) > maxTurn) {
      this.yaw += Math.sign(dyaw) * maxTurn;
    } else {
      this.yaw += dyaw;
    }
    while (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    while (this.yaw < -Math.PI) this.yaw += Math.PI * 2;

    let targetPitch;
    if (activeOpp) {
      targetPitch = Math.asin(Math.max(-0.99, Math.min(0.99, activeOpp.dir.y)));
    } else if (st.portalPhase === 'aim_primary') {
      targetPitch = st.primaryAimPitch;
    } else if (st.portalPhase === 'delay_secondary' || st.portalPhase === 'aim_secondary') {
      targetPitch = st.secondaryAimPitch;
    } else {
      targetPitch = Math.max(-0.25, Math.min(0.25, ((st.targetPos.y - this.pos.y) - 1.5) * 0.04));
    }

    if (st.rocketJumpPhase === 'aim_down') {
      const rjPitch = -1.35;
      this.pitch += (rjPitch - this.pitch) * Math.min(1, 14.0 * DT);

      if (this.pitch <= -1.15 || nowT - st.rocketJumpT > 0.22) {
        this.jumpBuf = nowT;
        const rjPos = this.pos.clone();
        rjPos.y += 0.35;
        const rjDir = new TH.Vector3(-Math.sin(this.yaw) * 0.15, -0.98, -Math.cos(this.yaw) * 0.15).normalize();
        const rjHit = { point: this.pos.clone(), normal: new TH.Vector3(0, 1, 0) };
        if (onFireRocket) {
          onFireRocket(rjPos, rjDir.multiplyScalar(70), rjHit);
        }
        st.lastRocketT = nowT;
        st.rocketJumpPhase = 'recover';
        st.rocketJumpT = nowT;
      }
    } else if (st.rocketJumpPhase === 'recover') {
      this.pitch += (targetPitch - this.pitch) * Math.min(1, 8.0 * DT);
      if (nowT - st.rocketJumpT > 0.4) {
        st.rocketJumpPhase = 'none';
      }
    } else {
      const pitchSpeed = isPortalAiming ? 4.0 : (activeOpp ? 4.5 : 6.0);
      this.pitch += (targetPitch - this.pitch) * Math.min(1, pitchSpeed * DT);
    }

    if (st.lastTickPos) {
      const dMoved = this.pos.distanceTo(st.lastTickPos);
      if (dist > 0.8 && dMoved < 0.02) {
        st.stuckT += DT;
      } else if (dMoved > 0.05) {
        st.stuckT = Math.max(0, st.stuckT - DT * 3.0);
      }
    }
    st.lastTickPos = this.pos.clone();

    if (st.stuckT > 0.3) {
      if (!underNow && !onRamp && (canStepOver || (closestHit && closestHit.distance < 1.2 && this.grounded))) {
        this.jumpBuf = nowT;
      }
      if (isTallWall) {
        const destWall = findDestructibleWall(eyePos, curFwd, obbs, session, 6.0);
        if (destWall && nowT - st.lastRocketT > 5.0 && onFireRocket) {
          this.activeWeapon = 2;
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

    const keys = {
      KeyW: (!isPortalAiming || Math.abs(dyaw) < 0.5) && Math.abs(dyaw) < 1.1 && (dist > 0.6 || st.portalPhase === 'walk_thru' || underNow != null || onRamp),
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
      if (st.rocketJumpPhase === 'aim_down' && (this.pitch <= -1.15 || nowT - st.rocketJumpT > 0.2)) {
        keys.Space = true;
      }
    }

    if (nowT < st.unstuckUntilT) {
      keys.KeyW = false;
      keys.KeyS = true;
      if (st.strafeDir) keys[st.strafeDir] = true;
    }

    if (st.stuckT > 1.0) {
      const route = pickBotTargetAndRoute(this.pos, portals, mapData);
      st.targetPos = route.target;
      st.waypoints = route.waypoints;
      if (underNow) {
        const toCenter = new TH.Vector3(-this.pos.x, 0, -this.pos.z).normalize();
        st.avoidYaw = Math.atan2(-toCenter.x, -toCenter.z);
      } else {
        st.avoidYaw = this.yaw + Math.PI * (0.8 + Math.random() * 0.4);
        this.jumpBuf = nowT;
      }
      st.avoidUntilT = nowT + 0.9;
      st.stuckT = 0;
      st.unstuckUntilT = 0;
    }

    const botPortalBase = this.portalBaseIndex;

    if (st.portalPhase === 'aim_primary') {
      let aimDyaw = st.primaryAimYaw - this.yaw;
      while (aimDyaw > Math.PI) aimDyaw -= Math.PI * 2;
      while (aimDyaw < -Math.PI) aimDyaw += Math.PI * 2;
      const aimDpitch = Math.abs(st.primaryAimPitch - this.pitch);
      const aligned = Math.abs(aimDyaw) < 0.08 && aimDpitch < 0.08;
      const timedOut = nowT - st.primaryAimT > 1.2;
      const minAimTimePassed = nowT - st.primaryAimT > 0.45;

      if (st.primarySurface && ((aligned && minAimTimePassed) || timedOut)) {
        const surface = st.primarySurface;
        const P = portals[botPortalBase];
        P.placed = true;
        P.c.copy(surface.c);
        P.n.copy(surface.n);
        P.r.copy(surface.r);
        P.u.copy(surface.u);

        if (onPortalPlaced) onPortalPlaced(botPortalBase, surface, surface.eyePos);

        const secondaryFound = findSecondaryPortalSurface(this.pos, surface.n, obbs, portals, PORT_, botPortalBase + 1, session);
        if (secondaryFound) {
          st.secondarySurface = secondaryFound.surface;
          st.secondaryAimYaw = secondaryFound.aimYaw;
          st.secondaryAimPitch = secondaryFound.aimPitch;
          st.portalPhase = 'delay_secondary';
          st.secondaryDelayUntil = nowT + 0.85 + Math.random() * 0.35;
        } else {
          st.portalPhase = 'none';
          st.lastPortalT = nowT + 3.0;
        }
      } else if (nowT - st.primaryAimT > 2.0) {
        st.portalPhase = 'none';
        st.lastPortalT = nowT + 2.0;
      }
    } else if (st.portalPhase === 'delay_secondary') {
      if (nowT >= st.secondaryDelayUntil) {
        st.portalPhase = 'aim_secondary';
        st.secondaryAimT = nowT;
      } else if (nowT > st.secondaryDelayUntil + 2.0) {
        st.portalPhase = 'none';
        st.lastPortalT = nowT + 2.0;
      }
    } else if (st.portalPhase === 'aim_secondary') {
      let aimDyaw = st.secondaryAimYaw - this.yaw;
      while (aimDyaw > Math.PI) aimDyaw -= Math.PI * 2;
      while (aimDyaw < -Math.PI) aimDyaw += Math.PI * 2;
      const aimDpitch = Math.abs(st.secondaryAimPitch - this.pitch);
      const aligned = Math.abs(aimDyaw) < 0.08 && aimDpitch < 0.08;
      const timedOut = nowT - st.secondaryAimT > 1.2;
      const minAimTimePassed = nowT - st.secondaryAimT > 0.35;

      if (st.secondarySurface && ((aligned && minAimTimePassed) || timedOut)) {
        const pIdx = botPortalBase + 1;
        const surface = st.secondarySurface;
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
      } else if (nowT - st.secondaryAimT > 2.0) {
        st.portalPhase = 'none';
        st.lastPortalT = nowT + 3.0;
      }
    } else if (st.portalPhase === 'walk_thru') {
      const primaryPortal = portals[botPortalBase];
      const secondaryPortal = portals[botPortalBase + 1];

      if (primaryPortal.placed) {
        st.targetPos = primaryPortal.c.clone().addScaledVector(primaryPortal.n, -0.6);
        const portalBottomY = primaryPortal.c.y - PORT_.hh;
        if (this.pos.distanceTo(primaryPortal.c) < 2.5 && portalBottomY > this.pos.y + 0.35) {
          this.jumpBuf = nowT;
        }
      }

      const passedThrough = secondaryPortal.placed && this.pos.distanceTo(secondaryPortal.c) < 2.5 && (nowT - st.walkThruT > 0.25);
      const reachedPrimary = primaryPortal.placed && this.pos.distanceTo(primaryPortal.c) < 0.9;
      const timedOut = nowT - st.walkThruT > 6.0;

      if (passedThrough || reachedPrimary || timedOut) {
        st.portalPhase = 'none';
        const route = pickBotTargetAndRoute(this.pos, portals, mapData);
        st.targetPos = route.target;
        st.waypoints = route.waypoints;
        st.lastPortalT = nowT;
      }
    }

    const jumpForLedge = !onRamp && heightDiffToTarget > 0.4 && heightDiffToTarget < 1.6 && dist < 3.5;
    const shouldJump = this.grounded && !isTallWall && !onRamp && (
      canStepOver ||
      jumpForLedge ||
      !hasGroundAhead(this.pos, this.yaw, obbs)
    );

    if (shouldJump && nowT - st.lastJumpT > JUMP_COOLDOWN_S) {
      this.jumpBuf = nowT;
      st.lastJumpT = nowT;
    }

    if (dist < 0.5 && st.portalPhase !== 'walk_thru' && (!st.waypoints || st.waypoints.length === 0)) {
      keys.KeyW = false;
    }

    return keys;
  }
}


