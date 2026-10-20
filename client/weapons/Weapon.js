/**
 * Weapon — Abstract Strategy base class for all weapons.
 */
export class Weapon {
  constructor(name, cooldown = 0.2) {
    this.name = name;
    this.cooldown = cooldown;
    this.cooldownTimer = 0;
    this.lastFireTime = -999;
  }

  /**
   * Update cooldown timer.
   * @param {number} dt - Delta time
   */
  update(dt) {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
      if (this.cooldownTimer < 0) this.cooldownTimer = 0;
    }
  }

  /**
   * Check if weapon is ready to fire.
   * @returns {boolean}
   */
  canFire() {
    if (this.cooldownTimer <= 0) return true;
    const now = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    if (now - this.lastFireTime >= this.cooldown) {
      this.cooldownTimer = 0;
      return true;
    }
    return false;
  }

  /**
   * Reset cooldown upon firing.
   */
  triggerCooldown() {
    this.cooldownTimer = this.cooldown;
    this.lastFireTime = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
  }

  /**
   * Primary fire action.
   */
  firePrimary() {}

  /**
   * Secondary fire action.
   * @param {boolean} [active=true]
   */
  fireSecondary(active = true) {
    void active;
  }

  /**
   * Called when weapon is equipped.
   */
  equip() {}

  /**
   * Called when weapon is unequipped.
   */
  unequip() {}
}
