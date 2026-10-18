import * as THREE from 'three';
import { AudioSys } from '../audio/AudioController.js';
import { RemotePlayer } from '../entities/RemotePlayer.js';
import { RocketProjectile } from '../projectiles/RocketProjectile.js';

function applyDestroyedWalls(G, V3, walls) {
  if (!walls || walls.length === 0) return;
  if (!G.destroyedWalls) G.destroyedWalls = [];
  for (const dw of walls) {
    G.destroyedWalls.push(dw);
    const cCenter = dw.wallCenter ? new V3(...dw.wallCenter) : null;
    const cPt = new V3(...dw.point);
    let obb = null;
    if (dw.wallId) obb = G.obbs.find(o => o.id === dw.wallId);
    if (!obb && cCenter) obb = G.obbs.find(o => o.c.distanceTo(cCenter) < 0.3);
    if (!obb) obb = G.obbs.find(o => o.kind === 'wall' && !o.boundary && o.c.distanceTo(cPt) <= o.rad + 0.5);
    if (obb) {
      G.destroyWall(obb, cPt, dw.normal ? new V3(...dw.normal) : null, false, false);
    }
  }
}

/**
 * Handle incoming server network messages.
 * @param {Object} G - Game state context
 * @param {Object} data - Deserialized network packet
 */
