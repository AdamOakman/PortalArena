import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../../shared/mapgen.js';

describe('Map Generator Determinism & Boundary Invariants (Regression 59ccea9)', () => {
  test('seed produces deterministic spawns, slabs, and ramps', () => {
    const mapA = generateMap('fixed_seed_12345');
    const mapB = generateMap('fixed_seed_12345');

    assert.strictEqual(mapA.slabs.length, mapB.slabs.length, 'Slab counts must match');
    assert.strictEqual(mapA.spawns.length, mapB.spawns.length, 'Spawn counts must match');
    assert.strictEqual(mapA.ramps.length, mapB.ramps.length, 'Ramp counts must match');
    assert.deepStrictEqual(mapA.spawns[0], mapB.spawns[0], 'First spawn point must be identical');
  });

  test('different seeds produce distinct maps', () => {
    const mapA = generateMap('seed_alpha');
    const mapB = generateMap('seed_beta');

    assert.notDeepStrictEqual(mapA.spawns, mapB.spawns, 'Different seeds should vary spawn points');
  });

  test('outer boundary walls are tagged with boundary: true to resist rockets', () => {
    // Regression check for commit 59ccea9: boundary walls must be marked boundary: true
    const map = generateMap('test_boundary_seed');
    const boundaryWalls = map.slabs.filter(s => s.boundary === true);

    assert.strictEqual(boundaryWalls.length, 4, 'Exactly 4 arena boundary walls must be marked indestructible');
    for (const wall of boundaryWalls) {
      assert.strictEqual(wall.boundary, true);
    }
  });

  test('guarantees valid duel spawns above floor level', () => {
    const map = generateMap('test_spawn_seed');
    assert.ok(map.spawns.length >= 2, 'Arena must have at least 2 spawn positions for duels');
    for (const sp of map.spawns) {
      assert.ok(sp.y >= 0, `Spawn point y=${sp.y} must not be below floor level`);
    }
  });
});
