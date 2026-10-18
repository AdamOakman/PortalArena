/**
 * EntityManager — Coordinates all active world entities and their lifecycle updates.
 */
export class EntityManager {
  constructor(engine) {
    this.engine = engine;
    this.entities = new Map();
  }

  /**
   * Add and register an entity.
   * @param {import('./Entity.js').Entity} entity
   * @returns {import('./Entity.js').Entity}
   */
  spawn(entity) {
    this.entities.set(entity.id, entity);
    return entity;
  }

  /**
   * Remove and cleanup an entity by id.
   * @param {number|string} id
   */
  despawn(id) {
    const entity = this.entities.get(id);
    if (entity) {
      entity.destroy();
      this.entities.delete(id);
    }
  }

  /**
   * Update all registered entities.
   * @param {number} dt - Delta time in seconds
   */
  update(dt) {
    for (const [id, entity] of this.entities) {
      if (!entity.active) {
        this.entities.delete(id);
        continue;
      }
      entity.update(dt);
    }
  }

  /**
   * Clear and destroy all entities.
   */
  clear() {
    for (const entity of this.entities.values()) {
      entity.destroy();
    }
    this.entities.clear();
  }
}