export function onMessage(G, data) {
  const { V3 } = G;
  if (data.type === 'init') {
    if (G.onConnectionSuccess) G.onConnectionSuccess();
    G.localPlayerId = data.playerId;
    G.isSpectator = !!data.isSpectator;
    G.localPlayerIndex = (data.playerIndex >= 0) ? (data.playerIndex % 2) : -1;

    if (!G.isSpectator && G.localPlayerIndex >= 0) {
      const localColor = G.localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
      const bMesh = G.playerModel.children.find(c => c.name === 'bodyMesh');
      if (bMesh) bMesh.material.color.setHex(localColor);
      const headGroup = G.playerModel.children.find(c => c.name === 'headGroup');
      if (headGroup) {
        const hMesh = headGroup.children.find(c => c.name === 'headMesh');
        if (hMesh) hMesh.material.color.setHex(localColor);
      }

      G.gun.userData.core.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
      G.gun.userData.ring.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
      G.gun.visible = (G.activeWeapon === 1);
      G.rocketGun.visible = (G.activeWeapon === 2);
      G.instagibGun.visible = (G.activeWeapon === 3);
      G.playerModel.visible = true;
    } else {
      G.gun.visible = false;
      G.rocketGun.visible = false;
      G.instagibGun.visible = false;
      G.playerModel.visible = false;
      G.spectatorMode = 'freefly';
      G.specPos.set(0, 8, 14);
      G.specYaw = 0;
      G.specPitch = -0.2;
    }

    G.started = true;
    G.startPanel.classList.add('hidden');
    G.loadMap(data.seed);
    G.destroyedWalls = [];
    G.destroyedWallObbs = [];
    applyDestroyedWalls(G, V3, data.destroyedWalls);
    if (data.spawn && !G.isSpectator) {
      G.pl.pos.fromArray(data.spawn);
      G.pl.vel.set(0, 0, 0);
      G.pl.cp.copy(G.pl.pos);
    }
    G.isConnected = true;
    if (data.match) {
      G.match = data.match;
      const me = G.match.players[G.localPlayerId];
      G.localReady = me ? !!me.ready : false;
      G.won = (G.match.phase === 'summary');
      if (G.won && !G.isSpectator) G.showSummary();
    }
    const switchBtn = document.getElementById('btnswitchmode');
    if (switchBtn) switchBtn.textContent = G.isSpectator ? 'JOIN GAME (J)' : 'SPECTATE';
    if (!G.pointerLocked) G.requestLock();
  } else if (data.type === 'join_success') {
    G.isSpectator = false;
    G.localPlayerId = data.playerId;
    G.localPlayerIndex = data.playerIndex % 2;
    const localColor = G.localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
    const bMesh = G.playerModel.children.find(c => c.name === 'bodyMesh');
    if (bMesh) bMesh.material.color.setHex(localColor);
    const headGroup = G.playerModel.children.find(c => c.name === 'headGroup');
    if (headGroup) {
      const hMesh = headGroup.children.find(c => c.name === 'headMesh');
      if (hMesh) hMesh.material.color.setHex(localColor);
    }

    G.gun.userData.core.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
    G.gun.userData.ring.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
    G.gun.visible = (G.activeWeapon === 1);
    G.rocketGun.visible = (G.activeWeapon === 2);
    G.instagibGun.visible = (G.activeWeapon === 3);
    G.playerModel.visible = true;

    if (data.seed && G.resetWalls) {
      G.resetWalls(data.seed);
      G.destroyedWalls = [];
      G.destroyedWallObbs = [];
      applyDestroyedWalls(G, V3, data.destroyedWalls);
    }
    if (data.spawn) {
      G.pl.pos.fromArray(data.spawn);
      G.pl.vel.set(0, 0, 0);
      G.pl.cp.copy(G.pl.pos);
      G.pl.yaw = 0;
      G.pl.pitch = 0;
    }
    if (data.match) {
      G.match = data.match;
      G.won = (G.match.phase === 'summary');
      if (G.winPanel && !G.winPanel.classList.contains('hidden') && !G.won) G.winPanel.classList.add('hidden');
    }
    const switchBtn = document.getElementById('btnswitchmode');
    if (switchBtn) switchBtn.textContent = 'SPECTATE';
    G.addEventLog('Joined game as active player', true);
    if (!G.pointerLocked) G.requestLock();
  } else if (data.type === 'join_denied') {
    G.addEventLog('Cannot join: ' + (data.reason || 'Server full'), true);
  } else if (data.type === 'spectate_success') {
    G.isSpectator = true;
    G.gun.visible = false;
    G.rocketGun.visible = false;
    G.instagibGun.visible = false;
    G.playerModel.visible = false;
    G.spectatorMode = 'freefly';
    G.specPos.copy(G.pl.pos);
    G.specPos.y += 2;
    G.specYaw = G.pl.yaw;
    G.specPitch = G.pl.pitch;
    if (data.seed && G.resetWalls) {
      G.resetWalls(data.seed);
      G.destroyedWalls = [];
      G.destroyedWallObbs = [];
      applyDestroyedWalls(G, V3, data.destroyedWalls);
    }
    if (data.match) G.match = data.match;
    const switchBtn = document.getElementById('btnswitchmode');
    if (switchBtn) switchBtn.textContent = 'JOIN GAME (J)';
    G.addEventLog('Switched to spectator mode', false);
    if (!G.pointerLocked) G.requestLock();
  } else if (data.type === 'spectate_denied') {
    G.addEventLog('Cannot spectate: ' + (data.reason || 'Spectator slots full'), true);
  } else if (data.type === 'player_connected') {
    G.addEventLog(data.name + ' has just connected');
  } else if (data.type === 'player_disconnected') {
    G.addEventLog(data.name + ' dropped from the game');
  } else if (data.type === 'map_change') {
    if (G.resetWalls) G.resetWalls(data.seed);
    else G.loadMap(data.seed);
    G.destroyedWalls = [];
    G.destroyedWallObbs = [];
    if (data.spawn && !G.isSpectator) {
      G.pl.pos.fromArray(data.spawn);
      G.pl.vel.set(0, 0, 0);
      G.pl.cp.copy(G.pl.pos);
      G.pl.yaw = Math.atan2(-data.spawn[0], -data.spawn[2]);
    }
  } else if (data.type === 'state') {
    if (data.match) {
      const oldPhase = G.match ? G.match.phase : null;
      G.match = data.match;
      if (oldPhase && oldPhase !== data.match.phase) {
        if (G.resetWalls) G.resetWalls();
        G.destroyedWalls = [];
        G.destroyedWallObbs = [];
      }
      const me = G.match.players[G.localPlayerId];
      G.localReady = me ? !!me.ready : false;
      G.won = (G.match.phase === 'summary');
      if (G.won) {
        if (G.winPanel.classList.contains('hidden') && !G.isSpectator) G.showSummary();
      } else if (!G.winPanel.classList.contains('hidden')) {
        G.winPanel.classList.add('hidden');
      }
      if (data.match.phase === 'countdown') {
        if (!G.countdownActive) {
          G.countdownActive = true;
          if (G.showCountdown) G.showCountdown();
        }
      } else {
        G.countdownActive = false;
        if (G.cancelCountdown) G.cancelCountdown();
      }
    }
    if (data.destroyedWallCount === 0 && G.destroyedWalls && G.destroyedWalls.length > 0) {
      if (G.resetWalls) G.resetWalls();
      G.destroyedWalls = [];
      G.destroyedWallObbs = [];
    }
    for (const pid in data.players) {
      if (pid === G.localPlayerId && !G.isSpectator) {
        continue;
      }
      if (!G.remotePlayers[pid]) {
        G.remotePlayers[pid] = new RemotePlayer(pid, data.players[pid]);
        if (!G.remotePlayers[pid].name && data.match?.players?.[pid]?.name) {
          G.remotePlayers[pid].name = data.match.players[pid].name;
        }
      } else {
        const oldRp = G.remotePlayers[pid];
        const prevDeathCamPos = oldRp.deathCamPos;
        const prevDeathCamTarget = oldRp.deathCamTarget;
        const prevLastShotOrigin = oldRp.lastShotOrigin;
        const prevLastKillerId = oldRp.lastKillerId;
        const prevViewOffset = oldRp.viewOffset;

        if (oldRp.updateFromSnapshot) {
          oldRp.updateFromSnapshot(data.players[pid], data.match);
        } else {
          G.remotePlayers[pid] = new RemotePlayer(pid, data.players[pid]);
        }

        if (G.remotePlayers[pid].isDead) {
          if (prevDeathCamPos) G.remotePlayers[pid].deathCamPos = prevDeathCamPos;
          if (prevDeathCamTarget) G.remotePlayers[pid].deathCamTarget = prevDeathCamTarget;
          if (prevLastShotOrigin) G.remotePlayers[pid].lastShotOrigin = prevLastShotOrigin;
          if (prevLastKillerId) G.remotePlayers[pid].lastKillerId = prevLastKillerId;
        }
        if (prevViewOffset && !G.remotePlayers[pid].viewOffset) {
          G.remotePlayers[pid].viewOffset = prevViewOffset;
        }
      }
    }
    for (const pid in G.remotePlayers) {
      if (!data.players[pid]) {
        delete G.remotePlayers[pid];
        if (G.remotePlayerMeshes[pid]) {
          G.scene.remove(G.remotePlayerMeshes[pid]);
          delete G.remotePlayerMeshes[pid];
        }
      }
    }

    for (let i = 0; i < 4; i++) {
      const sp = data.portals[i];
      const P = G.portals[i];
      if (P.closing) continue;
      const wasPlaced = P.placed;
      P.placed = sp.placed;
      if (P.placed) {
        P.c.fromArray(sp.c);
        P.n.fromArray(sp.n);
        P.r.fromArray(sp.r);
        P.u.fromArray(sp.u);
        let onBadWall = false;
        if (G.isPortalOnDestroyedWall && G.isPortalOnDestroyedWall(P.c, P.n, P.r, P.u)) {
          onBadWall = true;
        }
        if (onBadWall) {
          P.placed = false;
          P.openTime = 0;
        } else if (!wasPlaced && !P.openTime) {
          P.openTime = performance.now() / 1000;
        }
      } else {
        P.openTime = 0;
      }
    }
    G.updatePair();
    for (let i = 0; i < data.cubes.length; i++) {
      if (G.grabCubes[i]) {
        if (G.grabCubes[i] === G.grabbedCube) continue;
        G.grabCubes[i].pos.fromArray(data.cubes[i].pos);
        G.grabCubes[i].vel.fromArray(data.cubes[i].vel);
      }
    }
  } else if (data.type === 'portal_place') {
    const pC = new V3(...data.c);
    const pN = new V3(...data.n);
    const pR = new V3(...data.r);
    const pU = new V3(...data.u);
    let onBadWall = false;
    if (G.isPortalOnDestroyedWall && G.isPortalOnDestroyedWall(pC, pN, pR, pU)) {
      onBadWall = true;
    }
    if (!onBadWall) {
      const P = G.portals[data.pi];
      if (P) {
        P.placed = true;
        P.closing = false;
        P.c.copy(pC);
        P.n.copy(pN);
        P.r.copy(pR);
        P.u.copy(pU);
        P.openTime = performance.now() / 1000;
        G.updatePair();
        AudioSys.portalOpen(P.c);
      }
    }
  } else if (data.type === 'portal_remove') {
    G.cancelPortal(data.pi, false);
  } else if (data.type === 'destroy_wall') {
    if (!G.destroyedWalls) G.destroyedWalls = [];
    G.destroyedWalls.push(data);
    const cCenter = data.wallCenter ? new V3(...data.wallCenter) : null;
    const cPt = new V3(...data.point);
    let obb = null;
    if (data.wallId) obb = G.obbs.find(o => o.id === data.wallId);
    if (!obb && cCenter) obb = G.obbs.find(o => o.c.distanceTo(cCenter) < 0.3);
    if (!obb) obb = G.obbs.find(o => o.kind === 'wall' && !o.boundary && o.c.distanceTo(cPt) <= o.rad + 0.5);
    if (obb) {
      const spawnDebris = (typeof document === 'undefined' || !document.hidden);
      G.destroyWall(obb, cPt, data.normal ? new V3(...data.normal) : null, false, spawnDebris);
    }
  } else if (data.type === 'player_teleport') {
    const rp = G.remotePlayers[data.playerId];
    if (rp) {
      if (data.viewOffset) {
        rp.viewOffset = new THREE.Quaternion(
          data.viewOffset[0],
          data.viewOffset[1],
          data.viewOffset[2],
          data.viewOffset[3]
        );
      } else {
        rp.viewOffset = null;
      }
    }
    if (G.isSpectator && G.spectateTargetPid === data.playerId && G.spectatorMode === 'follow' && G.followPerspective === 'pov') {
      const flash = document.getElementById('flash');
      if (flash) {
        flash.classList.remove('fadeflash');
        void flash.offsetWidth;
        flash.classList.add('fadeflash');
      }
    }
  } else if (data.type === 'fire_beam') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
      G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    }
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) {
      G.muzzleT = 1;
      const hex = G.portals[data.pi] ? G.portals[data.pi].color : 0x0affff;
      if (G.gun.userData.core) G.gun.userData.core.material.emissive.setHex(hex);
      if (G.gun.userData.ring) G.gun.userData.ring.material.emissive.setHex(hex);
    }
    G.spawnBeam(G.portals[data.pi].color, new V3(...data.start), new V3(...data.end));
  } else if (data.type === 'fire_rocket') {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
      G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    }
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) {
      G.muzzleT = 1;
    }
    let spawnPos = new V3(...data.pos);
    const vel = new V3(...data.vel);

    if (G.isSpectator && G.spectatorMode === 'follow' && G.followPerspective === 'pov' && G.spectateTargetPid === data.playerId) {
      G.camera.updateMatrixWorld(true);
      G.rocketGun.updateMatrixWorld(true);
      spawnPos = new V3(0, 0, -0.6).applyMatrix4(G.rocketGun.matrixWorld);
    } else if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
      const isBot = (G.match && G.match.players && G.match.players[data.playerId] && G.match.players[data.playerId].isBot);
      const rm = G.remotePlayerMeshes[data.playerId];
      if (isBot && rm && rm.userData.mirrorRocketGun) {
        rm.updateMatrixWorld(true);
        if (rm.userData.headGroup) rm.userData.headGroup.updateMatrixWorld(true);
        rm.userData.mirrorRocketGun.updateMatrixWorld(true);
        spawnPos = new V3(0, 0, -0.6).applyMatrix4(rm.userData.mirrorRocketGun.matrixWorld);
      }
    }

    const rocket = new RocketProjectile(spawnPos, vel, data.playerId, false);
    G.scene.add(rocket.mesh);
    G.rockets.push(rocket);
    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1, 0, spawnPos);
  } else if (data.type === 'fire_instagib') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
      G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    }
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) {
      G.muzzleT = 1;
    }
    const pts = data.pts.map(a => new V3(...a));
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
      const rm = G.remotePlayerMeshes[data.playerId];
      if (rm.userData.mirrorInstagibGun) {
        rm.updateMatrixWorld(true);
        rm.userData.mirrorInstagibGun.updateMatrixWorld(true);
        pts[0].set(0, 0, -0.4).applyMatrix4(rm.userData.mirrorInstagibGun.matrixWorld);
      }
    }
    for (let i = 0; i < pts.length; i += 2) G.spawnInstagibBeam(pts[i], pts[i + 1]);
    const shooter = G.remotePlayers[data.playerId];
    AudioSys.instagibShot(shooter && shooter.pos ? new V3(...shooter.pos) : pts[0]);
    if (data.scorch) {
      const sp = new V3(...data.scorch.pos), sn = new V3(...data.scorch.n);
      G.spawnScorch(sp, sn);
      AudioSys.zap(sp, AudioSys.listenerPos ? sp.distanceTo(AudioSys.listenerPos) / 343 : 0);
    }

    if (data.hitPlayerId && G.remotePlayers[data.hitPlayerId]) {
      const hitRp = G.remotePlayers[data.hitPlayerId];
      hitRp.lastShotOrigin = pts && pts.length >= 2 ? pts[pts.length - 2].clone() : (shooter && shooter.pos ? new V3(...shooter.pos) : null);
      hitRp.lastKillerId = data.playerId;
    }

    if (data.hitPlayerId === G.localPlayerId && !G.isSpectator) {
      const shotOrigin = pts && pts.length >= 2 ? pts[pts.length - 2].clone() : (shooter && shooter.pos ? new V3(...shooter.pos) : null);
      G.die(data.playerId, data.pts.length > 2, 'instagib', shotOrigin);
    }
  } else if (data.type === 'player_died') {
    if (data.playerId !== G.localPlayerId || G.isSpectator) {
      const pos = new V3(...data.pos);
      G.spawnDeathAnimation(pos, data.color);
    }
    if (data.playerId === G.localPlayerId && !G.isDead && !G.isSpectator) {
      let shotOrigin = null;
      if (data.killerId && G.remotePlayers[data.killerId]) {
        const kp = G.remotePlayers[data.killerId];
        if (kp && kp.pos) shotOrigin = new V3(kp.pos[0], kp.pos[1] + 1.5, kp.pos[2]);
      }
      G.die(data.killerId, data.viaPortal, data.cause, shotOrigin);
    }
    const deadRp = G.remotePlayers[data.playerId];
    if (deadRp) {
      deadRp.isDead = true;
      if (data.killerId) deadRp.lastKillerId = data.killerId;
      const deadPos = new V3(...data.pos);
      const isSuicide = !data.killerId || data.killerId === data.playerId || data.cause === 'lava' || data.cause === 'void';
      let shotOrigin = deadRp.lastShotOrigin || null;
      if (!shotOrigin && data.killerId) {
        if (data.killerId === G.localPlayerId) {
          shotOrigin = new V3(G.pl.pos.x, G.pl.pos.y + 1.5, G.pl.pos.z);
        } else if (G.remotePlayers[data.killerId]) {
          const kp = G.remotePlayers[data.killerId];
          if (kp && kp.pos) shotOrigin = new V3(kp.pos[0], kp.pos[1] + 1.5, kp.pos[2]);
        }
      }

      if (isSuicide || !shotOrigin) {
        const offset = new V3(0, 2, 4).applyAxisAngle(new V3(0, 1, 0), deadRp.yaw || 0);
        const backDir = offset.clone().normalize();
        const rayHit = G.raycast ? G.raycast(deadPos, backDir, offset.length()) : null;
        const camDist = rayHit ? Math.max(0.6, rayHit.distance - 0.3) : offset.length();
        deadRp.deathCamPos = deadPos.clone().addScaledVector(backDir, camDist);
        deadRp.deathCamTarget = deadPos.clone();
      } else {
        const eyePos = new V3(deadPos.x, deadPos.y + 1.5, deadPos.z);
        const toShot = new V3().subVectors(shotOrigin, eyePos);
        const shotDist = toShot.length();
        const shotDir = shotDist > 0.01 ? toShot.clone().normalize() : new V3(-Math.sin(deadRp.yaw || 0), 0, -Math.cos(deadRp.yaw || 0));
        const pullDist = 2.0;
        const backDir = shotDir.clone().negate();
        const rayHit = G.raycast ? G.raycast(eyePos, backDir, pullDist + 0.3) : null;
        const actualPull = rayHit ? Math.max(0.1, rayHit.distance - 0.3) : pullDist;
        deadRp.deathCamPos = eyePos.clone().addScaledVector(backDir, actualPull);
        deadRp.deathCamPos.y += Math.min(0.35, actualPull * 0.25);
        deadRp.deathCamTarget = shotOrigin.clone();
      }
    }
    if (data.feedMsg) G.addEventLog(data.feedMsg, data.feedHot);
  } else if (data.type === 'respawn') {
    const isLocal = !G.isSpectator && (!data.playerId || data.playerId === G.localPlayerId);
    if (isLocal) {
      G.isDead = false;
      if (G.playerController) G.playerController.isDead = false;
      if (G.engine?.player) G.engine.player.isDead = false;
      G.playerModel.visible = true;
      if (G.activeWeapon === 1) G.gun.visible = true;
      if (G.activeWeapon === 2) G.rocketGun.visible = true;
      if (G.activeWeapon === 3) G.instagibGun.visible = true;
      if (data.pos) G.pl.pos.fromArray(data.pos);
      G.pl.vel.set(0, 0, 0);
      G.pl.yaw = -Math.PI / 2;
      G.pl.pitch = 0;
      G.pl.viewOffset = null;
      AudioSys.tone(120, 60, 0.4, 'sawtooth', 0.08);
    }
    const pid = data.playerId || (isLocal ? G.localPlayerId : null);
    if (pid && G.remotePlayers[pid]) {
      const respawnRp = G.remotePlayers[pid];
      respawnRp.isDead = false;
      respawnRp.deathCamPos = null;
      respawnRp.deathCamTarget = null;
      respawnRp.lastShotOrigin = null;
      respawnRp.lastKillerId = null;
      respawnRp.predictedDeadUntil = null;
      if (G.remotePlayerMeshes[pid]) {
        if (data.pos) G.remotePlayerMeshes[pid].position.fromArray(data.pos);
        G.remotePlayerMeshes[pid].visible = true;
      }
    }
  } else if (data.type === 'pong') {
    G.lastPingMs = Math.max(0, Math.round(performance.now() - data.t));
  } else if (data.type === 'round_over') {
    G.match = data.match;
    G.won = true;
    if (G.resetWalls) G.resetWalls();
    G.destroyedWalls = [];
    G.destroyedWallObbs = [];
    if (!G.isSpectator) G.showSummary();
  } else if (data.type === 'countdown_start') {
    G.countdownActive = true;
    if (G.match) G.match.phase = 'countdown';
    if (G.showCountdown) G.showCountdown();
    if (G.resetWalls) G.resetWalls();
    G.destroyedWalls = [];
    G.destroyedWallObbs = [];
  } else if (data.type === 'reset_walls') {
    if (G.resetWalls) G.resetWalls(data.seed);
    G.destroyedWalls = [];
    G.destroyedWallObbs = [];
  }
}

