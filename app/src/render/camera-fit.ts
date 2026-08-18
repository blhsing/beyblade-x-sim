import {
  pocketBasinPolygon,
  pocketGuardCenterline,
  pocketSurfaceZ,
  railPointAt,
  railTangentAt,
  STADIUM_GEOMETRY,
  stadiumTerrainAt,
  surfaceZAt,
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

/** Physical features which must remain visible in the initial battle shot.
 * The transparent safety cover is intentionally excluded: it may crop, but
 * the complete X-Line and every loss-zone basin/guard must remain on screen.
 * This gives both the fixed and sensor-driven cameras the closest useful
 * framing instead of shrinking the action to fit clear decorative plastic. */
export function stadiumFramingPoints(
  stadium: StadiumSpec,
  angularSamples = 1440,
): StadiumFramingPoint[] {
  const points: StadiumFramingPoint[] = [];
  const samples = Math.max(360, Math.round(angularSamples));
  const railHalf = stadium.railPhysicalHalfWidth ?? STADIUM_GEOMETRY.railPhysicalHalfWidthM;
  const featureGuard = 0.0035;
  const railTop = STADIUM_GEOMETRY.railChannelThicknessM + STADIUM_GEOMETRY.railToothHeightM;

  for (let sample = 0; sample < samples; sample++) {
    const theta = -Math.PI + sample / samples * Math.PI * 2;
    const point = railPointAt(stadium, theta);
    const tangent = railTangentAt(stadium, theta);
    const normal = { x: -tangent.y, y: tangent.x };
    for (const side of [-1, 1]) {
      const x = point.x + normal.x * (railHalf + featureGuard) * side;
      const y = point.y + normal.y * (railHalf + featureGuard) * side;
      points.push({ x, y, z: surfaceZAt(stadium, x, y) + railTop + 0.0015 });
    }
  }

  for (const pocket of stadium.pockets) {
    const polygon = pocketBasinPolygon(stadium, pocket);
    const center = polygon.reduce(
      (sum, point) => ({ x: sum.x + point.x / polygon.length, y: sum.y + point.y / polygon.length }),
      { x: 0, y: 0 },
    );
    for (const point of polygon) {
      const dx = point.x - center.x;
      const dy = point.y - center.y;
      const length = Math.sqrt(dx * dx + dy * dy) || 1;
      const x = point.x + dx / length * featureGuard;
      const y = point.y + dy / length * featureGuard;
      points.push({ x, y, z: pocketSurfaceZ(stadium, pocket, point.x, point.y) + 0.002 });
    }
    for (const point of pocketGuardCenterline(stadium, pocket)) {
      points.push({
        x: point.x,
        y: point.y,
        z: stadiumTerrainAt(stadium, point.x, point.y).height + 0.002,
      });
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
 * Tight distance for the action-critical silhouette at the requested initial
 * perspective. A 1.5% raster guard keeps the X-Line and pockets intact while
 * allowing the transparent casing to crop, as it does in a close real view.
 */
export function stadiumOrbitFitDistance(
  stadium: StadiumSpec,
  aspect: number,
  options: OrbitFitOptions = {},
): number {
  const fovDeg = options.fovDeg ?? 55;
  const safeAspect = Math.max(0.1, Number.isFinite(aspect) ? aspect : 1);
  const margin = options.margin ?? 1.015;
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
