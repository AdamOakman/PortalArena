import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AudioSys } from '../../client/audio/AudioController.js';

describe('Audio Subsystem Contracts (Regression df373b3)', () => {
  test('AudioSys exposes all required player physics event hooks', () => {
    // Regression check for commit df373b3 where AudioSys.jump/land were missing after OOP refactor
    const requiredMethods = ['jump', 'land', 'jumppad', 'tone', 'noise', 'toggleMute'];
    for (const method of requiredMethods) {
      assert.strictEqual(
        typeof AudioSys[method],
        'function',
        `AudioSys.${method} must be defined as a callable function`
      );
    }
  });

  test('AudioSys methods gracefully handle execution without active WebAudio context', () => {
    // Audio hooks must be no-ops or safely exit without throwing in headless/server/pre-init contexts
    assert.doesNotThrow(() => {
      AudioSys.jump();
      AudioSys.land(5.0);
      AudioSys.jumppad();
    }, 'AudioSys physics sound triggers should never throw when audio context is unavailable');
  });

  test('AudioSys toggleMute toggles mute state predictably', () => {
    const initial = AudioSys.muted;
    const toggled = AudioSys.toggleMute();
    assert.strictEqual(toggled, !initial);
    assert.strictEqual(AudioSys.muted, !initial);
    // Restore
    AudioSys.toggleMute();
    assert.strictEqual(AudioSys.muted, initial);
  });
});
