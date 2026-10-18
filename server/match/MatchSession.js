import * as TH from 'three';
import { generateMap } from '../../shared/mapgen.js';
import { WARMUP_TIME, ROUND_TIME, PORT } from '../../shared/constants.js';

export let seedStr = String(Math.floor(Math.random() * 1e9));
export let mapData = generateMap(seedStr);

export const gameState = {
  tick: 0,
  players: {},
  spectators: {},
  destroyedWalls: [],
  destroyedWallObbs: [],
  portals: [
    { placed: false, c: new TH.Vector3(), n: new TH.Vector3(), r: new TH.Vector3(), u: new TH.Vector3(), color: 0x2eeaff },
    { placed: false, c: new TH.Vector3(), n: new TH.Vector3(), r: new TH.Vector3(), u: new TH.Vector3(), color: 0x0055ff },
    { placed: false, c: new TH.Vector3(), n: new TH.Vector3(), r: new TH.Vector3(), u: new TH.Vector3(), color: 0xff9a3d },
    { placed: false, c: new TH.Vector3(), n: new TH.Vector3(), r: new TH.Vector3(), u: new TH.Vector3(), color: 0xff2200 }
  ],
  grabCubes: mapData.grabCubes.map(c => ({
    pos: new TH.Vector3(...c.c),
    vel: new TH.Vector3(),
    rotVel: new TH.Vector3()
  }))
};

export function buildObbs(map) {
  let slabIdx = 0;
  return map.slabs.map(s => {
    const mesh = new TH.Mesh(new TH.BoxGeometry(s.s[0], s.s[1], s.s[2]));
    mesh.position.set(...s.c);
    mesh.rotation.order = 'YZX';
    if (s.ry) mesh.rotation.y = s.ry;
    if (s.rz) mesh.rotation.z = s.rz;
    mesh.updateMatrixWorld(true);

    const ax = [new TH.Vector3(1, 0, 0), new TH.Vector3(0, 1, 0), new TH.Vector3(0, 0, 1)];
    ax[0].transformDirection(mesh.matrixWorld);
    ax[1].transformDirection(mesh.matrixWorld);
    ax[2].transformDirection(mesh.matrixWorld);

    return {
      id: `slab_${slabIdx}`,
      slabIdx: slabIdx++,
      c: new TH.Vector3(...s.c),
      ax,
      he: [s.s[0] / 2, s.s[1] / 2, s.s[2] / 2],
      rad: Math.hypot(s.s[0] / 2, s.s[1] / 2, s.s[2] / 2),
      kind: s.kind,
      boundary: s.boundary,
      noPortal: s.noPortal,
      ramp: s.ramp
    };
  });
}

export let obbs = buildObbs(mapData);

export const match = {
  phase: 'waiting',
  deadlineMs: 0,
  ready: {},
  scores: {},
  roundWins: {},
  winner: null
};

function spawnDistSq(a, b) {
  const dx = a.x - b.x, dz = a.z - b.z;
  return dx * dx + dz * dz;
}

export function pickSpawn(avoidIdxs = [], refPos = null, farN = 1) {
  const all = mapData.spawns.map((_, i) => i);
  let pool = all.filter(i => !avoidIdxs.includes(i));
  if (pool.length === 0) pool = all;
  if (refPos && pool.length > 1) {
    const ranked = pool.slice().sort((a, b) =>
      spawnDistSq(mapData.spawns[b], refPos) - spawnDistSq(mapData.spawns[a], refPos)
    );
    const top = ranked.slice(0, Math.min(farN || 1, ranked.length));
    return top[Math.floor(Math.random() * top.length)];
  }
  return pool[Math.floor(Math.random() * pool.length)];
}

export function placeAtSpawn(p, idx) {
  const s = mapData.spawns[idx];
  p.pos.set(s.x, s.y, s.z);
  p.vel.set(0, 0, 0);
  p.spawnIdx = idx;
}

export function assignRoundSpawns(pids) {
  if (pids.length === 0) return;
  const i0 = pickSpawn([]);
  placeAtSpawn(gameState.players[pids[0]], i0);
  if (pids.length > 1) {
    const i1 = pickSpawn([i0], mapData.spawns[i0], 2);
    placeAtSpawn(gameState.players[pids[1]], i1);
  }
}

