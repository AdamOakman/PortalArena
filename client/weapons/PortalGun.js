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
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.gun) G.gun.visible = true;
    if (this.model) this.model.visible = true;
  }

  unequip() {
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    if (G?.gun) G.gun.visible = false;
    if (this.model) this.model.visible = false;
  }

  firePrimary() {
    if (!this.canFire()) return;
    this.triggerCooldown();
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    const pi = G ? G.localPlayerIndex * 2 : 0;
    const wm = this.engine?.weaponManager || G?.weaponManager;
    if (wm?.firePortal) {
      wm.firePortal(pi, G);
    } else if (G?.firePortal) {
      G.firePortal(pi);
    }
    if (this.engine?.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_PORTAL', { portalIndex: pi });
    }
  }

  fireSecondary(active = true) {
    if (!active) return;
    if (!this.canFire()) return;
    this.triggerCooldown();
    const G = this.engine?.context || (typeof window !== 'undefined' ? window.__GAME_CONTEXT__ : null);
    const pi = G ? G.localPlayerIndex * 2 + 1 : 1;
    const wm = this.engine?.weaponManager || G?.weaponManager;
    if (wm?.firePortal) {
      wm.firePortal(pi, G);
    } else if (G?.firePortal) {
      G.firePortal(pi);
    }
    if (this.engine?.eventBus) {
      this.engine.eventBus.emit('WEAPON_FIRE_PORTAL', { portalIndex: pi });
    }
  }
}
