import * as THREE from "three";

import { POCKET_DWELL_TICKS, STOP_DWELL_TICKS } from "../core/sim";

export interface StopTopplePose {
  progress: number;
  angleRad: number;
  tipPivotLiftM: number;
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

/** Deterministic zero-spin settling pose driven by the same core dwell that
 * awards a Spin Finish. At the finish tick the Bey is already on its side. */
export function stopTopplePose(stopDwell: number, radiusM: number): StopTopplePose {
  const raw = Number.isFinite(stopDwell) ? stopDwell / STOP_DWELL_TICKS : 0;
  const progress = Math.max(0, Math.min(1, raw));
  const smooth = progress * progress * (3 - 2 * progress);
  const angleRad = smooth * Math.PI / 2;
  return {
    progress,
    angleRad,
    tipPivotLiftM: Math.max(0, radiusM) * Math.sin(angleRad),
  };
}

export function applyStopTopplePose(
  bey: THREE.Object3D,
  stopDwell: number,
  radiusM: number,
  visualSpin: number,
  surfaceHeight: number,
): StopTopplePose {
  const pose = stopTopplePose(stopDwell, radiusM);
  bey.rotation.set(pose.angleRad, 0, visualSpin);
  bey.position.z = surfaceHeight + pose.tipPivotLiftM;
  return pose;
}
