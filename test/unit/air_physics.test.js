import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

describe('Mid-Air W/S Subtle Acceleration & Speed Threshold', () => {
  const physics = initPhysics(THREE, CFG, PORT);

  const mockPortals = [
    { placed: false, c: new THREE.Vector3(), n: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3() },
    { placed: false, c: new THREE.Vector3(), n: new THREE.Vector3(), r: new THREE.Vector3(), u: new THREE.Vector3() }
  ];

  const mockTpState = {
    nowT: 0,
    tpGracePortal: null,
    tpGraceT: -1,
    R_AB: [new THREE.Matrix4(), new THREE.Matrix4()],
    R_BA: [new THREE.Matrix4(), new THREE.Matrix4()]
  };

  function createAirbornePlayer(velZ = -6, overrides = {}) {
    return {
      pos: new THREE.Vector3(0, 50, 0),
      vel: new THREE.Vector3(0, 0, velZ),
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      groundT: -10,
      jumpBuf: -1,
      crouchT: 0,
      yaw: 0,
      pitch: 0,
      maxSpeed: 0,
      ...overrides
    };
  }

  function step(pl, keys) {
    physics.physStep(
      pl,
      keys,
      0,           // autohop
      1 / 128,     // dt
      [],          // obbs
      mockPortals, // portals
      [],          // grabCubes
      null,        // grabbedCube
      mockTpState, // tpState
      {},          // events
      []           // otherPlayers
    );
  }

  test('pressing W in mid-air provides subtle acceleration below threshold', () => {
    const pl = createAirbornePlayer(-6);
    const initialSpeed = Math.hypot(pl.vel.x, pl.vel.z);

    // Step 1 physics tick with KeyW held
    step(pl, { KeyW: true });

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.ok(newSpeed > initialSpeed, 'Speed should subtly increase when holding W in mid-air');
    // Subtle check: acceleration should be minimal (around 0.35 m/s² * dt ~ 0.0027 m/s per tick)
    const delta = newSpeed - initialSpeed;
    assert.ok(delta > 0 && delta < 0.01, `Acceleration should be extremely gentle (got delta: ${delta})`);
  });

  test('mid-air acceleration stops completely when linear speed reaches threshold of ~60', () => {
    // Start at threshold speed (60 m/s)
    const pl = createAirbornePlayer(-60);

    step(pl, { KeyW: true });

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.ok(
      newSpeed <= 60.0001,
      `Horizontal speed should not exceed threshold 60 (got ${newSpeed})`
    );
  });

  test('super-threshold speed (e.g. from portal fling > 60) does not receive forward acceleration', () => {
    const pl = createAirbornePlayer(-75);

    step(pl, { KeyW: true });

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.ok(
      newSpeed <= 75.0001,
      `Super-threshold speed should not receive forward acceleration (got ${newSpeed})`
    );
  });

  test('no forward acceleration is added when neither W nor S is pressed', () => {
    const pl = createAirbornePlayer(-6);
    const initialSpeed = Math.hypot(pl.vel.x, pl.vel.z);

    step(pl, {});

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.strictEqual(newSpeed, initialSpeed, 'Speed should remain unchanged when no keys are pressed');
  });
});
