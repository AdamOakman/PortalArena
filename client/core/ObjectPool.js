/**
 * ObjectPool — Generic object pooling pattern to avoid runtime allocations and GC pauses.
 */
export class ObjectPool {
  /**
   * @param {Function} createFn - Factory function returning a new object
   * @param {Function} [resetFn] - Function to reset the object state upon release
   * @param {number} [initialSize=10] - Number of objects to preallocate
   */
  constructor(createFn, resetFn = null, initialSize = 10) {
    this.createFn = createFn;
    this.resetFn = resetFn;
    this.items = [];
    this.pool = [];

    for (let i = 0; i < initialSize; i++) {
      const item = this.createFn(i);
      this.items.push(item);
      this.pool.push(item);
    }
  }

  /**
   * Acquire an object from the pool, creating a new one if exhausted.
   * @returns {any}
   */
  acquire() {
    let item;
    if (this.pool.length > 0) {
      item = this.pool.pop();
    } else {
      item = this.createFn(this.items.length);
      this.items.push(item);
    }
    if (typeof item === 'object' && item !== null) {
      item.busy = true;
    }
    return item;
  }

  /**
   * Return an object to the pool.
   * @param {any} obj
   */
  release(obj) {
    if (!obj) return;
    if (typeof obj === 'object') {
      obj.busy = false;
    }
    if (this.resetFn) {
      this.resetFn(obj);
    }
    this.pool.push(obj);
  }

  /**
   * Release all tracked objects back into the pool.
   */
  releaseAll() {
    this.pool = [];
    for (const item of this.items) {
      if (typeof item === 'object' && item !== null) {
        item.busy = false;
      }
      if (this.resetFn) {
        this.resetFn(item);
      }
      this.pool.push(item);
    }
  }

  /**
   * Iterate over all managed items in the pool.
   */
  [Symbol.iterator]() {
    return this.items[Symbol.iterator]();
  }

  /**
   * Execute a callback for each managed item in the pool.
   * @param {Function} callback
   * @param {any} [thisArg]
   */
  forEach(callback, thisArg) {
    this.items.forEach(callback, thisArg);
  }

  /**
   * Total number of objects currently idle in the pool.
   */
  get size() {
    return this.pool.length;
  }
}
