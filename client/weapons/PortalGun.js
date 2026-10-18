import { Weapon } from './Weapon.js';

/**
 * PortalGun — Strategy implementation for placing primary and secondary portals.
 */
export class PortalGun extends Weapon {
  constructor(engine, options = {}) {
    super('Portal Gun', 0.2);
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
      this.engine.eventBus.emit('WEAPON_FIRE_PORTAL', { portalIndex: 0 });
    }
  }

  fireSecondary() {
    if (!this.canFire()) return;
    this.triggerCooldown();
    if (this.engine && this.engine.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_PORTAL', { portalIndex: 1 });
    }
  }
}
