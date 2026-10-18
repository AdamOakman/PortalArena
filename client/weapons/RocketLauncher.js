import { Weapon } from './Weapon.js';

/**
 * RocketLauncher — Strategy implementation for launching rocket projectiles.
 */
export class RocketLauncher extends Weapon {
  constructor(engine, options = {}) {
    super('Rocket Launcher', 0.5);
    this.engine = engine;
    this.model = options.model || null;
  }

  equip() {
    if (this.model) this.model.visible = true;
  }

  unequip() {
    if (this.model) this.model.visible = false;
  }

  firePrimary() {
    if (!this.canFire()) return;
    this.triggerCooldown();
    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_ROCKET');
    }
  }

  fireSecondary() {
    // Secondary trigger on rocket launcher handles zoom / alternate aim
    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('WEAPON_ALT_AIM');
    }
  }
}
