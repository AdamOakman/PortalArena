import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MatchSession } from '../../server/match/MatchSession.js';

describe('Destructible Wall State & Round Resets (Regressions ccc75fd, 4f786c2)', () => {
  test('destroyed walls are recorded and cleared upon resetDestructibleWalls', () => {
    const session = new MatchSession('test_wall_seed');
    assert.strictEqual(session.gameState.destroyedWalls.length, 0);

    // Simulate wall destruction during match
    session.gameState.destroyedWalls.push(10, 15);
    assert.strictEqual(session.gameState.destroyedWalls.length, 2);

    session.resetDestructibleWalls();
    assert.strictEqual(session.gameState.destroyedWalls.length, 0, 'Wall destruction must reset cleanly');
  });

  test('beginRound resets destructible walls so new rounds start with intact arena', () => {
    const session = new MatchSession('test_round_seed');
    session.gameState.destroyedWalls.push(3, 7);

    session.beginRound();

    assert.strictEqual(session.gameState.destroyedWalls.length, 0, 'New round must clear all destroyed walls');
    assert.strictEqual(session.match.phase, 'active');
  });

  test('boundary perimeter walls have boundary: true in session collider obbs', () => {
    const session = new MatchSession('test_boundary_colliders');
    const boundaryObbs = session.obbs.filter(obb => obb.boundary === true);

    assert.strictEqual(boundaryObbs.length, 4, 'Exactly 4 boundary collider OBBs must carry the boundary flag');
  });
});
