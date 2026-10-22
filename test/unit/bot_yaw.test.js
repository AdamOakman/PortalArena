import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAngle } from '../../server/bots/BotAgent.js';

describe('Bot Yaw & Angle Normalization (Regression 600a4a6)', () => {
  test('handles values within [-PI, PI] without modification', () => {
    assert.strictEqual(normalizeAngle(0), 0);
    assert.strictEqual(normalizeAngle(1.5), 1.5);
    assert.strictEqual(normalizeAngle(-1.5), -1.5);
    assert.strictEqual(normalizeAngle(Math.PI), Math.PI);
    assert.strictEqual(normalizeAngle(-Math.PI), -Math.PI);
  });

  test('normalizes negative angles beyond -PI without infinite looping', () => {
    // Regression check for commit 600a4a6 where pl.yaw < -Math.PI subtracted instead of added
    const angle1 = -Math.PI - 0.5;
    const normalized1 = normalizeAngle(angle1);
    assert.ok(normalized1 >= -Math.PI && normalized1 <= Math.PI, 'Result must be within [-PI, PI]');
    assert.ok(Math.abs(normalized1 - (Math.PI - 0.5)) < 1e-6);

    const extremeNeg = -10 * Math.PI - 0.2;
    const normExtreme = normalizeAngle(extremeNeg);
    assert.ok(normExtreme >= -Math.PI && normExtreme <= Math.PI, 'Extreme negative angle must wrap correctly');
  });

  test('normalizes positive angles beyond PI without infinite looping', () => {
    const angle = Math.PI + 0.5;
    const normalized = normalizeAngle(angle);
    assert.ok(normalized >= -Math.PI && normalized <= Math.PI, 'Result must be within [-PI, PI]');
    assert.ok(Math.abs(normalized - (-Math.PI + 0.5)) < 1e-6);

    const extremePos = 12 * Math.PI + 0.3;
    const normExtreme = normalizeAngle(extremePos);
    assert.ok(normExtreme >= -Math.PI && normExtreme <= Math.PI, 'Extreme positive angle must wrap correctly');
  });
});
