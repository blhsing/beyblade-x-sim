import { surfaceZ, type StadiumSpec } from "../core/stadium";

export interface OrbitFitOptions {
  fovDeg?: number;
  yaw?: number;
  pitch?: number;
  targetZ?: number;
  margin?: number;
  minimumDistance?: number;
}

/**
 * Return the camera distance needed to keep the complete stadium shell in a
 * perspective orbit view. The calculation projects all eight corners of the
 * product's authored 3-D bounds into the camera's right/up/forward basis, so
 * narrow portrait viewports are handled without a device-specific constant.
 */
export function stadiumOrbitFitDistance(
  stadium: StadiumSpec,
  aspect: number,
  options: OrbitFitOptions = {},
): number {
  const fovDeg = options.fovDeg ?? 55;
  const yaw = options.yaw ?? -Math.PI / 2;
  const pitch = options.pitch ?? 0.9;
  const targetZ = options.targetZ ?? 0.02;
  const minimumDistance = options.minimumDistance ?? 0.56;
  const safeAspect = Math.max(0.1, Number.isFinite(aspect) ? aspect : 1);
  // Narrow phone views need a visibly clear edge around the transparent shell;
  // otherwise refraction and rounded outer flanges read as being cropped even
  // when their mathematical bounding corners land exactly on-screen.
  const margin = options.margin ?? (safeAspect < 0.75 ? 1.2 : 1.07);
  const tanHalfVertical = Math.tan(fovDeg * Math.PI / 360);
  const tanHalfHorizontal = tanHalfVertical * safeAspect;

  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const right = { x: -sinYaw, y: cosYaw, z: 0 };
  const up = {
    x: -cosYaw * sinPitch,
    y: -sinYaw * sinPitch,
    z: cosPitch,
  };
  const forward = {
    x: -cosYaw * cosPitch,
    y: -sinYaw * cosPitch,
    z: -sinPitch,
  };

  const halfW = stadium.deckW * 0.5;
  const halfH = stadium.deckH * 0.5;
  const topZ = surfaceZ(stadium, stadium.rWall) + stadium.coverHeight;
  let required = minimumDistance;
  for (const x of [-halfW, halfW]) {
    for (const y of [-halfH, halfH]) {
      for (const z of [0, topZ]) {
        const dz = z - targetZ;
        const cameraX = x * right.x + y * right.y + dz * right.z;
        const cameraY = x * up.x + y * up.y + dz * up.z;
        const depthOffset = x * forward.x + y * forward.y + dz * forward.z;
        required = Math.max(
          required,
          margin * Math.abs(cameraX) / tanHalfHorizontal - depthOffset,
          margin * Math.abs(cameraY) / tanHalfVertical - depthOffset,
        );
      }
    }
  }
  return required;
}
