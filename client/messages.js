import { AudioSys } from './audio.js';

/* ============================================================================
   MESSAGES — server → client message handling: auth/init, state sync,
   portal/weapon events, deaths, respawns, pings, round end.
   ============================================================================ */

export function onMessage(G, data) {
  const { TH, V3 } = G;
  if (data.type === 'init') {
    G.localPlayerId = data.playerId;
    G.localPlayerIndex = data.playerIndex % 2;

    const localColor = G.localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
    const bMesh = G.playerModel.children.find(c => c.name === 'bodyMesh');
    if (bMesh) bMesh.material.color.setHex(localColor);
    const headGroup = G.playerModel.children.find(c => c.name === 'headGroup');
    if (headGroup) { const hMesh = headGroup.children.find(c => c.name === 'headMesh'); if (hMesh) hMesh.material.color.setHex(localColor); }

    G.gun.userData.core.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);
    G.gun.userData.ring.material.emissive.setHex(G.portals[G.localPlayerIndex * 2].color);

    G.started = true; G.startPanel.classList.add('hidden');
    G.gun.visible = (G.activeWeapon === 1);
    G.rocketGun.visible = (G.activeWeapon === 2);
    G.instagibGun.visible = (G.activeWeapon === 3);
    if (G.currentSeed !== data.seed) G.loadMap(data.seed);
    if (data.spawn) { G.pl.pos.fromArray(data.spawn); G.pl.vel.set(0, 0, 0); G.pl.cp.copy(G.pl.pos); }
    G.isConnected = true;
    if (data.match) {
      G.match = data.match;
      const me = G.match.players[G.localPlayerId];
      G.localReady = me ? !!me.ready : false;
      G.won = (G.match.phase === 'summary');
      if (G.won) G.showSummary();
    }
    if (!G.pointerLocked) G.requestLock();
  } else if (data.type === 'player_connected') {
    G.addEventLog(data.name + ' has just connected');
  } else if (data.type === 'player_disconnected') {
    G.addEventLog(data.name + ' dropped from the game');
  } else if (data.type === 'map_change') {
    G.loadMap(data.seed);
  } else if (data.type === 'state') {
    if (data.match) {
      G.match = data.match;
      const me = G.match.players[G.localPlayerId];
      G.localReady = me ? !!me.ready : false;
      G.won = (G.match.phase === 'summary');
      if (G.won) { if (G.winPanel.classList.contains('hidden')) G.showSummary(); }
      else if (!G.winPanel.classList.contains('hidden')) G.winPanel.classList.add('hidden');
    }
    for (const pid in data.players) {
       if (pid === G.localPlayerId) {
         continue;
       }
       const oldRp = G.remotePlayers[pid];
       G.remotePlayers[pid] = data.players[pid];
       if (oldRp && oldRp.predictedDeadUntil) G.remotePlayers[pid].predictedDeadUntil = oldRp.predictedDeadUntil;
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
      P.placed = sp.placed;
      if (P.placed) {
         P.c.fromArray(sp.c); P.n.fromArray(sp.n); P.r.fromArray(sp.r); P.u.fromArray(sp.u);
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
  } else if (data.type === 'portal_remove') {
    G.cancelPortal(data.pi, false);
  } else if (data.type === 'fire_beam') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
    G.spawnBeam(G.portals[data.pi].color, new V3(...data.start), new V3(...data.end));
  } else if (data.type === 'fire_rocket') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
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
    G.rockets.push({ pos: new V3(...data.pos), vel: new V3(...data.vel), mesh: rMesh, life: 5, isLocal: false });
    AudioSys.tone(300, 150, 0.3, 'sawtooth', 0.1, 0, new V3(...data.pos));
  } else if (data.type === 'fire_instagib') {
    if (data.playerId !== G.localPlayerId && G.remotePlayerMeshes[data.playerId]) G.remotePlayerMeshes[data.playerId].userData.muzzleT = 1;
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

    if (data.hitPlayerId === G.localPlayerId) {
       G.die(data.playerId, data.pts.length > 2);
    }
  } else if (data.type === 'player_died') {
    const pos = new V3(...data.pos);
    G.spawnDeathAnimation(pos, data.color);
    if (data.feedMsg) G.addEventLog(data.feedMsg, data.feedHot);
  } else if (data.type === 'respawn') {
    G.isDead = false;
    G.playerModel.visible = true;
    if (G.activeWeapon === 1) G.gun.visible = true;
    if (G.activeWeapon === 2) G.rocketGun.visible = true;
    if (G.activeWeapon === 3) G.instagibGun.visible = true;
    G.pl.pos.fromArray(data.pos);
    G.pl.vel.set(0, 0, 0);
    G.pl.yaw = -Math.PI / 2; G.pl.pitch = 0; G.pl.viewOffset = null;
    AudioSys.tone(120, 60, 0.4, 'sawtooth', 0.08);
  } else if (data.type === 'pong') {
    G.lastPingMs = Math.max(0, Math.round(performance.now() - data.t));
  } else if (data.type === 'round_over') {
    G.match = data.match;
    G.won = true;
    G.showSummary();
  }
}

export function onNetworkClose(G) {
  G.isConnected = false;
  if (G.started) {
     setTimeout(() => { if (G.lastIp) G.Network.connect(G.lastIp, G.lastPass, G.lastName); }, 1000);
  }
}
