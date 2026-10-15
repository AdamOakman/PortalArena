import { WebSocketServer } from 'ws';
import * as TH from 'three';
import { CFG, PORT, TICK_RATE, MAX_PLAYERS, MAX_SPECTATORS } from '../shared/constants.js';
import { initPhysics } from '../shared/physics.js';
import { tickBot, removeBot, cleanupBotPortals, resetBotState, getBotPortalBase, checkPortalOverlap } from './bots.js';

const wss = new WebSocketServer({ port: 3001 });
const physics = initPhysics(TH, CFG, PORT);

const SERVER_PASSWORD = "secret";
import { seedStr, mapData, gameState, obbs, updateMap, match, beginWarmup, startCountdown, beginRound, matchToWaiting, matchInfo, pickSpawn, placeAtSpawn, serverDestroyWall, resetMapState } from './gamestate.js';

// ------------------------------------------------------------------ bot management
const BOT_COUNT = 2; // how many bots to fill the server with when empty
let nextBotId = 0;

function addBot() {
  const botId = 'bot_' + (nextBotId++);
  const taken = new Set(Object.keys(gameState.players).map(id => gameState.players[id].playerIndex));
  const playerIndex = taken.has(0) ? (taken.has(1) ? 0 : 1) : 0;
  const usedIdxs = Object.values(gameState.players).map(p => p.spawnIdx).filter(i => i != null);
  const spawnIdx = pickSpawn(usedIdxs);
  const spawn = mapData.spawns[spawnIdx];
  const botName = 'Bot_' + nextBotId;
  gameState.players[botId] = {
    isBot: true,
    playerIndex,
    name: botName,
    ws: null,
    pos: new TH.Vector3(spawn.x, spawn.y, spawn.z),
    vel: new TH.Vector3(),
    yaw: 0, pitch: 0,
    grounded: false, groundNormal: new TH.Vector3(0, 1, 0),
    groundT: -1, jumpBuf: -1, maxSpeed: 0,
    ping: 0, shots: 0, hits: 0,
    inputBuffer: [], spawnIdx,
    activeWeapon: 1, crouchT: 0,
  };
  return botId;
}

function removeABot() {
  const pids = Object.keys(gameState.players);
  for (let i = pids.length - 1; i >= 0; i--) {
    const pid = pids[i];
    const pl = gameState.players[pid];
    if (pl.isBot) {
      const base = getBotPortalBase(pl);
      cleanupBotPortals(pid, pl, gameState.portals);
      updatePair();
      [base, base + 1].forEach(pi => {
        const msg = JSON.stringify({ type: 'portal_remove', pi });
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
      });
      delete gameState.players[pid];
      delete match.ready[pid];
      removeBot(pid);
      return pid;
    }
  }
  return null;
}

function countBots() {
  return Object.keys(gameState.players).filter(id => gameState.players[id].isBot).length;
}

function countHumans() {
  return Object.keys(gameState.players).filter(id => !gameState.players[id].isBot).length;
}

function fillWithBots() {
  const humans = countHumans();
  const maxBotsAllowed = Math.max(0, BOT_COUNT - humans);
  while (countBots() < maxBotsAllowed && Object.keys(gameState.players).length < BOT_COUNT) {
    addBot();
  }
  if (Object.keys(gameState.players).length >= 2 && match.phase === 'waiting') {
    beginWarmup();
  }
}

// Initial bot fill (give map a tick to initialise)
setTimeout(fillWithBots, 200);
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

