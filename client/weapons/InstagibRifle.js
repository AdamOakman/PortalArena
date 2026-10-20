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
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.instagibGun) G.instagibGun.visible = true;
    if (this.model) this.model.visible = true;
  }

  unequip() {
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.instagibGun) G.instagibGun.visible = false;
    if (this.model) this.model.visible = false;
  }

  firePrimary() {
    if (!this.canFire()) return;
    this.triggerCooldown();
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    const wm = this.engine?.weaponManager || G?.weaponManager;
    if (wm?.fireInstagib) {
      wm.fireInstagib(G);
    } else if (G?.fireInstagib) {
      G.fireInstagib();
    }
    if (this.engine?.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_INSTAGIB');
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
