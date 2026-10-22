import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { CFG, PORT } from '../../shared/constants.js';
import { initPhysics } from '../../shared/physics.js';

describe('Portal Placement Legality (Regressions 686cb4e, 4f786c2, c8bf689)', () => {
  const physics = initPhysics(THREE, CFG, PORT);

  const portalCenter = new THREE.Vector3(0, 5, 0);
  const normal = new THREE.Vector3(0, 0, 1);
  const right = new THREE.Vector3(1, 0, 0);
  const up = new THREE.Vector3(0, 1, 0);

  function createMockWall(overrides = {}) {
    return {
      c: new THREE.Vector3(0, 5, 0),
      he: [10, 10, 0.5], // Large enough for PORT.hw (1.4375) and PORT.hh (2.0)
      ax: [
        new THREE.Vector3(1, 0, 0),
        new THREE.Vector3(0, 1, 0),
        new THREE.Vector3(0, 0, 1)
      ],
      kind: 'wall',
      noPortal: false,
      destroyed: false,
      ...overrides
    };
  }

  test('allows portal placement on a valid, large wall surface', () => {
    const wall = createMockWall();
    const blocked = physics.isPortalPlacementBlocked(
      portalCenter, normal, right, up,
      wall, 0, [], [], [], [], []
    );
    assert.strictEqual(blocked, false, 'Valid wall should allow portal placement');
  });

  test('blocks portal placement on curved ramp colliders (Regression 686cb4e)', () => {
    const ramp = createMockWall({ kind: 'ramp' });
    const blocked = physics.isPortalPlacementBlocked(
      portalCenter, normal, right, up,
      ramp, 0, [], [], [], [], []
    );
    assert.strictEqual(blocked, true, 'Ramp surfaces must reject portal placement');
  });

  test('blocks portal placement on destroyed walls (Regressions 4f786c2, c8bf689)', () => {
    const destroyedWall = createMockWall({ destroyed: true });
    const blocked = physics.isPortalPlacementBlocked(
      portalCenter, normal, right, up,
      destroyedWall, 0, [], [], [], [], []
    );
    assert.strictEqual(blocked, true, 'Destroyed wall surfaces must reject portal placement');
  });

  test('blocks portal placement on surfaces tagged noPortal: true', () => {
    const noPortalWall = createMockWall({ noPortal: true });
    const blocked = physics.isPortalPlacementBlocked(
      portalCenter, normal, right, up,
      noPortalWall, 0, [], [], [], [], []
    );
    assert.strictEqual(blocked, true, 'noPortal wall surfaces must reject portal placement');
  });

  test('blocks portal placement when wall face is smaller than portal dimensions', () => {
    // Face half-extents (0.5m) smaller than portal mouth (PORT.hw = 1.4375m)
    const tinyWall = createMockWall({ he: [0.5, 0.5, 0.5] });
    const blocked = physics.isPortalPlacementBlocked(
      portalCenter, normal, right, up,
      tinyWall, 0, [], [], [], [], []
    );
    assert.strictEqual(blocked, true, 'Surfaces smaller than portal aperture must reject portal placement');
  });
});
