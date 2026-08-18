// Stadium geometry models. Data-driven so official variants (BX-10, BX-32,
// legacy Burst) are just different specs. Angles are radians in the stadium
// plane; +x right, +y away from player 0, origin = bowl center.
//
// Sources (docs/RULES.md §4): BX-10 Xtreme Stadium 440×455×155 mm, tornado
// ridge ⌀210 mm, three exits on one side — two corner Over Zones flanking a
// wider central Xtreme Zone at the end of the Xtreme Line (gear rack molded
// into the floor that meshes with the gear teeth every X bit has).
// BX-32 Wide Xtreme Stadium: larger rectangular body for 3 players, TWO
// corner Xtreme Zones + ONE central Over Zone, three shoot positions, indigo
// X-lines. Exact BX-32 dimensions are unpublished — ⚠ estimated from photos.

import { datan2, dcos, dsin, PI, wrapAngle } from "./fxmath";

export interface PocketThroatSpec {
  /** Product silhouette of the opening when viewed from above. */
  shape: "trapezoid" | "tangential-slot";
  /** Half-widths at the bowl-side and outer ends (m). */
  innerHalfWidth: number;
  outerHalfWidth: number;
  /** How far the throat reaches either side of the nominal bowl boundary. */
  inwardDepth: number;
  outwardDepth: number;
  /** Rotation from the local outward wall normal. Used by BX-32's slots. */
  skew?: number;
  /** Optional broader continuation of the same concave molded basin behind
   * a narrow visible throat. This is not a separate tray or floor. */
  basinHalfWidth?: number;
  basinDepth?: number;
}

/** Product-top-view coordinates in a pocket's local frame. `along` points
 * out through the bowl wall and `across` follows the mouth from left to
 * right. Values are metres after perspective rectification of the supplied
 * overhead photographs. */
export interface PocketTracePoint {
  along: number;
  across: number;
}

export interface PocketGuardSpec {
  /** Traced centerline of the low molded retaining wall before the basin. */
  centerline: readonly PocketTracePoint[];
  /** Rounded wall half-thickness and rise above the surrounding surface. */
  halfThickness: number;
  height: number;
}

export interface PocketTraceSpec {
  /** Narrow wall aperture through which a Bey enters or returns. */
  throat: readonly PocketTracePoint[];
  /** Complete concave loss-zone outline in the one-piece floor. */
  basin: readonly PocketTracePoint[];
  /** Low entry wall visible immediately before the pocket. */
  guard: PocketGuardSpec;
  /** Audit provenance. Images are references only and are not shipped. */
  reference: {
    source: string;
    calibration: string;
    mirroredFrom?: string;
  };
}

export interface PocketSpec {
  id: string;
  angleCenter: number;
  /** Projected aperture width, retained for UI/debug descriptions only.
   * Collision and rendering use the two-dimensional `throat` polygon. */
  halfWidth: number;
  kind: "over" | "xtreme";
  throat: PocketThroatSpec;
  /** Exact product silhouette. When present this supersedes the legacy
   * trapezoid/capsule construction above. */
  trace?: PocketTraceSpec;
}

export interface RailArc {
  start: number; // radians, ccw from start to end
  end: number;
}

/** Legacy custom-stadium radial dip. Official products use `railTrace`. */
export interface RailDip {
  center: number;
  halfWidth: number;
  depth: number;
}

/** Photo-traced periodic X-Line control point. `angle` is the monotonic loop
 * parameter, not necessarily the point's polar bearing: the real molded
 * release bays contain short near-radial/overhung runs. Explicit XY values
 * therefore preserve the traced product silhouette without forcing it into
 * the old one-radius-per-angle approximation. */
export interface RailTracePoint {
  angle: number;
  radius: number;
  x?: number;
  y?: number;
  linearToNext?: boolean;
}

export interface RailTraceReference {
  method: "raster-vector-catmull-rom";
  /** Audit provenance only. The screenshot itself is not shipped. */
  source: string;
  calibration: string;
  sourceControlPoints: number;
  generatedControlPoints: number;
  mirrored: boolean;
}

export interface StadiumSpec {
  name: string;
  labelZh: string;
  rDish: number; // tornado ridge radius (m) — main battle bowl
  dishDepth: number; // z drop from ridge to center (m)
  rWall: number; // wall radius (m)
  /** BX-10 is circular. BX-32 is a horizontal obround, not a scaled circle. */
  wallShape?: { kind: "circle" } | { kind: "obround"; halfStraight: number };
  rimRise: number; // z rise from ridge to wall (m)
  rimBaseSlope: number; // constant extra slope on the rim band
  rRail: number; // xtreme line base radius (m)
  railHalfWidth: number; // radial capture band of the gear rack (m)
  /** Visible molded strip half-width fitted independently for each product. */
  railPhysicalHalfWidth?: number;
  railArcs: RailArc[];
  /** Traced inward ramp segments where the Bit leaves the line toward center. */
  railReleaseArcs?: RailArc[];
  /** oval rails (BX-32): x/y scale of the base circle */
  railEllipse?: { a: number; b: number };
  /** concave sections matching the real molded line */
  railDips?: RailDip[];
  /** Product-specific centerline; supersedes ellipse/dip approximations. */
  railTrace?: RailTracePoint[];
  railTraceReference?: RailTraceReference;
  railColor: number; // render hint
  pockets: PocketSpec[];
  wallRestitution: number;
  exitSpeed: number; // min outward radial speed to fall into a pocket (m/s)
  deckW: number; // outer body width (m, render)
  deckH: number; // outer body depth (m, render)
  bodyColor: number; // render hint
  shootAngles: number[]; // marked shoot positions (render)
  shootMarkerStyles?: ("red-triangle" | "molded-chevron")[];
  /** Legacy custom-stadium escape windows. Official BX-10/BX-32 leave this
   * empty: their only side apertures are the three modeled pocket throats. */
  coverGaps: RailArc[];
  coverHeight: number; // render: casing height above the rim (m)
}

interface RailVectorPoint {
  x: number;
  y: number;
}

/** Keep module-initialized physics geometry on the documented deterministic
 * arithmetic subset instead of relying on engine-specific hypot reduction. */
function railVectorLength(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

/** Convert a closed raster-derived vector polyline into a dense, C1 loop.
 * Chord-weighted Catmull-Rom/Hermite tangents pass through the fitted
 * silhouette while giving every photographed elbow a real-radius transition.
 * Weighting by adjacent pixel-chord length prevents a densely sampled corner
 * beside a sparse circular span from collapsing into a sub-millimeter cusp.
 * The seam is placed at the fitted loop's natural negative-X apex (rather
 * than cutting a cubic at an arbitrary ray crossing), and the loop parameter
 * is arc-length based, so rendering and deterministic contact use identical
 * XY without a synthetic high-curvature seam. */
function buildVectorRailTrace(
  source: readonly RailVectorPoint[],
  subdivisionsPerSpan = 16,
  tangentScale = 0.76,
): RailTracePoint[] {
  const dense: RailVectorPoint[] = [];
  const count = source.length;
  const tangentAt = (index: number): RailVectorPoint => {
    const previous = source[(index + count - 1) % count]!;
    const current = source[index % count]!;
    const next = source[(index + 1) % count]!;
    const incomingLength = railVectorLength(current.x - previous.x, current.y - previous.y);
    const outgoingLength = railVectorLength(next.x - current.x, next.y - current.y);
    if (incomingLength <= 1e-12 || outgoingLength <= 1e-12) return { x: 0, y: 0 };
    const directionX = (current.x - previous.x) / incomingLength +
      (next.x - current.x) / outgoingLength;
    const directionY = (current.y - previous.y) / incomingLength +
      (next.y - current.y) / outgoingLength;
    const directionLength = railVectorLength(directionX, directionY);
    if (directionLength <= 1e-12) return { x: 0, y: 0 };
    const harmonicChord = 2 * incomingLength * outgoingLength / (incomingLength + outgoingLength);
    return {
      x: directionX / directionLength * harmonicChord * tangentScale,
      y: directionY / directionLength * harmonicChord * tangentScale,
    };
  };
  for (let index = 0; index < count; index++) {
    const p1 = source[index]!;
    const p2 = source[(index + 1) % count]!;
    const m1 = tangentAt(index);
    const m2 = tangentAt(index + 1);
    for (let step = 0; step < subdivisionsPerSpan; step++) {
      const u = step / subdivisionsPerSpan;
      const u2 = u * u;
      const u3 = u2 * u;
      const h00 = 2 * u3 - 3 * u2 + 1;
      const h10 = u3 - 2 * u2 + u;
      const h01 = -2 * u3 + 3 * u2;
      const h11 = u3 - u2;
      dense.push({
        x: h00 * p1.x + h10 * m1.x + h01 * p2.x + h11 * m2.x,
        y: h00 * p1.y + h10 * m1.y + h01 * p2.y + h11 * m2.y,
      });
    }
  }

  const signedArea = dense.reduce((area, point, index) => {
    const next = dense[(index + 1) % dense.length]!;
    return area + point.x * next.y - next.x * point.y;
  }, 0);
  if (signedArea < 0) dense.reverse();

  let seamIndex = 0;
  for (let index = 1; index < dense.length; index++) {
    const candidate = dense[index]!;
    const current = dense[seamIndex]!;
    if (candidate.x < current.x || (candidate.x === current.x && Math.abs(candidate.y) < Math.abs(current.y))) {
      seamIndex = index;
    }
  }
  const orderedRaw: RailVectorPoint[] = [];
  for (let offset = 0; offset < dense.length; offset++) {
    orderedRaw.push(dense[(seamIndex + offset) % dense.length]!);
  }
  const seam = orderedRaw[0]!;
  orderedRaw.push(seam);
  // Remove any sub-micron duplicate source anchor so the closed cubic does not
  // manufacture a curvature spike that no molded product contains.
  const minimumControlSpacing = 0.000001;
  const ordered: RailVectorPoint[] = [seam];
  for (let index = 1; index < orderedRaw.length - 1; index++) {
    const point = orderedRaw[index]!;
    const previous = ordered[ordered.length - 1]!;
    if (railVectorLength(point.x - previous.x, point.y - previous.y) <= minimumControlSpacing) continue;
    if (railVectorLength(point.x - seam.x, point.y - seam.y) <= minimumControlSpacing) continue;
    ordered.push(point);
  }
  ordered.push(seam);

  const cumulative = [0];
  for (let index = 1; index < ordered.length; index++) {
    const a = ordered[index - 1]!;
    const b = ordered[index]!;
    cumulative.push(cumulative[index - 1]! + Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2));
  }
  const total = cumulative[cumulative.length - 1]!;
  return ordered.map((point, index) => ({
    angle: -PI + 2 * PI * cumulative[index]! / total,
    radius: Math.sqrt(point.x * point.x + point.y * point.y),
    x: point.x,
    y: point.y,
  }));
}