/**
 * Handle network disconnect and automated reconnection logic.
 * @param {Object} G - Game state context
 */
export function onNetworkClose(G) {
  G.isConnected = false;
  if (G.started) {
    G.isReconnecting = true;
    if (G.showConnectOverlay) G.showConnectOverlay('Reconnecting...');
    if (!G.connectionTimeout && G.onConnectionTimeout) {
      G.connectionTimeout = setTimeout(() => {
        G.onConnectionTimeout('Reconnecting timed out after 30 seconds');
      }, 30000);
    }
    if (!G.reconnectRetryTimer) {
      G.reconnectRetryTimer = setTimeout(() => {
        G.reconnectRetryTimer = null;
        if (G.isReconnecting && G.lastIp && G.Network) {
          G.Network.connect(G.lastIp, G.lastPass, G.lastName);
        }
      }, 1500);
    }
  } else if (G.isConnecting) {
    if (!G.reconnectRetryTimer) {
      G.reconnectRetryTimer = setTimeout(() => {
        G.reconnectRetryTimer = null;
        if (G.isConnecting && G.lastIp && G.Network) {
          G.Network.connect(G.lastIp, G.lastPass, G.lastName);
        }
      }, 1500);
    }
  }
}

/**
 * NetworkManager — Manages WebSocket connection lifecycle, authentication, and packet routing.
 */
