import { Weapon } from './Weapon.js';

/**
 * InstagibRifle — Strategy implementation for high-damage hitscan railgun.
 */
export class InstagibRifle extends Weapon {
  constructor(engine, options = {}) {
    super('Instagib Rifle', 1.0);
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
      this.engine.eventBus.emit('WEAPON_FIRE_INSTAGIB');
    }
  }

  fireSecondary() {
    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('WEAPON_ALT_AIM');
    }
  }
}
