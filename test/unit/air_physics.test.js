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

  test('air-strafing with KeyD and mouse turn right curves velocity smoothly right while preserving speed', () => {
    // Airborne player moving forward in -Z with yaw 0
    const pl = createAirbornePlayer(-10);
    const initialSpeed = Math.hypot(pl.vel.x, pl.vel.z);

    // Turn mouse right (yaw decreases: dyaw < 0)
    pl.prevYaw = 0;
    pl.yaw = -0.02;

    step(pl, { KeyD: true });

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.ok(Math.abs(newSpeed - initialSpeed) < 0.05, 'Speed magnitude should be preserved during air strafe');
    assert.ok(pl.vel.x > 0, 'Velocity should curve towards the right (+X)');
    assert.ok(pl.vel.z < 0, 'Forward velocity should remain negative (-Z)');
  });

  test('air-strafing with KeyA and mouse turn left curves velocity smoothly left while preserving speed', () => {
    const pl = createAirbornePlayer(-10);
    const initialSpeed = Math.hypot(pl.vel.x, pl.vel.z);

    // Turn mouse left (yaw increases: dyaw > 0)
    pl.prevYaw = 0;
    pl.yaw = 0.02;

    step(pl, { KeyA: true });

    const newSpeed = Math.hypot(pl.vel.x, pl.vel.z);
    assert.ok(Math.abs(newSpeed - initialSpeed) < 0.05, 'Speed magnitude should be preserved during air strafe');
    assert.ok(pl.vel.x < 0, 'Velocity should curve towards the left (-X)');
    assert.ok(pl.vel.z < 0, 'Forward velocity should remain negative (-Z)');
  });

  test('aggressive mouse flick is clamped by STRAFE_MAX_TURN and avoids snapping direction', () => {
    const pl = createAirbornePlayer(-10);

    // Huge flick: 0.5 rad (~28 degrees) in a single tick
    pl.prevYaw = 0;
    pl.yaw = -0.5;

    step(pl, { KeyD: true });

    // With dt = 1/128 and STRAFE_MAX_TURN = 3.5, max turn is 3.5 / 128 = ~0.0273 rad (~1.56 degrees)
    // vx should be 10 * sin(turn) <= 10 * sin(0.028) ~ 0.28, NOT 10 * sin(0.5) ~ 4.79
    assert.ok(pl.vel.x > 0, 'Velocity should curve right');
    assert.ok(pl.vel.x < 0.35, `Velocity redirect should be smoothed and clamped (got vx: ${pl.vel.x})`);
  });
});
