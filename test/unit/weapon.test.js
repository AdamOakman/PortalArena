import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Weapon } from '../../client/weapons/Weapon.js';

describe('Weapon Cooldown System', () => {
  test('weapon starts ready to fire and triggers cooldown on fire', () => {
    const weapon = new Weapon('TestGun', 0.2);
    assert.strictEqual(weapon.canFire(), true, 'Weapon should initially be ready to fire');

    weapon.triggerCooldown();
    assert.strictEqual(weapon.canFire(), false, 'Weapon should be on cooldown immediately after firing');
    assert.strictEqual(weapon.cooldownTimer, 0.2, 'Cooldown timer should equal configured duration');
  });

  test('cooldown timer decrements correctly across update ticks', () => {
    const weapon = new Weapon('TestGun', 0.2);
    weapon.triggerCooldown();

    // Partial tick
    weapon.update(0.1);
    assert.strictEqual(weapon.canFire(), false, 'Weapon should remain on cooldown during intermediate tick');
    assert.ok(Math.abs(weapon.cooldownTimer - 0.1) < 1e-6, 'Cooldown timer should decrement by dt');

    // Complete cooldown
    weapon.update(0.1);
    assert.strictEqual(weapon.canFire(), true, 'Weapon should be ready once cooldown completes');
    assert.strictEqual(weapon.cooldownTimer, 0, 'Cooldown timer should clamp to zero');
  });

  test('wall-clock fallback recovers from dropped or missed update ticks', () => {
    const weapon = new Weapon('TestGun', 0.05);
    weapon.triggerCooldown();

    // Simulate skipped update ticks where cooldownTimer was not decremented
    // Set lastFireTime to 100ms in the past relative to the clock source
    const nowSec = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
    weapon.lastFireTime = nowSec - 0.1;

    assert.strictEqual(weapon.canFire(), true, 'Weapon should recover via wall-clock fallback when ticks are dropped');
    assert.strictEqual(weapon.cooldownTimer, 0, 'Cooldown timer should be reset to 0 on wall-clock recovery');
  });
});

describe('Player Hitbox & Crouch Raycast Verification', () => {
  test('getPlayerHeight accurately reflects standing vs crouched height', async () => {
    const { CFG, getPlayerHeight } = await import('../../shared/constants.js');
    assert.strictEqual(getPlayerHeight(0), CFG.H, 'Standing player should have height CFG.H (1.7m)');
    assert.strictEqual(getPlayerHeight(1), CFG.CROUCH_H, 'Fully crouched player should have height CFG.CROUCH_H (1.0m)');
    assert.strictEqual(getPlayerHeight(0.5), (CFG.H + CFG.CROUCH_H) / 2, 'Half-crouched height should be midway');
  });

  test('aiming above a crouched player misses the hitbox while hitting a standing player', async () => {
    const THREE = await import('three');
    const { getPlayerHeight } = await import('../../shared/constants.js');

    const playerPos = new THREE.Vector3(0, 0, 0);

    // Standing hitbox (crouchT = 0)
    const standingBox = new THREE.Box3();
    const standingH = getPlayerHeight(0);
    standingBox.min.copy(playerPos).add(new THREE.Vector3(-0.4, 0, -0.4));
    standingBox.max.copy(playerPos).add(new THREE.Vector3(0.4, standingH, 0.4));

    // Crouched hitbox (crouchT = 1)
    const crouchedBox = new THREE.Box3();
    const crouchedH = getPlayerHeight(1);
    crouchedBox.min.copy(playerPos).add(new THREE.Vector3(-0.4, 0, -0.4));
    crouchedBox.max.copy(playerPos).add(new THREE.Vector3(0.4, crouchedH, 0.4));

    // Ray passing at y = 1.35m (between crouched 1.0m and standing 1.7m)
    const rayOrigin = new THREE.Vector3(0, 1.35, 5);
    const rayDir = new THREE.Vector3(0, 0, -1);
    const ray = new THREE.Ray(rayOrigin, rayDir);

    const hitStanding = ray.intersectBox(standingBox, new THREE.Vector3());
    const hitCrouched = ray.intersectBox(crouchedBox, new THREE.Vector3());

    assert.ok(hitStanding !== null, 'Beam at y=1.35m must hit standing player');
    assert.strictEqual(hitCrouched, null, 'Beam at y=1.35m must miss crouched player');
  });
});

describe('Portal Gun First-Person & Mirror Avatar Color Match', () => {
  test('mirrorGun on player model synchronizes core and ring colors from first-person viewmodel', async () => {
    const THREE = await import('three');
    const { initModels } = await import('../../client/rendering/ModelFactory.js');

    const camera = new THREE.PerspectiveCamera(115, 1, 0.001, 300);
    const scene = new THREE.Scene();
    const { gun, createPlayerModel } = initModels(THREE, camera, scene);

    const playerModel = createPlayerModel(0x33ff33, 1, null);
    const mirrorGun = playerModel.userData.mirrorGun;

    assert.ok(mirrorGun, 'Player model must contain mirrorGun');
    assert.ok(mirrorGun.userData?.core, 'mirrorGun must have reference to portalGunCore');
    assert.ok(mirrorGun.userData?.ring, 'mirrorGun must have reference to portalGunRing');

    // Initial colors match
    assert.strictEqual(
      mirrorGun.userData.core.material.color.getHex(),
      gun.userData.core.material.color.getHex(),
      'Initial mirrorGun core color must match first-person gun core color'
    );
    assert.strictEqual(
      mirrorGun.userData.core.material.emissive.getHex(),
      gun.userData.core.material.emissive.getHex(),
      'Initial mirrorGun core emissive must match first-person gun core emissive'
    );

    // Simulate switching/firing secondary portal or changing team color (e.g. red 0xff5555)
    const newColor = 0xff5555;
    gun.userData.core.material.color.setHex(newColor);
    gun.userData.core.material.emissive.setHex(newColor);
    gun.userData.ring.material.color.setHex(newColor);
    gun.userData.ring.material.emissive.setHex(newColor);

    // Simulate PlayerController synchronization
    const { PlayerController } = await import('../../client/entities/PlayerController.js');
    const controller = new PlayerController();
    controller.playerModel = playerModel;

    const mockG = {
      started: true,
      isSpectator: false,
      won: false,
      isDead: false,
      gun,
      activeWeapon: 1,
      camera: new THREE.PerspectiveCamera(),
      TH: THREE
    };

    controller.updateLocalView(1 / 60, 0, mockG);

    assert.strictEqual(
      mirrorGun.userData.core.material.color.getHex(),
      newColor,
      'mirrorGun core color must match updated first-person gun color'
    );
    assert.strictEqual(
      mirrorGun.userData.core.material.emissive.getHex(),
      newColor,
      'mirrorGun core emissive must match updated first-person gun emissive'
    );
    assert.strictEqual(
      mirrorGun.userData.ring.material.color.getHex(),
      newColor,
      'mirrorGun ring color must match updated first-person gun ring color'
    );
  });
});
