import * as THREE from 'three';
import { ModelFactory } from '../rendering/ModelFactory.js';

/**
 * MenuDecorator — 3D interactive decorator rendering two opposing player models
 * aiming portal guns at each other across the currently selected menu option.
 */
export class MenuDecorator {
  /**
   * @param {HTMLCanvasElement} [canvas]
   */
  constructor(canvas = null) {
    this.canvas = canvas;
    this.renderer = null;
    this.scene = null;
    this.camera = null;

    this.leftModel = null;
    this.rightModel = null;
    this.leftGunCore = null;
    this.rightGunCore = null;
    this.leftGunRing = null;
    this.rightGunRing = null;

    this.targetY = 0;
    this.targetLeftX = -3.2;
    this.targetRightX = 3.2;
    this.currentY = 0;
    this.currentLeftX = -3.2;
    this.currentRightX = 3.2;

    this.isRunning = false;
    this.rafId = null;
    this.activeElement = null;

    if (this.canvas) {
      this.init();
    }
  }

  /**
   * Initialize Three.js scene, camera, lights, and player models.
   */
  init() {
    if (!this.canvas) return;

    const width = this.canvas.clientWidth || 720;
    const height = this.canvas.clientHeight || 500;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: true,
      powerPreference: 'low-power'
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height, false);

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 50);
    this.camera.position.set(0, 0, 9);
    this.camera.lookAt(0, 0, 0);

    // Subtle atmospheric lighting
    const ambientLight = new THREE.AmbientLight(0xffecd0, 1.2);
    const dirLight = new THREE.DirectionalLight(0xff8833, 2.2);
    dirLight.position.set(2, 6, 5);

    const leftPointLight = new THREE.PointLight(0x00ffff, 2.0, 7);
    leftPointLight.position.set(-3.5, 0, 2);

    const rightPointLight = new THREE.PointLight(0xff7a22, 2.0, 7);
    rightPointLight.position.set(3.5, 0, 2);

    this.scene.add(ambientLight, dirLight, leftPointLight, rightPointLight);

    this._buildPlayerModels();
    this.resize();
  }

  /**
   * Build Left (Green) and Right (Crimson) player models with portal guns.
   * @private
   */
  _buildPlayerModels() {
    // Model 1: Left player (Emerald green armor, cyan visor & portal gun)
    this.leftModel = this._createFighter(0x2d7a46, 0x00ffff, 0x00ffff, true);
    // Model 2: Right player (Gothic crimson armor, amber visor & portal gun)
    this.rightModel = this._createFighter(0x8a2417, 0xff7a22, 0xff7a22, false);

    this.scene.add(this.leftModel);
    this.scene.add(this.rightModel);
  }

  /**
   * Build a combatant player model aiming a portal gun horizontally.
   * @param {number} armorColor
   * @param {number} visorColor
   * @param {number} gunGlowColor
   * @param {boolean} isLeft - true if on left aiming right (+X), false if on right aiming left (-X)
   * @returns {THREE.Group}
   * @private
   */
  _createFighter(armorColor, visorColor, gunGlowColor, isLeft) {
    const root = new THREE.Group();
    const inner = new THREE.Group();

    // Body cylinder
    const bodyGeo = new THREE.CylinderGeometry(0.28, 0.28, 1.15, 14);
    bodyGeo.translate(0, 0.58, 0);
    const bodyMat = new THREE.MeshStandardMaterial({
      color: armorColor,
      metalness: 0.65,
      roughness: 0.35
    });
    const body = new THREE.Mesh(bodyGeo, bodyMat);
    inner.add(body);

    // Head
    const headGroup = new THREE.Group();
    headGroup.position.set(0, 1.48, 0);
    const headGeo = new THREE.BoxGeometry(0.38, 0.38, 0.38);
    const head = new THREE.Mesh(headGeo, bodyMat);
    headGroup.add(head);

    // Visor
    const eyeGeo = new THREE.PlaneGeometry(0.28, 0.12);
    const eyeMat = new THREE.MeshBasicMaterial({
      color: visorColor,
      side: THREE.DoubleSide
    });
    const eye = new THREE.Mesh(eyeGeo, eyeMat);
    eye.position.set(0, 0, -0.20);
    headGroup.add(eye);

    // Portal Gun
    const gun = ModelFactory.createPortalGun();
    gun.scale.set(1.05, 1.05, 1.05);
    gun.position.set(0.26, -0.22, -0.42);

    const glowCoreMat = new THREE.MeshStandardMaterial({
      color: gunGlowColor,
      emissive: gunGlowColor,
      emissiveIntensity: 2.2
    });
    const glowRingMat = new THREE.MeshStandardMaterial({
      color: gunGlowColor,
      emissive: gunGlowColor,
      emissiveIntensity: 2.2
    });

    if (gun.userData.core) {
      gun.userData.core.material = glowCoreMat;
      if (isLeft) this.leftGunCore = gun.userData.core;
      else this.rightGunCore = gun.userData.core;
    }
    if (gun.userData.ring) {
      gun.userData.ring.material = glowRingMat;
      if (isLeft) this.leftGunRing = gun.userData.ring;
      else this.rightGunRing = gun.userData.ring;
    }

    headGroup.add(gun);
    inner.add(headGroup);

    // Center the origin exactly around the portal gun barrel height (Y ~ 1.26)
    inner.position.set(0, -1.26, 0);

    root.add(inner);
    root.scale.set(0.52, 0.52, 0.52);

    // Orientation:
    // Left model rotates -PI/2 to point down +X (towards the right)
    // Right model rotates +PI/2 to point down -X (towards the left)
    root.rotation.y = isLeft ? -Math.PI / 2 : Math.PI / 2;

    root.userData = { headGroup, gun, isLeft };
    return root;
  }

  /**
   * Set the target menu element that the decorators should frame.
   * @param {HTMLElement} el
   */
  setTarget(el) {
    this.activeElement = el;
    this.updateTarget();
    requestAnimationFrame(() => this.updateTarget());
  }

  /**
   * Recalculate 3D target coordinates from the active DOM element bounding rect.
   */
  updateTarget() {
    if (!this.canvas || !this.activeElement || !this.camera) return;

    const canvasRect = this.canvas.getBoundingClientRect();
    const elRect = this.activeElement.getBoundingClientRect();

    if (canvasRect.height <= 0 || canvasRect.width <= 0) return;
    if (elRect.width <= 10 || elRect.height <= 5) {
      requestAnimationFrame(() => this.updateTarget());
      return;
    }

    const visibleHeight = 2 * this.camera.position.z * Math.tan((this.camera.fov * Math.PI) / 360);
    const visibleWidth = visibleHeight * (canvasRect.width / canvasRect.height);

    const elCenterY = (elRect.top + elRect.bottom) / 2 - canvasRect.top;
    const canvasCenterY = canvasRect.height / 2;
    this.targetY = (canvasCenterY - elCenterY) * (visibleHeight / canvasRect.height);

    const elLeft = elRect.left - canvasRect.left;
    const elRight = elRect.right - canvasRect.left;
    const canvasCenterX = canvasRect.width / 2;

    const pxToWorld = visibleWidth / canvasRect.width;
    const buttonLeft3D = (elLeft - canvasCenterX) * pxToWorld;
    const buttonRight3D = (elRight - canvasCenterX) * pxToWorld;

    // The portal gun extends ~0.48 world units towards the button from the model origin
    const gunTipOffset = 0.48;

    // Responsive padding between the portal gun tip and the button boundary (~26px in screen space)
    const padding3D = Math.max(0.26, 26 * pxToWorld);

    // Frame the button dynamically based on its actual width
    this.targetLeftX = buttonLeft3D - gunTipOffset - padding3D;
    this.targetRightX = buttonRight3D + gunTipOffset + padding3D;
  }

  /**
   * Handle canvas resize.
   */
  resize() {
    if (!this.canvas || !this.renderer || !this.camera) return;
    const width = this.canvas.clientWidth || 720;
    const height = this.canvas.clientHeight || 500;

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.updateTarget();
  }

  /**
   * Start rendering animation loop.
   */
  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.resize();

    // Snap initially to avoid huge lerp jump on first show
    if (this.activeElement) {
      this.updateTarget();
      this.currentY = this.targetY;
      this.currentLeftX = this.targetLeftX;
      this.currentRightX = this.targetRightX;
    }

    const animate = () => {
      if (!this.isRunning) return;
      this._renderFrame();
      this.rafId = requestAnimationFrame(animate);
    };
    this.rafId = requestAnimationFrame(animate);
  }

  /**
   * Stop rendering animation loop.
   */
  stop() {
    this.isRunning = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Render a single frame with subtle animations.
   * @private
   */
  _renderFrame() {
    if (!this.renderer || !this.scene || !this.camera) return;

    const t = performance.now() * 0.001;

    // Continuously maintain target tracking in case of scroll or reflow
    this.updateTarget();

    // Smooth position interpolation
    const prevY = this.currentY;
    this.currentY += (this.targetY - this.currentY) * 0.22;
    this.currentLeftX += (this.targetLeftX - this.currentLeftX) * 0.22;
    this.currentRightX += (this.targetRightX - this.currentRightX) * 0.22;

    const movingSpeed = Math.abs(this.currentY - prevY);
    // Walking footsteps modulation when traveling between options
    const walkStepL = Math.sin(t * 18.0) * Math.min(0.06, movingSpeed * 1.5);
    const walkStepR = Math.sin(t * 18.0 + Math.PI) * Math.min(0.06, movingSpeed * 1.5);
    const walkTiltL = Math.sin(t * 16.0) * Math.min(0.04, movingSpeed * 1.2);
    const walkTiltR = -Math.sin(t * 16.0) * Math.min(0.04, movingSpeed * 1.2);

    // Subtle breathing / vertical bobbing when standing, combined with walking footsteps
    const bobL = Math.sin(t * 2.8) * 0.035 + walkStepL;
    const bobR = Math.sin(t * 2.8 + 1.3) * 0.035 + walkStepR;

    if (this.leftModel) {
      this.leftModel.position.set(this.currentLeftX, this.currentY + bobL, 0);
      this.leftModel.rotation.z = walkTiltL;
      const head = this.leftModel.userData.headGroup;
      if (head) {
        head.rotation.x = Math.sin(t * 1.8) * 0.02;
        head.rotation.z = Math.cos(t * 1.5) * 0.02;
      }
    }

    if (this.rightModel) {
      this.rightModel.position.set(this.currentRightX, this.currentY + bobR, 0);
      this.rightModel.rotation.z = walkTiltR;
      const head = this.rightModel.userData.headGroup;
      if (head) {
        head.rotation.x = Math.sin(t * 1.8 + 1.2) * 0.02;
        head.rotation.z = Math.cos(t * 1.5 + 1.2) * 0.02;
      }
    }

    // Pulsing portal gun light cores
    const pulseL = 2.0 + Math.sin(t * 4.0) * 0.7;
    const pulseR = 2.0 + Math.sin(t * 4.0 + 1.8) * 0.7;
    if (this.leftGunCore?.material) this.leftGunCore.material.emissiveIntensity = pulseL;
    if (this.leftGunRing?.material) this.leftGunRing.material.emissiveIntensity = pulseL;
    if (this.rightGunCore?.material) this.rightGunCore.material.emissiveIntensity = pulseR;
    if (this.rightGunRing?.material) this.rightGunRing.material.emissiveIntensity = pulseR;

    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Release WebGL resources.
   */
  dispose() {
    this.stop();
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer = null;
    }
  }
}
