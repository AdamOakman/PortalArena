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
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.rocketGun) G.rocketGun.visible = true;
    if (this.model) this.model.visible = true;
  }

  unequip() {
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.rocketGun) G.rocketGun.visible = false;
    if (this.model) this.model.visible = false;
  }

  firePrimary() {
    if (!this.canFire()) return;
    this.triggerCooldown();
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    const wm = this.engine?.weaponManager || G?.weaponManager;
    if (wm?.fireRocket) {
      wm.fireRocket(G);
    } else if (G?.fireRocket) {
      G.fireRocket();
    }
    if (this.engine?.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_ROCKET');
    }
  }

  fireSecondary(active = true) {
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G) {
      G.isZooming = !!active;
    }
    if (this.engine?.eventBus) {
      this.engine.eventBus.emit('WEAPON_ALT_AIM', { active });
    }
  }
}
