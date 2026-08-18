import {
  stadiumBodyRadiusAt,
  stadiumBoundaryRadiusAt,
  surfaceZ,
  type StadiumSpec,
} from "../core/stadium";

export interface OrbitFitOptions {
  fovDeg?: number;
  yaw?: number;
  pitch?: number;
  targetZ?: number;
  margin?: number;
  minimumDistance?: number;
}

export interface StadiumFramingPoint {
  x: number;
  y: number;
  z: number;
}

export interface StadiumProjectedBounds {
  maxX: number;
  maxY: number;
}

/**
 * Compact silhouette of the actual authored product, rather than the eight
 * impossible corners of its rectangular shipping dimensions. The rings
 * match createCasing(): outer flange, two canopy shoulders and the launch
 * aperture. A dense polar sample makes the portrait fit tight even for the
 * BX-32 superellipse while remaining cheap enough to recompute on rotation.
 */
export function stadiumFramingPoints(
  stadium: StadiumSpec,
  angularSamples = 720,
): StadiumFramingPoint[] {
  const points: StadiumFramingPoint[] = [];
  const rimZ = surfaceZ(stadium, stadium.rWall);
  const topZ = rimZ + stadium.coverHeight;
  const apertureScale = stadium.name === "wide" ? 0.7 : 0.69;
  const samples = Math.max(64, Math.round(angularSamples));

  for (let sample = 0; sample < samples; sample++) {
    const theta = sample / samples * Math.PI * 2;
    const c = Math.cos(theta);
    const sn = Math.sin(theta);
    const body = stadiumBodyRadiusAt(stadium, theta);
    const wall = stadiumBoundaryRadiusAt(stadium, theta);
    const aperture = wall * apertureScale;
    const rings = [
      // Full body radius deliberately includes the outer lip's 1.2 mm safety
      // envelope and the opaque product base beneath it.
      { radius: body, z: 0 },
      { radius: body, z: rimZ + 0.012 },
      { radius: wall + (body - wall) * 0.58, z: rimZ + stadium.coverHeight * 0.3 },
      { radius: aperture + (wall - aperture) * 0.38, z: rimZ + stadium.coverHeight * 0.72 },
      // The rolled launch lip extends 3.2 mm outside the opening curve.
      { radius: aperture + 0.0032, z: topZ },
    ];
    for (const ring of rings) {
      points.push({ x: c * ring.radius, y: sn * ring.radius, z: ring.z });
    }
  }
  return points;
}

function cameraBasis(options: OrbitFitOptions): {
  right: StadiumFramingPoint;
  up: StadiumFramingPoint;
  forward: StadiumFramingPoint;
  targetZ: number;
} {
  const yaw = options.yaw ?? -Math.PI / 2;
  const pitch = options.pitch ?? 0.9;
  const targetZ = options.targetZ ?? 0.02;
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  return {
    right: { x: -sinYaw, y: cosYaw, z: 0 },
    up: {
      x: -cosYaw * sinPitch,
      y: -sinYaw * sinPitch,
      z: cosPitch,
    },
    // Camera-space forward: from the camera back toward the orbit target.
    forward: {
      x: -cosYaw * cosPitch,
      y: -sinYaw * cosPitch,
      z: -sinPitch,
    },
    targetZ,
  };
}

export function stadiumProjectedBounds(
  stadium: StadiumSpec,
  aspect: number,
  distance: number,
  options: OrbitFitOptions = {},
): StadiumProjectedBounds {
  const safeAspect = Math.max(0.1, Number.isFinite(aspect) ? aspect : 1);
  const fovDeg = options.fovDeg ?? 55;
  const tanHalfVertical = Math.tan(fovDeg * Math.PI / 360);
  const tanHalfHorizontal = tanHalfVertical * safeAspect;
  const { right, up, forward, targetZ } = cameraBasis(options);
  let maxX = 0;
  let maxY = 0;
  for (const point of stadiumFramingPoints(stadium)) {
    const dz = point.z - targetZ;
    const depth = distance + point.x * forward.x + point.y * forward.y + dz * forward.z;
    if (depth <= 1e-6) return { maxX: Infinity, maxY: Infinity };
    const x = point.x * right.x + point.y * right.y + dz * right.z;
    const y = point.x * up.x + point.y * up.y + dz * up.z;
    maxX = Math.max(maxX, Math.abs(x) / (depth * tanHalfHorizontal));
    maxY = Math.max(maxY, Math.abs(y) / (depth * tanHalfVertical));
  }
  return { maxX, maxY };
}

/**
 * Tight distance for the actual shell silhouette at the requested initial
 * perspective. A 3% guard is enough for antialiasing/refraction (roughly six
 * portrait pixels) without reducing a 390 px stadium to a small object.
 */
export function stadiumOrbitFitDistance(
  stadium: StadiumSpec,
  aspect: number,
  options: OrbitFitOptions = {},
): number {
  const fovDeg = options.fovDeg ?? 55;
  const safeAspect = Math.max(0.1, Number.isFinite(aspect) ? aspect : 1);
  const margin = options.margin ?? 1.03;
  const minimumDistance = options.minimumDistance ?? 0.1;
  const tanHalfVertical = Math.tan(fovDeg * Math.PI / 360);
  const tanHalfHorizontal = tanHalfVertical * safeAspect;
  const { right, up, forward, targetZ } = cameraBasis(options);
  let required = minimumDistance;
  for (const point of stadiumFramingPoints(stadium)) {
    const dz = point.z - targetZ;
    const cameraX = point.x * right.x + point.y * right.y + dz * right.z;
    const cameraY = point.x * up.x + point.y * up.y + dz * up.z;
    const depthOffset = point.x * forward.x + point.y * forward.y + dz * forward.z;
    required = Math.max(
      required,
      margin * Math.abs(cameraX) / tanHalfHorizontal - depthOffset,
      margin * Math.abs(cameraY) / tanHalfVertical - depthOffset,
    );
  }
  return required;
}
