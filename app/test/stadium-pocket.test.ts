import { describe, expect, it } from "vitest";

import {
  pocketAtPoint,
  pocketCatchPolygon,
  pocketExitTarget,
  pocketPath,
  pocketPolygon,
  pocketSecureAtPoint,
  railClosestPoint,
  railPointAt,
  railReleaseDirectionAt,
  stadiumBoundaryRadiusAt,
  stadiumBoundarySignedDistance,
  stadiumBodyRadiusAt,
  STADIUM_BX10,
  STADIUM_BX32,
  type StadiumSpec,
} from "../src/core/stadium";
import {
  createWorld,
  POCKET_DWELL_TICKS,
  step,
} from "../src/core/sim";
import type { BeyParams, WorldConfig } from "../src/core/types";

const params: BeyParams = {
  label: "pocket-fixture",
  massKg: 0.04,
  radiusM: 0.02625, // widest authored upper part (52.5 mm)
  inertia: 0.000012,
  cogHeightM: 0.012,
  attackFactor: 1,
  attackVariance: 0,
  defenseFactor: 1,
  burstRes: 100,
  dashFactor: 0,
  grip: 0,
  muSpin: 0.08,
  muMove: 0.8,
  spinDir: 1,
  latchCount: 3,
  staminaFactor: 1,
};

function config(count = 1): WorldConfig {
  return {
    seed: 0x51ad1a,
    beys: Array.from({ length: count }, () => ({ ...params })),
    launches: Array.from({ length: count }, () => ({
      sp: 7000,
      aimDeg: 0,
      tiltDeg: 0,
      launcher: "winder" as const,
      spinDir: 1 as const,
    })),
    xtremeDashEnabled: false,
    clicksMax: 4,
    maxTicks: 20_000,
  };
}

function groundBey(cfg: WorldConfig, stadium: StadiumSpec, pocketIndex: number, omega = 0) {
  const world = createWorld(cfg);
  const bey = world.beys[0]!;
  const pocket = stadium.pockets[pocketIndex]!;
  const target = pocketExitTarget(stadium, pocket);
  Object.assign(bey, {
    x: target.x,
    y: target.y,
    vx: 0,
    vy: 0,
    z: 0,
    vz: 0,
    airborne: false,
    pendingTicks: 0,
    omega,
    pocketIndex,
    pocketDwell: 0,
    railTicks: -1,
  });
  return { world, bey, pocket, target };
}

