import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

describe('Player Capsule Collisions & Head-Landing (Regression 686cb4e)', () => {
  const physics = initPhysics(THREE, CFG, PORT);

  function createMockPlayer(x, y, z, overrides = {}) {
    return {
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3(0, 0, 0),
      grounded: false,
      groundNormal: new THREE.Vector3(0, 1, 0),
      crouchT: 0,
      isDead: false,
      ...overrides
    };
  }

  test('pushes overlapping players apart horizontally', () => {
    const plA = createMockPlayer(0, 0, 0);
    const plB = createMockPlayer(0.2, 0, 0);

    const initialDist = plA.pos.distanceTo(plB.pos);
    assert.ok(initialDist < CFG.R * 2, 'Initial distance must be within collision radius');

    physics.collidePlayerWithPlayers(plA, [plB]);

    // plA should be pushed along negative X away from plB
    assert.ok(plA.pos.x < 0, 'Player A should be pushed away from Player B');
  });

  test('lands falling player on top of another player head', () => {
    // Regression check for commit 686cb4e (landing on player head)
    const groundPlayer = createMockPlayer(0, 0, 0);
    const fallingPlayer = createMockPlayer(0, CFG.H + 0.05, 0, {
      vel: new THREE.Vector3(0, -6, 0)
    });

    physics.collidePlayerWithPlayers(fallingPlayer, [groundPlayer]);

    assert.strictEqual(fallingPlayer.grounded, true, 'Falling player should become grounded on head');
    assert.strictEqual(fallingPlayer.vel.y, 0, 'Vertical falling velocity should clamp to zero on landing');
    assert.ok(fallingPlayer.pos.y >= CFG.H, 'Player should be resting at or above the other player height');
  });

  test('ignores dead players during collision checks', () => {
    const plA = createMockPlayer(0, 0, 0);
    const deadPl = createMockPlayer(0.1, 0, 0, { isDead: true });

    physics.collidePlayerWithPlayers(plA, [deadPl]);

    assert.strictEqual(plA.pos.x, 0, 'Player A position should not change when colliding with dead player');
  });
});
