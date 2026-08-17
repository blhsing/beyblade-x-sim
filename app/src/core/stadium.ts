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
  /** Half-widths at the bowl-side and catch-tray-side ends (m). */
  innerHalfWidth: number;
  outerHalfWidth: number;
  /** How far the throat reaches either side of the nominal bowl boundary. */
  inwardDepth: number;
  outwardDepth: number;
  /** Rotation from the local outward wall normal. Used by BX-32's slots. */
  skew?: number;
  /** Optional broader catch tray behind a narrow visible throat. */
  catchHalfWidth?: number;
  catchDepth?: number;
}

export interface PocketSpec {
  id: string;
  angleCenter: number;
  /** Projected aperture width, retained for UI/debug descriptions only.
   * Collision and rendering use the two-dimensional `throat` polygon. */
  halfWidth: number;
  kind: "over" | "xtreme";
  throat: PocketThroatSpec;
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

/** Photo-traced periodic X-Line control point. Adjacent controls are joined
 * in the product's XY plane, not by a polar-radius interpolation. */
export interface RailTracePoint {
  angle: number;
  radius: number;
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
  railArcs: RailArc[];
  /** Traced inward ramp segments where the Bit leaves the line toward center. */
  railReleaseArcs?: RailArc[];
  /** oval rails (BX-32): x/y scale of the base circle */
  railEllipse?: { a: number; b: number };
  /** concave sections matching the real molded line */
  railDips?: RailDip[];
  /** Product-specific centerline; supersedes ellipse/dip approximations. */
  railTrace?: RailTracePoint[];
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
  rRail: 0.138,
  railHalfWidth: 0.011,
  // the gear ring circles the whole bowl; dashes release toward the exits
  railArcs: [{ start: -PI, end: PI }],
  railReleaseArcs: [
    { start: 0.56, end: 0.64 },
    { start: 0.98, end: 1.06 },
  ],
  // Traced from the official top view: near-circular rack plus the distinctive
  // rear-right inward dogleg that releases an attack toward center.
  railTrace: [
    { angle: -PI, radius: 0.139 },
    { angle: -2.8, radius: 0.139 },
    { angle: -2.45, radius: 0.139 },
    { angle: -2.1, radius: 0.139 },
    { angle: -1.75, radius: 0.138 },
    { angle: -1.4, radius: 0.138 },
    { angle: -1.05, radius: 0.138 },
    { angle: -0.7, radius: 0.138 },
    { angle: -0.35, radius: 0.138 },
    { angle: 0, radius: 0.138 },
    { angle: 0.35, radius: 0.138 },
    { angle: 0.56, radius: 0.138 },
    // Abrupt, near-radial molded jog into the bay. This segment—not a
    // target-seeking impulse—aims a clockwise X-Dash through the center.
    { angle: 0.64, radius: 0.105 },
    { angle: 0.78, radius: 0.104 },
    { angle: 0.92, radius: 0.104 },
    { angle: 0.98, radius: 0.105 },
    // Mirrored outward jog supplies the counter-clockwise inward release.
    { angle: 1.06, radius: 0.138 },
    { angle: 1.4, radius: 0.139 },
    { angle: 1.75, radius: 0.139 },
    { angle: 2.1, radius: 0.139 },
    { angle: 2.45, radius: 0.139 },
    { angle: 2.8, radius: 0.139 },
    { angle: PI, radius: 0.139 },
  ],
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

/** BX-32 Wide Xtreme Stadium — the official 3-player stadium (600 × 440 mm),
 * which is exactly what the free-for-all mode wants. Bowl/rail proportions
 * are scaled from photos; the body size is the published figure. */
export const STADIUM_BX32: StadiumSpec = {
  name: "wide",
  labelZh: "BX-32 寬型X戰鬥盤",
  rDish: 0.15,
  dishDepth: 0.014,
  // The bowl has to leave a deck margin for the exit trays: at 0.21 it came
  // within 10 mm of the 440 mm body's short edge, which left no room for a
  // pocket at all (and no real stadium has its wall flush to the shell).
  rWall: 0.19,
  wallShape: { kind: "obround", halfStraight: 0.055 },
  rimRise: 0.022,
  rimBaseSlope: 0.09,
  rRail: 0.152,
  railHalfWidth: 0.012,
  // one continuous indigo loop following the wide oval bowl…
  railArcs: [{ start: -PI, end: PI }],
  railReleaseArcs: [
    { start: 1.1, end: 1.16 },
    { start: 1.96, end: 2.02 },
  ],
  // Photo-traced obround loop and deep rear-center dogleg. The trace is the
  // shared simulation/render centerline; it is not a stretched circle.
  railTrace: [
    { angle: -PI, radius: 0.178 },
    { angle: -2.7, radius: 0.175 },
    { angle: -2.43, radius: 0.166 },
    { angle: -2.02, radius: 0.151 },
    { angle: -1.57, radius: 0.145 },
    { angle: -1.12, radius: 0.151 },
    { angle: -0.71, radius: 0.166 },
    { angle: 0, radius: 0.178 },
    { angle: 0.46, radius: 0.173 },
    { angle: 0.73, radius: 0.161 },
    { angle: 1.1, radius: 0.146 },
    // The Wide Stadium also uses sharp XY doglegs, not an elliptical cosine
    // depression. Its long inner run forms the rear-center attack bay.
    { angle: 1.16, radius: 0.119 },
    { angle: 1.4, radius: 0.118 },
    { angle: 1.7, radius: 0.118 },
    { angle: 1.96, radius: 0.119 },
    { angle: 2.02, radius: 0.148 },
    { angle: 2.43, radius: 0.161 },
    { angle: 2.75, radius: 0.174 },
    { angle: PI, radius: 0.178 },
  ],
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
        catchHalfWidth: 0.05,
        catchDepth: 0.095,
      },
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
        catchHalfWidth: 0.05,
        catchDepth: 0.095,
      },
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
  // Photo/Bit-engagement calibrated: TT does not publish rack dimensions.
  railToothHeightM: 0.0022,
  railToothBottomWidthM: 0.004,
  railToothTopWidthM: 0.0024,
  railToothDepthM: 0.0048,
  railChannelThicknessM: 0.0007,
  railPhysicalHalfWidthM: 0.0036,
  casingThicknessM: 0.002,
  pocketFloorThicknessM: 0.0035,
  pocketRecessM: 0.028,
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

export function pocketPath(s: StadiumSpec, pocket: PocketSpec): PocketPath {
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
  return {
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
}

/** Exact top-view throat used by simulation, rendering, and burst debris. */
export function pocketPolygon(s: StadiumSpec, pocket: PocketSpec): readonly Point2[] {
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
    return points;
  }
  return [
    { x: f.innerCenter.x + f.across.x * iw, y: f.innerCenter.y + f.across.y * iw },
    { x: f.outerCenter.x + f.across.x * ow, y: f.outerCenter.y + f.across.y * ow },
    { x: f.outerCenter.x - f.across.x * ow, y: f.outerCenter.y - f.across.y * ow },
    { x: f.innerCenter.x - f.across.x * iw, y: f.innerCenter.y - f.across.y * iw },
  ];
}

/** Catch-tray footprint. Usually identical to the throat; BX-32 widens
 * behind each narrow rounded slot so a complete Bey can be retained. */
export function pocketCatchPolygon(s: StadiumSpec, pocket: PocketSpec): readonly Point2[] {
  const catchHalfWidth = pocket.throat.catchHalfWidth;
  const catchDepth = pocket.throat.catchDepth;
  if (catchHalfWidth === undefined || catchDepth === undefined) return pocketPolygon(s, pocket);
  const f = pocketPath(s, pocket);
  const innerAlong = pocket.throat.outwardDepth * 0.22;
  const inner = {
    x: f.boundary.x + f.axis.x * innerAlong,
    y: f.boundary.y + f.axis.y * innerAlong,
  };
  const outer = {
    x: f.boundary.x + f.axis.x * catchDepth,
    y: f.boundary.y + f.axis.y * catchDepth,
  };
  const innerWidth = pocket.throat.outerHalfWidth * 0.95;
  return [
    { x: inner.x + f.across.x * innerWidth, y: inner.y + f.across.y * innerWidth },
    { x: outer.x + f.across.x * catchHalfWidth, y: outer.y + f.across.y * catchHalfWidth },
    { x: outer.x - f.across.x * catchHalfWidth, y: outer.y - f.across.y * catchHalfWidth },
    { x: inner.x - f.across.x * innerWidth, y: inner.y - f.across.y * innerWidth },
  ];
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

/** Entire live pocket terrain (throat plus any broader catch tray). */
export function pocketAtPoint(s: StadiumSpec, x: number, y: number): PocketSpec | null {
  for (const pocket of s.pockets) {
    if (
      pointInConvexPolygon(pocketPolygon(s, pocket), x, y) ||
      pointInConvexPolygon(pocketCatchPolygon(s, pocket), x, y)
    ) return pocket;
  }
  return null;
}

function pointSegmentDistance(point: Point2, a: Point2, b: Point2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  const t = denom > 1e-14
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / denom))
    : 0;
  const px = a.x + dx * t;
  const py = a.y + dy * t;
  return Math.sqrt((point.x - px) ** 2 + (point.y - py) ** 2);
}