function polarVectorPoint(angle: number, radius: number): RailVectorPoint {
  return { x: radius * dcos(angle), y: radius * dsin(angle) };
}

function polarVectorArc(
  start: number,
  end: number,
  maximumStep: number,
  includeStart: boolean,
  includeEnd: boolean,
): RailVectorPoint[] {
  const segments = Math.max(1, Math.ceil((end - start) / maximumStep));
  const first = includeStart ? 0 : 1;
  const last = includeEnd ? segments : segments - 1;
  const points: RailVectorPoint[] = [];
  for (let index = first; index <= last; index++) {
    points.push(polarVectorPoint(start + (end - start) * index / segments, BX10_RAIL_RADIUS));
  }
  return points;
}

// The supplied retail raster is a third-party package shot, so it supplies
// topology rather than literal scale. Normalize its ordinary ring to the
// 138 mm canonical BX-10 centerline cross-checked in the official TT views;
// this also leaves one full 52.5 mm Bey diameter between rack and casing.
const BX10_RAIL_RADIUS = 0.138;
/** Full green centerline traced from the user-supplied straight-on retail
 * image `codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png`.
 * The bay anchors below follow the inner toothed silhouette in source pixels;
 * anisotropic scale rectifies the photographed ring back to a circle. The
 * ordinary ring is constrained to the same 138 mm centerline radius and was
 * cross-checked against Takara Tomy's BX-10 product views. In particular, the
 * two near-radial shoulders and their small molded elbow radii are preserved:
 * there are deliberately no sharp/linear joins. */
const BX10_RETAIL_CENTER_X_PX = 397.5;
const BX10_RETAIL_CENTER_Y_PX = 436.5;
const BX10_RETAIL_X_METERS_PER_PX = 0.000603;
const BX10_RETAIL_Y_METERS_PER_PX = 0.000720;
// The low-resolution raster resolves the corner as roughly ten pixels. Fit a
// curvature-limited cubic from its measured ordinary-ring tangent through the
// near-radial shoulder to the horizontal inner shelf. Unlike a polyline join,
// this retains an >8 mm centerline radius across the full circled elbow while
// still passing the traced ring and shelf endpoints. Mirror it exactly about
// the product centerline.
const BX10_ELBOW_RING_ANGLE = 1.24;
const BX10_ELBOW_START = polarVectorPoint(BX10_ELBOW_RING_ANGLE, BX10_RAIL_RADIUS);
const BX10_BAY_SHELF_Y = (BX10_RETAIL_CENTER_Y_PX - 288.5) * BX10_RETAIL_Y_METERS_PER_PX;
const BX10_ELBOW_END: RailVectorPoint = { x: 0.008, y: BX10_BAY_SHELF_Y };
const BX10_ELBOW_START_TANGENT = {
  x: -dsin(BX10_ELBOW_RING_ANGLE),
  y: dcos(BX10_ELBOW_RING_ANGLE),
};
const BX10_ELBOW_CONTROL_1 = {
  x: BX10_ELBOW_START.x + BX10_ELBOW_START_TANGENT.x * 0.032,
  y: BX10_ELBOW_START.y + BX10_ELBOW_START_TANGENT.y * 0.032,
};
const BX10_ELBOW_CONTROL_2 = { x: BX10_ELBOW_END.x + 0.02, y: BX10_ELBOW_END.y };
const BX10_RIGHT_BAY_SOURCE: readonly RailVectorPoint[] = Array.from({ length: 65 }, (_, index) => {
  const u = index / 64;
  const v = 1 - u;
  return {
    x: v ** 3 * BX10_ELBOW_START.x + 3 * v * v * u * BX10_ELBOW_CONTROL_1.x +
      3 * v * u * u * BX10_ELBOW_CONTROL_2.x + u ** 3 * BX10_ELBOW_END.x,
    y: v ** 3 * BX10_ELBOW_START.y + 3 * v * v * u * BX10_ELBOW_CONTROL_1.y +
      3 * v * u * u * BX10_ELBOW_CONTROL_2.y + u ** 3 * BX10_ELBOW_END.y,
  };
});
const BX10_RAIL_BAY_SOURCE: readonly RailVectorPoint[] = [
  ...BX10_RIGHT_BAY_SOURCE,
  { x: 0, y: BX10_BAY_SHELF_Y },
  ...BX10_RIGHT_BAY_SOURCE.slice().reverse().map((point) => ({ x: -point.x, y: point.y })),
];
const BX10_RAIL_SOURCE: readonly RailVectorPoint[] = [
  ...polarVectorArc(-PI, BX10_ELBOW_RING_ANGLE, 0.03, true, false),
  ...BX10_RAIL_BAY_SOURCE,
  ...polarVectorArc(PI - BX10_ELBOW_RING_ANGLE, PI, 0.03, false, false),
];
// Every analytic arc/cubic above is already sampled below 3 mm chord length;
// one interpolation stage (the shared compiled Hermite path) preserves its
// measured curvature instead of fitting a spline through a spline.
const BX10_RAIL_TRACE = buildVectorRailTrace(BX10_RAIL_SOURCE, 1);

/** Pocket vectors traced from the user-supplied straight-on retail overheads
 * and rectified against each product body. The official TT play diagrams were
 * used to disambiguate transparent-casing reflections from molded floor
 * edges. Controls deliberately describe the product-specific concavities,
 * not interchangeable radial trapezoids. `pocketPolygon`/`pocketBasinPolygon`
 * apply a deterministic Chaikin subdivision before core or rendering sees
 * them, so these sparse audit anchors become a high-line-count molded curve. */
const BX10_SIDE_THROAT: readonly PocketTracePoint[] = [
  { along: -0.024, across: 0.022 },
  { along: -0.010, across: 0.034 },
  { along: 0.015, across: 0.038 },
  { along: 0.021, across: -0.031 },
  { along: -0.008, across: -0.034 },
  { along: -0.024, across: -0.021 },
];
const BX10_SIDE_BASIN: readonly PocketTracePoint[] = [
  { along: -0.024, across: 0.022 },
  { along: -0.010, across: 0.038 },
  { along: 0.018, across: 0.051 },
  { along: 0.050, across: 0.046 },
  { along: 0.063, across: 0.024 },
  { along: 0.061, across: -0.018 },
  { along: 0.043, across: -0.043 },
  { along: 0.012, across: -0.046 },
  { along: -0.015, across: -0.033 },
  { along: -0.026, across: -0.016 },
];
const BX10_SIDE_GUARD: readonly PocketTracePoint[] = [
  { along: -0.021, across: -0.030 },
  { along: -0.015, across: -0.016 },
  { along: -0.012, across: 0 },
  { along: -0.015, across: 0.016 },
  { along: -0.021, across: 0.030 },
];
const BX10_CENTER_THROAT: readonly PocketTracePoint[] = [
  { along: -0.023, across: 0.060 },
  { along: -0.008, across: 0.071 },
  { along: 0.018, across: 0.068 },
  { along: 0.018, across: -0.068 },
  { along: -0.008, across: -0.071 },
  { along: -0.023, across: -0.060 },
];
const BX10_CENTER_BASIN: readonly PocketTracePoint[] = [
  { along: -0.023, across: 0.060 },
  { along: -0.008, across: 0.074 },
  { along: 0.020, across: 0.072 },
  { along: 0.045, across: 0.060 },
  { along: 0.054, across: 0.040 },
  { along: 0.057, across: 0 },
  { along: 0.054, across: -0.040 },
  { along: 0.045, across: -0.060 },
  { along: 0.020, across: -0.072 },
  { along: -0.008, across: -0.074 },
  { along: -0.023, across: -0.060 },
];
const BX10_CENTER_GUARD: readonly PocketTracePoint[] = [
  { along: -0.022, across: -0.060 },
  { along: -0.016, across: -0.032 },
  { along: -0.012, across: 0 },
  { along: -0.016, across: 0.032 },
  { along: -0.022, across: 0.060 },
];

const BX32_REAR_THROAT: readonly PocketTracePoint[] = [
  { along: -0.018, across: 0.014 },
  { along: -0.008, across: 0.021 },
  { along: 0.020, across: 0.022 },
  { along: 0.025, across: -0.019 },
  { along: -0.007, across: -0.021 },
  { along: -0.018, across: -0.012 },
];
const BX32_REAR_BASIN: readonly PocketTracePoint[] = [
  { along: -0.018, across: 0.012 },
  { along: -0.010, across: 0.019 },
  { along: 0.004, across: 0.023 },
  { along: 0.057, across: 0.023 },
  { along: 0.071, across: 0.015 },
  { along: 0.077, across: 0.003 },
  { along: 0.073, across: -0.012 },
  { along: 0.059, across: -0.021 },
  { along: 0.004, across: -0.022 },
  { along: -0.011, across: -0.017 },
  { along: -0.018, across: -0.008 },
];
const BX32_REAR_GUARD: readonly PocketTracePoint[] = [
  { along: -0.0302, across: -0.0369 },
  { along: -0.0203, across: -0.0288 },
  { along: -0.0123, across: -0.0158 },
  { along: -0.0093, across: 0.0002 },
  { along: -0.0123, across: 0.0162 },
  { along: -0.0204, across: 0.0292 },
  { along: -0.0277, across: 0.0375 },
];
const BX32_FRONT_THROAT: readonly PocketTracePoint[] = [
  { along: -0.021, across: 0.052 },
  { along: -0.009, across: 0.065 },
  { along: 0.018, across: 0.071 },
  { along: 0.018, across: -0.071 },
  { along: -0.009, across: -0.065 },
  { along: -0.021, across: -0.052 },
];
const BX32_FRONT_BASIN: readonly PocketTracePoint[] = [
  { along: -0.021, across: 0.052 },
  { along: -0.010, across: 0.067 },
  { along: 0.012, across: 0.078 },
  { along: 0.042, across: 0.071 },
  { along: 0.055, across: 0.051 },
  { along: 0.060, across: 0 },
  { along: 0.055, across: -0.051 },
  { along: 0.042, across: -0.071 },
  { along: 0.012, across: -0.078 },
  { along: -0.010, across: -0.067 },
  { along: -0.021, across: -0.052 },
];
const BX32_FRONT_GUARD: readonly PocketTracePoint[] = [
  { along: -0.022, across: -0.058 },
  { along: -0.016, across: -0.030 },
  { along: -0.012, across: 0 },
  { along: -0.016, across: 0.030 },
  { along: -0.022, across: 0.058 },
];