function handlePlayerDeath(victimId, killerId = null, cause = null, viaPortal = false) {
  const pl = gameState.players[victimId];
  if (!pl || pl.isDead) return;
  pl.isDead = true;

  const scoring = match.phase === 'active' || match.phase === 'warmup';
  const killerPid = (killerId && killerId !== victimId && gameState.players[killerId]) ? killerId : null;
  let feedMsg = null, feedHot = false;

  if (cause === 'void' || cause === 'lava') {
    if (scoring) match.scores[victimId] = (match.scores[victimId] || 0) - 1;
    feedMsg = feedPick(cause === 'lava' ? LAVA_MSGS : VOID_MSGS, pl.name, null);
  } else if (killerPid) {
    if (scoring) match.scores[killerPid] = (match.scores[killerPid] || 0) + (viaPortal ? 2 : 1);
    feedMsg = feedPick(viaPortal ? PORTAL_KILL_MSGS : KILL_MSGS, pl.name, gameState.players[killerPid].name);
    feedHot = viaPortal;
  } else if (viaPortal) {
    if (scoring) match.scores[victimId] = (match.scores[victimId] || 0) - 2;
    feedMsg = feedPick(PORTAL_SUICIDE_MSGS, pl.name, null);
  }

  const deathColor = pl.playerIndex === 0 ? 0x33ff33 : 0xff3333;
  const deathMsg = JSON.stringify({
    type: 'player_died',
    playerId: victimId,
    color: deathColor,
    pos: pl.pos.toArray(),
    killerId: killerPid,
    viaPortal: !!viaPortal,
    cause: cause || null,
    feedMsg,
    feedHot
  });

  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(deathMsg);
  });

  setTimeout(() => {
    if (pl.isDead && gameState.players[victimId]) {
      pl.isDead = false;
      const pids = Object.keys(gameState.players);
      const other = pids.find(id => id !== victimId && gameState.players[id] && !gameState.players[id].isDead);
      const avoid = pids.filter(id => id !== victimId).map(id => gameState.players[id] && gameState.players[id].spawnIdx).filter(i => i != null);
      const opp = other ? gameState.players[other] : null;
      placeAtSpawn(pl, pickSpawn(avoid, opp ? opp.pos : null, 2));

      if (pl.isBot) {
        resetBotState(victimId);
      } else if (pl.ws && pl.ws.readyState === 1) {
        pl.ws.send(JSON.stringify({ type: 'respawn', pos: pl.pos.toArray() }));
      }
    }
  }, 3000);
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
      if (Object.keys(gameState.spectators).length >= MAX_SPECTATORS) {
        ws.close(1008, "Spectator limit reached");
        return;
      }
      playerId = String(nextPlayerId++);
      const pName = data.name || 'Guest';
      gameState.spectators[playerId] = { id: playerId, name: pName, ws, ping: 0 };
      fillWithBots();

      ws.send(JSON.stringify({
        type: 'init',
        playerId,
        isSpectator: true,
        playerIndex: -1,
        seed: seedStr,
        spawn: [0, 8, 12],
        match: matchInfo(),
        destroyedWalls: gameState.destroyedWalls
      }));

      const evtMsg = JSON.stringify({ type: 'player_connected', name: pName });
      wss.clients.forEach(client => {
         if (client.readyState === 1) client.send(evtMsg);
      });

    } else if (data.type === 'join_game') {
      if (!playerId || gameState.players[playerId]) return;
      const spec = gameState.spectators[playerId];
      if (!spec) return;

      if (countHumans() >= MAX_PLAYERS) {
        ws.send(JSON.stringify({ type: 'join_denied', reason: 'Active player slots full (2/2)' }));
        return;
      }

      const humansBefore = countHumans();
      const botsBefore = countBots();

      if (Object.keys(gameState.players).length >= MAX_PLAYERS && countBots() > 0) {
        removeABot();
      }

      delete gameState.spectators[playerId];
      const taken = new Set(Object.keys(gameState.players).map(id => gameState.players[id].playerIndex));
      const playerIndex = taken.has(0) ? 1 : 0;
      const pName = spec.name;
      const usedIdxs = Object.values(gameState.players).map(p => p.spawnIdx).filter(i => i != null);
      const spawnIdx = pickSpawn(usedIdxs);
      const spawn = mapData.spawns[spawnIdx];
      gameState.players[playerId] = {
        isBot: false,
        playerIndex,
        name: pName,
        ws,
        pos: new TH.Vector3(spawn.x, spawn.y, spawn.z),
        vel: new TH.Vector3(),
        yaw: 0, pitch: 0,
        grounded: false, groundNormal: new TH.Vector3(0, 1, 0),
        groundT: -1, jumpBuf: -1, maxSpeed: 0,
        ping: spec.ping || 0, shots: 0, hits: 0,
        inputBuffer: [], spawnIdx,
        activeWeapon: 1, crouchT: 0
      };

      const shouldResetWarmup = (humansBefore === 0) || (humansBefore === 1 && botsBefore >= 1);
      if (shouldResetWarmup) {
        resetMapState();
        updatePair();
        for (let pi = 0; pi < 4; pi++) {
          const pMsg = JSON.stringify({ type: 'portal_remove', pi });
          wss.clients.forEach(c => { if (c.readyState === 1) c.send(pMsg); });
        }
        beginWarmup();
        for (const pid in gameState.players) {
          const p = gameState.players[pid];
          if (p.isBot) {
            resetBotState(pid);
          } else if (pid !== playerId && p.ws && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify({
              type: 'map_change',
              seed: seedStr,
              spawn: p.pos.toArray()
            }));
            p.ws.send(JSON.stringify({
              type: 'respawn',
              pos: p.pos.toArray()
            }));
          }
        }
        for (const sid in gameState.spectators) {
          const specWs = gameState.spectators[sid].ws;
          if (specWs && specWs.readyState === 1) {
            specWs.send(JSON.stringify({
              type: 'map_change',
              seed: seedStr
            }));
          }
        }
      } else if (Object.keys(gameState.players).length >= 2 && match.phase !== 'warmup' && match.phase !== 'active') {
        beginWarmup();
      }

      const finalSpawn = gameState.players[playerId].pos.toArray();
      ws.send(JSON.stringify({
        type: 'join_success',
        playerId,
        playerIndex,
        spawn: finalSpawn,
        match: matchInfo(),
        destroyedWalls: gameState.destroyedWalls
      }));

      if (shouldResetWarmup) {
        ws.send(JSON.stringify({
          type: 'map_change',
          seed: seedStr,
          spawn: finalSpawn
        }));
      }

      const evtMsg = JSON.stringify({ type: 'player_connected', name: pName });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(evtMsg);
      });

    } else if (data.type === 'spectate_game') {
      if (!playerId || gameState.spectators[playerId]) return;
      const pl = gameState.players[playerId];
      if (!pl) return;

      if (Object.keys(gameState.spectators).length >= MAX_SPECTATORS) {
        ws.send(JSON.stringify({ type: 'spectate_denied', reason: 'Spectator slots full (4/4)' }));
        return;
      }

      const pName = pl.name;
      const base = pl.playerIndex * 2;
      [base, base + 1].forEach(pi => {
        if (gameState.portals[pi]) gameState.portals[pi].placed = false;
        const msg = JSON.stringify({ type: 'portal_remove', pi });
        wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
      });
      updatePair();

      delete gameState.players[playerId];
      delete match.ready[playerId];

      if (match.phase === 'active' || match.phase === 'summary') matchToWaiting();
      else if (match.phase === 'warmup') { match.phase = 'waiting'; match.deadlineMs = 0; }

      gameState.spectators[playerId] = { id: playerId, name: pName, ws, ping: pl.ping || 0 };
      fillWithBots();

      ws.send(JSON.stringify({
        type: 'spectate_success',
        playerId,
        match: matchInfo()
      }));

      const evtMsg = JSON.stringify({ type: 'player_connected', name: pName + ' (spectating)' });
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
          for (const id in gameState.players) {
            if (gameState.players[id].isBot) match.ready[id] = true;
          }
          const pids = Object.keys(gameState.players);
          if (pids.length === 2 && pids.every(id => match.ready[id])) triggerCountdown();
        }
      }
    } else if (data.type === 'ping') {
      const p = gameState.players[playerId] || gameState.spectators[playerId];
      if (p) {
        if (typeof data.ping === 'number') p.ping = data.ping;
        ws.send(JSON.stringify({ type: 'pong', t: data.t }));
      }
    } else if (data.type === 'portal_place') {
      if (match.phase === 'countdown') return;
      const candidateC = new TH.Vector3().fromArray(data.c);
      const candidateN = new TH.Vector3().fromArray(data.n);
      const candidateR = new TH.Vector3().fromArray(data.r);
      const candidateU = new TH.Vector3().fromArray(data.u);
      if (checkPortalOverlap(candidateC, candidateN, candidateR, candidateU, gameState.portals, data.pi, PORT)) {
        return;
      }
      if (data.wallId) {
        const hitObb = obbs.find(o => o.id === data.wallId);
        if (hitObb && (hitObb.noPortal || hitObb.destroyed || hitObb.kind === 'ramp')) {
          return;
        }
      }
      for (const obb of obbs) {
        if (obb.destroyed) {
          const dx = candidateC.x - obb.c.x, dy = candidateC.y - obb.c.y, dz = candidateC.z - obb.c.z;
          const l0 = Math.abs(dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z);
          const l1 = Math.abs(dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z);
          const l2 = Math.abs(dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z);
          if (l0 <= obb.he[0] + 0.1 && l1 <= obb.he[1] + 0.1 && l2 <= obb.he[2] + 0.1) {
            return;
          }
        }
      }
      const P = gameState.portals[data.pi];
      P.placed = true;
      P.c.copy(candidateC);
      P.n.copy(candidateN);
      P.r.copy(candidateR);
      P.u.copy(candidateU);
      updatePair();
      const msg = JSON.stringify(data);
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === 1) c.send(msg);
      });
    } else if (data.type === 'destroy_wall') {
      if (match.phase === 'countdown') return;
      const result = serverDestroyWall(data.wallId, data.wallCenter, data.point);
      if (result) {
        updatePair();
        gameState.destroyedWalls.push(data);
        for (const pi of result.cancelledPortals) {
          const cancelMsg = JSON.stringify({ type: 'portal_remove', pi });
          wss.clients.forEach(c => { if (c.readyState === 1) c.send(cancelMsg); });
        }
        const fwdMsg = JSON.stringify(data);
        wss.clients.forEach(c => { if (c !== ws && c.readyState === 1) c.send(fwdMsg); });
      }
    } else if (data.type === 'portal_remove') {
      const P = gameState.portals[data.pi];
      P.placed = false;
      updatePair();
      const msg = JSON.stringify(data);
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === 1) c.send(msg);
      });
    } else if (data.type === 'blast_cubes') {
      data.cubes.forEach(c => {
         const cube = gameState.grabCubes[c.idx];
         if (cube) {
            cube.vel.fromArray(c.vel);
            if (c.rotVel) cube.rotVel.fromArray(c.rotVel);
         }
      });
    } else if (data.type === 'rocket_explosion') {
      if (match.phase === 'countdown') return;
      const explPos = new TH.Vector3().fromArray(data.pos);
      for (const pid in gameState.players) {
        const pl = gameState.players[pid];
        if (!pl.isDead) {
          const pCenter = pl.pos.clone();
          pCenter.y += CFG.H / 2;
          const dvec = new TH.Vector3().subVectors(pCenter, explPos);
          const dist = dvec.length();
          if (dist < 12) {
            if (dvec.y < 0.2) dvec.y = 0.2;
            dvec.normalize();
            const force = (12 - dist) * 2.25;
            pl.vel.add(dvec.multiplyScalar(force));
            pl.grounded = false;
          }
        }
      }
    } else if (data.type === String.fromCharCode(116,104,114,111,119,95,99,117,98,101)) {
      if (match.phase === 'countdown') return;
      const c = gameState.grabCubes[data.idx];
      if (c) {
         c.pos.fromArray(data.pos);
         c.vel.fromArray(data.vel);
      }
    } else if (data.type === 'fire_beam' || data.type === 'fire_rocket' || data.type === 'fire_instagib') {
      if (match.phase === 'countdown') return;
      data.playerId = playerId;
      // Accuracy: instagib is the one weapon whose hits the server can see
      if (data.type === 'fire_instagib') {
        const fp = gameState.players[playerId];
        if (fp && match.phase === 'active') {
          fp.shots++;
          if (data.hitPlayerId && gameState.players[data.hitPlayerId]) fp.hits++;
        }
        if (data.hitPlayerId && gameState.players[data.hitPlayerId]?.isBot) {
          handlePlayerDeath(data.hitPlayerId, playerId, 'instagib', !!(data.pts && data.pts.length > 2));
        }
      }
      const msg = JSON.stringify(data);
      wss.clients.forEach(c => {
        if (c !== ws && c.readyState === 1) c.send(msg);
      });
    } else if (data.type === 'player_died') {
      handlePlayerDeath(playerId, data.killerId, data.cause, data.viaPortal);
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
       if (match.phase === 'active' || match.phase === 'summary' || match.phase === 'countdown') matchToWaiting();
      else if (match.phase === 'warmup') { match.phase = 'waiting'; match.deadlineMs = 0; }
       const evtMsg = JSON.stringify({ type: 'player_disconnected', name: pName });
       wss.clients.forEach(client => {
          if (client.readyState === 1) client.send(evtMsg);
       });
       fillWithBots();
    } else if (playerId && gameState.spectators[playerId]) {
       const pName = gameState.spectators[playerId].name;
       delete gameState.spectators[playerId];
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

function triggerCountdown() {
  startCountdown();
  updatePair();
  for (const id in gameState.players) {
    const p = gameState.players[id];
    p.isDead = false;
    p.vel.set(0, 0, 0);
    if (p.isBot) {
      resetBotState(id);
    } else if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({
        type: 'map_change',
        seed: seedStr,
        spawn: p.pos.toArray()
      }));
      p.ws.send(JSON.stringify({
        type: 'respawn',
        pos: p.pos.toArray()
      }));
    }
  }
  const startMsg = JSON.stringify({ type: 'countdown_start' });
  wss.clients.forEach(c => {
    if (c.readyState === 1) c.send(startMsg);
  });
}

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