/** True only when the Bey center is deep enough for its footprint to be
 * retained by the catch tray, not balanced in the narrow mouth. */
export function pocketSecureAtPoint(
  s: StadiumSpec,
  pocket: PocketSpec,
  x: number,
  y: number,
  clearance: number,
): boolean {
  const polygon = pocketCatchPolygon(s, pocket);
  if (!pointInConvexPolygon(polygon, x, y)) return false;
  let edgeDistance = Infinity;
  for (let i = 0; i < polygon.length; i++) {
    edgeDistance = Math.min(edgeDistance, pointSegmentDistance(
      { x, y },
      polygon[i]!,
      polygon[(i + 1) % polygon.length]!,
    ));
  }
  return edgeDistance >= clearance;
}

/** Top of a modeled catch tray. Kept in core to prevent render/debris drift. */
export function pocketFloorTopZ(s: StadiumSpec): number {
  return surfaceZ(s, s.rWall) - STADIUM_GEOMETRY.pocketRecessM +
    STADIUM_GEOMETRY.pocketFloorThicknessM;
}

/** Bowl height at an actual point. BX-32 maps the radial fraction of its
 * obround boundary into the same molded cross-section as its short axis. */
export function surfaceZAt(s: StadiumSpec, x: number, y: number): number {
  const radius = Math.sqrt(x * x + y * y);
  if (radius <= 1e-12) return 0;
  const boundaryRadius = boundaryRadiusAlongUnit(s, x / radius, y / radius);
  return surfaceZ(s, radius * s.rWall / boundaryRadius);
}