function pocketTrace(
  throat: readonly PocketTracePoint[],
  basin: readonly PocketTracePoint[],
  guard: readonly PocketTracePoint[],
  height: number,
  source: string,
  calibration: string,
  mirroredFrom?: string,
  halfThickness = 0.0048,
): PocketTraceSpec {
  return {
    throat,
    basin,
    guard: { centerline: guard, halfThickness, height },
    reference: { source, calibration, mirroredFrom },
  };
}

/** BX-10 Xtreme Stadium — the official 1v1 tournament stadium. */
export const STADIUM_BX10: StadiumSpec = {
  name: "bx10",
  labelZh: "BX-10 X戰鬥盤",
  // scale audit vs the real product: bey ⌀49 and ridge ⌀210 are exact;
  // interior bowl ≈ ⌀350 (440 body minus deck margins) → rim band ≈ 1.4
  // bey-widths like the real stadium (0.15 was cramped)
  rDish: 0.105,
  dishDepth: 0.012,
  rWall: 0.175,
  wallShape: { kind: "circle" },
  rimRise: 0.02,
  rimBaseSlope: 0.1,
  rRail: BX10_RAIL_RADIUS,
  railHalfWidth: 0.011,
  railPhysicalHalfWidth: 0.0062,
  // the gear ring circles the whole bowl; dashes release toward the exits
  railArcs: [{ start: -PI, end: PI }],
  // Release eligibility is curve-derived: only a traced tangent pointing
  // strongly inward can release, even though the whole loop is searchable.
  railReleaseArcs: [{ start: -PI, end: PI }],
  railTrace: BX10_RAIL_TRACE,
  railTraceReference: {
    method: "raster-vector-catmull-rom",
    source: "user:codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png",
    calibration: "bay rectified about (397.5,436.5)px, normalized to 138mm TT-cross-checked ring; 440x455mm body",
    sourceControlPoints: BX10_RAIL_SOURCE.length,
    generatedControlPoints: BX10_RAIL_TRACE.length,
    mirrored: false,
  },
  railColor: 0x35b24a,
  // The official play diagram has exactly three front-side openings:
  // Over / Xtreme / Over. There are no corresponding rear pockets.
  pockets: [
    {
      id: "front-left-over",
      angleCenter: -2.53,
      halfWidth: 0.27,
      kind: "over",
      throat: {
        shape: "trapezoid",
        innerHalfWidth: 0.035,
        outerHalfWidth: 0.043,
        inwardDepth: 0.026,
        outwardDepth: 0.036,
      },
      trace: pocketTrace(
        BX10_SIDE_THROAT,
        BX10_SIDE_BASIN,
        BX10_SIDE_GUARD,
        0.006,
        "user:codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png + TT:BX-07-manual-p7",
        "440x455mm body; front-left molded concavity and bowl-side retaining lip",
      ),
    },
    {
      id: "front-center-xtreme",
      angleCenter: -1.5707963,
      halfWidth: 0.36,
      kind: "xtreme",
      throat: {
        shape: "trapezoid",
        innerHalfWidth: 0.06,
        outerHalfWidth: 0.068,
        inwardDepth: 0.026,
        outwardDepth: 0.036,
      },
      trace: pocketTrace(
        BX10_CENTER_THROAT,
        BX10_CENTER_BASIN,
        BX10_CENTER_GUARD,
        0.0065,
        "user:codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png + TT:BX-07-manual-p7",
        "440x455mm body; broad central Xtreme concavity and curved retaining lip",
      ),
    },
    {
      id: "front-right-over",
      angleCenter: -0.61,
      halfWidth: 0.27,
      kind: "over",
      throat: {
        shape: "trapezoid",
        innerHalfWidth: 0.035,
        outerHalfWidth: 0.043,
        inwardDepth: 0.026,
        outwardDepth: 0.036,
      },
      trace: pocketTrace(
        BX10_SIDE_THROAT,
        BX10_SIDE_BASIN,
        BX10_SIDE_GUARD,
        0.006,
        "user:codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png + TT:BX-07-manual-p7",
        "440x455mm body; mirrored front-right molded concavity and retaining lip",
        "front-left-over",
      ),
    },
  ],
  wallRestitution: 0.52,
  exitSpeed: 0.8,
  // real body: 440 × 455 mm (docs/MODELING.md §2.1)
  deckW: 0.44,
  deckH: 0.455,
  // the standard release is a WHITE shell with a green X-Line
  bodyColor: 0xe9ebf2,
  // BX-10 has no red molded shoot-position triangles.
  shootAngles: [],
  coverGaps: [],
  coverHeight: 0.09,
};

/** Upper-half indigo centerline sampled from the exact user-supplied 500 px
 * retail overhead image
 * `codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png`.
 * Pixel Y is the product's 600 mm axis. The unobstructed upper half is traced
 * once, perspective-rectified against the 600 x 440 mm body, then mirrored
 * about y=282.5 px as requested because the lower rail is packet-obscured.
 * These anchors follow the center of the blue inner/outer silhouette; the
 * Catmull-Rom conversion makes the photographed shoulders and elbows round. */
const BX32_RETAIL_UPPER_RAIL_PX: readonly [number, number][] = [
  [155, 282.5], [155, 252], [156, 228], [153, 219], [143, 213], [130, 204],
  [127, 192], [127, 177], [132, 165], [145, 153], [162, 145], [181, 137],
  [205, 131], [232, 128], [257, 131], [278, 138], [298, 150], [314, 164],
  [326, 181], [336, 201], [344, 221], [349, 244], [352, 266], [354, 282.5],
];
// The two unobstructed rail crossings at the trace mirror line are x=155 and
// x=354, fixing the photographed stadium short-axis center at their midpoint.
// Do not translate this origin to make a release tangent aim at the center.
const BX32_RETAIL_CENTER_X_PX = 254.5;
const BX32_RETAIL_MIRROR_Y_PX = 282.5;
// A single body-calibrated uniform fit would push the photographed ribbon
// through the simulated wall once the widest 52.5 mm Bey clearance is
// included. The product photo has residual perspective foreshortening, so fit
// each body axis independently inside that physical envelope while retaining
// the measured endpoint midpoint and all traced relative control positions.
const BX32_RETAIL_LONG_AXIS_METERS_PER_PX = 0.00133;
const BX32_RETAIL_SHORT_AXIS_METERS_PER_PX = 0.00114;
const BX32_RAIL_UPPER_SOURCE: readonly RailVectorPoint[] = BX32_RETAIL_UPPER_RAIL_PX.map(([x, y]) => ({
  x: (BX32_RETAIL_MIRROR_Y_PX - y) * BX32_RETAIL_LONG_AXIS_METERS_PER_PX,
  y: (x - BX32_RETAIL_CENTER_X_PX) * BX32_RETAIL_SHORT_AXIS_METERS_PER_PX,
}));
const BX32_RAIL_SOURCE: readonly RailVectorPoint[] = [
  ...BX32_RAIL_UPPER_SOURCE,
  ...BX32_RAIL_UPPER_SOURCE.slice(1, -1).reverse().map((point) => ({ x: -point.x, y: point.y })),
];
const BX32_RAIL_TRACE = buildVectorRailTrace(BX32_RAIL_SOURCE, 18, 1);

/** BX-32 Wide Xtreme Stadium — the official 3-player stadium (600 × 440 mm),
 * which is exactly what the free-for-all mode wants. Bowl/rail proportions
 * are scaled from photos; the body size is the published figure. */
export const STADIUM_BX32: StadiumSpec = {
  name: "wide",
  labelZh: "BX-32 寬型X戰鬥盤",
  rDish: 0.15,
  dishDepth: 0.014,
  // The bowl has to leave a deck margin for the concave loss zones: at 0.21 it came
  // within 10 mm of the 440 mm body's short edge, which left no room for a
  // pocket at all (and no real stadium has its wall flush to the shell).
  rWall: 0.19,
  wallShape: { kind: "obround", halfStraight: 0.055 },
  rimRise: 0.022,
  rimBaseSlope: 0.09,
  // Nominal mean radius is retained for legacy/debug callers; all product
  // contact and rendering use the explicit 600 mm-axis vector trace below.
  rRail: 0.205,
  railHalfWidth: 0.012,
  railPhysicalHalfWidth: 0.0068,
  // one continuous indigo loop following the wide oval bowl…
  railArcs: [{ start: -PI, end: PI }],
  railReleaseArcs: [{ start: -PI, end: PI }],
  railTrace: BX32_RAIL_TRACE,
  railTraceReference: {
    method: "raster-vector-catmull-rom",
    source: "user:codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png",
    calibration: "upper half rectified 1.330x1.140mm/px about endpoint midpoint x=254.5px; 600x440mm body; mirrored",
    sourceControlPoints: BX32_RETAIL_UPPER_RAIL_PX.length,
    generatedControlPoints: BX32_RAIL_TRACE.length,
    mirrored: true,
  },
  railColor: 0x5246c9,
  // Product photography shows two narrow, tangential rear Xtreme slots and
  // a single trapezoidal front Over opening. No extra corner pockets.
  pockets: [
    {
      id: "rear-left-xtreme",
      angleCenter: 2.43,
      halfWidth: 0.16,
      kind: "xtreme",
      throat: {
        shape: "tangential-slot",
        innerHalfWidth: 0.029,
        outerHalfWidth: 0.032,
        inwardDepth: 0.025,
        outwardDepth: 0.046,
        skew: 1.02,
        basinHalfWidth: 0.05,
        basinDepth: 0.095,
      },
      trace: pocketTrace(
        BX32_REAR_THROAT,
        BX32_REAR_BASIN,
        BX32_REAR_GUARD,
        0.0168,
        "user:codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png + TT:BX-32-manual + https://m.media-amazon.com/images/I/61mev0MM2vL.jpg",
        "600x440mm body; overhead plan trace plus oblique shadow-edge fit normalized against the adjacent 4.6mm X-Line; inferred 16.8mm rise and 21mm full width",
        undefined,
        0.0105,
      ),
    },
    {
      id: "rear-right-xtreme",
      angleCenter: 0.71,
      halfWidth: 0.16,
      kind: "xtreme",
      throat: {
        shape: "tangential-slot",
        innerHalfWidth: 0.029,
        outerHalfWidth: 0.032,
        inwardDepth: 0.025,
        outwardDepth: 0.046,
        skew: -1.02,
        basinHalfWidth: 0.05,
        basinDepth: 0.095,
      },
      trace: pocketTrace(
        BX32_REAR_THROAT,
        BX32_REAR_BASIN,
        BX32_REAR_GUARD,
        0.0168,
        "user:codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png + TT:BX-32-manual + https://m.media-amazon.com/images/I/61mev0MM2vL.jpg",
        "600x440mm body; mirrored overhead plan trace plus opposite oblique shadow-edge cross-check; inferred 16.8mm rise and 21mm full width",
        "rear-left-xtreme",
        0.0105,
      ),
    },
    {
      id: "front-center-over",
      angleCenter: -1.5707963,
      halfWidth: 0.22,
      kind: "over",
      throat: {
        shape: "trapezoid",
        innerHalfWidth: 0.04,
        outerHalfWidth: 0.055,
        inwardDepth: 0.028,
        outwardDepth: 0.028,
      },
      trace: pocketTrace(
        BX32_FRONT_THROAT,
        BX32_FRONT_BASIN,
        BX32_FRONT_GUARD,
        0.006,
        "user:codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png + TT:BX-32-manual",
        "600x440mm body; front-center broad Over concavity and curved entrance wall",
      ),
    },
  ],
  wallRestitution: 0.52,
  exitSpeed: 0.8,
  // real body: 600 × 440 mm, the largest X stadium (docs/MODELING.md §2.2)
  deckW: 0.6,
  deckH: 0.44,
  bodyColor: 0xe4e7f0,
  // Two red triangular guide marks are molded diagonally opposite each other.
  shootAngles: [-2.55, -0.59, 1.5707963],
  shootMarkerStyles: ["red-triangle", "red-triangle", "molded-chevron"],
  coverGaps: [],
  coverHeight: 0.1,
};

