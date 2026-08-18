import { describe, expect, it } from "vitest";

import { STADIUM_BX10, STADIUM_BX32, surfaceZ, type StadiumSpec } from "../src/core/stadium";
import { stadiumOrbitFitDistance } from "../src/render/camera-fit";

function projectedBounds(stadium: StadiumSpec, aspect: number, distance: number) {
  const yaw = -Math.PI / 2;
  const pitch = 0.9;
  const targetZ = 0.02;
  const tanV = Math.tan(55 * Math.PI / 360);
  const tanH = tanV * aspect;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const right = { x: -sy, y: cy, z: 0 };
  const up = { x: -cy * sp, y: -sy * sp, z: cp };
  const forward = { x: -cy * cp, y: -sy * cp, z: -sp };
  const top = surfaceZ(stadium, stadium.rWall) + stadium.coverHeight;
  let maxX = 0;
  let maxY = 0;
  for (const x of [-stadium.deckW / 2, stadium.deckW / 2]) {
    for (const y of [-stadium.deckH / 2, stadium.deckH / 2]) {
      for (const z of [0, top]) {
        const dz = z - targetZ;
        const depth = distance + x * forward.x + y * forward.y + dz * forward.z;
        maxX = Math.max(maxX, Math.abs(x * right.x + y * right.y) / (depth * tanH));
        maxY = Math.max(maxY, Math.abs(x * up.x + y * up.y + dz * up.z) / (depth * tanV));
      }
    }
  }
  return { maxX, maxY };
}

describe("responsive stadium orbit framing", () => {
  it.each([STADIUM_BX10, STADIUM_BX32])("fits the complete %s shell in a 390x844 portrait view", (stadium) => {
    const aspect = 390 / 844;
    const distance = stadiumOrbitFitDistance(stadium, aspect);
    const bounds = projectedBounds(stadium, aspect, distance);
    expect(bounds.maxX).toBeLessThanOrEqual(1 / 1.2 + 1e-10);
    expect(bounds.maxY).toBeLessThanOrEqual(1 / 1.2 + 1e-10);
    expect(distance).toBeGreaterThan(1);
  });

  it("pulls the wider BX-32 farther back without shrinking normal landscape framing", () => {
    const portrait = 390 / 844;
    expect(stadiumOrbitFitDistance(STADIUM_BX32, portrait))
      .toBeGreaterThan(stadiumOrbitFitDistance(STADIUM_BX10, portrait));
    expect(stadiumOrbitFitDistance(STADIUM_BX10, 16 / 9)).toBeCloseTo(0.56, 8);
    expect(stadiumOrbitFitDistance(STADIUM_BX32, 16 / 9)).toBeLessThan(0.7);
  });
});
