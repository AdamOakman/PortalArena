import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

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
});