export function surfaceGradientAt(s: StadiumSpec, x: number, y: number): Point2 {
  const h = 0.00025;
  return {
    x: (surfaceZAt(s, x + h, y) - surfaceZAt(s, x - h, y)) / (2 * h),
    y: (surfaceZAt(s, x, y + h) - surfaceZAt(s, x, y - h)) / (2 * h),
  };
}

function pocketProgress(s: StadiumSpec, pocket: PocketSpec, x: number, y: number): number {
  const f = pocketPath(s, pocket);
  const dx = x - f.innerCenter.x;
  const dy = y - f.innerCenter.y;
  const length = pocket.throat.inwardDepth + pocket.throat.outwardDepth;
  return Math.max(0, Math.min(1, (dx * f.axis.x + dy * f.axis.y) / length));
}

/** Height of the sloped pocket throat or recessed tray at a point. */
export function pocketSurfaceZ(s: StadiumSpec, pocket: PocketSpec, x: number, y: number): number {
  const t = pocketProgress(s, pocket, x, y);
  const inner = pocketPath(s, pocket).innerCenter;
  const innerZ = surfaceZAt(s, inner.x, inner.y) - 0.002;
  const smooth = t * t * (3 - 2 * t);
  return innerZ + (pocketFloorTopZ(s) - innerZ) * smooth;
}

