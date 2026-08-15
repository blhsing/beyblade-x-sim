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
const TABLE_DISTANCE = 0.32;
/** assumed hand-held camera position in W once the phone is picked up */
const HOLD_POS = new THREE.Vector3(0, -TABLE_DISTANCE - 0.05, 0.34);

const EULER_ORDER = "YXZ";
const Q_SCREEN_TILT = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° X
const Q_SWAP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // F(Y-up)→W(Z-up)

export class GyroCamera {
  available = false;
  active = false;
  private qF = new THREE.Quaternion(); // camera orientation in F
  private qAlign: THREE.Quaternion | null = null;
  private wantCalibrate = true;
  private parallax = new THREE.Vector3();
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
      this.parallax.set(0, 0, 0);
    }
  }

  private handleMotion(e: DeviceMotionEvent): void {
    const a = e.acceleration;
    if (!a || a.x === null) return;
    const k = 0.0016;
    this.parallax.x = this.parallax.x * 0.92 - (a.x ?? 0) * k;
    this.parallax.y = this.parallax.y * 0.92 - (a.y ?? 0) * k;
    this.parallax.z = this.parallax.z * 0.92 - (a.z ?? 0) * k;
  }

  /** Applies the anchored pose to the camera (stadium is at the origin). */
  apply(camera: THREE.PerspectiveCamera): void {
    if (!this.active || !this.qAlign) return;
    camera.quaternion.copy(this.qAlign).multiply(this.qF);
    camera.position.copy(HOLD_POS).add(this.parallax);
  }
}

export const gyro = new GyroCamera();
