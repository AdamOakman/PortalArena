import { WebSocketServer } from 'ws';
import * as TH from 'three';
import { CFG, PORT, TICK_RATE } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js';


const wss = new WebSocketServer({ port: 3001 });
const physics = initPhysics(TH, CFG, PORT);

const SERVER_PASSWORD = "secret";
 import { seedStr, mapData, gameState, obbs, updateMap, match, beginWarmup, beginRound, matchToWaiting, matchInfo, pickSpawn, placeAtSpawn } from './gamestate.js';
let nextPlayerId = 0;
// Kill feed message pools ({v} = victim, {k} = killer)
const KILL_MSGS = [
  '{k} fragged {v}',
  '{v} got fragged by {k}',
  '{k} removed {v} from the equation'
];
const PORTAL_KILL_MSGS = [
  '{k} FRAGGED {v} THROUGH THE PORTAL!',
  '{k} yeeted {v} to the other side! (via portal)',
  '{k} fragged {v} via portal! double points, no refunds!'
];
const PORTAL_SUICIDE_MSGS = [
  '{v} fed the portal, and the portal kept the change',
  '{v} fragged themselves via portal. bold choice',
  '{v} found out the portal was a one-way ticket'
];
 const VOID_MSGS = [
   '{v} fell into the void. the void said no',
   '{v} discovered the floor is a suggestion',
   '{v} took the scenic route into the void'
 ];
 const LAVA_MSGS = [
   '{v} waded into the lava. the lava did not care',
   '{v} made friends with the lava',
   '{v} was cremated on the spot'
 ];
function feedPick(pool, victim, killer) {
  return pool[Math.floor(Math.random() * pool.length)].replace('{v}', victim).replace('{k}', killer || '');
}

