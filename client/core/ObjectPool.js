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
    this.pool = [];

    for (let i = 0; i < initialSize; i++) {
      this.pool.push(this.createFn());
    }
  }

  /**
   * Acquire an object from the pool, creating a new one if exhausted.
   * @returns {any}
   */
  acquire() {
    return this.pool.length > 0 ? this.pool.pop() : this.createFn();
  }

  /**
   * Return an object to the pool.
   * @param {any} obj
   */
  release(obj) {
    if (this.resetFn) {
      this.resetFn(obj);
    }
    this.pool.push(obj);
  }

  /**
   * Total number of objects currently idle in the pool.
   */
  get size() {
    return this.pool.length;
  }
}