export function beginWarmup() {
  match.phase = 'warmup';
  match.deadlineMs = Date.now() + WARMUP_TIME * 1000;
  match.scores = {};
  match.winner = null;
  match.ready = {};
  for (const id in gameState.players) {
    gameState.players[id].shots = 0;
    gameState.players[id].hits = 0;
  }
  resetMapState();
}

export function startCountdown() {
  match.phase = 'countdown';
  match.deadlineMs = Date.now() + 3800;
  match.scores = {};
  match.winner = null;
  match.ready = {};
  for (const id in gameState.players) {
    gameState.players[id].shots = 0;
    gameState.players[id].hits = 0;
  }
  resetMapState();
}

export function beginRound() {
  match.phase = 'active';
  match.scores = {};
  match.deadlineMs = Date.now() + ROUND_TIME * 1000;
  for (const id in gameState.players) {
    const p = gameState.players[id];
    p.isDead = false;
  }
  resetDestructibleWalls();
}

export function matchToWaiting() {
  match.phase = 'waiting';
  match.deadlineMs = 0;
  match.scores = {};
  match.winner = null;
  resetMapState();
}

export function matchInfo() {
  const players = {};
  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    const shots = p.shots || 0, hits = p.hits || 0;
    players[pid] = {
      index: p.playerIndex,
      name: p.name,
      ready: !!match.ready[pid],
      score: match.scores[pid] || 0,
      ping: p.ping || 0,
      shots,
      hits,
      acc: shots > 0 ? Math.round((hits / shots) * 100) : 0,
      isBot: !!p.isBot
    };
  }
  const spectators = {};
  for (const sid in gameState.spectators) {
    const s = gameState.spectators[sid];
    spectators[sid] = {
      name: s.name,
      ping: s.ping || 0
    };
  }
  const msLeft = (match.phase === 'warmup' || match.phase === 'active' || match.phase === 'countdown') ? match.deadlineMs - Date.now() : 0;
  return {
    phase: match.phase,
    timeLeft: Math.max(0, msLeft / 1000),
    players,
    spectators,
    spectatorCount: Object.keys(gameState.spectators).length,
    winner: match.winner,
    roundWins: Object.assign({}, match.roundWins)
  };
}