wss.on('connection', (ws) => {
  let playerId = null;

  ws.on('message', (message) => {
    const data = JSON.parse(message);

    if (data.type === 'auth') {
      if (data.password !== SERVER_PASSWORD) {
        ws.close(1008, "Invalid password");
        return;
      }
      if (Object.keys(gameState.players).length >= 2) {
        ws.close(1008, "Server full");
        return;
      }
      // First player into an empty chamber always regenerates the map; the second just joins.
      if (Object.keys(gameState.players).length === 0) {
        updateMap(String(Math.floor(Math.random() * 1e9)));
      }
      playerId = String(nextPlayerId++);
      const taken = new Set(Object.keys(gameState.players).map(id => gameState.players[id].playerIndex));
      const playerIndex = taken.has(0) ? 1 : 0;
      const pName = data.name || 'Guest';
      // Spawn: random point, never the one the opponent is standing on
      const usedIdxs = Object.values(gameState.players).map(p => p.spawnIdx).filter(i => i != null);
      const spawnIdx = pickSpawn(usedIdxs);
      const spawn = mapData.spawns[spawnIdx];
      gameState.players[playerId] = { playerIndex, name: pName, ws,
        pos: new TH.Vector3(spawn.x, spawn.y, spawn.z),
        vel: new TH.Vector3(),
        yaw: 0, pitch: 0,
        grounded: false, groundNormal: new TH.Vector3(0,1,0),
        groundT: -1, jumpBuf: -1, maxSpeed: 0,
        ping: 0, shots: 0, hits: 0, inputBuffer: [], spawnIdx
      };
      
      // Warmup starts the moment a second player is connected (before the init snapshot)
      if (Object.keys(gameState.players).length === 2 && match.phase !== 'warmup' && match.phase !== 'active') beginWarmup();

      ws.send(JSON.stringify({
        type: 'init',
        playerId,
        playerIndex,
        seed: seedStr,
        spawn: [spawn.x, spawn.y, spawn.z],
        match: matchInfo()
      }));

      const evtMsg = JSON.stringify({ type: 'player_connected', name: pName });
      wss.clients.forEach(client => {
         if (client.readyState === 1) client.send(evtMsg);
      });
    } else if (data.type === 'input') {
      if (!playerId) return;
      const p = gameState.players[playerId];
      if (!p) return;
      p.inputBuffer.push(data);
      if (data.grabbedCubeIdx !== undefined) {
         p.grabbedCubeIdx = data.grabbedCubeIdx;
         const c = gameState.grabCubes[data.grabbedCubeIdx];
         if (c) {
            c.pos.fromArray(data.grabbedCubePos);
            c.vel.fromArray(data.grabbedCubeVel);
         }
      } else {
         p.grabbedCubeIdx = -1;
      }

    } else if (data.type === 'ready') {
      const p = gameState.players[playerId];
      if (p && (match.phase === 'warmup' || match.phase === 'waiting')) {
        match.ready[playerId] = !!data.ready;
        if (match.phase === 'warmup') {
          const pids = Object.keys(gameState.players);
          if (pids.length === 2 && pids.every(id => match.ready[id])) beginRound();
        }
      }
    } else if (data.type === 'ping') {
      const p = gameState.players[playerId];
      if (p) {
        if (typeof data.ping === 'number') p.ping = data.ping;
        ws.send(JSON.stringify({ type: 'pong', t: data.t }));
      }
    } else if (data.type === 'portal_place') {
      const P = gameState.portals[data.pi];
      P.placed = true;
      P.c.fromArray(data.c);
      P.n.fromArray(data.n);
      P.r.fromArray(data.r);
      P.u.fromArray(data.u);
      updatePair();
    } else if (data.type === 'blast_cubes') {
      data.cubes.forEach(c => {
         const cube = gameState.grabCubes[c.idx];
         if (cube) {
            cube.vel.fromArray(c.vel);
            if (c.rotVel) cube.rotVel.fromArray(c.rotVel);
         }
      });
    } else if (data.type === String.fromCharCode(116,104,114,111,119,95,99,117,98,101)) {
      const c = gameState.grabCubes[data.idx];
      if (c) {
         c.pos.fromArray(data.pos);
         c.vel.fromArray(data.vel);
      }
    } else if (data.type === 'fire_beam' || data.type === 'fire_rocket' || data.type === 'fire_instagib') {
      data.playerId = playerId;
      // Accuracy: instagib is the one weapon whose hits the server can see
      if (data.type === 'fire_instagib' && match.phase === 'active') {
        const fp = gameState.players[playerId];
        if (fp) {
          fp.shots++;
          if (data.hitPlayerId && gameState.players[data.hitPlayerId]) fp.hits++;
        }
      }
      const msg = JSON.stringify(data);
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === 1) c.send(msg);
      });
    } else if (data.type === 'player_died') {
      const pl = gameState.players[playerId];
      if (pl && !pl.isDead) {
        pl.isDead = true;
        // Kill/void/lava feed and scoring apply in both warmup and active.
        // The score resets when the active round begins, so warmup is live practice.
        if (match.phase === 'active' || match.phase === 'warmup') {
          const viaPortal = !!data.viaPortal;
          const killerPid = (data.killerId && data.killerId !== playerId && gameState.players[data.killerId]) ? data.killerId : null;
          let feedMsg = null, feedHot = false;
          if (data.cause === 'void' || data.cause === 'lava') {
            match.scores[playerId] = (match.scores[playerId] || 0) - 1;
            feedMsg = feedPick(data.cause === 'lava' ? LAVA_MSGS : VOID_MSGS, pl.name, null);
          } else if (killerPid) {
            match.scores[killerPid] = (match.scores[killerPid] || 0) + (viaPortal ? 2 : 1);
            feedMsg = feedPick(viaPortal ? PORTAL_KILL_MSGS : KILL_MSGS, pl.name, gameState.players[killerPid].name);
            feedHot = viaPortal;
          } else if (viaPortal) {
            match.scores[playerId] = (match.scores[playerId] || 0) - 2;
            feedMsg = feedPick(PORTAL_SUICIDE_MSGS, pl.name, null);
          }
          if (feedMsg) { data.feedMsg = feedMsg; data.feedHot = feedHot; }
        }
        data.playerId = playerId;
        const msg = JSON.stringify(data);
        wss.clients.forEach(c => {
          if (c !== ws && c.readyState === 1) c.send(msg);
        });
        setTimeout(() => {
          if (pl.isDead) {
            pl.isDead = false;
            // Respawn: random one of the 2 spawn points farthest from the opponent
            const pids = Object.keys(gameState.players);
            const other = pids.find(id => id !== playerId && gameState.players[id] && !gameState.players[id].isDead);
            const avoid = pids.filter(id => id !== playerId).map(id => gameState.players[id] && gameState.players[id].spawnIdx).filter(i => i != null);
            const opp = other ? gameState.players[other] : null;
            placeAtSpawn(pl, pickSpawn(avoid, opp ? opp.pos : null, 2));
            ws.send(JSON.stringify({ type: 'respawn', pos: pl.pos.toArray() }));
          }
        }, 3000);
      }
    } else if (data.type === 'new_map') {
      updateMap(data.seed);
      updatePair();
      // New map (re)starts the duel cycle
      if (Object.keys(gameState.players).length === 2) beginWarmup();
      else matchToWaiting();
      wss.clients.forEach(c => {
        if (c.readyState === 1) {
          c.send(JSON.stringify({ type: 'map_change', seed: data.seed }));
        }
      });
    }
  });

  ws.on('close', () => {
    if (playerId && gameState.players[playerId]) {
       const pName = gameState.players[playerId].name;
       delete gameState.players[playerId];
       delete match.ready[playerId];
       // A mid-round disconnect voids the round (scores reset, warmup restarts on next join).
       if (match.phase === 'active' || match.phase === 'summary') matchToWaiting();
      else if (match.phase === 'warmup') { match.phase = 'waiting'; match.deadlineMs = 0; }
       const evtMsg = JSON.stringify({ type: 'player_disconnected', name: pName });
       wss.clients.forEach(client => {
          if (client.readyState === 1) client.send(evtMsg);
       });
    }
  });
});

