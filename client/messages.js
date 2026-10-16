import { AudioSys } from './audio.js';

/* ============================================================================
   MESSAGES — server → client message handling: auth/init, state sync,
   portal/weapon events, deaths, respawns, pings, round end.
   ============================================================================ */

export function onMessage(G, data) {
  const { TH, V3 } = G;
  if (data.type === 'init') {
    G.localPlayerId = data.playerId;
    G.isSpectator = !!data.isSpectator;
    G.localPlayerIndex = (data.playerIndex >= 0) ? (data.playerIndex % 2) : -1;

    if (!G.isSpectator && G.localPlayerIndex >= 0) {
      const localColor = G.localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
      const bMesh = G.playerModel.children.find(c => c.name === 'bodyMesh');
      if (bMesh) bMesh.material.color.setHex(localColor);
      const headGroup = G.playerModel.children.find(c => c.name === 'headGroup');
      if (headGroup) { const hMesh = headGroup.children.find(c => c.name === 'headMesh'); if (hMesh) hMesh.material.color.setHex(localColor); }

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

    G.started = true; G.startPanel.classList.add('hidden');
    if (G.currentSeed !== data.seed) G.loadMap(data.seed);
    if (data.destroyedWalls && data.destroyedWalls.length > 0) {
      if (!G.destroyedWalls) G.destroyedWalls = [];
      for (const dw of data.destroyedWalls) {
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
    if (data.spawn && !G.isSpectator) { G.pl.pos.fromArray(data.spawn); G.pl.vel.set(0, 0, 0); G.pl.cp.copy(G.pl.pos); }
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
    if (headGroup) { const hMesh = headGroup.children.find(c => c.name === 'headMesh'); if (hMesh) hMesh.material.color.setHex(localColor); }

    G.gun.userData.core.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
    G.gun.userData.ring.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
    G.gun.visible = (G.activeWeapon === 1);
    G.rocketGun.visible = (G.activeWeapon === 2);
    G.instagibGun.visible = (G.activeWeapon === 3);
    G.playerModel.visible = true;

    if (data.spawn) {
      G.pl.pos.fromArray(data.spawn);
      G.pl.vel.set(0, 0, 0);
      G.pl.cp.copy(G.pl.pos);
      G.pl.yaw = 0; G.pl.pitch = 0;
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
    G.loadMap(data.seed);
    if (data.spawn && !G.isSpectator) {
      G.pl.pos.fromArray(data.spawn);
      G.pl.vel.set(0, 0, 0);
      G.pl.cp.copy(G.pl.pos);
      G.pl.yaw = Math.atan2(-data.spawn[0], -data.spawn[2]);
    }
  } else if (data.type === 'state') {
    if (data.match) {
      G.match = data.match;
      const me = G.match.players[G.localPlayerId];
      G.localReady = me ? !!me.ready : false;
      G.won = (G.match.phase === 'summary');
      if (G.won) { if (G.winPanel.classList.contains('hidden') && !G.isSpectator) G.showSummary(); }
      else if (!G.winPanel.classList.contains('hidden')) G.winPanel.classList.add('hidden');
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
    for (const pid in data.players) {
       if (pid === G.localPlayerId && !G.isSpectator) {
         continue;
       }
       const oldRp = G.remotePlayers[pid];
       G.remotePlayers[pid] = data.players[pid];
       if (oldRp) {
         if (oldRp.predictedDeadUntil) G.remotePlayers[pid].predictedDeadUntil = oldRp.predictedDeadUntil;
         if (oldRp.viewOffset) {
           G.remotePlayers[pid].viewOffset = oldRp.viewOffset;
         } else if (data.players[pid].viewOffset) {
           const vo = data.players[pid].viewOffset;
           G.remotePlayers[pid].viewOffset = new TH.Quaternion(vo[0], vo[1], vo[2], vo[3]);
         }
       } else if (data.players[pid].viewOffset) {
         const vo = data.players[pid].viewOffset;
         G.remotePlayers[pid].viewOffset = new TH.Quaternion(vo[0], vo[1], vo[2], vo[3]);
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
      if (P.closing) continue; // close animation in progress; server already reflects the removal
      const wasPlaced = P.placed;
      P.placed = sp.placed;
      if (P.placed) {
        P.c.fromArray(sp.c); P.n.fromArray(sp.n); P.r.fromArray(sp.r); P.u.fromArray(sp.u);
        let onBadWall = false;
        if (G.isPortalOnDestroyedWall && G.isPortalOnDestroyedWall(P.c, P.n, P.r, P.u)) {
          onBadWall = true;
        } else {
          for (const obb of G.obbs) {
            if (obb.destroyed || obb.noPortal) {
              const dx = P.c.x - obb.c.x, dy = P.c.y - obb.c.y, dz = P.c.z - obb.c.z;
              const l0 = Math.abs(dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z);
              const l1 = Math.abs(dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z);
              const l2 = Math.abs(dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z);
              if (l0 <= obb.he[0] + 0.3 && l1 <= obb.he[1] + 0.3 && l2 <= obb.he[2] + 0.3) {
                onBadWall = true;
                break;
              }
            }
          }
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
    } else {
      for (const obb of G.obbs) {
        if (obb.destroyed || obb.noPortal) {
          const dx = pC.x - obb.c.x, dy = pC.y - obb.c.y, dz = pC.z - obb.c.z;
          const l0 = Math.abs(dx * obb.ax[0].x + dy * obb.ax[0].y + dz * obb.ax[0].z);
          const l1 = Math.abs(dx * obb.ax[1].x + dy * obb.ax[1].y + dz * obb.ax[1].z);
          const l2 = Math.abs(dx * obb.ax[2].x + dy * obb.ax[2].y + dz * obb.ax[2].z);
          if (l0 <= obb.he[0] + 0.3 && l1 <= obb.he[1] + 0.3 && l2 <= obb.he[2] + 0.3) {
            onBadWall = true;
            break;
          }
        }
      }
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
        rp.viewOffset = new TH.Quaternion(
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
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) {
      G.muzzleT = 1;
      const hex = G.portals[data.pi] ? G.portals[data.pi].color : 0x0affff;
      if (G.gun.userData.core) G.gun.userData.core.material.emissive.setHex(hex);
      if (G.gun.userData.ring) G.gun.userData.ring.material.emissive.setHex(hex);
    }
    G.spawnBeam(G.portals[data.pi].color, new V3(...data.start), new V3(...data.end));
  } else if (data.type === 'fire_rocket') {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) G.muzzleT = 1;
    const rMesh = new TH.Group();
    const bGeo = new TH.CylinderGeometry(0.06, 0.06, 0.4, 8);
    const bMat = new TH.MeshStandardMaterial({ color: 0x222222 });
    const body = new TH.Mesh(bGeo, bMat);
    const tGeo = new TH.ConeGeometry(0.06, 0.2, 8);
    const tMat = new TH.MeshStandardMaterial({ color: 0xff0000 });
    const tip = new TH.Mesh(tGeo, tMat);
    tip.position.y = 0.3;
    rMesh.add(body, tip);
    rMesh.rotation.order = 'YXZ';
    rMesh.quaternion.setFromUnitVectors(new V3(0, 0, -1), new V3(...data.vel).normalize());
    rMesh.rotateX(Math.PI / 2);
    rMesh.position.fromArray(data.pos);
    G.scene.add(rMesh);
    G.rockets.push({ pos: new V3(...data.pos), vel: new V3(...data.vel), mesh: rMesh, life: 5, isLocal: false, shooterId: data.playerId });
    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1, 0, new V3(...data.pos));
  } else if (data.type === 'fire_instagib') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    if (G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === data.playerId) G.muzzleT = 1;
    const pts = data.pts.map(a => new V3(...a));
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) {
       const rm = G.remotePlayerMeshes[data.playerId];
       if (rm.userData.mirrorInstagibGun) {
         rm.updateMatrixWorld(true);
         rm.userData.mirrorInstagibGun.updateMatrixWorld(true);
         pts[0].set(0, 0, -0.4).applyMatrix4(rm.userData.mirrorInstagibGun.matrixWorld);
       }
    }
    for (let i = 0; i < pts.length; i += 2) G.spawnInstagibBeam(pts[i], pts[i+1]);
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
    if (!G.isSpectator) {
      G.isDead = false;
      G.playerModel.visible = true;
      if (G.activeWeapon === 1) G.gun.visible = true;
      if (G.activeWeapon === 2) G.rocketGun.visible = true;
      if (G.activeWeapon === 3) G.instagibGun.visible = true;
      G.pl.pos.fromArray(data.pos);
      G.pl.vel.set(0, 0, 0);
      G.pl.yaw = -Math.PI / 2; G.pl.pitch = 0; G.pl.viewOffset = null;
      AudioSys.tone(120, 60, 0.4, 'sawtooth', 0.08);
    }
  } else if (data.type === 'pong') {
    G.lastPingMs = Math.max(0, Math.round(performance.now() - data.t));
  } else if (data.type === 'round_over') {
    G.match = data.match;
    G.won = true;
    if (!G.isSpectator) G.showSummary();
  } else if (data.type === 'countdown_start') {
    G.countdownActive = true;
    if (G.match) G.match.phase = 'countdown';
    if (G.showCountdown) G.showCountdown();
  }
}

export function onNetworkClose(G) {
  G.isConnected = false;
  if (G.started) {
     setTimeout(() => { if (G.lastIp) G.Network.connect(G.lastIp, G.lastPass, G.lastName); }, 1000);
  }
}
