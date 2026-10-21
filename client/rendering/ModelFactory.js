import * as THREE from 'three';

/**
 * ModelFactory — Factory pattern for building 3D weapon viewmodels and character avatar meshes.
 */
export class ModelFactory {
  /**
   * Build portal gun viewmodel.
   * @returns {THREE.Group}
   */
  static createPortalGun() {
    const gun = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x1a2230, metalness: 0.85, roughness: 0.25 });
    const glowA = new THREE.MeshStandardMaterial({ color: 0x0affff, emissive: 0x2eeaff, emissiveIntensity: 2.2 });
    const glowB = new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff9a3d, emissiveIntensity: 2.2 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.14, 0.42), bodyMat);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.075, 0.3, 12), bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.02, -0.3);

    const core = new THREE.Mesh(new THREE.SphereGeometry(0.045, 12, 8), glowA);
    core.position.set(0, 0.06, -0.05);

    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.012, 8, 24), glowB);
    ring.position.set(0, 0.02, -0.42);

    const prong1 = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.16, 0.05), bodyMat);
    prong1.position.set(-0.09, 0.08, -0.2);
    const prong2 = prong1.clone();
    prong2.position.x = 0.09;

    gun.add(body, barrel, core, ring, prong1, prong2);
    gun.userData.core = core;
    gun.userData.ring = ring;
    gun.position.set(0.3, -0.26, -0.5);
    return gun;
  }

  /**
   * Build rocket launcher viewmodel.
   * @returns {THREE.Group}
   */
  static createRocketGun() {
    const rocketGun = new THREE.Group();
    const bodyMat = new THREE.MeshStandardMaterial({ color: 0x2e3532, metalness: 0.9, roughness: 0.2 });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.8, 12), bodyMat);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0, -0.2);

    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.2, 0.1), bodyMat);
    handle.position.set(0, -0.15, 0.1);

    rocketGun.add(barrel, handle);
    rocketGun.position.set(0.3, -0.26, -0.5);
    return rocketGun;
  }

  /**
   * Build instagib rifle viewmodel.
   * @returns {THREE.Group}
   */
  static createInstagibGun() {
    const instagibGun = new THREE.Group();
    const metalMat = new THREE.MeshStandardMaterial({ color: 0x222222, metalness: 0.9, roughness: 0.2 });
    const redMat = new THREE.MeshStandardMaterial({ color: 0xaa1111 });
    const glowMat = new THREE.MeshStandardMaterial({ color: 0xff0000, emissive: 0xff2222, emissiveIntensity: 4.0 });

    const body = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.18, 0.45), metalMat);
    body.position.set(0, 0, 0.1);

    const railL = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.8), redMat);
    railL.position.set(-0.06, 0.02, -0.4);
    const railR = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.08, 0.8), redMat);
    railR.position.set(0.06, 0.02, -0.4);

    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.85, 12), glowMat);
    core.rotation.x = Math.PI / 2;
    core.position.set(0, 0.02, -0.4);

    const r1 = new THREE.Mesh(new THREE.TorusGeometry(0.06, 0.015, 8, 16), metalMat);
    r1.position.set(0, 0.02, -0.3);
    const r2 = r1.clone(); r2.position.set(0, 0.02, -0.5);
    const r3 = r1.clone(); r3.position.set(0, 0.02, -0.7);

    const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.2, 8), metalMat);
    scope.rotation.x = Math.PI / 2;
    scope.position.set(0, 0.13, 0.05);

    const scopeGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.21, 8), glowMat);
    scopeGlow.rotation.x = Math.PI / 2;
    scopeGlow.position.set(0, 0.13, 0.05);

    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.2, 0.12), metalMat);
    handle.position.set(0, -0.15, 0.15);
    handle.rotation.x = 0.25;

    instagibGun.add(body, railL, railR, core, r1, r2, r3, scope, scopeGlow, handle);
    instagibGun.position.set(0.3, -0.26, -0.5);
    return instagibGun;
  }

  /**
   * Build character avatar mesh.
   * @param {number} color
   * @param {number} [layer]
   * @param {THREE.Plane} [clipPlane]
   * @returns {THREE.Group}
   */
  static createPlayerModel(color, layer = null, clipPlane = null) {
    const model = new THREE.Group();

    const bodyGeo = new THREE.CylinderGeometry(0.3, 0.3, 1.2, 16);
    bodyGeo.translate(0, 0.6, 0);
    const bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.7, side: THREE.DoubleSide });
    const bodyMesh = new THREE.Mesh(bodyGeo, bodyMat);
    bodyMesh.name = 'bodyMesh';
    model.add(bodyMesh);

    const headGroup = new THREE.Group();
    headGroup.name = 'headGroup';
    headGroup.position.set(0, 1.58, 0);
    model.add(headGroup);

    const headGeo = new THREE.BoxGeometry(0.4, 0.4, 0.4);
    const headMat = new THREE.MeshStandardMaterial({ color, metalness: 0.2, roughness: 0.7, side: THREE.DoubleSide });
    const headMesh = new THREE.Mesh(headGeo, headMat);
    headMesh.name = 'headMesh';
    headGroup.add(headMesh);

    const eyeGeo = new THREE.PlaneGeometry(0.3, 0.15);
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x2eeaff, side: THREE.DoubleSide });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0, 0, -0.21);
    headGroup.add(eye);

    if (layer != null) {
      model.traverse(o => o.layers.set(layer));
    }
    if (clipPlane) {
      model.traverse(o => {
        if (o.material) {
          o.material.clippingPlanes = [clipPlane];
        }
      });
    }

    return model;
  }
}

export function initModels(TH, camera, scene) {
  const gun = ModelFactory.createPortalGun();
  const rocketGun = ModelFactory.createRocketGun();
  const instagibGun = ModelFactory.createInstagibGun();

  camera.add(gun);
  camera.add(rocketGun);
  camera.add(instagibGun);
  if (scene) scene.add(camera);

  function createPlayerModel(color, layer, clipPlane) {
    const model = ModelFactory.createPlayerModel(color, layer, clipPlane);
    const headGroup = model.getObjectByName('headGroup') || new THREE.Group();

    const mirrorGun = gun.clone();
    mirrorGun.position.set(0.3, -0.26, -0.5);
    mirrorGun.rotation.set(0, 0, 0);
    headGroup.add(mirrorGun);

    const mirrorRocketGun = rocketGun.clone();
    mirrorRocketGun.position.set(0.3, -0.26, -0.5);
    mirrorRocketGun.rotation.set(0, 0, 0);
    headGroup.add(mirrorRocketGun);

    const mirrorInstagibGun = instagibGun.clone();
    mirrorInstagibGun.position.set(0.3, -0.26, -0.5);
    mirrorInstagibGun.rotation.set(0, 0, 0);
    headGroup.add(mirrorInstagibGun);

    model.traverse(c => {
      if (c.isMesh) {
        if (layer != null) c.layers.set(layer);
        if (clipPlane) {
          c.material = c.material.clone();
          c.material.clippingPlanes = [clipPlane];
          c.material.clipShadows = true;
          c.material.side = THREE.DoubleSide;
        }
      }
    });

    model.userData = { headGroup, mirrorGun, mirrorRocketGun, mirrorInstagibGun };
    return model;
  }

  [gun, rocketGun, instagibGun].forEach(g => g.traverse(c => { if (c.isMesh) c.layers.set(2); }));
  return { gun, rocketGun, instagibGun, createPlayerModel };
}

