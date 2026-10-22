import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../../client/core/EventBus.js';

describe('EventBus Exception Isolation & Subscription Lifecycle (Regression c3be251)', () => {
  test('dispatches payload to registered listeners', () => {
    const bus = new EventBus();
    let received = null;

    bus.on('TEST_EVENT', (data) => {
      received = data;
    });

    bus.emit('TEST_EVENT', { score: 10 });
    assert.deepStrictEqual(received, { score: 10 });
  });

  test('faulty listener throwing exception does not prevent subsequent listeners from executing', () => {
    const bus = new EventBus();
    let firstExecuted = false;
    let secondExecuted = false;

    // First listener throws an error
    bus.on('EXPLOSION', () => {
      firstExecuted = true;
      throw new Error('Simulated failure in downstream UI/audio hook');
    });

    // Second listener should still run safely
    bus.on('EXPLOSION', () => {
      secondExecuted = true;
    });

    assert.doesNotThrow(() => {
      bus.emit('EXPLOSION', { power: 100 });
    });

    assert.strictEqual(firstExecuted, true);
    assert.strictEqual(secondExecuted, true, 'Subsequent listener must execute despite earlier exception');
  });

  test('returned unsubscribe function detaches listener cleanly', () => {
    const bus = new EventBus();
    let callCount = 0;

    const unsubscribe = bus.on('TICK', () => {
      callCount++;
    });

    bus.emit('TICK');
    assert.strictEqual(callCount, 1);

    unsubscribe();

    bus.emit('TICK');
    assert.strictEqual(callCount, 1, 'Listener should not be invoked after unsubscribe');
  });

  test('clear removes all registered listeners across events', () => {
    const bus = new EventBus();
    let countA = 0;
    let countB = 0;

    bus.on('EVENT_A', () => { countA++; });
    bus.on('EVENT_B', () => { countB++; });

    bus.clear();

    bus.emit('EVENT_A');
    bus.emit('EVENT_B');

    assert.strictEqual(countA, 0);
    assert.strictEqual(countB, 0);
  });
});