export function serverDestroyWall(wallId, wallCenter, point) {
  const cPt = new TH.Vector3(...point);
  const cCenter = wallCenter ? new TH.Vector3(...wallCenter) : null;

  let obb = null;
  if (wallId) obb = obbs.find(o => o.id === wallId);
  if (!obb && cCenter) obb = obbs.find(o => o.c.distanceTo(cCenter) < 0.3);
  if (!obb) {
    obb = obbs.find(o => o.kind === 'wall' && !o.boundary && o.c.distanceTo(cPt) <= o.rad + 0.5);
  }

  if (!obb || obb.kind !== 'wall' || obb.boundary) return null;

  const uIdx = obb.he[0] >= obb.he[2] ? 0 : 2;
  const tIdx = uIdx === 0 ? 2 : 0;
  if (obb.he[tIdx] > 2.5) return null;

  if (!gameState.destroyedWallObbs) gameState.destroyedWallObbs = [];
  gameState.destroyedWallObbs.push({
    id: obb.id,
    c: obb.c.clone(),
    ax: [obb.ax[0].clone(), obb.ax[1].clone(), obb.ax[2].clone()],
    he: [obb.he[0], obb.he[1], obb.he[2]],
    rad: obb.rad
  });
  obb.destroyed = true;
  obb.noPortal = true;

  const idx = obbs.indexOf(obb);
  if (idx > -1) obbs.splice(idx, 1);

  const cancelledPortals = [];
  for (let i = 0; i < gameState.portals.length; i++) {
    const P = gameState.portals[i];
    if (P.placed && P.c.distanceTo(obb.c) < obb.rad + 2.0) {
      const d = P.c.clone().sub(obb.c);
      const u0 = Math.abs(d.dot(obb.ax[0]));
      const u1 = Math.abs(d.dot(obb.ax[1]));
      const u2 = Math.abs(d.dot(obb.ax[2]));
      if (u0 <= obb.he[0] + 0.6 && u1 <= obb.he[1] + 0.6 && u2 <= obb.he[2] + 0.6) {
        P.placed = false;
        cancelledPortals.push(i);
      }
    }
  }

  const rel = new TH.Vector3(cPt.x - obb.c.x, cPt.y - obb.c.y, cPt.z - obb.c.z);
  const uC = rel.dot(obb.ax[uIdx]);
  const yC = rel.dot(obb.ax[1]);

  const R = 4.8;
  const MIN_PIECE = 0.3;
  const uMin = -obb.he[uIdx], uMax = obb.he[uIdx];
  const yMin = -obb.he[1], yMax = obb.he[1];

  const pieces = [];
  const startU = uC - R;
  const endU = uC + R;

  if (startU > uMin + MIN_PIECE) pieces.push({ u: (uMin + startU) / 2, w: startU - uMin, y: 0, h: yMax - yMin });
  if (endU < uMax - MIN_PIECE) pieces.push({ u: (endU + uMax) / 2, w: uMax - endU, y: 0, h: yMax - yMin });

  const bandMinU = Math.max(uMin, startU);
  const bandMaxU = Math.min(uMax, endU);
  const bandW = bandMaxU - bandMinU;
  const bandMinY = Math.max(yMin, yC - R);
  const bandMaxY = Math.min(yMax, yC + R);

  if (bandW >= MIN_PIECE && bandMaxY - bandMinY >= MIN_PIECE) {
    if (bandMinY - yMin > MIN_PIECE)
      pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (yMin + bandMinY) / 2, h: bandMinY - yMin });
    if (yMax - bandMaxY > MIN_PIECE)
      pieces.push({ u: (bandMinU + bandMaxU) / 2, w: bandW, y: (bandMaxY + yMax) / 2, h: yMax - bandMaxY });
  }

  const A = obb.ax, C = obb.c;
  for (let pIdx = 0; pIdx < pieces.length; pIdx++) {
    const p = pieces[pIdx];
    const c = new TH.Vector3(
      C.x + A[uIdx].x * p.u + A[1].x * p.y,
      C.y + A[uIdx].y * p.u + A[1].y * p.y,
      C.z + A[uIdx].z * p.u + A[1].z * p.y
    );
    const sx = uIdx === 0 ? p.w : obb.he[tIdx] * 2;
    const sz = uIdx === 2 ? p.w : obb.he[tIdx] * 2;

    obbs.push({
      id: `${obb.id}_f${pIdx}`,
      c,
      ax: [A[0].clone(), A[1].clone(), A[2].clone()],
      he: [sx / 2, p.h / 2, sz / 2],
      rad: Math.hypot(sx, p.h, sz) / 2 + 3,
      kind: 'wall',
      destroyed: true,
      noPortal: true
    });
  }

  return { cancelledPortals, obbId: obb.id };
}

export function resetDestructibleWalls() {
  const fresh = buildObbs(mapData);
  obbs.length = 0;
  obbs.push(...fresh);
  gameState.destroyedWalls = [];
  gameState.destroyedWallObbs = [];
}

export function resetMapState() {
  resetDestructibleWalls();

  for (const p of gameState.portals) {
    p.placed = false;
    p.c.set(0, 0, 0);
    p.n.set(0, 0, 0);
    p.r.set(0, 0, 0);
    p.u.set(0, 0, 0);
  }

  gameState.grabCubes = mapData.grabCubes.map(c => ({
    pos: new TH.Vector3(...c.c),
    vel: new TH.Vector3(),
    rotVel: new TH.Vector3()
  }));

  assignRoundSpawns(Object.keys(gameState.players));
  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    p.isDead = false;
    p.inputBuffer = [];
  }
}

export function updateMap(newSeed) {
  seedStr = newSeed;
  mapData = generateMap(seedStr);
  resetMapState();
  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type: 'respawn', pos: p.pos.toArray() }));
    }
  }
}