/** Deterministic visual/rigid-body rest target within the real catch tray. */
export function pocketExitTarget(s: StadiumSpec, pocket: PocketSpec): Point2 {
  const path = pocketPath(s, pocket);
  const catchDepth = pocket.throat.catchDepth;
  const along = catchDepth === undefined
    ? (pocket.throat.outwardDepth - pocket.throat.inwardDepth) / 2
    : (pocket.throat.outwardDepth * 0.22 + catchDepth) / 2;
  return {
    x: path.boundary.x + path.axis.x * along,
    y: path.boundary.y + path.axis.y * along,
  };
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
  let height = surfaceZAt(s, sampleX, sampleY);
  let region: StadiumTerrainSample["region"] = boundaryDistance > 0 ? "outside" : "bowl";
  if (boundaryDistance <= 0) {
    const closestRail = railClosestPoint(s, x, y);
    const railDistance = closestRail.distance;
    const onRailArc = s.railArcs.some((arc) => inArc(arc, closestRail.theta));
    if (onRailArc && railDistance <= STADIUM_GEOMETRY.railPhysicalHalfWidthM) {
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
  const h = 0.00025;
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
  a: RailTracePoint;
  b: RailTracePoint;
  pa: Point2;
  pb: Point2;
  dx: number;
  dy: number;
  length: number;
  length2: number;
  u: number;
}

type CompiledRailSegment = Omit<RailTraceSegment, "u">;
const COMPILED_RAIL_TRACES = new WeakMap<readonly RailTracePoint[], readonly CompiledRailSegment[]>();

function compiledRailTrace(trace: readonly RailTracePoint[]): readonly CompiledRailSegment[] {
  const cached = COMPILED_RAIL_TRACES.get(trace);
  if (cached) return cached;
  const compiled: CompiledRailSegment[] = [];
  for (let index = 0; index < trace.length - 1; index++) {
    const a = trace[index]!;
    const b = trace[index + 1]!;
    const pa = traceControlPoint(a);
    const pb = traceControlPoint(b);
    const dx = pb.x - pa.x;
    const dy = pb.y - pa.y;
    const length2 = dx * dx + dy * dy;
    compiled.push({ a, b, pa, pb, dx, dy, length2, length: Math.sqrt(length2) });
  }
  COMPILED_RAIL_TRACES.set(trace, compiled);
  return compiled;
}

function railTraceSegmentAt(trace: readonly RailTracePoint[], theta: number): RailTraceSegment {
  const angle = wrapAngle(theta);
  const compiled = compiledRailTrace(trace);
  for (const segment of compiled) {
    if (angle < segment.a.angle || angle > segment.b.angle) continue;
    const width = segment.b.angle - segment.a.angle;
    return { ...segment, u: width > 1e-12 ? (angle - segment.a.angle) / width : 0 };
  }
  const segment = angle <= trace[0]!.angle ? compiled[0]! : compiled[compiled.length - 1]!;
  return { ...segment, u: angle <= trace[0]!.angle ? 0 : 1 };
}

function traceControlPoint(point: RailTracePoint): Point2 {
  return {
    x: point.radius * dcos(point.angle),
    y: point.radius * dsin(point.angle),
  };
}

function tracedRailPointAt(trace: readonly RailTracePoint[], theta: number): Point2 {
  const { pa, dx, dy, u } = railTraceSegmentAt(trace, theta);
  return {
    x: pa.x + dx * u,
    y: pa.y + dy * u,
  };
}

/** Radial distance of the Xtreme Line at polar parameter θ. */
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
    const { dx, dy, length } = railTraceSegmentAt(s.railTrace, theta);
    if (length > 1e-12) return { x: dx / length, y: dy / length };
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

/** Deterministic local closest-point solve on the shared traced centerline. */
export function railClosestPoint(s: StadiumSpec, x: number, y: number): RailClosestPoint {
  let theta: number;
  let point: Point2;
  let tangent: Point2;
  let bestDistance2 = Infinity;
  if (s.railTrace && s.railTrace.length >= 2) {
    const compiled = compiledRailTrace(s.railTrace);
    theta = compiled[0]!.a.angle;
    point = compiled[0]!.pa;
    tangent = { x: 1, y: 0 };
    for (const segment of compiled) {
      const u = segment.length2 > 1e-14
        ? Math.max(0, Math.min(1, ((x - segment.pa.x) * segment.dx + (y - segment.pa.y) * segment.dy) / segment.length2))
        : 0;
      const candidate = { x: segment.pa.x + segment.dx * u, y: segment.pa.y + segment.dy * u };
      const distance2 = (candidate.x - x) ** 2 + (candidate.y - y) ** 2;
      if (distance2 < bestDistance2) {
        bestDistance2 = distance2;
        theta = segment.a.angle + (segment.b.angle - segment.a.angle) * u;
        point = candidate;
        tangent = segment.length > 1e-12
          ? { x: segment.dx / segment.length, y: segment.dy / segment.length }
          : { x: 1, y: 0 };
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
  // Only the nearly radial product jog may release. A loose threshold made
  // ordinary obround tangents look like false sling ramps at the ±Y ends.
  return radialDot < -0.7 ? travel : null;
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