describe("product-accurate stadium openings", () => {
  it("has exactly the official three apertures and no invented cover gaps", () => {
    expect(STADIUM_BX10.pockets.map((pocket) => pocket.kind)).toEqual(["over", "xtreme", "over"]);
    expect(STADIUM_BX10.pockets).toHaveLength(3);
    expect(STADIUM_BX10.pockets.every((pocket) => Math.sin(pocket.angleCenter) < 0)).toBe(true);
    expect(STADIUM_BX10.coverGaps).toEqual([]);

    expect(STADIUM_BX32.pockets).toHaveLength(3);
    expect(STADIUM_BX32.pockets.filter((pocket) => pocket.kind === "xtreme")).toHaveLength(2);
    expect(STADIUM_BX32.pockets.filter((pocket) => pocket.kind === "over")).toHaveLength(1);
    expect(STADIUM_BX32.pockets.slice(0, 2).every((pocket) => Math.sin(pocket.angleCenter) > 0)).toBe(true);
    expect(STADIUM_BX32.pockets[2]!.angleCenter).toBeCloseTo(-Math.PI / 2, 4);
    expect(STADIUM_BX32.coverGaps).toEqual([]);
  });

  it("uses an obround BX-32 wall and rounded tangential slot outlines", () => {
    expect(STADIUM_BX32.wallShape?.kind).toBe("obround");
    expect(stadiumBoundaryRadiusAt(STADIUM_BX32, 0) - stadiumBoundaryRadiusAt(STADIUM_BX32, Math.PI / 2))
      .toBeCloseTo(0.055, 4);
    for (const pocket of STADIUM_BX32.pockets.slice(0, 2)) {
      expect(pocket.throat.shape).toBe("tangential-slot");
      expect(pocketPolygon(STADIUM_BX32, pocket).length).toBeGreaterThan(40);
      expect(pocket.throat.innerHalfWidth).toBeGreaterThan(params.radiusM);
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("securely contains the widest authored Bey at every tray target in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      const target = pocketExitTarget(stadium, pocket);
      expect(pocketAtPoint(stadium, target.x, target.y)).toBe(pocket);
      expect(pocketSecureAtPoint(stadium, pocket, target.x, target.y, params.radiusM)).toBe(true);
      for (const vertex of pocketCatchPolygon(stadium, pocket)) {
        const angle = Math.atan2(vertex.y, vertex.x);
        expect(Math.hypot(vertex.x, vertex.y)).toBeLessThanOrEqual(stadiumBodyRadiusAt(stadium, angle) + 1e-8);
      }
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("keeps an uninterrupted open throat-to-catch route in %s", (stadium) => {
    for (const pocket of stadium.pockets) {
      const path = pocketPath(stadium, pocket);
      const target = pocketExitTarget(stadium, pocket);
      for (let stepIndex = 0; stepIndex <= 100; stepIndex++) {
        const u = stepIndex / 100;
        const x = path.boundary.x + (target.x - path.boundary.x) * u;
        const y = path.boundary.y + (target.y - path.boundary.y) * u;
        expect(pocketAtPoint(stadium, x, y), `${pocket.id} route gap at ${u}`).toBe(pocket);
      }
    }
  });

  it.each([STADIUM_BX10, STADIUM_BX32])("uses only explicit traced ramps whose actual first release reaches a center Bey in %s", (stadium) => {
    expect(stadium.railTrace?.length).toBeGreaterThan(10);
    let releases = 0;
    for (let i = 0; i <= 720; i++) {
      const angle = -Math.PI + (Math.PI * 2 * i) / 720;
      const onExplicitRamp = (stadium.railReleaseArcs ?? []).some((arc) => angle >= arc.start && angle <= arc.end);
      for (const direction of [1, -1] as const) {
        const release = railReleaseDirectionAt(stadium, angle, direction);
        if (!onExplicitRamp) expect(release).toBeNull();
        if (!release) continue;
        releases++;
        const point = railPointAt(stadium, angle);
        const radius = Math.hypot(point.x, point.y);
        const radialDot = (release.x * point.x + release.y * point.y) / radius;
        expect(radialDot).toBeLessThan(-0.7);
        const forward = -(point.x * release.x + point.y * release.y);
        expect(forward).toBeGreaterThan(0);
      }
    }
    expect(releases).toBeGreaterThan(10);
    for (const direction of [1, -1] as const) {
      let first: { angle: number; x: number; y: number } | null = null;
      for (let i = 0; i <= 12_000; i++) {
        const angle = direction === 1
          ? -Math.PI + (Math.PI * 2 * i) / 12_000
          : Math.PI - (Math.PI * 2 * i) / 12_000;
        const release = railReleaseDirectionAt(stadium, angle, direction);
        if (!release) continue;
        const point = railPointAt(stadium, angle);
        first = { angle, x: point.x * release.y - point.y * release.x, y: 0 };
        break;
      }
      expect(first, `missing ${direction > 0 ? "+" : "-"} release on ${stadium.name}`).not.toBeNull();
      // A straight tangent must enter the contact envelope of a centered pair
      // of maximum authored Beys (2 × 26.25 mm), before bowl gravity helps.
      expect(Math.abs(first!.x), `${stadium.name} direction ${direction} first release at ${first!.angle}`)
        .toBeLessThanOrEqual(params.radiusM * 2);
    }
  });
});

describe("reversible live pocket simulation", () => {
  it.each([STADIUM_BX10, STADIUM_BX32])("releases an engaged attack Bit along the traced inward ramp in %s", (stadium) => {
    const cfg = config();
    cfg.xtremeDashEnabled = true;
    cfg.beys[0] = { ...cfg.beys[0]!, dashFactor: 1.4, grip: 1.2 };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const startAngle = stadium.railReleaseArcs![0]!.start - 0.2;
    const start = railPointAt(stadium, startAngle);
    const next = railPointAt(stadium, startAngle + 0.001);
    const length = Math.hypot(next.x - start.x, next.y - start.y);
    const tangent = { x: (next.x - start.x) / length, y: (next.y - start.y) / length };
    Object.assign(bey, {
      x: start.x,
      y: start.y,
      vx: tangent.x * 1.35,
      vy: tangent.y * 1.35,
      airborne: false,
      pendingTicks: 0,
      omega: 520,
      railTicks: 240,
      railDir: 1,
    });
    for (let i = 0; i < 240 && bey.railTicks > 0; i++) step(world, cfg, stadium, true);
    expect(world.events.some((event) => event.kind === "dashEnd")).toBe(true);
    const radial = Math.hypot(bey.x, bey.y);
    expect((bey.vx * bey.x + bey.vy * bey.y) / radial).toBeLessThan(-0.4);
  });

  it("does not convert a slow inner-mouth graze into pocket occupancy", () => {
    const cfg = config();
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    Object.assign(bey, {
      x: path.boundary.x - path.axis.x * 0.004,
      y: path.boundary.y - path.axis.y * 0.004,
      vx: path.axis.x * 0.15,
      vy: path.axis.y * 0.15,
      airborne: false,
      pendingTicks: 0,
      omega: 200,
    });
    for (let i = 0; i < 30; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(bey.exited).toBeNull();
  });

  it("admits a realistic 1.0 m/s outward crossing through the exact BX-10 throat", () => {
    const cfg = config();
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    const contactClearance = params.radiusM * 0.6;
    Object.assign(bey, {
      x: path.boundary.x - path.axis.x * (contactClearance + 0.001),
      y: path.boundary.y - path.axis.y * (contactClearance + 0.001),
      vx: path.axis.x,
      vy: path.axis.y,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 8 && bey.pocketIndex < 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(1);
    expect(bey.exited).toBeNull();
  });

  it("lets a realistic hit cross the low rack and continue into the BX-10 center throat", () => {
    const cfg = { ...config(), xtremeDashEnabled: true };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const pocket = STADIUM_BX10.pockets[1]!;
    const path = pocketPath(STADIUM_BX10, pocket);
    const rail = railClosestPoint(STADIUM_BX10, path.axis.x * STADIUM_BX10.rRail, path.axis.y * STADIUM_BX10.rRail);
    const startSide = -STADIUM_BX10.railHalfWidth * 0.75 - 0.001;
    Object.assign(bey, {
      x: rail.point.x + rail.normal.x * startSide,
      y: rail.point.y + rail.normal.y * startSide,
      vx: rail.normal.x * 0.9,
      vy: rail.normal.y * 0.9,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 40 && bey.pocketIndex < 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(1);
    expect(bey.exited).toBeNull();
  });

  it("deflects a low-energy outward crossing instead of leaking through the rack", () => {
    const cfg = { ...config(), xtremeDashEnabled: true };
    const world = createWorld(cfg);
    const bey = world.beys[0]!;
    const rail = railClosestPoint(STADIUM_BX10, 0, -STADIUM_BX10.rRail);
    const inner = -STADIUM_BX10.railHalfWidth * 0.75;
    Object.assign(bey, {
      x: rail.point.x + rail.normal.x * (inner - 0.0002),
      y: rail.point.y + rail.normal.y * (inner - 0.0002),
      vx: rail.normal.x * 0.15,
      vy: rail.normal.y * 0.15,
      airborne: false,
      pendingTicks: 0,
      omega: 240,
    });
    for (let i = 0; i < 8; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(stadiumBoundarySignedDistance(STADIUM_BX10, bey.x, bey.y)).toBeLessThan(0);
    expect(bey.vx * rail.normal.x + bey.vy * rail.normal.y).toBeLessThanOrEqual(0);
  });

  it("allows a fast entry to rebound and escape back through the open throat", () => {
    const cfg = config();
    const { world, bey, pocket } = groundBey(cfg, STADIUM_BX10, 1, 250);
    const path = pocketPath(STADIUM_BX10, pocket);
    bey.x = path.boundary.x + path.axis.x * 0.008;
    bey.y = path.boundary.y + path.axis.y * 0.008;
    bey.vx = -path.axis.x * 1.2;
    bey.vy = -path.axis.y * 1.2;
    for (let i = 0; i < 120 && bey.pocketIndex >= 0; i++) step(world, cfg, STADIUM_BX10, true);
    expect(bey.pocketIndex).toBe(-1);
    expect(bey.exited).toBeNull();
    expect(bey.alive).toBe(true);
  });

  it("keeps a securely trapped but spinning Bey live", () => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, STADIUM_BX32, 0, 80);
    for (let i = 0; i < POCKET_DWELL_TICKS * 3; i++) step(world, cfg, STADIUM_BX32, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
    expect(bey.alive).toBe(true);
  });

  it.each([
    [STADIUM_BX10, 1, "xtreme"],
    [STADIUM_BX32, 2, "over"],
  ] as const)("scores %s only after a literal full stop and 24 post-collision ticks", (stadium, pocketIndex, kind) => {
    const cfg = config();
    const { world, bey } = groundBey(cfg, stadium, pocketIndex);
    for (let i = 0; i < POCKET_DWELL_TICKS - 1; i++) step(world, cfg, stadium, true);
    expect(bey.exited).toBeNull();
    expect(bey.alive).toBe(true);
    step(world, cfg, stadium, true);
    expect(bey.exited).toBe(kind);
    expect(bey.alive).toBe(false);
  });

  it("resets a nearly complete zone dwell when a collision wakes the Bey", () => {
    const cfg = config(2);
    const { world, bey, pocket, target } = groundBey(cfg, STADIUM_BX10, 1);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    const path = pocketPath(STADIUM_BX10, pocket);
    const attacker = world.beys[1]!;
    Object.assign(attacker, {
      x: target.x + path.across.x * (params.radiusM * 1.85),
      y: target.y + path.across.y * (params.radiusM * 1.85),
      vx: -path.across.x * 0.8,
      vy: -path.across.y * 0.8,
      z: 0,
      vz: 0,
      airborne: false,
      pendingTicks: 0,
      omega: 200,
      pocketIndex: 1,
      pocketDwell: 0,
      railTicks: -1,
    });
    step(world, cfg, STADIUM_BX10, true);
    expect(bey.exited).toBeNull();
    expect(bey.pocketDwell).toBe(0);
    expect(bey.pocketIndex).toBe(1);
  });

  it("authorizes a stopped zone loss before the longer global Spin dwell", () => {
    const cfg = config(2);
    const { world, bey } = groundBey(cfg, STADIUM_BX10, 1);
    bey.pocketDwell = POCKET_DWELL_TICKS - 1;
    const rival = world.beys[1]!;
    Object.assign(rival, {
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      z: 0,
      vz: 0,
      airborne: false,
      pendingTicks: 0,
      omega: 300,
    });
    step(world, cfg, STADIUM_BX10);
    expect(world.finish?.type).toBe("xtreme");
    expect(world.finish?.winner).toBe(1);
  });
});
