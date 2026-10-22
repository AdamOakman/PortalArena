import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Weapon } from '../../client/weapons/Weapon.js';

describe('Weapon Cooldown System', () => {
  test('weapon starts ready to fire and triggers cooldown on fire', () => {
    const weapon = new Weapon('TestGun', 0.2);
    assert.strictEqual(weapon.canFire(), true, 'Weapon should initially be ready to fire');

    weapon.triggerCooldown();
    assert.strictEqual(weapon.canFire(), false, 'Weapon should be on cooldown immediately after firing');
    assert.strictEqual(weapon.cooldownTimer, 0.2, 'Cooldown timer should equal configured duration');
  });

  test('cooldown timer decrements correctly across update ticks', () => {
    const weapon = new Weapon('TestGun', 0.2);
    weapon.triggerCooldown();

    // Partial tick
    weapon.update(0.1);
    assert.strictEqual(weapon.canFire(), false, 'Weapon should remain on cooldown during intermediate tick');
    assert.ok(Math.abs(weapon.cooldownTimer - 0.1) < 1e-6, 'Cooldown timer should decrement by dt');

    // Complete cooldown
    weapon.update(0.1);
    assert.strictEqual(weapon.canFire(), true, 'Weapon should be ready once cooldown completes');
    assert.strictEqual(weapon.cooldownTimer, 0, 'Cooldown timer should clamp to zero');
  });

  test('wall-clock fallback recovers from dropped or missed update ticks', () => {
    const weapon = new Weapon('TestGun', 0.05);
    weapon.triggerCooldown();

    // Simulate skipped update ticks where cooldownTimer was not decremented
    // Set lastFireTime to 100ms in the past relative to the clock source
    const nowSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    weapon.lastFireTime = nowSec - 0.1;

    assert.strictEqual(weapon.canFire(), true, 'Weapon should recover via wall-clock fallback when ticks are dropped');
    assert.strictEqual(weapon.cooldownTimer, 0, 'Cooldown timer should be reset to 0 on wall-clock recovery');
  });
});