/** Only the two official Xtreme stadiums are selectable. */
export const STADIUMS: Record<string, StadiumSpec> = {
  bx10: STADIUM_BX10,
  wide: STADIUM_BX32,
};

/** Dimensions shared by deterministic collision and the high-density model.
 * Public product material sheets do not publish these mold measurements, so
 * they are photo-scaled model dimensions rather than claimed factory specs. */
export const STADIUM_GEOMETRY = Object.freeze({
  railToothPitchM: 0.005,
  // Patent/Bit-engagement calibrated: TT does not publish rack dimensions.
  // The molded shoulder supplies most of the required gear-band overlap;
  // tooth rise stays comparable to the Bit's own tooth depth.
  railToothHeightM: 0.0022,
  railToothBottomWidthM: 0.004,
  railToothTopWidthM: 0.0024,
  railToothDepthM: 0.0048,
  railChannelThicknessM: 0.0024,
  railPhysicalHalfWidthM: 0.0036,
  casingThicknessM: 0.002,
  // The loss zones are depressions in the one-piece battle surface. Public
  // drawings do not dimension their section, so this is photo-scaled from
  // the official product views rather than claimed as a factory dimension.
  pocketBasinDepthM: 0.024,
  pocketBasinShoulderM: 0.014,
});

export interface Point2 {
  x: number;
  y: number;
}

export interface StadiumTerrainSample {
  height: number;
  normalX: number;
  normalY: number;
  normalZ: number;
  region: "bowl" | "rail" | "pocket" | "outside";
  pocket: PocketSpec | null;
}

function boundaryRadiusAlongUnit(s: StadiumSpec, ux: number, uy: number): number {
  if (s.wallShape?.kind !== "obround") return s.rWall;
  const halfStraight = s.wallShape.halfStraight;
  const absUx = Math.abs(ux);
  const absUy = Math.abs(uy);
  // A horizontal capsule consists of a central rectangle and two semicircles.
  // Rays near vertical first meet a straight y=±r edge.
  if (absUy > 1e-12) {
    const straightHit = s.rWall / absUy;
    if (straightHit * absUx <= halfStraight) return straightHit;
  }
  const discriminant = Math.max(0, s.rWall * s.rWall - halfStraight * halfStraight * uy * uy);
  return halfStraight * absUx + Math.sqrt(discriminant);
}

/** Distance from center to the bowl wall along a polar ray. */
export function stadiumBoundaryRadiusAt(s: StadiumSpec, theta: number): number {
  return boundaryRadiusAlongUnit(s, dcos(theta), dsin(theta));
}

export function stadiumBoundaryPointAt(s: StadiumSpec, theta: number): Point2 {
  const radius = stadiumBoundaryRadiusAt(s, theta);
  return { x: radius * dcos(theta), y: radius * dsin(theta) };
}

/** Outer molded body contour shared with pocket-fit audits/rendering. */
export function stadiumBodyRadiusAt(s: StadiumSpec, theta: number): number {
  const a = s.deckW / 2;
  const b = s.deckH / 2;
  const exponent = s.name === "wide" ? 7 : 5.5;
  const ux = Math.abs(dcos(theta)) / a;
  const uy = Math.abs(dsin(theta)) / b;
  return (ux ** exponent + uy ** exponent) ** (-1 / exponent);
}

/** Signed planar distance to the product bowl boundary. Negative is inside.
 * `clearance` shrinks the usable bowl by a circular body's contact radius. */
export function stadiumBoundarySignedDistance(
  s: StadiumSpec,
  x: number,
  y: number,
  clearance = 0,
): number {
  if (s.wallShape?.kind !== "obround") return Math.sqrt(x * x + y * y) - s.rWall + clearance;
  const dx = Math.max(Math.abs(x) - s.wallShape.halfStraight, 0);
  return Math.sqrt(dx * dx + y * y) - s.rWall + clearance;
}

/** Outward unit normal of the nearest point on the circular/obround wall. */
export function stadiumBoundaryNormalAt(s: StadiumSpec, x: number, y: number): Point2 {
  if (s.wallShape?.kind === "obround") {
    const centerX = Math.max(-s.wallShape.halfStraight, Math.min(s.wallShape.halfStraight, x));
    const dx = x - centerX;
    const length = Math.sqrt(dx * dx + y * y);
    if (length > 1e-12) return { x: dx / length, y: y / length };
  }
  const length = Math.sqrt(x * x + y * y);
  return length > 1e-12 ? { x: x / length, y: y / length } : { x: 0, y: -1 };
}

export interface PocketPath {
  boundary: Point2;
  axis: Point2;
  across: Point2;
  innerCenter: Point2;
  outerCenter: Point2;
}

const POCKET_PATH_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, PocketPath>>();
const POCKET_THROAT_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, readonly Point2[]>>();
const POCKET_BASIN_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, readonly Point2[]>>();

function smoothClosedPocketTrace(
  control: readonly PocketTracePoint[],
  passes = 4,
): PocketTracePoint[] {
  let points = control.map((point) => ({ ...point }));
  for (let pass = 0; pass < passes; pass++) {
    const next: PocketTracePoint[] = [];
    for (let index = 0; index < points.length; index++) {
      const a = points[index]!;
      const b = points[(index + 1) % points.length]!;
      next.push(
        { along: a.along * 0.75 + b.along * 0.25, across: a.across * 0.75 + b.across * 0.25 },
        { along: a.along * 0.25 + b.along * 0.75, across: a.across * 0.25 + b.across * 0.75 },
      );
    }
    points = next;
  }
  return points;
}

function smoothOpenPocketTrace(
  control: readonly PocketTracePoint[],
  passes = 3,
): PocketTracePoint[] {
  let points = control.map((point) => ({ ...point }));
  for (let pass = 0; pass < passes; pass++) {
    const next: PocketTracePoint[] = [points[0]!];
    for (let index = 0; index < points.length - 1; index++) {
      const a = points[index]!;
      const b = points[index + 1]!;
      next.push(
        { along: a.along * 0.75 + b.along * 0.25, across: a.across * 0.75 + b.across * 0.25 },
        { along: a.along * 0.25 + b.along * 0.75, across: a.across * 0.25 + b.across * 0.75 },
      );
    }
    next.push(points[points.length - 1]!);
    points = next;
  }
  return points;
}

function tracedPocketPoints(
  s: StadiumSpec,
  pocket: PocketSpec,
  control: readonly PocketTracePoint[],
): Point2[] {
  const path = pocketPath(s, pocket);
  return smoothClosedPocketTrace(control).map((point) => {
    let x = path.boundary.x + path.axis.x * point.along + path.across.x * point.across;
    let y = path.boundary.y + path.axis.y * point.along + path.across.y * point.across;
    // Perspective rectification can put an antialiased source pixel a few
    // tenths of a millimetre beyond the physical shell. Keep the traced shape
    // while clipping that sub-pixel uncertainty to the inside of the actual
    // product body, so neither physics nor rendering invents an overhang.
    const radius = Math.sqrt(x * x + y * y);
    if (radius > 1e-12) {
      const bodyRadius = stadiumBodyRadiusAt(s, datan2(y, x)) - 0.0002;
      if (radius > bodyRadius) {
        x *= bodyRadius / radius;
        y *= bodyRadius / radius;
      }
    }
    return { x, y };
  });
}

function pocketCache<T>(
  cache: WeakMap<StadiumSpec, WeakMap<PocketSpec, T>>,
  stadium: StadiumSpec,
): WeakMap<PocketSpec, T> {
  let entries = cache.get(stadium);
  if (!entries) {
    entries = new WeakMap<PocketSpec, T>();
    cache.set(stadium, entries);
  }
  return entries;
}

