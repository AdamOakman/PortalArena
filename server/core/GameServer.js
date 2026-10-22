import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import * as TH from 'three';
import { CFG, PORT, TICK_RATE, MAX_PLAYERS, MAX_SPECTATORS } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';
import { BotAgent } from '../bots/BotAgent.js';
import { MatchSession } from '../match/MatchSession.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../../dist');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wav': 'audio/wav',
  '.woff2': 'font/woff2',
};

const SERVER_PASSWORD = 'secret';
const BOT_COUNT = 2;

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

/**
 * GameServer — Object-Oriented Composition Root for the authoritative multiplayer backend.
 */
export class GameServer {
  constructor(port = 3001) {
    this.port = port;
    this.matchSession = new MatchSession();
    this.nextPlayerId = 0;
    this.nextBotId = 0;
    this.botSummaryAutoRestart = 0;
    this.lastPhysicsTime = performance.now();
    this.physicsAccumulator = 0;
    this.DT = 1 / TICK_RATE;

    this.R_AB = [new TH.Matrix4(), new TH.Matrix4()];
    this.R_BA = [new TH.Matrix4(), new TH.Matrix4()];
    this.tpState = { nowT: 0, tpGracePortal: null, tpGraceT: -1, R_AB: this.R_AB, R_BA: this.R_BA };

    this.physics = initPhysics(TH, CFG, PORT);
    this.server = http.createServer((req, res) => this._handleHttpRequest(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws) => this._handleConnection(ws));

    this.tickInterval = null;
  }

  get gameState() {
    return this.matchSession.gameState;
  }

  get match() {
    return this.matchSession.match;
  }

  get mapData() {
    return this.matchSession.mapData;
  }

  get obbs() {
    return this.matchSession.obbs;
  }

  get seedStr() {
    return this.matchSession.seedStr;
  }

