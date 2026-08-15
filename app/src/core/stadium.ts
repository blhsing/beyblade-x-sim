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

import { PI, wrapAngle } from "./fxmath";

export interface PocketSpec {
  angleCenter: number;
  halfWidth: number;
  kind: "over" | "xtreme";
}

export interface RailArc {
  start: number; // radians, ccw from start to end
  end: number;
}

export interface StadiumSpec {
  name: string;
  labelZh: string;
  rDish: number; // tornado ridge radius (m) — main battle bowl
  dishDepth: number; // z drop from ridge to center (m)
  rWall: number; // wall radius (m)
  rimRise: number; // z rise from ridge to wall (m)
  rimBaseSlope: number; // constant extra slope on the rim band
  rRail: number; // xtreme line radius (m)
  railHalfWidth: number; // radial capture band of the gear rack (m)
  railArcs: RailArc[];
  railColor: number; // render hint
  pockets: PocketSpec[];
  wallRestitution: number;
  exitSpeed: number; // min outward radial speed to fall into a pocket (m/s)
  deckW: number; // outer body width (m, render)
  deckH: number; // outer body depth (m, render)
  bodyColor: number; // render hint
  shootAngles: number[]; // marked shoot positions (render)
}

/** BX-10 Xtreme Stadium — the official 1v1 tournament stadium. */
export const STADIUM_BX10: StadiumSpec = {
  name: "bx10",
  labelZh: "BX-10 X戰鬥盤",
  rDish: 0.105,
  dishDepth: 0.012,
  rWall: 0.15,
  rimRise: 0.02,
  rimBaseSlope: 0.1,
  rRail: 0.126,
  railHalfWidth: 0.011,
  // the gear ring circles the whole bowl; dashes release toward the exits
  railArcs: [{ start: -PI, end: PI }],
  railColor: 0x5a70d6,
  pockets: [
    { angleCenter: -1.5707963, halfWidth: 0.42, kind: "xtreme" },
    { angleCenter: -2.53, halfWidth: 0.24, kind: "over" },
    { angleCenter: -0.61, halfWidth: 0.24, kind: "over" },
  ],
  wallRestitution: 0.52,
  exitSpeed: 0.45,
  deckW: 0.455,
  deckH: 0.44,
  bodyColor: 0x27335f,
  shootAngles: [2.3562, 0.7854],
};

/** BX-32 Wide Xtreme Stadium — 3-player official; ⚠ dimensions estimated. */
export const STADIUM_BX32: StadiumSpec = {
  name: "wide",
  labelZh: "BX-32 寬型X戰鬥盤",
  rDish: 0.132,
  dishDepth: 0.014,
  rWall: 0.185,
  rimRise: 0.022,
  rimBaseSlope: 0.09,
  rRail: 0.156,
  railHalfWidth: 0.012,
  // two indigo X-lines sweeping into the corner Xtreme Zones
  railArcs: [
    { start: -3.05, end: -1.75 },
    { start: -1.39, end: -0.09 },
  ],
  railColor: 0x6b52c9,
  pockets: [
    { angleCenter: -2.53, halfWidth: 0.3, kind: "xtreme" },
    { angleCenter: -0.61, halfWidth: 0.3, kind: "xtreme" },
    { angleCenter: -1.5707963, halfWidth: 0.28, kind: "over" },
  ],
  wallRestitution: 0.52,
  exitSpeed: 0.45,
  deckW: 0.56,
  deckH: 0.47,
  bodyColor: 0xdfe3ee,
  shootAngles: [2.618, 0.5236, 1.5708],
};

/** Legacy Burst-style stadium: no rail, no xtreme zone, round pockets. */
export const STADIUM_BURST_STD: StadiumSpec = {
  name: "burstStd",
  labelZh: "標準戰鬥盤（無X衝擊線）",
  rDish: 0.1,
  dishDepth: 0.014,
  rWall: 0.14,
  rimRise: 0.016,
  rimBaseSlope: 0.08,
  rRail: 0,
  railHalfWidth: 0,
  railArcs: [],
  railColor: 0x444444,
  pockets: [
    { angleCenter: -1.5707963, halfWidth: 0.3, kind: "over" },
    { angleCenter: 0.5235988, halfWidth: 0.3, kind: "over" },
    { angleCenter: 2.6179939, halfWidth: 0.3, kind: "over" },
  ],
  wallRestitution: 0.5,
  exitSpeed: 0.3,
  deckW: 0.4,
  deckH: 0.4,
  bodyColor: 0x333a55,
  shootAngles: [2.3562, 0.7854],
};

export const STADIUMS: Record<string, StadiumSpec> = {
  bx10: STADIUM_BX10,
  wide: STADIUM_BX32,
  burstStd: STADIUM_BURST_STD,
};

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

export function inArc(arc: RailArc, angle: number): boolean {
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
