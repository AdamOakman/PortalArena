import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ObjectPool } from '../../client/core/ObjectPool.js';

describe('ObjectPool Lifecycle & State Reset (Regression 8cada7f)', () => {
  test('preallocates items and manages busy flag during acquire/release', () => {
    let resetCount = 0;
    const pool = new ObjectPool(
      (id) => ({ id, value: 0 }),
      (obj) => { obj.value = 0; resetCount++; },
      3
    );

    assert.strictEqual(pool.items.length, 3);
    assert.strictEqual(pool.pool.length, 3);

    const a = pool.acquire();
    assert.strictEqual(a.busy, true);
    assert.strictEqual(pool.pool.length, 2);

    a.value = 42;
    pool.release(a);

    assert.strictEqual(a.busy, false);
    assert.strictEqual(a.value, 0, 'Object state must be cleaned by resetFn');
    assert.strictEqual(resetCount, 1);
    assert.strictEqual(pool.pool.length, 3);
  });

  test('dynamically expands pool when preallocated capacity is exhausted', () => {
    const pool = new ObjectPool(
      (id) => ({ id }),
      null,
      2
    );

    const obj1 = pool.acquire();
    const obj2 = pool.acquire();
    assert.strictEqual(pool.pool.length, 0);

    // Acquire 3rd object (beyond initial capacity)
    const obj3 = pool.acquire();
    assert.strictEqual(pool.items.length, 3);
    assert.strictEqual(obj3.busy, true);

    pool.release(obj1);
    pool.release(obj2);
    pool.release(obj3);

    assert.strictEqual(pool.pool.length, 3);
  });
});
