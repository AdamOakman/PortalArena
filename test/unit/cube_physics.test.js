import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

describe('Cube Wall Collision & Portal Passthrough (Regression 05ab9b6)', () => {
  const physics = initPhysics(THREE, CFG, PORT);

  function createMockWall(overrides = {}) {
    return {
      c: new THREE.Vector3(0, 5, 0),
      rad: 15,
      he: [10, 10, 0.5], // thickness 1.0m (from -0.5 to +0.5 along Z)
      ax: [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1)
      ],
      ...overrides
    };
  }

  test('cube bounces off a solid wall with restitution', () => {
    const wall = createMockWall();
    // Cube approaching wall from Z=1.0 with velocity Z=-10
    const cube = {
      pos: new THREE.Vector3(0, 5, 0.6), // surface is at z=0.5, radius=0.2 touches surface
      vel: new THREE.Vector3(0, 0, -10)
    };

    physics.collideCube(cube, [wall], [], 0.2);

    // Cube velocity along normal (+Z) should reflect and become positive
    assert.ok(cube.vel.z > 0, `Cube velocity (${cube.vel.z}) should reflect and bounce off wall`);
    assert.ok(cube.pos.z >= 0.7, 'Cube position should be pushed out of wall face');
  });

  test('cube bypasses collision and passes through an open portal aperture', () => {
    const wall = createMockWall();
    // Place active portal on the wall face at z=0.5
    const portalA = {
      placed: true,
      c: new THREE.Vector3(0, 5, 0.5),
      n: new THREE.Vector3(0, 0, 1),
      r: new THREE.Vector3(1, 0, 0),
      u: new THREE.Vector3(0, 1, 0)
    };
    const portalB = {
      placed: true,
      c: new THREE.Vector3(20, 5, 0),
      n: new THREE.Vector3(1, 0, 0),
      r: new THREE.Vector3(0, 0, 1),
      u: new THREE.Vector3(0, 1, 0)
    };

    const cube = {
      pos: new THREE.Vector3(0, 5, 0.6),
      vel: new THREE.Vector3(0, 0, -10)
    };

    physics.collideCube(cube, [wall], [portalA, portalB], 0.2);

    // Because portal is placed on the wall surface, collideCube should recognize the hole
    // and NOT bounce the cube or invert its velocity
    assert.strictEqual(cube.vel.z, -10, 'Cube velocity should remain unchanged through portal aperture');
    assert.strictEqual(cube.pos.z, 0.6, 'Cube should not be pushed back by wall face');
  });
});
