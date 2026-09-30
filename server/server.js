import { WebSocketServer } from 'ws';
import * as TH from 'three';
import { CFG, PORT } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js';
import { generateMap } from '../shared/mapgen.js';

const wss = new WebSocketServer({ port: 3001 });
const physics = initPhysics(TH, CFG, PORT);

const SERVER_PASSWORD = "secret";
import { seedStr, mapData, gameState, obbs, updateMap } from './gamestate.js';

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
      playerId = Object.keys(gameState.players).length.toString();
      const playerIndex = Object.keys(gameState.players).length;
      const pName = data.name || 'Guest';
        gameState.players[playerId] = { playerIndex, name: pName,
        pos: new TH.Vector3(mapData.spawn.x, mapData.spawn.y, mapData.spawn.z),
        vel: new TH.Vector3(),
        yaw: 0, pitch: 0,
        grounded: false, groundNormal: new TH.Vector3(0,1,0),
        groundT: -1, jumpBuf: -1, maxSpeed: 0,
        inputBuffer: []
      };
      
      ws.send(JSON.stringify({
        type: 'init',
        playerId,
        playerIndex,
        seed: seedStr
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
    } else if (data.type === 'fire_beam' || data.type === 'fire_rocket' || data.type === 'fire_instagib' || data.type === 'player_died') {
      data.playerId = playerId;
      const msg = JSON.stringify(data);
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === 1) c.send(msg);
      });
    } else if (data.type === 'new_map') {
      updateMap(data.seed);
      updatePair();
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
const TICK_RATE = 128;
const DT = 1 / TICK_RATE;

// Provide a dummy R_AB / R_BA for teleport check (we'll implement real matrices later)
const tpState = { nowT: 0, tpGracePortal: null, tpGraceT: -1, R_AB, R_BA };
const events = {};

setInterval(() => {
  tpState.nowT = Date.now() / 1000;

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
      if (input.pos) pl.pos.fromArray(input.pos);
      if (input.vel) pl.vel.fromArray(input.vel);
      if (input.activeWeapon !== undefined) pl.activeWeapon = input.activeWeapon;
      if (input.isDead !== undefined) pl.isDead = input.isDead;
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
  };
  
  for (const pid in gameState.players) {
    const p = gameState.players[pid];
    stateUpdate.players[pid] = {
      pos: p.pos.toArray(),
      vel: p.vel.toArray(),
      yaw: p.yaw,
      pitch: p.pitch,
      activeWeapon: p.activeWeapon || 1
    };
  }

  const payload = JSON.stringify(stateUpdate);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });

}, 1000 / TICK_RATE);

console.log("PORTAL//FLUX Server running on ws://localhost:3001");










