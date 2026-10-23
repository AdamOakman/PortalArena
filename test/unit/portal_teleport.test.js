import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';
import { PortalManager } from '../../client/portals/PortalManager.js';

describe('Portal Teleportation & Ceiling Clearance (Regression 7b18e71)', () => {
  const physics = initPhysics(THREE, CFG, PORT);

  // Portal P on floor: center at y=0, normal points up (+Y)
  const floorPortal = {
    placed: true,
    c: new THREE.Vector3(0, 0, 0),
    n: new THREE.Vector3(0, 1, 0),
    r: new THREE.Vector3(1, 0, 0),
    u: new THREE.Vector3(0, 0, -1)
  };

  // Portal Q on ceiling: center at y=20, normal points down (-Y)
  const ceilingPortal = {
    placed: true,
    c: new THREE.Vector3(0, 20, 0),
    n: new THREE.Vector3(0, -1, 0),
    r: new THREE.Vector3(1, 0, 0),
    u: new THREE.Vector3(0, 0, 1)
  };

  const portals = [floorPortal, ceilingPortal];

  // R_AB: rotation matrix from P to Q (rotates P.n (0,1,0) to -Q.n (0,1,0))
  const R_AB = new THREE.Matrix4().identity();
  const R_BA = new THREE.Matrix4().identity();

  const mockTpState = {
    nowT: 0,
    tpGracePortal: null,
    tpGraceT: -1,
    R_AB: [R_AB, new THREE.Matrix4()],
    R_BA: [R_BA, new THREE.Matrix4()]
  };

  test('ceiling exit positions player completely below the ceiling (Regression 7b18e71)', () => {
    // Player eye crosses portal plane y = 0
    // Eye height is pl.pos.y + CFG.H - 0.12 = pl.pos.y + 1.58
    // With pos.y = -1.5, eye is at +0.08 (above floor portal)
    // Moving with vel.y = -15 takes eye below 0 within 1 tick (dt = 1/128s)
    const pl = {
      pos: new THREE.Vector3(0, -1.5, 0),
      vel: new THREE.Vector3(0, -15, 0),
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundT: -10,
      jumpBuf: -1,
      crouchT: 0,
      yaw: 0,
      pitch: 0,
      maxSpeed: 0
    };

    let teleported = false;
    const events = {
      onTeleport: () => { teleported = true; }
    };

    physics.physStep(
      pl,
      {},
      0,
      1 / 128,
      [],
      portals,
      [],
      null,
      mockTpState,
      events,
      []
    );

    assert.strictEqual(teleported, true, 'Player crossing portal aperture must teleport');
    // Player should emerge below ceilingPortal.c (y=20) by at least CFG.H + 0.2 = 1.9m
    const expectedMaxY = ceilingPortal.c.y - (CFG.H + 0.2);
    assert.ok(
      pl.pos.y <= expectedMaxY + 0.05,
      `Exiting player pos.y (${pl.pos.y}) must be below ceiling portal minus player height (${expectedMaxY})`
    );
  });

  test('ceiling exit enforces minimum downward fling speed (>= 6.0 m/s)', () => {
    // Player dropping slowly into floor portal, crossing plane
    const pl = {
      pos: new THREE.Vector3(0, -1.57, 0),
      vel: new THREE.Vector3(0, -2, 0), // slow drop
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundT: -10,
      jumpBuf: -1,
      crouchT: 0,
      yaw: 0,
      pitch: 0,
      maxSpeed: 0
    };

    let teleported = false;
    physics.physStep(
      pl,
      {},
      0,
      1 / 128,
      [],
      portals,
      [],
      null,
      mockTpState,
      { onTeleport: () => { teleported = true; } },
      []
    );

    assert.strictEqual(teleported, true, 'Player should teleport upon camera plane crossing');
    // Speed along Q.n (downward, -Y) must be at least 6.0 m/s (i.e. vel.y <= -6.0)
    assert.ok(
      pl.vel.y <= -5.99,
      `Exiting player velocity (${pl.vel.y}) must have at least 6 m/s downward fling`
    );
  });

  test('passing slowly through a wall portal preserves controlled entry speed without outward fling push', () => {
    // Portal P on vertical wall: center at (0, 1.5, 0), normal facing +Z
    const wallPortalP = {
      placed: true,
      c: new THREE.Vector3(0, 1.5, 0),
      n: new THREE.Vector3(0, 0, 1),
      r: new THREE.Vector3(1, 0, 0),
      u: new THREE.Vector3(0, 1, 0)
    };

    // Portal Q on opposite wall: center at (0, 1.5, 20), normal facing -Z
    const wallPortalQ = {
      placed: true,
      c: new THREE.Vector3(0, 1.5, 20),
      n: new THREE.Vector3(0, 0, -1),
      r: new THREE.Vector3(-1, 0, 0),
      u: new THREE.Vector3(0, 1, 0)
    };

    // R_AB: maps P.n (0,0,1) to -Q.n (0,0,1) and preserves up
    const R_AB_wall = new THREE.Matrix4().identity();
    const R_BA_wall = new THREE.Matrix4().identity();

    const wallTpState = {
      nowT: 0,
      tpGracePortal: null,
      tpGraceT: -1,
      R_AB: [R_AB_wall, new THREE.Matrix4()],
      R_BA: [R_BA_wall, new THREE.Matrix4()]
    };

    // Player walking forward into portal P with a slow, controlled speed of 1.2 m/s along -Z
    // Player starts just in front of portal plane (z = 0.005)
    const pl = {
      pos: new THREE.Vector3(0, 0, 0.005),
      vel: new THREE.Vector3(0, 0, -1.2),
      grounded: true,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundT: 0,
      jumpBuf: -1,
      crouchT: 0,
      yaw: 0,
      pitch: 0,
      maxSpeed: 1.2
    };

    let teleported = false;
    physics.physStep(
      pl,
      { KeyW: true },
      0,
      1 / 60,
      [],
      [wallPortalP, wallPortalQ],
      [],
      null,
      wallTpState,
      { onTeleport: () => { teleported = true; } },
      []
    );

    assert.strictEqual(teleported, true, 'Player crossing wall portal aperture should teleport');
    // Player speed along Q.n (-Z) should preserve the controlled walking speed (~1.2 m/s),
    // and must NOT be forcefully boosted to 6.0 m/s
    assert.ok(
      Math.abs(pl.vel.z) < 3.0,
      `Exiting player velocity (${pl.vel.z}) should not be boosted to 6 m/s fling speed`
    );
    assert.ok(
      pl.vel.z < -0.5,
      `Exiting player velocity (${pl.vel.z}) should continue moving outward through exit portal`
    );
    // Player should have crossed through to the exit portal position in front of Q (z < 20)
    assert.ok(
      pl.pos.z < 20.0,
      `Exiting player position (${pl.pos.z}) should be on the outward side of portal Q`
    );
  });

  test('portal visual elements remain visible when very close to portal (< 0.05m)', () => {
    const pm = new PortalManager();
    pm.portals[0].placed = true;
    pm.portals[0].c.set(0, 1.5, 0);
    pm.portals[0].n.set(0, 0, 1);
    pm.portals[0].r.set(1, 0, 0);
    pm.portals[0].u.set(0, 1, 0);

    // Camera at 0.02m (2 cm) in front of the portal (halfway through player capsule, < 0.05m)
    pm.camera = { position: new THREE.Vector3(0, 1.5, 0.02) };
    pm.quads = [{ quaternion: new THREE.Quaternion(), position: new THREE.Vector3(), visible: false }];
    pm.frames = [{ quaternion: new THREE.Quaternion(), position: new THREE.Vector3(), visible: false }];
    pm.glowLights = [{ position: new THREE.Vector3(), color: { setHex: () => {} }, intensity: 0 }];
    pm.sparkles = [{ mesh: { quaternion: new THREE.Quaternion(), position: new THREE.Vector3(), visible: false } }];

    pm.placePortalVisuals();

    assert.strictEqual(
      pm.frames[0].visible,
      true,
      'Portal frame must remain visible at distance 0.02m (< 0.05m)'
    );
    assert.strictEqual(
      pm.sparkles[0].mesh.visible,
      true,
      'Portal sparkles must remain visible at distance 0.02m (< 0.05m)'
    );
    assert.ok(
      pm.glowLights[0].intensity > 0,
      'Portal glow light must remain active at distance 0.02m (< 0.05m)'
    );
  });
});