  _handleHttpRequest(req, res) {
    const reqUrl = req.url === '/' ? '/index.html' : (req.url || '').split('?')[0];
    const safePath = path.normalize(reqUrl).replace(/^(\.\.[/\\])+/, '');
    const filePath = path.join(DIST_DIR, safePath);

    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err || !stats.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found - Ensure `npm run build` has been executed.');
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      fs.createReadStream(filePath).pipe(res);
    });
  }

  broadcast(messageObj, filterWs = null) {
    const payload = typeof messageObj === 'string' ? messageObj : JSON.stringify(messageObj);
    this.wss.clients.forEach(client => {
      if (client.readyState === 1 && (!filterWs || client !== filterWs)) {
        client.send(payload);
      }
    });
  }

  frameFor(n) {
    const r = new TH.Vector3();
    const ref = Math.abs(n.y) > 0.98 ? new TH.Vector3(0, 0, 1) : new TH.Vector3(0, 1, 0);
    r.crossVectors(ref, n).normalize();
    if (r.lengthSq() < 1e-8) r.set(1, 0, 0);
    const u = new TH.Vector3().crossVectors(n, r);
    return { r, u };
  }

  updatePair() {
    for (let idx = 0; idx < 2; idx++) {
      const offset = idx * 2;
      if (!this.gameState.portals[offset] || !this.gameState.portals[offset + 1]) continue;
      const fA = this.frameFor(this.gameState.portals[offset].n);
      const fB = this.frameFor(this.gameState.portals[offset + 1].n);
      const mA = new TH.Matrix4().makeBasis(fA.r, fA.u, this.gameState.portals[offset].n);
      const mB = new TH.Matrix4().makeBasis(fB.r.clone().multiplyScalar(-1), fB.u, this.gameState.portals[offset + 1].n.clone().multiplyScalar(-1));
      this.R_AB[idx] = new TH.Matrix4().multiplyMatrices(mB, new TH.Matrix4().copy(mA).transpose());
      this.R_BA[idx] = new TH.Matrix4().copy(this.R_AB[idx]).transpose();
    }
  }

  broadcastResetWalls() {
    this.matchSession.resetDestructibleWalls();
    this.updatePair();
    const msg = JSON.stringify({
      type: 'reset_walls',
      seed: this.seedStr,
      destroyedWalls: []
    });
    this.broadcast(msg);
  }

  pickFunnyBotName() {
    const existingNames = new Set(Object.values(this.gameState.players).map(p => p.name));
    return BotAgent.generateName(existingNames);
  }

  addBot() {
    const botId = 'bot_' + (this.nextBotId++);
    const taken = new Set(Object.keys(this.gameState.players).map(id => this.gameState.players[id].playerIndex));
    const playerIndex = taken.has(0) ? (taken.has(1) ? 0 : 1) : 0;
    const usedIdxs = Object.values(this.gameState.players).map(p => p.spawnIdx).filter(i => i != null);
    const spawnIdx = this.matchSession.pickSpawn(usedIdxs);
    const spawn = this.mapData.spawns[spawnIdx];
    const botName = this.pickFunnyBotName();
    this.gameState.players[botId] = new BotAgent({
      botId,
      playerIndex,
      name: botName,
      spawn,
      spawnIdx
    });
    return botId;
  }

  removeABot() {
    const pids = Object.keys(this.gameState.players);
    for (let i = pids.length - 1; i >= 0; i--) {
      const pid = pids[i];
      const pl = this.gameState.players[pid];
      if (pl.isBot) {
        const base = pl.portalBaseIndex;
        pl.cleanupPortals(this.gameState.portals);
        this.updatePair();
        [base, base + 1].forEach(pi => {
          this.broadcast(JSON.stringify({ type: 'portal_remove', pi }));
        });
        delete this.gameState.players[pid];
        delete this.match.ready[pid];
        return pid;
      }
    }
    return null;
  }

  countBots() {
    return Object.keys(this.gameState.players).filter(id => this.gameState.players[id].isBot).length;
  }

  countHumans() {
    return Object.keys(this.gameState.players).filter(id => !this.gameState.players[id].isBot).length;
  }

  fillWithBots() {
    const humans = this.countHumans();
    const maxBotsAllowed = Math.max(0, BOT_COUNT - humans);
    while (this.countBots() < maxBotsAllowed && Object.keys(this.gameState.players).length < BOT_COUNT) {
      this.addBot();
    }
    if (Object.keys(this.gameState.players).length >= 2 && this.match.phase === 'waiting') {
      this.matchSession.beginWarmup();
      this.broadcastResetWalls();
    }
  }

  handlePlayerDeath(victimId, killerId = null, cause = null, viaPortal = false, shotOrigin = null, beamDir = null) {
    const pl = this.gameState.players[victimId];
    if (!pl || pl.isDead) return;
    pl.isDead = true;

    const scoring = this.match.phase === 'active' || this.match.phase === 'warmup';
    const killerPid = (killerId && killerId !== victimId && this.gameState.players[killerId]) ? killerId : null;
    let feedMsg = null, feedHot = false;

    if (cause === 'void' || cause === 'lava') {
      if (scoring) this.match.scores[victimId] = (this.match.scores[victimId] || 0) - 1;
      feedMsg = feedPick(cause === 'lava' ? LAVA_MSGS : VOID_MSGS, pl.name, null);
    } else if (killerPid) {
      if (scoring) this.match.scores[killerPid] = (this.match.scores[killerPid] || 0) + (viaPortal ? 2 : 1);
      feedMsg = feedPick(viaPortal ? PORTAL_KILL_MSGS : KILL_MSGS, pl.name, this.gameState.players[killerPid].name);
      feedHot = viaPortal;
    } else if (viaPortal) {
      if (scoring) this.match.scores[victimId] = (this.match.scores[victimId] || 0) - 2;
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
      feedHot,
      shotOrigin: shotOrigin || null,
      beamDir: beamDir || null
    });

    this.broadcast(deathMsg);

    setTimeout(() => {
      if (pl.isDead && this.gameState.players[victimId]) {
        pl.isDead = false;
        const pids = Object.keys(this.gameState.players);
        const other = pids.find(id => id !== victimId && this.gameState.players[id] && !this.gameState.players[id].isDead);
        const avoid = pids.filter(id => id !== victimId).map(id => this.gameState.players[id] && this.gameState.players[id].spawnIdx).filter(i => i != null);
        const opp = other ? this.gameState.players[other] : null;
        this.matchSession.placeAtSpawn(pl, this.matchSession.pickSpawn(avoid, opp ? opp.pos : null, 2));

        if (pl.isBot) {
          pl.resetAI();
        }
        const respawnMsg = JSON.stringify({
          type: 'respawn',
          playerId: victimId,
          pos: pl.pos.toArray()
        });
        this.broadcast(respawnMsg);
      }
    }, 3000);
  }

  triggerCountdown() {
    this.matchSession.startCountdown();
    this.updatePair();
    for (const id in this.gameState.players) {
      const p = this.gameState.players[id];
      p.isDead = false;
      p.vel.set(0, 0, 0);
      if (p.isBot) {
        p.resetAI();
      } else if (p.ws && p.ws.readyState === 1) {
        p.ws.send(JSON.stringify({
          type: 'map_change',
          seed: this.seedStr,
          spawn: p.pos.toArray()
        }));
        p.ws.send(JSON.stringify({
          type: 'respawn',
          pos: p.pos.toArray()
        }));
      }
    }
    for (const sid in this.gameState.spectators) {
      const spec = this.gameState.spectators[sid];
      if (spec.ws && spec.ws.readyState === 1) {
        spec.ws.send(JSON.stringify({
          type: 'map_change',
          seed: this.seedStr
        }));
      }
    }
    this.broadcastResetWalls();
    this.broadcast(JSON.stringify({ type: 'countdown_start' }));
  }

  endRound() {
    const pids = Object.keys(this.gameState.players);
    let winner = null;
    if (pids.length === 2) {
      const a = pids[0], b = pids[1];
      const sa = this.match.scores[a] || 0, sb = this.match.scores[b] || 0;
      if (sa === sb) winner = 'tie';
      else { winner = sa > sb ? a : b; this.match.roundWins[winner] = (this.match.roundWins[winner] || 0) + 1; }
    } else if (pids.length === 1) {
      winner = pids[0];
      this.match.roundWins[winner] = (this.match.roundWins[winner] || 0) + 1;
    }
    this.match.winner = winner;
    this.match.phase = 'summary';
    this.match.deadlineMs = 0;
    this.broadcast(JSON.stringify({ type: 'round_over', match: this.matchSession.getInfo() }));
  }

  handleBotRocket(pid, rocketPos, rocketVel, targetHit) {
    if (this.match.phase === 'countdown') return;
    this.broadcast(JSON.stringify({
      type: 'fire_rocket',
      playerId: pid,
      pos: rocketPos.toArray(),
      vel: rocketVel.toArray()
    }));

    const hitPt = targetHit && targetHit.point ? targetHit.point : rocketPos.clone().addScaledVector(rocketVel.clone().normalize(), 20);
    const hitDist = rocketPos.distanceTo(hitPt);
    const flightMs = Math.max(30, Math.min(1500, (hitDist / 70) * 1000));

    setTimeout(() => {
      if (this.match.phase === 'countdown') return;
      this.broadcast(JSON.stringify({
        type: 'rocket_explosion',
        pos: hitPt.toArray()
      }));

      for (const plId in this.gameState.players) {
        const pl = this.gameState.players[plId];
        if (!pl.isDead) {
          const pCenter = pl.pos.clone();
          pCenter.y += CFG.H / 2;
          const dvec = new TH.Vector3().subVectors(pCenter, hitPt);
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

      if (targetHit && targetHit.obb && targetHit.obb.kind === 'wall' && !targetHit.obb.boundary) {
        const result = this.matchSession.serverDestroyWall(targetHit.obb.id, targetHit.obb.c.toArray(), hitPt.toArray());
        if (result) {
          this.updatePair();
          const dwMsg = {
            type: 'destroy_wall',
            wallId: targetHit.obb.id,
            wallCenter: targetHit.obb.c.toArray(),
            point: hitPt.toArray(),
            normal: targetHit.normal ? targetHit.normal.toArray() : [0, 1, 0]
          };
          this.gameState.destroyedWalls.push(dwMsg);
          for (const pi of result.cancelledPortals) {
            this.broadcast(JSON.stringify({ type: 'portal_remove', pi }));
          }
          this.broadcast(JSON.stringify(dwMsg));
        }
      }
    }, flightMs);
  }

  handleBotInstagib(pid, pts, hitPlayerId, scorch) {
    if (this.match.phase === 'countdown') return;
    const fp = this.gameState.players[pid];
    if (fp && this.match.phase === 'active') {
      fp.shots = (fp.shots || 0) + 1;
      if (hitPlayerId && this.gameState.players[hitPlayerId]) {
        fp.hits = (fp.hits || 0) + 1;
      }
    }

    if (hitPlayerId && this.gameState.players[hitPlayerId]?.isBot) {
      let shotOrigin = null, beamDir = null;
      if (pts && pts.length >= 2) {
        const pStart = pts[pts.length - 2];
        const pEnd = pts[pts.length - 1];
        shotOrigin = pStart.toArray();
        beamDir = new TH.Vector3().subVectors(pEnd, pStart).normalize().toArray();
      }
      this.handlePlayerDeath(hitPlayerId, pid, 'instagib', pts.length > 2, shotOrigin, beamDir);
    }

    this.broadcast(JSON.stringify({
      type: 'fire_instagib',
      playerId: pid,
      pts: pts.map(p => p.toArray()),
      hitPlayerId: hitPlayerId || null,
      scorch: scorch || null
    }));
  }

  _handleConnection(ws) {
    let playerId = null;

    ws.on('message', (message) => {
      let data;
      try {
        data = JSON.parse(message);
      } catch {
        return;
      }

      if (data.type === 'auth') {
        if (data.password !== SERVER_PASSWORD) {
          ws.close(1008, 'Invalid password');
          return;
        }
        if (Object.keys(this.gameState.spectators).length >= MAX_SPECTATORS) {
          ws.close(1008, 'Spectator limit reached');
          return;
        }
        playerId = String(this.nextPlayerId++);
        const pName = data.name || 'Guest';
        this.gameState.spectators[playerId] = { id: playerId, name: pName, ws, ping: 0 };
        this.fillWithBots();

        ws.send(JSON.stringify({
          type: 'init',
          playerId,
          isSpectator: true,
          playerIndex: -1,
          seed: this.seedStr,
          spawn: [0, 8, 12],
          match: this.matchSession.getInfo(),
          destroyedWalls: this.gameState.destroyedWalls
        }));

        this.broadcast(JSON.stringify({ type: 'player_connected', name: pName }));

      } else if (data.type === 'join_game') {
        if (!playerId || this.gameState.players[playerId]) return;
        const spec = this.gameState.spectators[playerId];
        if (!spec) return;

        if (this.countHumans() >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: 'join_denied', reason: 'Active player slots full (2/2)' }));
          return;
        }

        const humansBefore = this.countHumans();
        const botsBefore = this.countBots();

        if (Object.keys(this.gameState.players).length >= MAX_PLAYERS && this.countBots() > 0) {
          this.removeABot();
        }

        delete this.gameState.spectators[playerId];
        const taken = new Set(Object.keys(this.gameState.players).map(id => this.gameState.players[id].playerIndex));
        const playerIndex = taken.has(0) ? 1 : 0;
        const pName = spec.name;
        const usedIdxs = Object.values(this.gameState.players).map(p => p.spawnIdx).filter(i => i != null);
        const spawnIdx = this.matchSession.pickSpawn(usedIdxs);
        const spawn = this.mapData.spawns[spawnIdx];
        this.gameState.players[playerId] = {
          isBot: false,
          playerIndex,
          name: pName,
          ws,
          pos: new TH.Vector3(spawn.x, spawn.y, spawn.z),
          vel: new TH.Vector3(),
          yaw: 0,
          pitch: 0,
          grounded: false,
          groundNormal: new TH.Vector3(0, 1, 0),
          groundT: -1,
          jumpBuf: -1,
          maxSpeed: 0,
          ping: spec.ping || 0,
          shots: 0,
          hits: 0,
          inputBuffer: [],
          spawnIdx,
          activeWeapon: 1,
          crouchT: 0
        };

        const shouldResetWarmup = (humansBefore === 0) || (humansBefore === 1 && botsBefore >= 1);
        if (shouldResetWarmup) {
          this.matchSession.resetMapState();
          this.updatePair();
          for (let pi = 0; pi < 4; pi++) {
            this.broadcast(JSON.stringify({ type: 'portal_remove', pi }));
          }
          this.matchSession.beginWarmup();
          this.broadcastResetWalls();
          for (const pid in this.gameState.players) {
            const p = this.gameState.players[pid];
            if (p.isBot) {
              p.resetAI();
            } else if (pid !== playerId && p.ws && p.ws.readyState === 1) {
              p.ws.send(JSON.stringify({
                type: 'map_change',
                seed: this.seedStr,
                spawn: p.pos.toArray()
              }));
              p.ws.send(JSON.stringify({
                type: 'respawn',
                pos: p.pos.toArray()
              }));
            }
          }
          for (const sid in this.gameState.spectators) {
            const specWs = this.gameState.spectators[sid].ws;
            if (specWs && specWs.readyState === 1) {
              specWs.send(JSON.stringify({
                type: 'map_change',
                seed: this.seedStr
              }));
            }
          }
        } else if (Object.keys(this.gameState.players).length >= 2 && this.match.phase !== 'warmup' && this.match.phase !== 'active') {
          this.matchSession.beginWarmup();
          this.broadcastResetWalls();
        }

        const finalSpawn = this.gameState.players[playerId].pos.toArray();
        ws.send(JSON.stringify({
          type: 'join_success',
          playerId,
          playerIndex,
          spawn: finalSpawn,
          match: this.matchSession.getInfo(),
          seed: this.seedStr,
          destroyedWalls: this.gameState.destroyedWalls
        }));

        if (shouldResetWarmup) {
          ws.send(JSON.stringify({
            type: 'map_change',
            seed: this.seedStr,
            spawn: finalSpawn
          }));
        }

        this.broadcast(JSON.stringify({ type: 'player_connected', name: pName }));

      } else if (data.type === 'spectate_game') {
        if (!playerId || this.gameState.spectators[playerId]) return;
        const pl = this.gameState.players[playerId];
        if (!pl) return;

        if (Object.keys(this.gameState.spectators).length >= MAX_SPECTATORS) {
          ws.send(JSON.stringify({ type: 'spectate_denied', reason: 'Spectator slots full (4/4)' }));
          return;
        }

        const pName = pl.name;
        const base = pl.playerIndex * 2;
        [base, base + 1].forEach(pi => {
          if (this.gameState.portals[pi]) this.gameState.portals[pi].placed = false;
          this.broadcast(JSON.stringify({ type: 'portal_remove', pi }));
        });
        this.updatePair();

        delete this.gameState.players[playerId];
        delete this.match.ready[playerId];

        if (this.match.phase === 'active' || this.match.phase === 'summary') {
          this.matchSession.resetToWaiting();
          this.broadcastResetWalls();
        } else if (this.match.phase === 'warmup') {
          this.match.phase = 'waiting';
          this.match.deadlineMs = 0;
          this.broadcastResetWalls();
        }

        this.gameState.spectators[playerId] = { id: playerId, name: pName, ws, ping: pl.ping || 0 };
        this.fillWithBots();

        ws.send(JSON.stringify({
          type: 'spectate_success',
          playerId,
          match: this.matchSession.getInfo(),
          seed: this.seedStr,
          destroyedWalls: this.gameState.destroyedWalls
        }));

        this.broadcast(JSON.stringify({ type: 'player_connected', name: pName + ' (spectating)' }));
        this.broadcastState();

      } else if (data.type === 'input') {
        if (!playerId) return;
        const p = this.gameState.players[playerId];
        if (!p) return;
        p.inputBuffer.push(data);
        if (data.grabbedCubeIdx !== undefined) {
          p.grabbedCubeIdx = data.grabbedCubeIdx;
          const c = this.gameState.grabCubes[data.grabbedCubeIdx];
          if (c) {
            c.pos.fromArray(data.grabbedCubePos);
            c.vel.fromArray(data.grabbedCubeVel);
          }
        } else {
          p.grabbedCubeIdx = -1;
        }

      } else if (data.type === 'ready') {
        const p = this.gameState.players[playerId];
        if (p && (this.match.phase === 'warmup' || this.match.phase === 'waiting')) {
          this.match.ready[playerId] = !!data.ready;
          if (this.match.phase === 'warmup') {
            for (const id in this.gameState.players) {
              if (this.gameState.players[id].isBot) this.match.ready[id] = true;
            }
            const pids = Object.keys(this.gameState.players);
            if (pids.length === 2 && pids.every(id => this.match.ready[id])) this.triggerCountdown();
          }
        }
      } else if (data.type === 'ping') {
        const p = this.gameState.players[playerId] || this.gameState.spectators[playerId];
        if (p) {
          if (typeof data.ping === 'number') p.ping = data.ping;
          ws.send(JSON.stringify({ type: 'pong', t: data.t }));
        }
      } else if (data.type === 'portal_place') {
        if (this.match.phase === 'countdown') return;
        const candidateC = new TH.Vector3().fromArray(data.c);
        const candidateN = new TH.Vector3().fromArray(data.n);
        const candidateR = new TH.Vector3().fromArray(data.r);
        const candidateU = new TH.Vector3().fromArray(data.u);
        const hitObb = data.wallId ? this.obbs.find(o => o.id === data.wallId) : null;
        if (hitObb && (hitObb.noPortal || hitObb.destroyed || hitObb.kind === 'ramp')) {
          ws.send(JSON.stringify({ type: 'portal_remove', pi: data.pi }));
          return;
        }
        if (this.physics.isPortalPlacementBlocked(
          candidateC, candidateN, candidateR, candidateU, hitObb, data.pi,
          this.obbs, this.gameState.portals, this.mapData.lava, this.gameState.destroyedWallObbs, this.gameState.destroyedWalls
        )) {
          const fixed = this.physics.findClosestValidPortalPos(
            candidateC, candidateN, candidateR, candidateU, hitObb, data.pi,
            this.obbs, this.gameState.portals, this.mapData.lava, this.gameState.destroyedWallObbs, this.gameState.destroyedWalls
          );
          if (fixed) {
            candidateC.copy(fixed.c);
            data.c = candidateC.toArray();
          } else {
            ws.send(JSON.stringify({ type: 'portal_remove', pi: data.pi }));
            return;
          }
        }
        const P = this.gameState.portals[data.pi];
        P.placed = true;
        P.c.copy(candidateC);
        P.n.copy(candidateN);
        P.r.copy(candidateR);
        P.u.copy(candidateU);
        this.updatePair();
        this.broadcast(JSON.stringify(data), ws);
      } else if (data.type === 'destroy_wall') {
        if (this.match.phase === 'countdown') return;
        const result = this.matchSession.serverDestroyWall(data.wallId, data.wallCenter, data.point);
        if (result) {
          this.updatePair();
          this.gameState.destroyedWalls.push(data);
          for (const pi of result.cancelledPortals) {
            this.broadcast(JSON.stringify({ type: 'portal_remove', pi }));
          }
          this.broadcast(JSON.stringify(data), ws);
        }
      } else if (data.type === 'portal_remove') {
        const P = this.gameState.portals[data.pi];
        P.placed = false;
        this.updatePair();
        this.broadcast(JSON.stringify(data), ws);
      } else if (data.type === 'blast_cubes') {
        data.cubes.forEach(c => {
          const cube = this.gameState.grabCubes[c.idx];
          if (cube) {
            cube.vel.fromArray(c.vel);
            if (c.rotVel) cube.rotVel.fromArray(c.rotVel);
          }
        });
      } else if (data.type === 'rocket_explosion') {
        if (this.match.phase === 'countdown') return;
        const explPos = new TH.Vector3().fromArray(data.pos);
        for (const pid in this.gameState.players) {
          const pl = this.gameState.players[pid];
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
      } else if (data.type === String.fromCharCode(116, 104, 114, 111, 119, 95, 99, 117, 98, 101)) {
        if (this.match.phase === 'countdown') return;
        const c = this.gameState.grabCubes[data.idx];
        if (c) {
          c.pos.fromArray(data.pos);
          c.vel.fromArray(data.vel);
        }
      } else if (data.type === 'fire_beam' || data.type === 'fire_rocket' || data.type === 'fire_instagib') {
        if (this.match.phase === 'countdown') return;
        data.playerId = playerId;
        if (data.type === 'fire_instagib') {
          const fp = this.gameState.players[playerId];
          if (fp && this.match.phase === 'active') {
            fp.shots++;
            if (data.hitPlayerId && this.gameState.players[data.hitPlayerId]) fp.hits++;
          }
          if (data.hitPlayerId && this.gameState.players[data.hitPlayerId]?.isBot) {
            let shotOrigin = null, beamDir = null;
            if (data.pts && data.pts.length >= 2) {
              const pStart = new TH.Vector3(...data.pts[data.pts.length - 2]);
              const pEnd = new TH.Vector3(...data.pts[data.pts.length - 1]);
              shotOrigin = pStart.toArray();
              beamDir = pEnd.clone().sub(pStart).normalize().toArray();
            }
            this.handlePlayerDeath(data.hitPlayerId, playerId, 'instagib', !!(data.pts && data.pts.length > 2), shotOrigin, beamDir);
          }
        }
        this.broadcast(JSON.stringify(data), ws);
      } else if (data.type === 'teleport') {
        if (playerId && this.gameState.players[playerId]) {
          const p = this.gameState.players[playerId];
          if (data.viewOffset) {
            p.viewOffset = new TH.Quaternion(data.viewOffset[0], data.viewOffset[1], data.viewOffset[2], data.viewOffset[3]);
          } else {
            p.viewOffset = null;
          }
          if (data.pos) {
            p.pos.set(data.pos[0], data.pos[1], data.pos[2]);
          }
          if (data.yaw != null) {
            p.yaw = data.yaw;
          }
          this.broadcast(JSON.stringify({
            type: 'player_teleport',
            playerId,
            pos: data.pos,
            yaw: data.yaw,
            viewOffset: data.viewOffset
          }), ws);
        }
      } else if (data.type === 'player_died') {
        this.handlePlayerDeath(playerId, data.killerId, data.cause, data.viaPortal, data.shotOrigin, data.beamDir);
      } else if (data.type === 'new_map') {
        this.matchSession.updateMap(data.seed);
        this.updatePair();
        if (Object.keys(this.gameState.players).length === 2) {
          this.matchSession.beginWarmup();
          this.broadcastResetWalls();
        } else {
          this.matchSession.resetToWaiting();
          this.broadcastResetWalls();
        }
        for (const pid in this.gameState.players) {
          const p = this.gameState.players[pid];
          this.broadcast(JSON.stringify({ type: 'respawn', playerId: pid, pos: p.pos.toArray() }));
        }
        this.broadcast(JSON.stringify({ type: 'map_change', seed: data.seed }));
      }
    });

    ws.on('close', () => {
      if (playerId && this.gameState.players[playerId]) {
        const pName = this.gameState.players[playerId].name;
        delete this.gameState.players[playerId];
        delete this.match.ready[playerId];
        if (this.match.phase === 'active' || this.match.phase === 'summary' || this.match.phase === 'countdown') {
          this.matchSession.resetToWaiting();
          this.broadcastResetWalls();
        } else if (this.match.phase === 'warmup') {
          this.match.phase = 'waiting';
          this.match.deadlineMs = 0;
          this.broadcastResetWalls();
        }
        this.broadcast(JSON.stringify({ type: 'player_disconnected', name: pName }));
        this.fillWithBots();
      } else if (playerId && this.gameState.spectators[playerId]) {
        const pName = this.gameState.spectators[playerId].name;
        delete this.gameState.spectators[playerId];
        this.broadcast(JSON.stringify({ type: 'player_disconnected', name: pName }));
      }
    });
  }

  stepPhysics(dt) {
    this.tpState.nowT = Date.now() / 1000;

    for (const pid in this.gameState.players) {
      const pl = this.gameState.players[pid];
      let lastKeys = pl.lastKeys || { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
      let autohop = pl.autohop || false;

      if (pl.isBot) {
        if (pl.crouchT > 0) {
          pl.crouchT = Math.max(0, pl.crouchT - dt * 3);
        }
        if (!pl.isDead && this.match.phase !== 'countdown' && this.match.phase !== 'summary') {
          lastKeys = pl.tick(this.tpState.nowT, this.matchSession, {
            onPortalPlaced: (pIdx, surface, eyePos) => {
              const P = this.gameState.portals[pIdx];
              if (this.matchSession.isPortalOnDestroyedWall(P.c, P.n, P.r, P.u, PORT)) {
                P.placed = false;
                return;
              }
              this.updatePair();
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
              this.broadcast(placeMsg);
              this.broadcast(beamMsg);
            },
            onFireRocket: (rocketPos, rocketVel, targetHit) => {
              this.handleBotRocket(pid, rocketPos, rocketVel, targetHit);
            },
            onFireInstagib: (pts, hitPlayerId, scorch) => {
              this.handleBotInstagib(pid, pts, hitPlayerId, scorch);
            }
          }, PORT);
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

      if (this.match.phase === 'countdown') {
        lastKeys = { KeyW: false, KeyA: false, KeyS: false, KeyD: false, Space: false, ShiftLeft: false };
        autohop = false;
        pl.vel.set(0, 0, 0);
      }

      const playerEvents = {
        onTeleport: (teleportedPl) => {
          this.broadcast(JSON.stringify({
            type: 'player_teleport',
            playerId: pid,
            pos: teleportedPl?.pos ? [teleportedPl.pos.x, teleportedPl.pos.y, teleportedPl.pos.z] : null,
            yaw: teleportedPl?.yaw,
            viewOffset: (teleportedPl && teleportedPl.viewOffset) ? [
              teleportedPl.viewOffset.x,
              teleportedPl.viewOffset.y,
              teleportedPl.viewOffset.z,
              teleportedPl.viewOffset.w
            ] : null
          }));
        }
      };

      this.physics.physStep(
        pl,
        lastKeys,
        autohop,
        dt,
        this.obbs,
        this.gameState.portals,
        this.gameState.grabCubes,
        null,
        this.tpState,
        playerEvents,
        this.gameState.players
      );

      if (pl.viewOffset) {
        const id = new TH.Quaternion();
        pl.viewOffset.slerp(id, Math.min(1, dt * 5));
        if (pl.viewOffset.angleTo(id) < 0.001) pl.viewOffset = null;
      }

      if (pl.isBot && !pl.isDead) {
        let deadCause = null;
        if (pl.pos.y < -40.5) {
          deadCause = 'void';
        } else if (this.mapData.lava) {
          for (const L of this.mapData.lava) {
            const dx = pl.pos.x - L.x, dz = pl.pos.z - L.z;
            if (dx * dx + dz * dz < L.r * L.r && pl.pos.y < L.y + 0.6) {
              deadCause = 'lava';
              break;
            }
          }
        }
        if (deadCause) {
          this.handlePlayerDeath(pid, null, deadCause, false);
        }
      }
    }

    this.physics.resolvePlayerCollisions(this.gameState.players);

    for (const c of this.gameState.grabCubes) {
      let isGrabbed = false;
      for (const pid in this.gameState.players) {
        if (this.gameState.players[pid].grabbedCubeIdx === this.gameState.grabCubes.indexOf(c)) {
          isGrabbed = true;
          break;
        }
      }
      if (!isGrabbed) {
        c.vel.y -= CFG.G * dt;
        const teleported = this.physics.teleportCube(c, dt, this.gameState.portals, this.R_AB, this.R_BA);
        if (!teleported) {
          const step = c.vel.clone().multiplyScalar(dt);
          c.pos.add(step);
          this.physics.collideCube(c, this.obbs, this.gameState.portals, 0.75);
        }
      }
    }
    this.physics.resolveCubeCollisions(this.gameState.grabCubes, null);
    this.gameState.grabCubes.forEach(c => { if (c.vel.lengthSq() < 0.001) c.vel.set(0, 0, 0); });
  }

  tick() {
    if (this.match.phase === 'warmup' && Date.now() >= this.match.deadlineMs) this.triggerCountdown();
    else if (this.match.phase === 'countdown' && Date.now() >= this.match.deadlineMs) {
      this.matchSession.beginRound();
      this.broadcastResetWalls();
    }
    else if (this.match.phase === 'active' && Date.now() >= this.match.deadlineMs) this.endRound();
    else if (this.match.phase === 'summary' && this.countHumans() === 0) {
      if (!this.botSummaryAutoRestart) this.botSummaryAutoRestart = Date.now() + 6000;
      else if (Date.now() >= this.botSummaryAutoRestart) {
        this.botSummaryAutoRestart = 0;
        this.matchSession.beginWarmup();
        this.broadcastResetWalls();
      }
    } else {
      this.botSummaryAutoRestart = 0;
    }

    const now = performance.now();
    let elapsed = (now - this.lastPhysicsTime) / 1000;
    this.lastPhysicsTime = now;
    if (elapsed > 0.1) elapsed = 0.1;
    this.physicsAccumulator += elapsed;

    let steps = 0;
    while (this.physicsAccumulator >= this.DT && steps < 16) {
      this.stepPhysics(this.DT);
      this.physicsAccumulator -= this.DT;
      steps++;
    }

    this.broadcastState();
  }

  broadcastState() {
    const stateUpdate = {
      type: 'state',
      tick: this.gameState.tick++,
      players: {},
      cubes: this.gameState.grabCubes.map(c => ({ pos: c.pos.toArray(), vel: c.vel.toArray() })),
      portals: this.gameState.portals.map(P => ({
        placed: P.placed,
        c: P.c.toArray(), n: P.n.toArray(), r: P.r.toArray(), u: P.u.toArray()
      })),
      match: this.matchSession.getInfo(),
      destroyedWallCount: this.gameState.destroyedWalls.length
    };

    for (const pid in this.gameState.players) {
      const p = this.gameState.players[pid];
      stateUpdate.players[pid] = {
        name: p.name,
        pos: p.pos.toArray(),
        vel: p.vel.toArray(),
        yaw: p.yaw,
        pitch: p.pitch,
        activeWeapon: p.activeWeapon || 1,
        crouchT: p.crouchT || 0,
        isDead: !!p.isDead,
        playerIndex: p.playerIndex,
        isBot: !!p.isBot,
        viewOffset: p.viewOffset ? [p.viewOffset.x, p.viewOffset.y, p.viewOffset.z, p.viewOffset.w] : null
      };
    }

    this.broadcast(JSON.stringify(stateUpdate));
  }

  start() {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Portal Arena Server running at http://localhost:${this.port} and ws://localhost:${this.port}`);
        setTimeout(() => this.fillWithBots(), 200);
        this.tickInterval = setInterval(() => this.tick(), 1000 / TICK_RATE);
        resolve();
      });
    });
  }

  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
    }
    this.wss.close();
    this.server.close();
  }
}
