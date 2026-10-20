/**
 * Weapon — Abstract Strategy base class for all weapons.
 */
export class Weapon {
  constructor(name, cooldown = 0.2) {
    this.name = name;
    this.cooldown = cooldown;
    this.cooldownTimer = 0;
  }

  /**
   * Update cooldown timer.
   * @param {number} dt - Delta time
   */
  update(dt) {
    if (this.cooldownTimer > 0) {
      this.cooldownTimer -= dt;
    }
  }

  /**
   * Check if weapon is ready to fire.
   * @returns {boolean}
   */
  canFire() {
    return this.cooldownTimer <= 0;
  }

  /**
   * Reset cooldown upon firing.
   */
  triggerCooldown() {
    this.cooldownTimer = this.cooldown;
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