// Physics Loop (128 Tick)

function frameFor(n) {
  const r = new TH.Vector3();
  const ref = Math.abs(n.y) > 0.98 ? new TH.Vector3(0, 0, 1) : new TH.Vector3(0, 1, 0);
  r.crossVectors(ref, n).normalize();
  if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
  const u = new TH.Vector3().crossVectors(n, r);
  return { r, u };
}

let R_AB = [new TH.Matrix4(), new TH.Matrix4()], R_BA = [new TH.Matrix4(), new TH.Matrix4()];
function updatePair() {
  for (let idx = 0; idx < 2; idx++) {
    const offset = idx * 2;
    if (!gameState.portals[offset] || !gameState.portals[offset+1]) continue;
    const fA = frameFor(gameState.portals[offset].n), fB = frameFor(gameState.portals[offset+1].n);
    const mA = new TH.Matrix4().makeBasis(fA.r, fA.u, gameState.portals[offset].n);
    const mB = new TH.Matrix4().makeBasis(fB.r.clone().multiplyScalar(-1), fB.u, gameState.portals[offset+1].n.clone().multiplyScalar(-1));
    R_AB[idx] = new TH.Matrix4().multiplyMatrices(mB, new TH.Matrix4().copy(mA).transpose());
    R_BA[idx] = new TH.Matrix4().copy(R_AB[idx]).transpose();
  }
}
const DT = 1 / TICK_RATE;

// Provide a dummy R_AB / R_BA for teleport check (we'll implement real matrices later)
const tpState = { nowT: 0, tpGracePortal: null, tpGraceT: -1, R_AB, R_BA };
const events = {};

