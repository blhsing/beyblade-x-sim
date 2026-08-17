import * as THREE from "three";

import { POCKET_DWELL_TICKS, STOP_DWELL_TICKS } from "../core/sim";

export interface StopTopplePose {
  progress: number;
  angleRad: number;
  tipPivotLiftM: number;
}

/** Below ~525 rpm an X Bey no longer has enough gyroscopic stiffness to stay
 * upright. It visibly precesses and leans before its spin reaches exact zero. */
export const BALANCE_LOSS_OMEGA = 55;
/** Once exact zero is reached, gravity completes the fall in 0.2 s; scoring
 * still waits for the core's full 0.6 s settled confirmation. */
export const ZERO_SPIN_TOPPLE_TICKS = 48;
const ZERO_SPIN_ENTRY_ANGLE = THREE.MathUtils.degToRad(50);
const RIM_CONTACT_ANGLE = THREE.MathUtils.degToRad(38);

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function smooth01(value: number): number {
  const x = clamp01(value);
  return x * x * (3 - 2 * x);
}

/** Once a zero-spin Bey has begun falling it cannot spring upright merely
 * because a same-tick collision resets the authoritative settle dwell. */
export function persistentStopToppleDwell(
  previousDwell: number,
  authoritativeDwell: number,
): number {
  const previous = Number.isFinite(previousDwell) ? Math.max(0, previousDwell) : 0;
  const current = Number.isFinite(authoritativeDwell) ? Math.max(0, authoritativeDwell) : 0;
  return Math.min(STOP_DWELL_TICKS, Math.max(previous, current));
}

/** Pocket scoring has a shorter confirmation dwell, but the visible zero-spin
 * fall still needs to reach the same physically side-resting terminal pose. */
export function pocketToppleDwell(pocketDwell: number): number {
  const dwell = Number.isFinite(pocketDwell) ? Math.max(0, pocketDwell) : 0;
  return Math.min(STOP_DWELL_TICKS, dwell * STOP_DWELL_TICKS / POCKET_DWELL_TICKS);
}

/** Unified deterministic balance pose. Low non-zero spin grows into a broad
 * precession cone; the exact-zero dwell continues from that same angle rather
 * than snapping upright and starting a delayed cosmetic fall. */
export function balanceTopplePose(
  absoluteOmega: number,
  stopDwell: number,
  radiusM: number,
): StopTopplePose {
  const omega = Number.isFinite(absoluteOmega) ? Math.max(0, absoluteOmega) : BALANCE_LOSS_OMEGA;
  const balanceLoss = smooth01(1 - omega / BALANCE_LOSS_OMEGA);
  const preZeroAngle = balanceLoss * ZERO_SPIN_ENTRY_ANGLE;
  const zeroFall = omega === 0
    ? smooth01(stopDwell / ZERO_SPIN_TOPPLE_TICKS)
    : 0;
  const angleRad = preZeroAngle + (Math.PI / 2 - preZeroAngle) * zeroFall;
  const rimContact = smooth01(
    (angleRad - RIM_CONTACT_ANGLE) / (Math.PI / 2 - RIM_CONTACT_ANGLE),
  );
  return {
    progress: angleRad / (Math.PI / 2),
    angleRad,
    // The top pivots about its Bit until the Blade rim touches. Only then does
    // the tip lift as load transfers to the rim, reaching one radius on-side.
    tipPivotLiftM: Math.max(0, radiusM) * rimContact,
  };
}

/** Exact-zero convenience retained for callers/tests. */
export function stopTopplePose(stopDwell: number, radiusM: number): StopTopplePose {
  return balanceTopplePose(0, stopDwell, radiusM);
}

export function applyBalanceTopplePose(
  bey: THREE.Object3D,
  absoluteOmega: number,
  stopDwell: number,
  radiusM: number,
  precessionPhase: number,
  surfaceHeight: number,
): StopTopplePose {
  const pose = balanceTopplePose(absoluteOmega, stopDwell, radiusM);
  bey.rotation.set(pose.angleRad, 0, precessionPhase);
  bey.position.z = surfaceHeight + pose.tipPivotLiftM;
  return pose;
}

export function applyStopTopplePose(
  bey: THREE.Object3D,
  stopDwell: number,
  radiusM: number,
  visualSpin: number,
  surfaceHeight: number,
): StopTopplePose {
  return applyBalanceTopplePose(
    bey,
    0,
    stopDwell,
    radiusM,
    visualSpin,
    surfaceHeight,
  );
}
