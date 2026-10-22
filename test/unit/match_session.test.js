import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { MatchSession } from '../../server/match/MatchSession.js';

describe('MatchSession Lifecycle & State (Regressions 9213804, ccc75fd)', () => {
  test('initializes with default waiting phase and valid map data', () => {
    const session = new MatchSession('test_seed_123');
    assert.strictEqual(session.match.phase, 'waiting');
    assert.ok(session.mapData.spawns.length > 0, 'Spawns must be generated');
    assert.strictEqual(session.gameState.destroyedWalls.length, 0);
  });

  test('transitions smoothly through warmup, countdown, and active rounds', () => {
    const session = new MatchSession('test_seed_123');
    
    // Warmup
    session.beginWarmup();
    assert.strictEqual(session.match.phase, 'warmup');
    assert.ok(session.match.deadlineMs > Date.now());

    // Countdown
    session.startCountdown();
    assert.strictEqual(session.match.phase, 'countdown');

    // Active
    session.beginRound();
    assert.strictEqual(session.match.phase, 'active');
    assert.ok(session.match.deadlineMs > Date.now());

    // Reset to waiting
    session.resetToWaiting();
    assert.strictEqual(session.match.phase, 'waiting');
    assert.strictEqual(session.match.deadlineMs, 0);
  });

  test('resetMapState cleans up placed portals and active cubes', () => {
    const session = new MatchSession('test_seed_123');
    // Simulate placed portals
    session.gameState.portals[0].placed = true;
    session.gameState.portals[1].placed = true;
    session.gameState.destroyedWalls.push(0);

    session.resetMapState();

    assert.strictEqual(session.gameState.portals[0].placed, false, 'Portals must reset on state clear');
    assert.strictEqual(session.gameState.portals[1].placed, false);
    assert.strictEqual(session.gameState.destroyedWalls.length, 0, 'Destroyed walls must reset');
  });
});