export function isPortalOnDestroyedWall(c, n, r, u, PORT_) {
  const hw = PORT_ ? PORT_.hw : (PORT ? PORT.hw : 1.4375);
  const hh = PORT_ ? PORT_.hh : (PORT ? PORT.hh : 2.0);

  if (gameState.destroyedWallObbs) {
    for (const dob of gameState.destroyedWallObbs) {
      const d = c.clone().sub(dob.c);
      const u0 = Math.abs(d.dot(dob.ax[0]));
      const u1 = Math.abs(d.dot(dob.ax[1]));
      const u2 = Math.abs(d.dot(dob.ax[2]));
      const ext0 = r && u ? (hw * Math.abs(r.dot(dob.ax[0])) + hh * Math.abs(u.dot(dob.ax[0]))) : hw;
      const ext1 = r && u ? (hw * Math.abs(r.dot(dob.ax[1])) + hh * Math.abs(u.dot(dob.ax[1]))) : hh;
      const ext2 = r && u ? (hw * Math.abs(r.dot(dob.ax[2])) + hh * Math.abs(u.dot(dob.ax[2]))) : hw;
      if (u0 <= dob.he[0] + ext0 + 0.2 &&
          u1 <= dob.he[1] + ext1 + 0.2 &&
          u2 <= dob.he[2] + ext2 + 0.2) {
        return true;
      }
    }
  }

  for (const obb of obbs) {
    if (obb.kind === 'ramp') continue;
    if (obb.destroyed || obb.noPortal) {
      const d = c.clone().sub(obb.c);
      const u0 = Math.abs(d.dot(obb.ax[0]));
      const u1 = Math.abs(d.dot(obb.ax[1]));
      const u2 = Math.abs(d.dot(obb.ax[2]));
      const ext0 = r && u ? (hw * Math.abs(r.dot(obb.ax[0])) + hh * Math.abs(u.dot(obb.ax[0]))) : hw;
      const ext1 = r && u ? (hw * Math.abs(r.dot(obb.ax[1])) + hh * Math.abs(u.dot(obb.ax[1]))) : hh;
      const ext2 = r && u ? (hw * Math.abs(r.dot(obb.ax[2])) + hh * Math.abs(u.dot(obb.ax[2]))) : hw;
      if (u0 <= obb.he[0] + ext0 + 0.2 &&
          u1 <= obb.he[1] + ext1 + 0.2 &&
          u2 <= obb.he[2] + ext2 + 0.2) {
        return true;
      }
    }
  }

  if (gameState.destroyedWalls) {
    for (const dw of gameState.destroyedWalls) {
      if (dw.point) {
        const pt = new TH.Vector3(...dw.point);
        if (c.distanceTo(pt) < 5.4) return true;
      }
      if (dw.wallCenter) {
        const wc = new TH.Vector3(...dw.wallCenter);
        if (c.distanceTo(wc) < 4.5) return true;
      }
    }
  }

  return false;
}

/**
 * MatchSession — Encapsulates server-side duel match state, phases, scoring, and spawns.
 */
export class MatchSession {
  constructor(seed = null) {
    if (seed) {
      updateMap(seed);
    }
  }

  get seedStr() {
    return seedStr;
  }

  set seedStr(val) {
    seedStr = val;
  }

  get mapData() {
    return mapData;
  }

  get gameState() {
    return gameState;
  }

  get obbs() {
    return obbs;
  }

  get match() {
    return match;
  }

  beginWarmup(players = {}) {
    beginWarmup();
    void players;
  }

  startCountdown(players = {}) {
    startCountdown();
    void players;
  }

  beginRound(pids = [], players = {}) {
    beginRound();
    if (pids.length > 0) {
      assignRoundSpawns(pids);
    }
    void players;
  }

  resetToWaiting() {
    matchToWaiting();
  }

  pickSpawn(avoidIdxs = [], refPos = null, farN = 1) {
    return pickSpawn(avoidIdxs, refPos, farN);
  }

  placeAtSpawn(p, idx) {
    placeAtSpawn(p, idx);
  }

  assignRoundSpawns(pids) {
    assignRoundSpawns(pids);
  }

  getInfo() {
    return matchInfo();
  }

  matchInfo() {
    return matchInfo();
  }

  resetDestructibleWalls() {
    resetDestructibleWalls();
  }

  resetMapState() {
    resetMapState();
  }

  updateMap(newSeed) {
    updateMap(newSeed);
  }

  serverDestroyWall(wallId, wallCenter, point) {
    return serverDestroyWall(wallId, wallCenter, point);
  }

  isPortalOnDestroyedWall(c, n, r, u, PORT_) {
    return isPortalOnDestroyedWall(c, n, r, u, PORT_);
  }
}
