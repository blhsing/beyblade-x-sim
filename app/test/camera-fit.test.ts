import { describe, expect, it } from "vitest";

import { STADIUM_BX10, STADIUM_BX32 } from "../src/core/stadium";
import {
  stadiumOrbitFitDistance,
  stadiumProjectedBounds,
  type OrbitFitOptions,
} from "../src/render/camera-fit";
import {
  GYRO_HOLD_Y,
  GYRO_HOLD_Z,
  framedGyroHoldPosition,
} from "../src/sensors/gyro";

const ORBIT: OrbitFitOptions = {
  yaw: -Math.PI / 2,
  pitch: 0.9,
  targetZ: 0.02,
};
const GYRO: OrbitFitOptions = {
  yaw: -Math.PI / 2,
  pitch: Math.atan2(GYRO_HOLD_Z - 0.02, -GYRO_HOLD_Y),
  targetZ: 0.02,
};
const VIEWS = [
  ["portrait", 390 / 844],
  ["landscape", 844 / 390],
] as const;

describe("responsive stadium camera framing", () => {
  it.each([STADIUM_BX10, STADIUM_BX32])(
    "fits the complete $name shell tightly in fixed and dynamic views",
    (stadium) => {
      for (const [, aspect] of VIEWS) {
        for (const options of [ORBIT, GYRO]) {
          const distance = stadiumOrbitFitDistance(stadium, aspect, options);
          const bounds = stadiumProjectedBounds(stadium, aspect, distance, options);
          const limitingAxis = Math.max(bounds.maxX, bounds.maxY);

          // Keep only a 3% antialias/refraction guard around the actual shell,
          // rather than shrinking it to fit an impossible shipping-box corner.
          expect(bounds.maxX).toBeLessThanOrEqual(1 / 1.03 + 1e-10);
          expect(bounds.maxY).toBeLessThanOrEqual(1 / 1.03 + 1e-10);
          expect(limitingAxis).toBeGreaterThan(0.969);

          // Pulling this carefully fitted camera just 3% closer must clip.
          const tooClose = stadiumProjectedBounds(stadium, aspect, distance * 0.97, options);
          expect(Math.max(tooClose.maxX, tooClose.maxY)).toBeGreaterThan(1);
        }
      }
    },
  );

  it("keeps the dynamic camera on its calibrated ray at the fitted distance", () => {
    const distance = stadiumOrbitFitDistance(STADIUM_BX32, 390 / 844, GYRO);
    const position = framedGyroHoldPosition(distance, 0.02);
    const relative = position.clone();
    relative.z -= 0.02;

    expect(relative.length()).toBeCloseTo(distance, 10);
    expect(relative.x).toBeCloseTo(0, 12);
    expect(relative.z / -relative.y).toBeCloseTo((GYRO_HOLD_Z - 0.02) / -GYRO_HOLD_Y, 10);
  });
});