export function pocketPath(s: StadiumSpec, pocket: PocketSpec): PocketPath {
  const entries = pocketCache(POCKET_PATH_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  const boundary = stadiumBoundaryPointAt(s, pocket.angleCenter);
  const normal = stadiumBoundaryNormalAt(s, boundary.x, boundary.y);
  const tangent = { x: -normal.y, y: normal.x };
  const skew = pocket.throat.skew ?? 0;
  const c = dcos(skew);
  const sn = dsin(skew);
  const axisLength = Math.sqrt(
    (normal.x * c + tangent.x * sn) ** 2 +
    (normal.y * c + tangent.y * sn) ** 2,
  );
  const axis = {
    x: (normal.x * c + tangent.x * sn) / axisLength,
    y: (normal.y * c + tangent.y * sn) / axisLength,
  };
  const across = { x: -axis.y, y: axis.x };
  const path = {
    boundary,
    axis,
    across,
    innerCenter: {
      x: boundary.x - axis.x * pocket.throat.inwardDepth,
      y: boundary.y - axis.y * pocket.throat.inwardDepth,
    },
    outerCenter: {
      x: boundary.x + axis.x * pocket.throat.outwardDepth,
      y: boundary.y + axis.y * pocket.throat.outwardDepth,
    },
  };
  entries.set(pocket, path);
  return path;
}

/** Exact top-view throat used by simulation, rendering, and burst debris. */
export function pocketPolygon(s: StadiumSpec, pocket: PocketSpec): readonly Point2[] {
  const entries = pocketCache(POCKET_THROAT_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  if (pocket.trace) {
    const traced = tracedPocketPoints(s, pocket, pocket.trace.throat);
    entries.set(pocket, traced);
    return traced;
  }
  const f = pocketPath(s, pocket);
  const iw = pocket.throat.innerHalfWidth;
  const ow = pocket.throat.outerHalfWidth;
  if (pocket.throat.shape === "tangential-slot") {
    const innerCap = {
      x: f.boundary.x - f.axis.x * Math.max(0, pocket.throat.inwardDepth - iw),
      y: f.boundary.y - f.axis.y * Math.max(0, pocket.throat.inwardDepth - iw),
    };
    const outerCap = {
      x: f.boundary.x + f.axis.x * Math.max(0, pocket.throat.outwardDepth - ow),
      y: f.boundary.y + f.axis.y * Math.max(0, pocket.throat.outwardDepth - ow),
    };
    const points: Point2[] = [];
    // Clockwise capsule: +across side, rounded outer cap, -across side,
    // rounded inner cap. Twenty-four cap divisions keep the slot visibly
    // molded at close camera distance while remaining deterministic.
    const capDivisions = 24;
    for (let i = 0; i <= capDivisions; i++) {
      const angle = (PI * i) / capDivisions;
      const along = dsin(angle) * ow;
      const across = dcos(angle) * ow;
      points.push({
        x: outerCap.x + f.axis.x * along + f.across.x * across,
        y: outerCap.y + f.axis.y * along + f.across.y * across,
      });
    }
    for (let i = 0; i <= capDivisions; i++) {
      const angle = PI + (PI * i) / capDivisions;
      const along = dsin(angle) * iw;
      const across = dcos(angle) * iw;
      points.push({
        x: innerCap.x + f.axis.x * along + f.across.x * across,
        y: innerCap.y + f.axis.y * along + f.across.y * across,
      });
    }
    entries.set(pocket, points);
    return points;
  }
  const points = [
    { x: f.innerCenter.x + f.across.x * iw, y: f.innerCenter.y + f.across.y * iw },
    { x: f.outerCenter.x + f.across.x * ow, y: f.outerCenter.y + f.across.y * ow },
    { x: f.outerCenter.x - f.across.x * ow, y: f.outerCenter.y - f.across.y * ow },
    { x: f.innerCenter.x - f.across.x * iw, y: f.innerCenter.y - f.across.y * iw },
  ];
  entries.set(pocket, points);
  return points;
}

function cross2(origin: Point2, a: Point2, b: Point2): number {
  return (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x);
}

/** Deterministic clockwise convex hull. Official loss-zone basins are convex
 * molded depressions; using one outline avoids an artificial throat/floor
 * overlap seam in collision, terrain, and rendering. */
function convexHullClockwise(points: readonly Point2[]): Point2[] {
  const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const unique = sorted.filter((point, index) =>
    index === 0 || point.x !== sorted[index - 1]!.x || point.y !== sorted[index - 1]!.y
  );
  if (unique.length <= 2) return unique.reverse();
  const lower: Point2[] = [];
  for (const point of unique) {
    while (lower.length >= 2 && cross2(lower[lower.length - 2]!, lower[lower.length - 1]!, point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  const upper: Point2[] = [];
  for (let index = unique.length - 1; index >= 0; index--) {
    const point = unique[index]!;
    while (upper.length >= 2 && cross2(upper[upper.length - 2]!, upper[upper.length - 1]!, point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper).reverse();
}

/** Complete top-view footprint of the one-piece concave loss-zone basin.
 * BX-32 continues its narrow rounded mouth into a broader rounded depression;
 * both portions are molded as one surface, never as a separate catch tray. */
export function pocketBasinPolygon(s: StadiumSpec, pocket: PocketSpec): readonly Point2[] {
  const entries = pocketCache(POCKET_BASIN_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  if (pocket.trace) {
    const traced = tracedPocketPoints(s, pocket, pocket.trace.basin);
    entries.set(pocket, traced);
    return traced;
  }
  const throat = pocketPolygon(s, pocket);
  const basinHalfWidth = pocket.throat.basinHalfWidth;
  const basinDepth = pocket.throat.basinDepth;
  if (basinHalfWidth === undefined || basinDepth === undefined) {
    entries.set(pocket, throat);
    return throat;
  }
  const f = pocketPath(s, pocket);
  const innerAlong = pocket.throat.outwardDepth * 0.2;
  const capRadius = Math.min(basinHalfWidth, Math.max(0.001, basinDepth - innerAlong));
  const capCenterAlong = basinDepth - capRadius;
  const basinPoints: Point2[] = [];
  const capDivisions = 32;
  for (let division = 0; division <= capDivisions; division++) {
    const angle = (PI * division) / capDivisions;
    const along = capCenterAlong + dsin(angle) * capRadius;
    const across = dcos(angle) * basinHalfWidth;
    basinPoints.push({
      x: f.boundary.x + f.axis.x * along + f.across.x * across,
      y: f.boundary.y + f.axis.y * along + f.across.y * across,
    });
  }
  const basin = convexHullClockwise([...throat, ...basinPoints]);
  entries.set(pocket, basin);
  return basin;
}

/** Allocation-free convex containment used with precomputed product polygons
 * by core, renderer and debris/contact audits. */
export function pointInConvexPolygon(polygon: readonly Point2[], x: number, y: number): boolean {
  let sign = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    const cross = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
    if (Math.abs(cross) <= 1e-10) continue;
    const current = cross > 0 ? 1 : -1;
    if (sign !== 0 && sign !== current) return false;
    sign = current;
  }
  return true;
}

/** Narrow product throat containing a point (used to cut the bowl wall). */
export function pocketThroatAtPoint(s: StadiumSpec, x: number, y: number): PocketSpec | null {
  for (const pocket of s.pockets) {
    if (pointInConvexPolygon(pocketPolygon(s, pocket), x, y)) return pocket;
  }
  return null;
}

/** Entire live pocket terrain: one continuous concave basin. */
export function pocketAtPoint(s: StadiumSpec, x: number, y: number): PocketSpec | null {
  for (const pocket of s.pockets) {
    if (pointInConvexPolygon(pocketBasinPolygon(s, pocket), x, y)) return pocket;
  }
  return null;
}

function pointSegmentDistance(x: number, y: number, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  const t = denom > 1e-14
    ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / denom))
    : 0;
  const px = a.x + dx * t;
  const py = a.y + dy * t;
  return Math.sqrt((x - px) ** 2 + (y - py) ** 2);
}

interface CompiledPocketGuard {
  points: readonly PocketTracePoint[];
  minAlong: number;
  maxAlong: number;
  minAcross: number;
  maxAcross: number;
}

const POCKET_GUARD_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, CompiledPocketGuard>>();

function compiledPocketGuard(s: StadiumSpec, pocket: PocketSpec): CompiledPocketGuard | null {
  if (!pocket.trace) return null;
  const entries = pocketCache(POCKET_GUARD_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  const points = smoothOpenPocketTrace(pocket.trace.guard.centerline);
  const margin = pocket.trace.guard.halfThickness;
  const compiled: CompiledPocketGuard = {
    points,
    minAlong: Math.min(...points.map((point) => point.along)) - margin,
    maxAlong: Math.max(...points.map((point) => point.along)) + margin,
    minAcross: Math.min(...points.map((point) => point.across)) - margin,
    maxAcross: Math.max(...points.map((point) => point.across)) + margin,
  };
  entries.set(pocket, compiled);
  return compiled;
}

/** World-space high-line-count centerline of the molded pocket-entry wall. */
export function pocketGuardCenterline(s: StadiumSpec, pocket: PocketSpec): readonly Point2[] {
  const guard = compiledPocketGuard(s, pocket);
  if (!guard) return [];
  const path = pocketPath(s, pocket);
  return guard.points.map((point) => ({
    x: path.boundary.x + path.axis.x * point.along + path.across.x * point.across,
    y: path.boundary.y + path.axis.y * point.along + path.across.y * point.across,
  }));
}

/** Smooth raised lip before each official loss zone. Its dimensions are
 * photo-scaled inferences because TT does not publish mold sections. */
export function pocketGuardRiseAt(s: StadiumSpec, x: number, y: number): number {
  let rise = 0;
  for (const pocket of s.pockets) {
    const guard = compiledPocketGuard(s, pocket);
    if (!guard || !pocket.trace) continue;
    const path = pocketPath(s, pocket);
    const dx = x - path.boundary.x;
    const dy = y - path.boundary.y;
    const along = dx * path.axis.x + dy * path.axis.y;
    const across = dx * path.across.x + dy * path.across.y;
    if (
      along < guard.minAlong || along > guard.maxAlong ||
      across < guard.minAcross || across > guard.maxAcross
    ) continue;
    let distance = Infinity;
    for (let index = 0; index < guard.points.length - 1; index++) {
      const a = guard.points[index]!;
      const b = guard.points[index + 1]!;
      distance = Math.min(distance, pointSegmentDistance(
        along,
        across,
        { x: a.along, y: a.across },
        { x: b.along, y: b.across },
      ));
    }
    const profile = smooth01(1 - distance / pocket.trace.guard.halfThickness);
    rise = Math.max(rise, pocket.trace.guard.height * profile);
  }
  return rise;
}

/** Heightfield gradient of the pocket-entry lips, kept separate from the
 * gear rail so ordinary bowl motion does not inherit rack-tooth normals. */
export function pocketGuardGradientAt(s: StadiumSpec, x: number, y: number): Point2 {
  const h = 0.0002;
  return {
    x: (pocketGuardRiseAt(s, x + h, y) - pocketGuardRiseAt(s, x - h, y)) / (2 * h),
    y: (pocketGuardRiseAt(s, x, y + h) - pocketGuardRiseAt(s, x, y - h)) / (2 * h),
  };
}

/** True only when the Bey's complete footprint is retained by the concave
 * basin rather than balancing across its open inner mouth. */
export function pocketSecureAtPoint(
  s: StadiumSpec,
  pocket: PocketSpec,
  x: number,
  y: number,
  clearance: number,
): boolean {
  const polygon = pocketBasinPolygon(s, pocket);
  if (!pointInConvexPolygon(polygon, x, y)) return false;
  let edgeDistance = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    edgeDistance = Math.min(edgeDistance, pointSegmentDistance(
      x,
      y,
      polygon[i]!,
      polygon[(i + 1) % polygon.length]!,
    ));
  }
  return edgeDistance >= clearance;
}

/** Bowl height at an actual point. BX-32 maps the radial fraction of its
 * obround boundary into the same molded cross-section as its short axis. */
export function surfaceZAt(s: StadiumSpec, x: number, y: number): number {
  const radius = Math.sqrt(x * x + y * y);
  if (radius <= 1e-12) return 0;
  const boundaryRadius = boundaryRadiusAlongUnit(s, x / radius, y / radius);
  const mappedRadius = Math.min(s.rWall, radius * s.rWall / boundaryRadius);
  const bowlZ = surfaceZ(s, mappedRadius);
  // The molded bowl rolls smoothly into the flat rim rather than meeting it
  // at a mathematical crease. Keep this shared by ordinary dish and pocket
  // terrain so a traced concavity has no lighting/physics seam where it
  // crosses the nominal wall boundary.
  const rimBlendWidth = 0.008;
  const blend = smooth01(1 - (s.rWall - mappedRadius) / rimBlendWidth);
  return bowlZ + (surfaceZ(s, s.rWall) - bowlZ) * blend;
}

export function surfaceGradientAt(s: StadiumSpec, x: number, y: number): Point2 {
  const h = 0.00025;
  return {
    x: (surfaceZAt(s, x + h, y) - surfaceZAt(s, x - h, y)) / (2 * h),
    y: (surfaceZAt(s, x, y + h) - surfaceZAt(s, x, y - h)) / (2 * h),
  };
}

function smooth01(value: number): number {
  const clamped = Math.max(0, Math.min(1, value));
  return clamped * clamped * (3 - 2 * clamped);
}

interface PocketSurfaceFrame {
  target: Point2;
  path: PocketPath;
  halfAlong: number;
  halfAcross: number;
}

const POCKET_SURFACE_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, PocketSurfaceFrame>>();

function pocketBasinCenter(s: StadiumSpec, pocket: PocketSpec): Point2 {
  const path = pocketPath(s, pocket);
  if (pocket.trace) {
    const points = smoothClosedPocketTrace(pocket.trace.basin);
    let along = 0;
    let across = 0;
    for (const point of points) {
      along += point.along;
      across += point.across;
    }
    return {
      x: path.boundary.x + path.axis.x * along / points.length + path.across.x * across / points.length,
      y: path.boundary.y + path.axis.y * along / points.length + path.across.y * across / points.length,
    };
  }
  const basinDepth = pocket.throat.basinDepth;
  const along = basinDepth === undefined
    ? (pocket.throat.outwardDepth - pocket.throat.inwardDepth) / 2
    : (pocket.throat.outwardDepth * 0.2 + basinDepth) / 2;
  return {
    x: path.boundary.x + path.axis.x * along,
    y: path.boundary.y + path.axis.y * along,
  };
}

function pocketSurfaceFrame(s: StadiumSpec, pocket: PocketSpec): PocketSurfaceFrame {
  const entries = pocketCache(POCKET_SURFACE_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  const target = pocketBasinCenter(s, pocket);
  const path = pocketPath(s, pocket);
  let halfAlong = 0;
  let halfAcross = 0;
  for (const point of pocketBasinPolygon(s, pocket)) {
    const dx = point.x - target.x;
    const dy = point.y - target.y;
    halfAlong = Math.max(halfAlong, Math.abs(dx * path.axis.x + dy * path.axis.y));
    halfAcross = Math.max(halfAcross, Math.abs(dx * path.across.x + dy * path.across.y));
  }
  const frame = { target, path, halfAlong, halfAcross };
  entries.set(pocket, frame);
  return frame;
}

function pocketBoundaryDistance(s: StadiumSpec, pocket: PocketSpec, x: number, y: number): number {
  const polygon = pocketBasinPolygon(s, pocket);
  let distance = Infinity;
  for (let index = 0; index < polygon.length; index++) {
    distance = Math.min(distance, pointSegmentDistance(
      x,
      y,
      polygon[index]!,
      polygon[(index + 1) % polygon.length]!,
    ));
  }
  return distance;
}

function pocketSurroundingZ(s: StadiumSpec, x: number, y: number): number {
  // `surfaceZAt` already clamps outside points to the rim and applies the same
  // molded roll-off on the ordinary battle surface.
  return surfaceZAt(s, x, y);
}

/** Height of the one-piece concave loss-zone surface. It meets the bowl/deck
 * at identical height with zero shoulder derivative, so there is no inserted
 * floor, vertical internal seam, or invisible step at the mouth. */
export function pocketSurfaceZ(s: StadiumSpec, pocket: PocketSpec, x: number, y: number): number {
  const rimZ = pocketSurroundingZ(s, x, y);
  const edgeDistance = pocketBoundaryDistance(s, pocket, x, y);
  const shoulder = smooth01(edgeDistance / STADIUM_GEOMETRY.pocketBasinShoulderM);
  const frame = pocketSurfaceFrame(s, pocket);
  const dx = x - frame.target.x;
  const dy = y - frame.target.y;
  const along = (dx * frame.path.axis.x + dy * frame.path.axis.y) / Math.max(frame.halfAlong, 1e-6);
  const across = (dx * frame.path.across.x + dy * frame.path.across.y) / Math.max(frame.halfAcross, 1e-6);
  const centerBias = smooth01(1 - Math.min(1, along * along + across * across));
  const depression = STADIUM_GEOMETRY.pocketBasinDepthM * shoulder * (0.82 + centerBias * 0.18);
  return rimZ - depression + pocketGuardRiseAt(s, x, y);
}

const POCKET_REST_TARGET_CACHE = new WeakMap<StadiumSpec, WeakMap<PocketSpec, Point2>>();

/** Deterministic visual/rigid-body rest target at the actual low point of the
 * concavity. The depression is superimposed on a sloped bowl, so its traced
 * geometric centroid is not generally where a stationary Bey comes to rest. */
export function pocketExitTarget(s: StadiumSpec, pocket: PocketSpec): Point2 {
  const entries = pocketCache(POCKET_REST_TARGET_CACHE, s);
  const cached = entries.get(pocket);
  if (cached) return cached;
  const polygon = pocketBasinPolygon(s, pocket);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  let best = pocketBasinCenter(s, pocket);
  let bestHeight = pocketSurfaceZ(s, pocket, best.x, best.y);
  const divisions = 24;
  for (let iy = 0; iy <= divisions; iy++) {
    const y = minY + (maxY - minY) * iy / divisions;
    for (let ix = 0; ix <= divisions; ix++) {
      const x = minX + (maxX - minX) * ix / divisions;
      if (!pointInConvexPolygon(polygon, x, y)) continue;
      const height = pocketSurfaceZ(s, pocket, x, y);
      if (height < bestHeight) {
        best = { x, y };
        bestHeight = height;
      }
    }
  }
  let stepX = (maxX - minX) / divisions;
  let stepY = (maxY - minY) / divisions;
  for (let refinement = 0; refinement < 14; refinement++) {
    let next = best;
    let nextHeight = bestHeight;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const x = best.x + ox * stepX;
        const y = best.y + oy * stepY;
        if (!pointInConvexPolygon(polygon, x, y)) continue;
        const height = pocketSurfaceZ(s, pocket, x, y);
        if (height < nextHeight) {
          next = { x, y };
          nextHeight = height;
        }
      }
    }
    best = next;
    bestHeight = nextHeight;
    stepX *= 0.5;
    stepY *= 0.5;
  }
  entries.set(pocket, best);
  return best;
}

/** Canonical basin-bottom height used by presentation/tests. */
export function pocketBasinBottomZ(s: StadiumSpec, pocket: PocketSpec): number {
  const target = pocketExitTarget(s, pocket);
  return pocketSurfaceZ(s, pocket, target.x, target.y);
}

function terrainHeightAt(s: StadiumSpec, x: number, y: number): Pick<StadiumTerrainSample, "height" | "region" | "pocket"> {
  const pocket = pocketAtPoint(s, x, y);
  if (pocket) {
    return { height: pocketSurfaceZ(s, pocket, x, y), region: "pocket", pocket };
  }

  const boundaryDistance = stadiumBoundarySignedDistance(s, x, y);
  const radius = Math.sqrt(x * x + y * y);
  let sampleX = x;
  let sampleY = y;
  if (boundaryDistance > 0 && radius > 1e-12) {
    const boundaryRadius = boundaryRadiusAlongUnit(s, x / radius, y / radius);
    sampleX = x * boundaryRadius / radius;
    sampleY = y * boundaryRadius / radius;
  }
  let height = surfaceZAt(s, sampleX, sampleY) + pocketGuardRiseAt(s, x, y);
  let region: StadiumTerrainSample["region"] = boundaryDistance > 0 ? "outside" : "bowl";
  if (boundaryDistance <= 0) {
    const closestRail = railClosestPoint(s, x, y);
    const railDistance = closestRail.distance;
    const onRailArc = s.railArcs.some((arc) => inArc(arc, closestRail.theta));
    if (onRailArc && railDistance <= (s.railPhysicalHalfWidth ?? STADIUM_GEOMETRY.railPhysicalHalfWidthM)) {
      const toothHalfDepth = STADIUM_GEOMETRY.railToothDepthM / 2;
      const toothProfile = Math.max(0, 1 - railDistance / toothHalfDepth);
      height += STADIUM_GEOMETRY.railChannelThicknessM +
        STADIUM_GEOMETRY.railToothHeightM * toothProfile;
      region = "rail";
    }
  }
  return { height, region, pocket: null };
}

/** Canonical terrain sample shared by rendered geometry and rigid debris. */
export function stadiumTerrainAt(s: StadiumSpec, x: number, y: number): StadiumTerrainSample {
  const center = terrainHeightAt(s, x, y);
  // Fine enough to resolve the C1 shoulder of a molded loss-zone basin
  // without turning its position-matched rim into an artificial normal seam.
  const h = 0.0001;
  // Differentiate the complete physical envelope, including pocket ramps and
  // the narrow trapezoidal rack profile—not merely the underlying bowl.
  const dzdx = (terrainHeightAt(s, x + h, y).height - terrainHeightAt(s, x - h, y).height) / (2 * h);
  const dzdy = (terrainHeightAt(s, x, y + h).height - terrainHeightAt(s, x, y - h).height) / (2 * h);
  const normalLength = Math.sqrt(dzdx * dzdx + dzdy * dzdy + 1);
  return {
    ...center,
    normalX: -dzdx / normalLength,
    normalY: -dzdy / normalLength,
    normalZ: 1 / normalLength,
  };
}

/** Surface height above center, z(r). Purely for rendering + energy. */
export function surfaceZ(s: StadiumSpec, r: number): number {
  if (r <= s.rDish) {
    const t = r / s.rDish;
    return s.dishDepth * t * t;
  }
  const t = (r - s.rDish) / (s.rWall - s.rDish);
  return s.dishDepth + s.rimRise * t * t + s.rimBaseSlope * (r - s.rDish);
}

/** Radial slope dz/dr — gravity restoring force is g·slope inward. */
export function surfaceSlope(s: StadiumSpec, r: number): number {
  if (r <= s.rDish) return (2 * s.dishDepth * r) / (s.rDish * s.rDish);
  const t = (r - s.rDish) / (s.rWall - s.rDish);
  return (2 * s.rimRise * t) / (s.rWall - s.rDish) + s.rimBaseSlope;
}

// ---- rail curve (deterministic — used by the sim) -------------------------

interface RailTraceSegment {
  segment: CompiledRailSegment;
  index: number;
  u: number;
}

interface CompiledRailSegment {
  a: RailTracePoint;
  b: RailTracePoint;
  pa: Point2;
  pb: Point2;
  /** Chord, retained for exact linear jogs and nearest-point seeding. */
  dx: number;
  dy: number;
  length: number;
  length2: number;
  angleWidth: number;
  linear: boolean;
  /** Cubic-Hermite endpoint derivatives scaled from dP/dθ to dP/du. */
  m0x: number;
  m0y: number;
  m1x: number;
  m1y: number;
}

const COMPILED_RAIL_TRACES = new WeakMap<readonly RailTracePoint[], readonly CompiledRailSegment[]>();
interface RailBvhNode {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  left: number;
  right: number;
  start: number;
  count: number;
}
interface RailBvh {
  nodes: readonly RailBvhNode[];
  segmentIndices: readonly number[];
  /** Reused by synchronous deterministic queries; avoids hot-path garbage. */
  queryStack: Int32Array;
}
const RAIL_BVH_LEAF_SEGMENTS = 1;
const COMPILED_RAIL_BVHS = new WeakMap<readonly RailTracePoint[], RailBvh>();

function compiledRailTrace(trace: readonly RailTracePoint[]): readonly CompiledRailSegment[] {
  const cached = COMPILED_RAIL_TRACES.get(trace);
  if (cached) return cached;
  const points = trace.map(traceControlPoint);
  const segmentCount = trace.length - 1;
  const fullTurn = PI * 2;
  const linearSegment = (index: number): boolean => Boolean(trace[index]?.linearToNext);
  const derivativeAt = (controlIndex: number): Point2 => {
    // The final +π point duplicates -π. Use the same centered derivative on
    // both sides so the molded loop closes without a shading/normal seam.
    const index = controlIndex === segmentCount ? 0 : controlIndex;
    const previousSegment = index === 0 ? segmentCount - 1 : index - 1;
    const nextSegment = index;
    const previousIsSmooth = !linearSegment(previousSegment);
    const nextIsSmooth = !linearSegment(nextSegment);
    const current = points[index]!;
    const currentAngle = trace[index]!.angle;
    const previousIndex = index === 0 ? segmentCount - 1 : index - 1;
    const nextIndex = index + 1;
    const previous = points[previousIndex]!;
    const next = points[nextIndex]!;
    const previousAngle = index === 0
      ? trace[previousIndex]!.angle - fullTurn
      : trace[previousIndex]!.angle;
    const nextAngle = trace[nextIndex]!.angle;

    if (previousIsSmooth && nextIsSmooth) {
      const width = nextAngle - previousAngle;
      return width > 1e-12
        ? { x: (next.x - previous.x) / width, y: (next.y - previous.y) / width }
        : { x: 0, y: 0 };
    }
    if (nextIsSmooth) {
      const width = nextAngle - currentAngle;
      return width > 1e-12
        ? { x: (next.x - current.x) / width, y: (next.y - current.y) / width }
        : { x: 0, y: 0 };
    }
    if (previousIsSmooth) {
      const width = currentAngle - previousAngle;
      return width > 1e-12
        ? { x: (current.x - previous.x) / width, y: (current.y - previous.y) / width }
        : { x: 0, y: 0 };
    }
    return { x: 0, y: 0 };
  };

  const compiled: CompiledRailSegment[] = [];
  for (let index = 0; index < segmentCount; index++) {
    const a = trace[index]!;
    const b = trace[index + 1]!;
    const pa = points[index]!;
    const pb = points[index + 1]!;
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const length2 = dx * dx + dy * dy;
    const angleWidth = b.angle - a.angle;
    const d0 = derivativeAt(index);
    const d1 = derivativeAt(index + 1);
    compiled.push({
      a,
      b,
      pa,
      pb,
      dx,
      dy,
      length2,
      length: Math.sqrt(length2),
      angleWidth,
      linear: linearSegment(index),
      m0x: d0.x * angleWidth,
      m0y: d0.y * angleWidth,
      m1x: d1.x * angleWidth,
      m1y: d1.y * angleWidth,
    });
  }
  COMPILED_RAIL_TRACES.set(trace, compiled);
  // Parametric raster traces contain inset/radial shoulders, so neither polar
  // bearing nor loop parameter identifies the globally nearest span for an
  // interior query. Build a deterministic flat BVH over exact cubic Bezier
  // control-hull AABBs. Point-to-box lower bounds make the result global while
  // the nearer-child-first traversal avoids scanning hundreds of dense spans.
  const segmentBounds = compiled.map((segment) => {
    const controls = segment.linear
      ? [segment.pa, segment.pb]
      : [
          segment.pa,
          { x: segment.pa.x + segment.m0x / 3, y: segment.pa.y + segment.m0y / 3 },
          { x: segment.pb.x - segment.m1x / 3, y: segment.pb.y - segment.m1y / 3 },
          segment.pb,
        ];
    const minX = Math.min(...controls.map((point) => point.x));
    const maxX = Math.max(...controls.map((point) => point.x));
    const minY = Math.min(...controls.map((point) => point.y));
    const maxY = Math.max(...controls.map((point) => point.y));
    return { minX, maxX, minY, maxY };
  });
  const nodes: RailBvhNode[] = [];
  const orderedLeafSegments: number[] = [];
  const buildNode = (indices: number[]): number => {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const index of indices) {
      const bounds = segmentBounds[index]!;
      minX = Math.min(minX, bounds.minX);
      maxX = Math.max(maxX, bounds.maxX);
      minY = Math.min(minY, bounds.minY);
      maxY = Math.max(maxY, bounds.maxY);
    }
    const nodeIndex = nodes.length;
    nodes.push({ minX, maxX, minY, maxY, left: -1, right: -1, start: -1, count: 0 });
    if (indices.length <= RAIL_BVH_LEAF_SEGMENTS) {
      indices.sort((a, b) => a - b);
      const start = orderedLeafSegments.length;
      orderedLeafSegments.push(...indices);
      nodes[nodeIndex] = { minX, maxX, minY, maxY, left: -1, right: -1, start, count: indices.length };
      return nodeIndex;
    }
    const splitX = maxX - minX >= maxY - minY;
    indices.sort((a, b) => {
      const first = segmentBounds[a]!;
      const second = segmentBounds[b]!;
      const delta = splitX
        ? first.minX + first.maxX - second.minX - second.maxX
        : first.minY + first.maxY - second.minY - second.maxY;
      return delta || a - b;
    });
    const middle = indices.length >>> 1;
    const left = buildNode(indices.slice(0, middle));
    const right = buildNode(indices.slice(middle));
    nodes[nodeIndex] = { minX, maxX, minY, maxY, left, right, start: -1, count: 0 };
    return nodeIndex;
  };
  buildNode(compiled.map((_segment, index) => index));
  COMPILED_RAIL_BVHS.set(trace, {
    nodes,
    segmentIndices: orderedLeafSegments,
    queryStack: new Int32Array(nodes.length),
  });
  return compiled;
}

function railTraceSegmentAt(trace: readonly RailTracePoint[], theta: number): RailTraceSegment {
  const angle = wrapAngle(theta);
  const compiled = compiledRailTrace(trace);
  // Lower-bound on segment end preserves the old exact-knot convention: a
  // sharp knot belongs to its incoming segment, while smooth knots are C1.
  let low = 0;
  let high = compiled.length - 1;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (angle <= compiled[middle]!.b.angle) high = middle;
    else low = middle + 1;
  }
  const index = angle <= trace[0]!.angle ? 0 : low;
  const segment = compiled[index]!;
  const u = segment.angleWidth > 1e-12
    ? Math.max(0, Math.min(1, (angle - segment.a.angle) / segment.angleWidth))
    : 0;
  return { segment, index, u };
}

function traceControlPoint(point: RailTracePoint): Point2 {
  if (point.x !== undefined && point.y !== undefined) return { x: point.x, y: point.y };
  return {
    x: point.radius * dcos(point.angle),
    y: point.radius * dsin(point.angle),
  };
}

function pointOnRailSegment(segment: CompiledRailSegment, u: number): Point2 {
  if (segment.linear) {
    return { x: segment.pa.x + segment.dx * u, y: segment.pa.y + segment.dy * u };
  }
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  return {
    x: h00 * segment.pa.x + h10 * segment.m0x + h01 * segment.pb.x + h11 * segment.m1x,
    y: h00 * segment.pa.y + h10 * segment.m0y + h01 * segment.pb.y + h11 * segment.m1y,
  };
}

function derivativeOnRailSegment(segment: CompiledRailSegment, u: number): Point2 {
  if (segment.linear) return { x: segment.dx, y: segment.dy };
  const u2 = u * u;
  const h00 = 6 * u2 - 6 * u;
  const h10 = 3 * u2 - 4 * u + 1;
  const h01 = -6 * u2 + 6 * u;
  const h11 = 3 * u2 - 2 * u;
  return {
    x: h00 * segment.pa.x + h10 * segment.m0x + h01 * segment.pb.x + h11 * segment.m1x,
    y: h00 * segment.pa.y + h10 * segment.m0y + h01 * segment.pb.y + h11 * segment.m1y,
  };
}

function secondDerivativeOnRailSegment(segment: CompiledRailSegment, u: number): Point2 {
  if (segment.linear) return { x: 0, y: 0 };
  const h00 = 12 * u - 6;
  const h10 = 6 * u - 4;
  const h01 = -12 * u + 6;
  const h11 = 6 * u - 2;
  return {
    x: h00 * segment.pa.x + h10 * segment.m0x + h01 * segment.pb.x + h11 * segment.m1x,
    y: h00 * segment.pa.y + h10 * segment.m0y + h01 * segment.pb.y + h11 * segment.m1y,
  };
}

function tracedRailPointAt(trace: readonly RailTracePoint[], theta: number): Point2 {
  const { segment, u } = railTraceSegmentAt(trace, theta);
  return pointOnRailSegment(segment, u);
}

/** Radial distance of the Xtreme Line at periodic path parameter θ. */
export function railRadiusAt(s: StadiumSpec, theta: number): number {
  const trace = s.railTrace;
  if (trace && trace.length >= 2) {
    const point = tracedRailPointAt(trace, theta);
    return Math.sqrt(point.x * point.x + point.y * point.y);
  }
  let r = s.rRail;
  const e = s.railEllipse;
  if (e) {
    const cx = e.b * dcos(theta);
    const cy = e.a * dsin(theta);
    r = (s.rRail * e.a * e.b) / Math.sqrt(cx * cx + cy * cy);
  }
  for (const d of s.railDips ?? []) {
    const u = wrapAngle(theta - d.center) / d.halfWidth;
    if (u > -1 && u < 1) {
      r -= s.rRail * d.depth * 0.5 * (1 + dcos(PI * u));
    }
  }
  return r;
}

/** Point on the rail curve. */
export function railPointAt(s: StadiumSpec, theta: number): { x: number; y: number } {
  if (s.railTrace && s.railTrace.length >= 2) return tracedRailPointAt(s.railTrace, theta);
  const r = railRadiusAt(s, theta);
  return { x: r * dcos(theta), y: r * dsin(theta) };
}

/** Unit tangent of the rail curve (central difference — deterministic). */
export function railTangentAt(s: StadiumSpec, theta: number): { x: number; y: number } {
  if (s.railTrace && s.railTrace.length >= 2) {
    const { segment, u } = railTraceSegmentAt(s.railTrace, theta);
    const derivative = derivativeOnRailSegment(segment, u);
    const length = Math.sqrt(derivative.x * derivative.x + derivative.y * derivative.y);
    if (length > 1e-12) return { x: derivative.x / length, y: derivative.y / length };
  }
  const h = 0.001;
  const p0 = railPointAt(s, theta - h);
  const p1 = railPointAt(s, theta + h);
  const dx = p1.x - p0.x;
  const dy = p1.y - p0.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  return len > 1e-12 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
}

export interface RailClosestPoint {
  theta: number;
  point: Point2;
  tangent: Point2;
  /** Perpendicular oriented toward the product wall. */
  normal: Point2;
  /** Signed distance along `normal`; positive is outside the rack. */
  signedDistance: number;
  distance: number;
}

interface RailSegmentNearest {
  u: number;
  point: Point2;
  tangent: Point2;
  distance2: number;
}

function nearestPointOnRailSegment(segment: CompiledRailSegment, x: number, y: number): RailSegmentNearest {
  let u = segment.length2 > 1e-14
    ? Math.max(0, Math.min(1, ((x - segment.pa.x) * segment.dx + (y - segment.pa.y) * segment.dy) / segment.length2))
    : 0;
  if (!segment.linear) {
    // A few bounded Newton projections are enough for these low-curvature
    // photo traces. This avoids scanning a dense LUT on every 240 Hz tick.
    for (let iteration = 0; iteration < 3; iteration++) {
      const point = pointOnRailSegment(segment, u);
      const first = derivativeOnRailSegment(segment, u);
      const second = secondDerivativeOnRailSegment(segment, u);
      const rx = point.x - x;
      const ry = point.y - y;
      const numerator = rx * first.x + ry * first.y;
      const denominator = first.x * first.x + first.y * first.y + rx * second.x + ry * second.y;
      if (Math.abs(denominator) <= 1e-14) break;
      const next = Math.max(0, Math.min(1, u - numerator / denominator));
      if (Math.abs(next - u) <= 1e-8) {
        u = next;
        break;
      }
      u = next;
    }
  }
  let point = pointOnRailSegment(segment, u);
  let distance2 = (point.x - x) ** 2 + (point.y - y) ** 2;
  // Newton may settle at a non-minimum on a very short transition. Endpoints
  // make the local solve conservative without expanding the hot-path search.
  const startDistance2 = (segment.pa.x - x) ** 2 + (segment.pa.y - y) ** 2;
  if (startDistance2 < distance2) {
    u = 0;
    point = segment.pa;
    distance2 = startDistance2;
  }
  const endDistance2 = (segment.pb.x - x) ** 2 + (segment.pb.y - y) ** 2;
  if (endDistance2 < distance2) {
    u = 1;
    point = segment.pb;
    distance2 = endDistance2;
  }
  const derivative = derivativeOnRailSegment(segment, u);
  const tangentLength = Math.sqrt(derivative.x * derivative.x + derivative.y * derivative.y);
  const tangent = tangentLength > 1e-12
    ? { x: derivative.x / tangentLength, y: derivative.y / tangentLength }
    : { x: 1, y: 0 };
  return { u, point, tangent, distance2 };
}

function railBvhNodeDistance2(node: RailBvhNode, x: number, y: number): number {
  const dx = x < node.minX ? node.minX - x : x > node.maxX ? x - node.maxX : 0;
  const dy = y < node.minY ? node.minY - y : y > node.maxY ? y - node.maxY : 0;
  return dx * dx + dy * dy;
}

/** Deterministic globally closest-point solve on the shared traced centerline.
 * The flat Bezier-hull BVH bounds the hot-path candidate set without
 * assuming the nearest bay/shoulder shares the query's polar bearing. */
export function railClosestPoint(s: StadiumSpec, x: number, y: number): RailClosestPoint {
  let theta: number;
  let point: Point2;
  let tangent: Point2;
  let bestDistance2 = Infinity;
  if (s.railTrace && s.railTrace.length >= 2) {
    const compiled = compiledRailTrace(s.railTrace);
    const bvh = COMPILED_RAIL_BVHS.get(s.railTrace)!;
    theta = compiled[0]!.a.angle;
    point = compiled[0]!.pa;
    tangent = { x: 1, y: 0 };
    const stack = bvh.queryStack;
    let stackSize = 1;
    stack[0] = 0;
    while (stackSize > 0) {
      const node = bvh.nodes[stack[--stackSize]!]!;
      if (railBvhNodeDistance2(node, x, y) >= bestDistance2) continue;
      if (node.count > 0) {
        const end = node.start + node.count;
        for (let offset = node.start; offset < end; offset++) {
          const index = bvh.segmentIndices[offset]!;
          const segment = compiled[index]!;
          const nearest = nearestPointOnRailSegment(segment, x, y);
          if (nearest.distance2 >= bestDistance2) continue;
          bestDistance2 = nearest.distance2;
          theta = segment.a.angle + segment.angleWidth * nearest.u;
          point = nearest.point;
          tangent = nearest.tangent;
        }
        continue;
      }
      const left = bvh.nodes[node.left]!;
      const right = bvh.nodes[node.right]!;
      const leftDistance2 = railBvhNodeDistance2(left, x, y);
      const rightDistance2 = railBvhNodeDistance2(right, x, y);
      // Stack is LIFO: append the farther child first so the nearer child can
      // tighten the best bound before the farther subtree is reconsidered.
      if (leftDistance2 <= rightDistance2) {
        if (rightDistance2 < bestDistance2) stack[stackSize++] = node.right;
        if (leftDistance2 < bestDistance2) stack[stackSize++] = node.left;
      } else {
        if (leftDistance2 < bestDistance2) stack[stackSize++] = node.left;
        if (rightDistance2 < bestDistance2) stack[stackSize++] = node.right;
      }
    }
  } else {
    theta = datan2(y, x);
    let step = 0.08;
    for (let pass = 0; pass < 7; pass++) {
      let bestTheta = theta;
      for (const candidate of [theta - step, theta, theta + step]) {
        const candidatePoint = railPointAt(s, candidate);
        const distance2 = (candidatePoint.x - x) ** 2 + (candidatePoint.y - y) ** 2;
        if (distance2 < bestDistance2) {
          bestDistance2 = distance2;
          bestTheta = candidate;
        }
      }
      theta = bestTheta;
      step *= 0.5;
    }
    theta = wrapAngle(theta);
    point = railPointAt(s, theta);
    tangent = railTangentAt(s, theta);
  }
  let nx = -tangent.y;
  let ny = tangent.x;
  if (nx * point.x + ny * point.y < 0) {
    nx = -nx;
    ny = -ny;
  }
  const signedDistance = (x - point.x) * nx + (y - point.y) * ny;
  return {
    theta,
    point,
    tangent,
    normal: { x: nx, y: ny },
    signedDistance,
    distance: Math.sqrt(bestDistance2),
  };
}

/** Shape-driven inward launch direction on an explicit product ramp. */
export function railReleaseDirectionAt(
  s: StadiumSpec,
  theta: number,
  direction: 1 | -1,
): Point2 | null {
  if (!(s.railReleaseArcs ?? []).some((arc) => inArc(arc, theta))) return null;
  const point = railPointAt(s, theta);
  const radius = Math.sqrt(point.x * point.x + point.y * point.y);
  if (radius <= 1e-12) return null;
  const tangent = railTangentAt(s, theta);
  const travel = { x: tangent.x * direction, y: tangent.y * direction };
  const radialDot = travel.x * point.x / radius + travel.y * point.y / radius;
  // Only the near-radial, photo-traced shoulder may release. This threshold
  // excludes the round elbow itself: the departing tangent then intersects a
  // centered Bey envelope instead of merely skimming the inner bowl.
  return radialDot < -0.97 ? travel : null;
}

export function inArc(arc: RailArc, angle: number): boolean {
  // full-circle arcs (e.g. {-π, π}) must not collapse under wrapping
  if (arc.end - arc.start >= 6.283185 - 1e-6) return true;
  const a = wrapAngle(angle);
  const s = wrapAngle(arc.start);
  const e = wrapAngle(arc.end);
  return s <= e ? a >= s && a <= e : a >= s || a <= e;
}

/** Pocket containing the given angle, if any. */
export function pocketAt(s: StadiumSpec, angle: number): PocketSpec | null {
  for (const p of s.pockets) {
    if (Math.abs(wrapAngle(angle - p.angleCenter)) <= p.halfWidth) return p;
  }
  return null;
}
