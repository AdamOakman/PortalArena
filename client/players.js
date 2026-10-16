import { AudioSys } from './audio.js';
import { CFG } from '../shared/constants.js';

/* ============================================================================
   PLAYERS — local player state (capsule), grab cubes, remote players, the
   local player model, movement/physics stepping, and death handling.
   ============================================================================ */
export function initPlayers(G) {
  const { TH, V3 } = G;
  const { camera, scene } = G;

  G.pl = { pos: new V3(), vel: new V3(), yaw: 0, pitch: 0, viewOffset: null, grounded: false, groundNormal: new V3(0, 1, 0), groundT: -1, jumpBuf: -1, cp: new V3(), maxSpeed: 0, crouchT: 0 };

  G.grabCubes = [];
  G.grabbedCube = null;

  G.remotePlayers = {}; // { id: { pos, vel, yaw, pitch } }
  G.remotePlayerMeshes = {};

  let tpGracePortal = null, tpGraceT = -1;
  const _tpFlash = document.getElementById('flash');

  function physStep(dt, activeKeys) {
    const k = G.isDead ? {} : activeKeys;
    const tpState = { nowT: G.nowT, tpGracePortal, tpGraceT, R_AB: G.R_AB, R_BA: G.R_BA };
    const events = {
      onJumppad: () => { AudioSys.tone(200, 600, 0.4, 'sine', 0.15); },
      onLand: (vol) => { G.landingThump = vol; },
      onJump: () => { AudioSys.tone(340, 520, 0.06, 'triangle', 0.04); },
      onTeleport: () => {
        _tpFlash.classList.remove('fadeflash');
        void _tpFlash.offsetWidth;
        _tpFlash.classList.add('fadeflash');
        if (G.Network && G.Network.send) {
          G.Network.send({
            type: 'teleport',
            viewOffset: G.pl.viewOffset ? [
              G.pl.viewOffset.x,
              G.pl.viewOffset.y,
              G.pl.viewOffset.z,
              G.pl.viewOffset.w
            ] : null
          });
        }
      }
    };
    G.physics.physStep(G.pl, k, G.autohop, dt, G.obbs, G.portals, G.grabCubes, G.grabbedCube, tpState, events, G.remotePlayers);
    tpGracePortal = tpState.tpGracePortal;
    tpGraceT = tpState.tpGraceT;
    if (G.pl.pos.y < -40.5) die(null, false, 'void');
    else {
      for (const L of G.lavaPools) {
        const dx = G.pl.pos.x - L.x, dz = G.pl.pos.z - L.z;
        if (dx * dx + dz * dz < L.r * L.r && G.pl.pos.y < L.y + 0.6) { die(null, false, 'lava'); break; }
      }
    }
  }

  function collideCube(c, radius) {
    G.physics.collideCube(c, G.obbs, G.portals, radius);
  }

  function resolveCubeCollisions() {
    G.physics.resolveCubeCollisions(G.grabCubes, G.grabbedCube);
  }

  /* ------------------------------------------------------ death */
  G.isDead = false;
  const deathCamPos = new TH.Vector3();
  const deathCamTarget = new TH.Vector3();
  function die(killerId, viaPortal, cause, shotOrigin) {
     if (!G.started || G.won || G.isDead) return;
     G.isDead = true;
     const myColor = G.localPlayerIndex === 0 ? 0x33ff33 : 0xff3333;
     G.Network.send({ type: 'player_died', pos: G.pl.pos.toArray(), color: myColor, killerId: killerId || null, viaPortal: !!viaPortal, cause: cause || null });
     G.spawnDeathAnimation(G.pl.pos, myColor);

     G.gun.visible = false; G.rocketGun.visible = false; G.instagibGun.visible = false;
     G.playerModel.visible = false;

     const isSuicide = !killerId || killerId === G.localPlayerId || cause === 'lava' || cause === 'void';

     if (isSuicide) {
       // Suicide kill: maintain standard 3rd-person death camera overlooking the death spot
       const offset = new TH.Vector3(0, 2, 4).applyAxisAngle(new TH.Vector3(0, 1, 0), G.pl.yaw);
       deathCamPos.copy(G.pl.pos).add(offset);
       deathCamTarget.copy(G.pl.pos);
     } else {
       // Killed by an opponent: aim camera so the crosshair points in the direction the shot originated
       if (!shotOrigin && killerId && G.remotePlayers[killerId]) {
         const kp = G.remotePlayers[killerId];
         if (kp && kp.pos) {
           shotOrigin = new TH.Vector3(kp.pos[0], kp.pos[1] + 1.5, kp.pos[2]);
         }
       }

       if (shotOrigin) {
         const eyeH = (CFG.H - (CFG.H - CFG.CROUCH_H) * G.pl.crouchT) - 0.12;
         const eyePos = new TH.Vector3(G.pl.pos.x, G.pl.pos.y + eyeH, G.pl.pos.z);
         const toShot = new TH.Vector3().subVectors(shotOrigin, eyePos);
         const shotDist = toShot.length();
         const shotDir = shotDist > 0.01 ? toShot.clone().normalize() : new TH.Vector3(-Math.sin(G.pl.yaw), 0, -Math.cos(G.pl.yaw));

         const pullDist = 2.0;
         const backDir = shotDir.clone().negate();
         const rayHit = G.raycast ? G.raycast(eyePos, backDir, pullDist + 0.3) : null;
         const actualPull = rayHit ? Math.max(0.1, rayHit.distance - 0.3) : pullDist;

         deathCamPos.copy(eyePos).addScaledVector(backDir, actualPull);
         deathCamPos.y += Math.min(0.35, actualPull * 0.25);
         deathCamTarget.copy(shotOrigin);
       } else {
         const offset = new TH.Vector3(0, 2, 4).applyAxisAngle(new TH.Vector3(0, 1, 0), G.pl.yaw);
         deathCamPos.copy(G.pl.pos).add(offset);
         deathCamTarget.copy(G.pl.pos);
       }
     }

     // Server will send 'respawn' after 3 seconds
  }

  /* ------------------------------------------------ local player model */
  const playerClipPlane = new TH.Plane(new V3(0, 1, 0), 1e6);

  const playerModel = G.createPlayerModel(0x4a86e8, 1, playerClipPlane);
  scene.add(playerModel);

  // Assign global to be used in frame()
  window.playerClipPlane = playerClipPlane;

  // The real player model on Layer 1 is sufficient for portals to render you.
  G.playerModel = playerModel;
  G.playerClipPlane = playerClipPlane;

  /* ------------------------------------------- per-frame player updates */

  // Render remote players (extracted from the main loop)
  function updateRemotePlayers(dt, nowT) {
    for (const pid in G.remotePlayers) {
      const rp = G.remotePlayers[pid];
      if (!G.remotePlayerMeshes[pid]) {
        let remoteIndex = (rp.playerIndex !== undefined) ? rp.playerIndex : (G.match && G.match.players[pid] ? G.match.players[pid].index : (1 - G.localPlayerIndex));
        if (remoteIndex < 0) remoteIndex = 0;
        const remoteColor = remoteIndex === 0 ? 0x33ff33 : 0xff3333;
        const mesh = G.createPlayerModel(remoteColor, 0); // Correct color, layer 0
        G.scene.add(mesh);
        G.remotePlayerMeshes[pid] = mesh;
      }
      const m = G.remotePlayerMeshes[pid];
      if (rp.predictedDeadUntil && nowT < rp.predictedDeadUntil) rp.isDead = true;
      const isTargetFollowPOV = G.isSpectator && G.spectatorMode === 'follow' && G.spectateTargetPid === pid && G.followPerspective === 'pov';
      if (!isTargetFollowPOV && rp.viewOffset) {
        const id = new TH.Quaternion();
        rp.viewOffset.slerp(id, Math.min(1, dt * 5));
        if (rp.viewOffset.angleTo(id) < 0.001) rp.viewOffset = null;
      }
      m.visible = !rp.isDead && !isTargetFollowPOV;
      m.position.set(rp.pos[0], rp.pos[1], rp.pos[2]);
      m.rotation.y = rp.yaw;
      const rpCT = rp.crouchT || 0;
      if (m.userData.smoothCrouchT === undefined) {
        m.userData.smoothCrouchT = rpCT;
      } else {
        m.userData.smoothCrouchT += (rpCT - m.userData.smoothCrouchT) * Math.min(1, dt * 14);
      }
      const cT = m.userData.smoothCrouchT;
      const rpBody = m.children.find(c => c.name === 'bodyMesh');
      if (rpBody) { rpBody.scale.y = 1 - cT * 0.4; rpBody.position.y = -cT * 0.25; }
      m.userData.headGroup.rotation.x = rp.pitch;
      m.userData.headGroup.position.y = 1.5 - cT * 0.7;
      m.userData.mirrorGun.visible = (rp.activeWeapon === 1 || !rp.activeWeapon);
      m.userData.mirrorRocketGun.visible = (rp.activeWeapon === 2);
      if (m.userData.mirrorInstagibGun) m.userData.mirrorInstagibGun.visible = (rp.activeWeapon === 3);
      if (m.userData.muzzleT !== undefined) {
         m.userData.muzzleT = Math.max(0, m.userData.muzzleT - dt * 6);
         const mt = m.userData.muzzleT;
         const rScale = 1 + mt * 0.12;
         const rZ = -0.4 + mt * 0.15;
         const rRot = mt * 0.3;
         m.userData.mirrorGun.scale.setScalar(1); m.userData.mirrorGun.position.z = -0.4; m.userData.mirrorGun.rotation.x = 0;
         m.userData.mirrorRocketGun.scale.setScalar(1); m.userData.mirrorRocketGun.position.z = -0.4; m.userData.mirrorRocketGun.rotation.x = 0;
         if (m.userData.mirrorInstagibGun) { m.userData.mirrorInstagibGun.scale.setScalar(1); m.userData.mirrorInstagibGun.position.z = -0.4; m.userData.mirrorInstagibGun.rotation.x = 0; }
         const aw = rp.activeWeapon || 1;
         const activeMir = aw === 1 ? m.userData.mirrorGun : (aw === 2 ? m.userData.mirrorRocketGun : m.userData.mirrorInstagibGun);
         if (activeMir) { activeMir.scale.setScalar(rScale); activeMir.position.z = rZ; activeMir.rotation.x = rRot; }
      } else { m.userData.muzzleT = 0; }
    }
  }

  // Local camera + player model + clip plane + zoom + grab crosshair
  // (extracted from the main loop)
  function updateLocalView(dt, now) {
    if (!G.started || G.isSpectator) return;
    const sp = Math.hypot(G.pl.vel.x, G.pl.vel.z);
    if (G.isDead) {
      camera.position.lerp(deathCamPos, Math.min(1, dt * 5));
      const m = new TH.Matrix4().lookAt(camera.position, deathCamTarget, new TH.Vector3(0, 1, 0));
      camera.quaternion.slerp(new TH.Quaternion().setFromRotationMatrix(m), Math.min(1, dt * 5));
    } else {
    camera.position.copy(G.pl.pos);
    camera.position.y += (CFG.H - (CFG.H - CFG.CROUCH_H) * G.pl.crouchT) - 0.12; // pl.pos is the feet point — eyes near top of capsule
    let bob = 0;
    if (G.pl.grounded && sp > 1) bob = Math.sin(now * 0.012 * Math.min(2, sp / 7)) * 0.03 * Math.min(1, sp / CFG.GMAX);
    G.landingThump = Math.max(0, G.landingThump - dt * 4);
    camera.position.y += bob - G.landingThump * 0.18;
    camera.rotation.order = 'YXZ';
    camera.quaternion.setFromEuler(new TH.Euler(G.pl.pitch, G.pl.yaw, 0, 'YXZ'));
    }

    playerModel.position.copy(G.pl.pos);
    playerModel.rotation.set(0, G.pl.yaw, 0, 'YXZ');
    // Crouch animation: squish body, lower head
    const cBody = playerModel.children.find(c => c.name === 'bodyMesh');
    if (cBody) { cBody.scale.y = 1 - G.pl.crouchT * 0.4; cBody.position.y = -G.pl.crouchT * 0.25; }
    if (playerModel.userData.headGroup) {
      playerModel.userData.headGroup.rotation.x = G.pl.pitch;
      playerModel.userData.headGroup.position.y = 1.5 - G.pl.crouchT * 0.7;
    }
    if (playerModel.userData.mirrorGun) {
      playerModel.userData.mirrorGun.visible = (G.activeWeapon === 1);
      playerModel.userData.mirrorRocketGun.visible = (G.activeWeapon === 2);
      if (playerModel.userData.mirrorInstagibGun) playerModel.userData.mirrorInstagibGun.visible = (G.activeWeapon === 3);
    }

    let closestPortal = -1, minDist = 3.5;
    for (let i = 0; i < 4; i++) {
      if (!G.portals[i].placed) continue;
      const d = G.pl.pos.distanceTo(G.portals[i].c);
      if (d < minDist) { minDist = d; closestPortal = i; }
    }
    if (closestPortal !== -1) {
      const P = G.portals[closestPortal];
      playerClipPlane.normal.copy(P.n);
      playerClipPlane.constant = -P.n.dot(P.c);
    } else {
      playerClipPlane.normal.set(0, 1, 0);
      playerClipPlane.constant = 1e6;
    }

    if (G.pl.viewOffset) {
      const id = new TH.Quaternion();
      G.pl.viewOffset.slerp(id, Math.min(1, dt * 5));
      if (G.pl.viewOffset.angleTo(id) < 0.001) G.pl.viewOffset = null;
      else camera.quaternion.multiply(G.pl.viewOffset);
    }
    // Zoom: Z / L-Shift scope in with any weapon, RMB with rocket & instagib.
    // Not possible on the death camera — decays back out even while held.
    const zoomHeld = !G.isDead && (G.keys['KeyZ'] || G.keys['ShiftLeft'] || (G.isZooming && (G.activeWeapon === 2 || G.activeWeapon === 3)));
    if (zoomHeld) {
       G.zoomAmt = Math.min(1.0, G.zoomAmt + dt / 0.1);
    } else {
       G.zoomAmt = Math.max(0.0, G.zoomAmt - dt / 0.1);
    }
    const spFov = Math.min(G.baseFov + 16, G.baseFov + Math.max(0, (sp - CFG.GMAX) * 0.5));
    const zoomedFov = G.baseFov * 0.4;
    const wantFov = spFov * (1 - G.zoomAmt) + zoomedFov * G.zoomAmt;
    if (Math.abs(camera.fov - wantFov) > 0.05) { camera.fov = wantFov; camera.updateProjectionMatrix(); }

    let canGrab = false;
    if (!G.grabbedCube) {
       camera.updateMatrixWorld(true);
       const pos = camera.getWorldPosition(new TH.Vector3());
       const dir = new TH.Vector3(0, 0, -1).applyQuaternion(camera.quaternion).normalize();
       for (const cb of G.grabCubes) {
          const v = cb.pos.clone().sub(pos);
          const dist = v.length();
          if (dist < 7.0 && v.normalize().dot(dir) > 0.9) { canGrab = true; break; }
       }
    }
    const ch = G.dom('crosshair');
    if (canGrab) ch.classList.add('grab');
    else ch.classList.remove('grab');
  }

  G.physStep = physStep;
  G.collideCube = collideCube;
  G.resolveCubeCollisions = resolveCubeCollisions;
  G.die = die;
  G.updateRemotePlayers = updateRemotePlayers;
  G.updateLocalView = updateLocalView;
}
