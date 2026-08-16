// Phone-anchored stadium view.
//
// The goal is that the stadium behaves like a real object sitting on the
// table: it stays in one physical place, and *moving the phone* — turning it,
// lifting it, leaning left — changes your viewpoint of it, with parallax.
//
// Calibration pose (on enable + every recalibrate): the phone LIES FLAT on
// the table, face up, and the stadium is assumed to sit ON the table just
// beyond the phone's TOP edge. Pick the phone up and aim it at that spot and
// the stadium is there.
//
// Rotation comes from `deviceorientation` and is exact. Translation is the
// hard part: 3DOF sensors cannot measure position, so we estimate it by
// double-integrating linear acceleration in the world frame. Naive double
// integration drifts within a second, so this does what pedestrian dead
// reckoning does:
//
//   · gravity is removed with a low-pass estimator when the platform only
//     gives us `accelerationIncludingGravity` (most Android browsers),
//   · a zero-velocity update (ZUPT) snaps velocity to zero whenever the
//     phone is held still, which is what actually kills drift,
//   · leak is *adaptive*: nearly absent while you are moving (so a real
//     30 cm lean shows as a 30 cm viewpoint change) and strong once you
//     settle (so accumulated error decays instead of parking the view off
//     to one side),
//   · excursion is bounded to arm's reach so a bad sample can never throw
//     the stadium off screen.
//
// Frames: W = world (stadium centre at origin, Z up, +Y from the phone's
// resting spot toward the stadium). F = deviceorientation's Y-up frame.

import * as THREE from "three";

/** stadium-centre distance from the phone's resting position (m) */
const TABLE_DISTANCE = 0.35;
/** assumed hand-held camera position in W once the phone is picked up */
const HOLD_POS = new THREE.Vector3(0, -TABLE_DISTANCE - 0.05, 0.36);

const EULER_ORDER = "YXZ";
const Q_SCREEN_TILT = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2); // -90° X
const Q_SWAP = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // F(Y-up)→W(Z-up)

/** movement envelope (m): about as far as you can move a phone while seated */
const LIMIT = new THREE.Vector3(0.45, 0.4, 0.55);
/** |a| below this (m/s²) counts as "not moving" for the ZUPT */
const STILL_ACCEL = 0.16;
/** consecutive still samples before velocity is zeroed */
const STILL_SAMPLES = 9;

export class GyroCamera {
  available = false;
  active = false;
  /** true once translation tracking has a usable acceleration source */
  positional = false;

  private qF = new THREE.Quaternion(); // camera orientation in F
  private qAlign: THREE.Quaternion | null = null;
  private wantCalibrate = true;
  private euler = new THREE.Euler();
  private onOrient = (e: DeviceOrientationEvent): void => this.handleOrient(e);
  private onMotion = (e: DeviceMotionEvent): void => this.handleMotion(e);

  // translation estimator state
  private vel = new THREE.Vector3();
  private off = new THREE.Vector3();
  private gravity = new THREE.Vector3(); // low-passed, device frame
  private gravityInit = false;
  private stillCount = 0;
  private smooth = new THREE.Vector3(); // render-side smoothing of `off`

  /**
   * Must be called from a user gesture (iOS permission prompt). Safe to call
   * repeatedly — resolves true when sensors stream.
   */
  async enable(): Promise<boolean> {
    if (this.active) return true;
    const D = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    const M = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof D.requestPermission === "function") {
        if ((await D.requestPermission()) !== "granted") return false;
      }
      if (typeof M.requestPermission === "function") {
        // motion is a separate grant on iOS; without it we lose parallax but
        // rotation anchoring still works, so a refusal is not fatal
        await M.requestPermission().catch(() => "denied");
      }
    } catch {
      return false;
    }
    window.addEventListener("deviceorientation", this.onOrient, true);
    window.addEventListener("devicemotion", this.onMotion, true);
    this.active = true;
    this.wantCalibrate = true;
    await new Promise((r) => setTimeout(r, 350)); // wait for a first sample
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
      this.smooth.set(0, 0, 0);
      this.gravityInit = false;
      this.stillCount = 0;
    }
  }

  /** Linear acceleration in the DEVICE frame, gravity removed. */
  private linearAccel(e: DeviceMotionEvent, dt: number): THREE.Vector3 | null {
    const a = e.acceleration;
    if (a && (a.x !== null || a.y !== null || a.z !== null)) {
      this.positional = true;
      return new THREE.Vector3(a.x ?? 0, a.y ?? 0, a.z ?? 0);
    }
    // fall back to raw accelerometer: low-pass to estimate gravity, subtract
    const g = e.accelerationIncludingGravity;
    if (!g || (g.x === null && g.y === null && g.z === null)) return null;
    const raw = new THREE.Vector3(g.x ?? 0, g.y ?? 0, g.z ?? 0);
    if (!this.gravityInit) {
      this.gravity.copy(raw);
      this.gravityInit = true;
      return new THREE.Vector3();
    }
    // ~0.5 s time constant: slow enough to pass real motion, fast enough to
    // track the phone being reoriented
    const k = Math.min(1, dt / 0.5);
    this.gravity.lerp(raw, k);
    this.positional = true;
    return raw.clone().sub(this.gravity);
  }

  private handleMotion(e: DeviceMotionEvent): void {
    if (!this.qAlign) return;
    const dt = Math.min(0.1, (e.interval ?? 16) / 1000);
    const accDevice = this.linearAccel(e, dt);
    if (!accDevice) return;

    // zero-velocity update: while the phone is effectively still, kill the
    // velocity outright. This is what stops double-integration drift.
    if (accDevice.length() < STILL_ACCEL) {
      if (++this.stillCount >= STILL_SAMPLES) {
        this.vel.multiplyScalar(0.35);
        this.off.multiplyScalar(0.985); // ease back toward the anchor pose
      }
    } else {
      this.stillCount = 0;
    }

    const worldQ = this.qAlign.clone().multiply(this.qF);
    const acc = accDevice.applyQuaternion(worldQ);
    // deadband so sensor noise never integrates into a slow crawl
    if (acc.length() < 0.05) acc.set(0, 0, 0);

    this.vel.addScaledVector(acc, dt);
    // light damping only while moving, so a real lean reads at full scale
    this.vel.multiplyScalar(this.stillCount > 0 ? 0.86 : 0.985);
    this.off.addScaledVector(this.vel, dt);

    // bound the excursion, and bleed velocity when we hit the wall so the
    // estimate does not keep pushing against the limit
    for (const axis of ["x", "y", "z"] as const) {
      const lim = LIMIT[axis];
      if (Math.abs(this.off[axis]) > lim) {
        this.off[axis] = Math.sign(this.off[axis]) * lim;
        this.vel[axis] *= 0.2;
      }
    }
  }

  /** Applies the anchored pose to the camera (stadium is at the origin). */
  apply(camera: THREE.PerspectiveCamera): void {
    if (!this.active || !this.qAlign) return;
    camera.quaternion.copy(this.qAlign).multiply(this.qF);
    // smooth the estimated offset for presentation only — the estimate
    // itself stays raw so it never lags behind a real movement
    this.smooth.lerp(this.off, 0.25);
    camera.position.copy(HOLD_POS).add(this.smooth);
  }
}

export const gyro = new GyroCamera();