export class NetworkManager {
  constructor(engine = null) {
    this.engine = engine;
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.handlers = null;
  }

  /**
   * Connect to server.
   * @param {string} ip - Server host:port
   * @param {string} password - Server password
   * @param {string} name - Player handle
   */
  connect(ip, password, name) {
    this.disconnect();
    this.isConnecting = true;

    try {
      this.ws = new WebSocket('ws://' + ip);
    } catch (err) {
      this.isConnecting = false;
      if (this.handlers && this.handlers.onError) {
        this.handlers.onError(err);
      }
      if (this.engine && this.engine.eventBus) {
        this.engine.eventBus.emit('NET_ERROR', { error: err });
      }
      return;
    }

    this.ws.onopen = () => {
      this.isConnected = true;
      this.isConnecting = false;
      this.send({ type: 'auth', password, name });
      if (this.engine && this.engine.eventBus) {
        this.engine.eventBus.emit('NET_CONNECTED');
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (this.handlers && this.handlers.onMessage) {
          this.handlers.onMessage(data);
        }
        if (this.engine && this.engine.eventBus) {
          this.engine.eventBus.emit('NET_MESSAGE', data);
          if (data.type) {
            this.engine.eventBus.emit(`NET_${data.type.toUpperCase()}`, data);
          }
        }
      } catch (err) {
        console.error('Failed to parse network packet:', err);
      }
    };

    this.ws.onerror = (err) => {
      if (this.handlers && this.handlers.onError) {
        this.handlers.onError(err);
      }
      if (this.engine && this.engine.eventBus) {
        this.engine.eventBus.emit('NET_ERROR', { error: err });
      }
    };

    this.ws.onclose = () => {
      this.isConnected = false;
      this.isConnecting = false;
      if (this.handlers && this.handlers.onClose) {
        this.handlers.onClose();
      }
      if (this.engine && this.engine.eventBus) {
        this.engine.eventBus.emit('NET_CLOSED');
      }
    };
  }

  /**
   * Send JSON message object to server.
   * @param {object} msgObj
   */
  send(msgObj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msgObj));
    }
  }

  /**
   * Disconnect from server.
   */
  disconnect() {
    if (this.ws) {
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch (err) {
        void err;
      }
      this.ws = null;
    }
    this.isConnected = false;
    this.isConnecting = false;
  }
}

export function initNetwork(handlers = {}) {
  const manager = new NetworkManager(null);
  manager.handlers = handlers;
  return {
    networkManager: manager,
    connect: (ip, pass, name) => manager.connect(ip, pass, name),
    send: (msg) => manager.send(msg),
    disconnect: () => manager.disconnect()
  };
}