let botSummaryAutoRestart = 0;
let lastPhysicsTime = performance.now();
let physicsAccumulator = 0;

function stepPhysics(dt) {
  tpState.nowT = Date.now() / 1000;

  for (const pid in gameState.players) {
    const pl = gameState.players[pid];
    
    let lastKeys = pl.lastKeys || { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
    let autohop = pl.autohop || false;

    if (pl.isBot) {
      if (!pl.isDead && match.phase !== 'countdown') {
        lastKeys = tickBot(pid, pl, tpState.nowT, gameState.portals, PORT, (pIdx, surface, eyePos) => {
          updatePair();
          const P = gameState.portals[pIdx];
          const placeMsg = JSON.stringify({
            type: 'portal_place',
            pi: pIdx,
            c: P.c.toArray(),
            n: P.n.toArray(),
            r: P.r.toArray(),
            u: P.u.toArray()
          });
          const beamMsg = JSON.stringify({
            type: 'fire_beam',
            playerId: pid,
            pi: pIdx,
            start: eyePos.toArray(),
            end: surface.c.toArray()
          });
          wss.clients.forEach(c => {
            if (c.readyState === 1) {
              c.send(placeMsg);
              c.send(beamMsg);
            }
          });
        });
        autohop = true;
      } else {
        lastKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
        pl.vel.set(0, 0, 0);
      }
    } else {
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
      pl.lastKeys = lastKeys;
      pl.autohop = autohop;
    }
    
    if (match.phase === 'countdown') {
      lastKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
      autohop = false;
      pl.vel.set(0, 0, 0);
    }

    physics.physStep(
      pl, 
      lastKeys, 
      autohop, 
      dt, 
      obbs, 
      gameState.portals, 
      gameState.grabCubes, 
      null, 
      tpState, 
      events,
      gameState.players
    );

    // Bot death check (void / lava)
    if (pl.isBot && !pl.isDead) {
      let deadCause = null;
      if (pl.pos.y < -40.5) {
        deadCause = 'void';
      } else if (mapData.lava) {
        for (const L of mapData.lava) {
          const dx = pl.pos.x - L.x, dz = pl.pos.z - L.z;
          if (dx * dx + dz * dz < L.r * L.r && pl.pos.y < L.y + 0.6) {
            deadCause = 'lava';
            break;
          }
        }
      }
      if (deadCause) {
        handlePlayerDeath(pid, null, deadCause, false);
      }
    }
  }

  physics.resolvePlayerCollisions(gameState.players);

  for (const c of gameState.grabCubes) {
      let isGrabbed = false;
      for (const pid in gameState.players) {
         if (gameState.players[pid].grabbedCubeIdx === gameState.grabCubes.indexOf(c)) {
             isGrabbed = true; break;
         }
      }
      if (!isGrabbed) {
          c.vel.y -= CFG.G * dt;
          const teleported = physics.teleportCube(c, dt, gameState.portals, R_AB, R_BA);
          if (!teleported) {
             const step = c.vel.clone().multiplyScalar(dt);
             c.pos.add(step);
             physics.collideCube(c, obbs, gameState.portals, 0.75);
          }
      }
  }
  physics.resolveCubeCollisions(gameState.grabCubes, null);
  gameState.grabCubes.forEach(c => { if (c.vel.lengthSq() < 0.001) c.vel.set(0,0,0); });
}

setInterval(() => {
  if (match.phase === 'warmup' && Date.now() >= match.deadlineMs) triggerCountdown();
  else if (match.phase === 'countdown' && Date.now() >= match.deadlineMs) beginRound();
  else if (match.phase === 'active' && Date.now() >= match.deadlineMs) endRound();
  else if (match.phase === 'summary' && countHumans() === 0) {
    if (!botSummaryAutoRestart) botSummaryAutoRestart = Date.now() + 6000;
    else if (Date.now() >= botSummaryAutoRestart) {
      botSummaryAutoRestart = 0;
      beginWarmup();
    }
  } else {
    botSummaryAutoRestart = 0;
  }

  const now = performance.now();
  let elapsed = (now - lastPhysicsTime) / 1000;
  lastPhysicsTime = now;
  if (elapsed > 0.1) elapsed = 0.1;
  physicsAccumulator += elapsed;

  let steps = 0;
  while (physicsAccumulator >= DT && steps < 16) {
    stepPhysics(DT);
    physicsAccumulator -= DT;
    steps++;
  }

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
      isDead: !!p.isDead,
      playerIndex: p.playerIndex
    };
  }

  const payload = JSON.stringify(stateUpdate);
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });

}, 1000 / TICK_RATE);

console.log("Portal Arena Server running on ws://localhost:3001");















