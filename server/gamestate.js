import * as TH from 'three';
import { generateMap } from '../shared/mapgen.js';
import { TICK_RATE, WARMUP_TIME, ROUND_TIME } from '../shared/constants.js';

export let seedStr = String(Math.floor(Math.random() * 1e9));
export let mapData = generateMap(seedStr);

export const gameState = {
  tick: 0,
  players: {},
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

export let obbs = buildObbs(mapData);
// ---------------------------------------------------------------- match / round state
// Phases: waiting (0-1 players) -> warmup (both connected, <= WARMUP_TIME)
//        -> active (ROUND_TIME duel) -> summary (winner shown) -> warmup (rematch)
export const match = {
  phase: 'waiting',
  deadlineTick: 0,       // tick at which the current timed phase ends
  ready: {},             // { [pid]: bool }
  scores: {},            // { [pid]: kills in the current round }
  roundWins: {},         // { [pid]: cumulative round wins across rematches }
  winner: null           // pid of the round winner, or 'tie'
};

export function beginWarmup() {
  match.phase = 'warmup';
  match.deadlineTick = gameState.tick + WARMUP_TIME * TICK_RATE;
  match.scores = {};
  match.winner = null;
  for (const pid of Object.keys(match.ready)) {
    if (!(pid in gameState.players)) delete match.ready[pid];
  }
}

export function beginRound() {
  match.phase = 'active';
  match.deadlineTick = gameState.tick + ROUND_TIME * TICK_RATE;
}

export function matchToWaiting() {
  match.phase = 'waiting';
  match.deadlineTick = 0;
  match.scores = {};
  match.winner = null;
}

export function matchInfo() {
  const players = {};
  for (const pid in gameState.players) {
    players[pid] = {
      index: gameState.players[pid].playerIndex,
      name: gameState.players[pid].name,
      ready: !!match.ready[pid],
      score: match.scores[pid] || 0
    };
  }
  const tickLeft = (match.phase === 'warmup' || match.phase === 'active') ? match.deadlineTick - gameState.tick : 0;
  return {
    phase: match.phase,
    timeLeft: Math.max(0, tickLeft / TICK_RATE),
    players,
    winner: match.winner,
    roundWins: Object.assign({}, match.roundWins)
  };
}


function buildObbs(map) {
  return map.slabs.map(s => {
    const mesh = new TH.Mesh(new TH.BoxGeometry(s.s[0], s.s[1], s.s[2]));
    mesh.position.set(...s.c);
    if (s.ry) mesh.rotation.y = s.ry;
    if (s.rz) mesh.rotation.z = s.rz;
    mesh.updateMatrixWorld(true);
    
    const ax = [new TH.Vector3(1,0,0), new TH.Vector3(0,1,0), new TH.Vector3(0,0,1)];
    ax[0].transformDirection(mesh.matrixWorld);
    ax[1].transformDirection(mesh.matrixWorld);
    ax[2].transformDirection(mesh.matrixWorld);
    
    return {
      c: new TH.Vector3(...s.c),
      ax,
      he: [s.s[0]/2, s.s[1]/2, s.s[2]/2],
      rad: Math.hypot(s.s[0]/2, s.s[1]/2, s.s[2]/2),
      kind: s.kind
    };
  });
}

export function updateMap(newSeed) {
  seedStr = newSeed;
  mapData = generateMap(seedStr);
  obbs = buildObbs(mapData);
  
  for (const p of gameState.portals) p.placed = false;
  
  gameState.grabCubes = mapData.grabCubes.map(c => ({
    pos: new TH.Vector3(...c.c),
    vel: new TH.Vector3(),
    rotVel: new TH.Vector3()
  }));
  
  for (const pid in gameState.players) {
    gameState.players[pid].pos.set(mapData.spawn.x, mapData.spawn.y, mapData.spawn.z);
    gameState.players[pid].vel.set(0, 0, 0);
  }
}