function endRound() {
  const pids = Object.keys(gameState.players);
  let winner = null;
  if (pids.length === 2) {
    const a = pids[0], b = pids[1];
    const sa = match.scores[a] || 0, sb = match.scores[b] || 0;
    if (sa === sb) winner = 'tie';
    else { winner = sa > sb ? a : b; match.roundWins[winner] = (match.roundWins[winner] || 0) + 1; }
  } else if (pids.length === 1) {
    winner = pids[0];
    match.roundWins[winner] = (match.roundWins[winner] || 0) + 1;
  }
  match.winner = winner;
  match.phase = 'summary';
  match.deadlineMs = 0;
  const msg = JSON.stringify({ type: 'round_over', match: matchInfo() });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(msg);
  });
}

setInterval(() => {
  tpState.nowT = Date.now() / 1000;

  if (match.phase === 'warmup' && Date.now() >= match.deadlineMs) beginRound();
  else if (match.phase === 'active' && Date.now() >= match.deadlineMs) endRound();

  for (const pid in gameState.players) {
    const pl = gameState.players[pid];
    
    let lastKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
    let autohop = false;
    while (pl.inputBuffer.length > 0) {
      const input = pl.inputBuffer.shift();
      pl.yaw = input.yaw;
      pl.pitch = input.pitch;
      if (input.keys) lastKeys = input.keys;
      if (input.autohop !== undefined) autohop = input.autohop;
      if (input.jumpBuf !== undefined) pl.jumpBuf = input.jumpBuf;
      if (!pl.isDead && input.pos) pl.pos.fromArray(input.pos);
      if (!pl.isDead && input.vel) pl.vel.fromArray(input.vel);
      if (input.activeWeapon !== undefined) pl.activeWeapon = input.activeWeapon;
      if (input.crouchT !== undefined) pl.crouchT = input.crouchT;
    }
    
    physics.physStep(
      pl, 
      lastKeys, 
      autohop, 
      DT, 
      obbs, 
      gameState.portals, 
      gameState.grabCubes, 
      null, 
      tpState, 
      events
    );
  }


  for (const c of gameState.grabCubes) {
      let isGrabbed = false;
      for (const pid in gameState.players) {
         if (gameState.players[pid].grabbedCubeIdx === gameState.grabCubes.indexOf(c)) {
             isGrabbed = true; break;
         }
      }
      if (!isGrabbed) {
          c.vel.y -= CFG.G * DT;
          const teleported = physics.teleportCube(c, DT, gameState.portals, R_AB, R_BA);
          if (!teleported) {
             const step = c.vel.clone().multiplyScalar(DT);
             c.pos.add(step);
             physics.collideCube(c, obbs, gameState.portals, 0.75);
          }
      }
  }
  physics.resolveCubeCollisions(gameState.grabCubes, null);
  gameState.grabCubes.forEach(c => { if (c.vel.lengthSq() < 0.001) c.vel.set(0,0,0); });
  // Broadcast state
  const stateUpdate = {
    type: 'state',
    tick: gameState.tick++,
    players: {},
    cubes: gameState.grabCubes.map(c => ({ pos: c.pos.toArray(), vel: c.vel.toArray() })),
    portals: gameState.portals.map(P => ({
      placed: P.placed,
      c: P.c.toArray(), n: P.n.toArray(), r: P.r.toArray(), u: P.u.toArray()
    })),
    match: matchInfo()
  };
  
  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    stateUpdate.players[pid] = {
      pos: p.pos.toArray(),
      vel: p.vel.toArray(),
      yaw: p.yaw,
      pitch: p.pitch,
      activeWeapon: p.activeWeapon || 1,
      crouchT: p.crouchT || 0,
      isDead: !!p.isDead
    };
  }

  const payload = JSON.stringify(stateUpdate);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });

}, 1000 / TICK_RATE);

console.log("PORTAL//FLUX Server running on ws://localhost:3001");















