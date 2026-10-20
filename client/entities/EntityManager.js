import { RemotePlayer } from './RemotePlayer.js';

/**
 * EntityManager — Coordinates all active world entities, player instances, and their lifecycle updates.
 */
export class EntityManager {
  constructor(engine) {
    this.engine = engine;
    this.entities = new Map();
    this.remotePlayers = {};
  }

  /**
   * Add and register an entity.
   * @param {import('./Entity.js').Entity} entity
   * @returns {import('./Entity.js').Entity}
   */
  spawn(entity) {
    this.entities.set(entity.id, entity);
    if (entity instanceof RemotePlayer || entity.pid != null) {
      this.remotePlayers[entity.pid || entity.id] = entity;
    }
    return entity;
  }

  /**
   * Remove and cleanup an entity by id.
   * @param {number|string} id
   */
  despawn(id) {
    const entity = this.entities.get(id) || this.remotePlayers[id];
    if (entity) {
      entity.destroy();
      this.entities.delete(entity.id);
    }
    if (this.remotePlayers[id]) {
      delete this.remotePlayers[id];
    }
  }

  /**
   * Update all registered entities.
   * @param {number} dt - Delta time in seconds
   * @param {number} [nowT=0] - Frame timestamp
   * @param {Object} [context=null] - Shared engine context
   */
  update(dt, nowT = 0, context = null) {
    const ctx = context || this.engine?.context;
    for (const [id, entity] of this.entities) {
      if (!entity.active) {
        this.despawn(id);
        continue;
      }
      entity.update(dt, nowT, ctx);
    }
  }

  /**
   * Update all active remote opponent entities.
   * @param {number} dt
   * @param {number} [nowT=0]
   * @param {Object} [context=null]
   */
  updateRemotePlayers(dt, nowT = 0, context = null) {
    const ctx = context || this.engine?.context;
    for (const pid in this.remotePlayers) {
      const rp = this.remotePlayers[pid];
      if (rp && rp.active) {
        rp.update(dt, nowT, ctx);
      }
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
    this.remotePlayers = {};
  }
}
