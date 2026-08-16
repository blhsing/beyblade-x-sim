// Mode A stadium anchoring with a table-calibration model:
//
// Calibration pose (on enable + every recalibrate): the phone LIES FLAT on
// the table, face up, and the virtual stadium is assumed to sit ON the table
// just beyond the phone's TOP edge. Pick the phone up and angle it toward
// that spot on the table → the stadium is there, fixed in physical space
// (rotationally tracked; translation is an assumed hold position since 3DOF
// sensors cannot measure it — WebXR/ARKit upgrade comes later).
//
// Frames: W = world (stadium center at origin, Z up, +Y = from the phone's
// lying spot toward the stadium). F = deviceorientation's Y-up frame.

import * as THREE from "three";

/** stadium-center distance from the phone's lying position (m) */
const TABLE_DISTANCE = 0.35;
/** assumed hand-held camera position in W once the phone is picked up */
const HOLD_POS = new THREE.Vector3(0, -TABLE_DISTANCE - 0.05, 0.36);

const EULER_ORDER = "YXZ";
const Q_SCREEN_TILT = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° X
const Q_SWAP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // F(Y-up)→W(Z-up)

export class GyroCamera {
  available = false;
  active = false;
  private qF = new THREE.Quaternion(); // camera orientation in F
  private qAlign: THREE.Quaternion | null = null;
  private wantCalibrate = true;
  private euler = new THREE.Euler();
  private onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);

  /**
   * Must be called from a user gesture (iOS permission prompt). Safe to call
   * repeatedly — resolves true when sensors stream.
   */
  async enable(): Promise<boolean> {
    if (this.active) return true;
    const D = DeviceOrientationEvent as unknown as {
      requestPermission?: () => Promise<string>;
    };
    try {
      if (typeof D.requestPermission === "function") {
        if ((await D.requestPermission()) !== "granted") return false;
      }
    } catch {
      return false;
    }
    window.addEventListener("deviceorientation", this.onOrient, true);
    window.addEventListener("devicemotion", this.onMotion, true);
    this.active = true;
    this.wantCalibrate = true;
    // wait briefly for a first sample so callers know sensors really exist
    await new Promise((r) => setTimeout(r, 350));
    return this.available;
  }

  disable(): void {
    window.removeEventListener("deviceorientation", this.onOrient, true);
    window.removeEventListener("devicemotion", this.onMotion, true);
    this.active = false;
  }

  /** Call with the phone lying flat on the table, stadium beyond top edge. */
  recenter(): void {
    this.wantCalibrate = true;
  }

  private handleOrient(e: DeviceOrientationEvent): void {
    if (e.alpha === null || e.beta === null || e.gamma === null) return;
    this.available = true;
    const deg = Math.PI / 180;
    this.euler.set(e.beta * deg, e.alpha * deg, -e.gamma * deg, EULER_ORDER);
    this.qF.setFromEuler(this.euler);
    this.qF.multiply(Q_SCREEN_TILT);
    const orient = (screen.orientation?.angle ?? 0) * deg;
    this.qF.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -orient));
    if (this.wantCalibrate) {
      this.wantCalibrate = false;
      // device top edge (= camera up) direction in F, projected horizontal
      const top = new THREE.Vector3(0, 1, 0).applyQuaternion(this.qF);
      top.y = 0;
      if (top.lengthSq() < 1e-6) top.set(0, 0, -1);
      top.normalize();
      const yawF = Math.atan2(top.x, -top.z); // angle from -Z toward +X
      const qYaw = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yawF);
      this.qAlign = Q_SWAP.clone().multiply(qYaw);
      this.vel.set(0, 0, 0);
      this.off.set(0, 0, 0);
    }
  }

  /**
   * Translation from the accelerometer (leaky double-integration in the
   * WORLD frame, bounded + recentering): physically raising the phone lifts
   * the viewpoint toward an overhead look, lowering or side-stepping gives
   * low/side angles. Gyro still owns rotation, so aim stays anchored.
   */
  private vel = new THREE.Vector3();
  private off = new THREE.Vector3();

  private handleMotion(e: DeviceMotionEvent): void {
    const a = e.acceleration;
    if (!a || a.x === null || !this.qAlign) return;
    const dt = Math.min(0.1, (e.interval ?? 16) / 1000);
    const worldQ = this.qAlign.clone().multiply(this.qF);
    const acc = new THREE.Vector3(a.x ?? 0, a.y ?? 0, a.z ?? 0).applyQuaternion(worldQ);
    this.vel.addScaledVector(acc, dt).multiplyScalar(0.9);
    this.off.addScaledVector(this.vel, dt).multiplyScalar(0.982);
    this.off.x = Math.max(-0.35, Math.min(0.35, this.off.x));
    this.off.y = Math.max(-0.3, Math.min(0.25, this.off.y));
    this.off.z = Math.max(-0.14, Math.min(0.5, this.off.z));
  }

  /** Applies the anchored pose to the camera (stadium is at the origin). */
  apply(camera: THREE.PerspectiveCamera): void {
    if (!this.active || !this.qAlign) return;
    camera.quaternion.copy(this.qAlign).multiply(this.qF);
    camera.position.copy(HOLD_POS).add(this.off);
  }
}

export const gyro = new GyroCamera();
