// The deterministic battle simulation. Fixed timestep, no native trig, one
// PRNG stream — identical results on every device for identical inputs
// (see docs/PHYSICS.md). Rendering interpolates between ticks; the sim never
// depends on wall-clock time.

import { clamp, datan2, dsin, dcos, hashFloats, rngNext, PI } from "./fxmath";
import type { StadiumSpec } from "./stadium";
import { inArc, pocketAt, railRadiusAt, railTangentAt, surfaceSlope } from "./stadium";
import type {
  BeyParams,
  BeyState,
  LaunchParams,
  WorldConfig,
  WorldState,
} from "./types";

export const DT = 1 / 240;
export const TICKS_PER_SECOND = 240;

const G = 9.81;
export const OMEGA_STOP = 30; // rad/s below which a bey has "stopped"

const T = {
  // launch — bowl escape speed is ~0.77 m/s, so entries stay below it and
  // mostly tangential; KOs must come from hits and Xtreme Dash, not launches
  v0Base: 0.35,
  v0PerSp: 0.55 / 11000,
  omega0Base: 250,
  omega0PerSp: 0.055,
  entryRadius: 0.075,
  entryTangentDeg: 68,
  // motion
  driftAccel: 1.35,
  driftSatSpeed: 0.6,
  lowSpinThreshold: 120,
  lowSpinDrag: 1.6,
  spinDecayBase: 130,
  spinDecaySpeed: 26,
  // rail
  railMinSpeed: 0.25,
  railTicks: 36,
  railAccel: 7,
  railSpring: 60,
  railCooldownTicks: 96,
  railFlingRadial: 0.4,
  // collisions (rim slip ≈ 16 m/s at full spin → smash impulse ~0.01–0.02
  // kg·m/s → Δv ~0.3–0.5 m/s and spin loss ~15–40 rad/s per solid hit)
  restitution: 0.25,
  smashScale: 0.0012,
  recoilShare: 0.45,
  spinLossK: 0.5,
  burstNormalK: 2.2,
  burstSmashK: 9,
  burstScale: 650,
  hitEventGapTicks: 6,
  // walls
  wallSpinKick: 0.00012,
  overTopSpeed: 1.9,
};

const LAUNCHER: Record<LaunchParams["launcher"], { v: number; w: number }> = {
  winder: { v: 0.9, w: 1.0 },
  string: { v: 1.05, w: 1.0 },
  hold: { v: 1.0, w: 1.12 },
};

function makeBey(
  params: BeyParams,
  launch: LaunchParams,
  side: 0 | 1,
): BeyState {
  const baseAngle = side === 0 ? PI - 0.55 : 0.55;
  const r0 = T.entryRadius + launch.tiltDeg * 0.0008;
  const x = r0 * dcos(baseAngle);
  const y = r0 * dsin(baseAngle);
  const lk = LAUNCHER[launch.launcher];
  const sp = clamp(launch.sp, 0, 11000);
  const speed = (T.v0Base + sp * T.v0PerSp) * lk.v;
  // aim: velocity points inward, rotated by spin-handed tangent bias + aim
  const inward = baseAngle + PI;
  const bias =
    ((launch.spinDir * T.entryTangentDeg + launch.aimDeg) * PI) / 180;
  const dir = inward + bias;
  const omega =
    launch.spinDir *
    (T.omega0Base + sp * T.omega0PerSp) *
    lk.w *
    params.staminaFactor;
  return {
    x,
    y,
    vx: speed * dcos(dir),
    vy: speed * dsin(dir),
    omega,
    burstDamage: 0,
    alive: true,
    exited: null,
    stoppedTick: -1,
    contacted: false,
    railTicks: 0,
    railDir: 1,
    phase: 0,
  };
}

export function createWorld(cfg: WorldConfig): WorldState {
  return {
    tick: 0,
    rng: cfg.seed >>> 0,
    beys: [
      makeBey(cfg.beys[0], cfg.launches[0], 0),
      makeBey(cfg.beys[1], cfg.launches[1], 1),
    ],
    finish: null,
    draw: false,
    events: [],
    lastHitTick: -999,
  };
}

function rand(w: WorldState): number {
  const r = rngNext(w.rng);
  w.rng = r.state;
  return r.value;
}

function pushEvent(
  w: WorldState,
  kind: WorldState["events"][number]["kind"],
  bey: 0 | 1,
  magnitude: number,
): void {
  if (w.events.length < 4096) {
    w.events.push({ tick: w.tick, kind, bey, magnitude });
  }
}

function stepBey(
  w: WorldState,
  s: StadiumSpec,
  b: BeyState,
  p: BeyParams,
  i: 0 | 1,
  xtremeDash: boolean,
): void {
  const r = Math.sqrt(b.x * b.x + b.y * b.y);
  const ur = r > 1e-9 ? { x: b.x / r, y: b.y / r } : { x: 1, y: 0 };
  const angle = datan2(b.y, b.x);
  const absOmega = Math.abs(b.omega);

  // gravity restoring force down the bowl surface
  const slope = surfaceSlope(s, r);
  let ax = -G * slope * ur.x;
  let ay = -G * slope * ur.y;

  // tornado drift: tip traction converts spin into tangential travel.
  // Grippy (attack) tips additionally wander in petal-shaped loops that cut
  // across the bowl — this is what brings attackers onto center-sitting
  // opponents (deterministic: phase is a pure function of tick + side).
  const tang = { x: -ur.y * p.spinDir, y: ur.x * p.spinDir };
  const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const petal =
    dsin(w.tick * DT * (0.9 + p.grip * 0.5) * 6.2832 + i * 2.1) *
    0.95 *
    Math.min(1, p.grip);
  const cP = dcos(petal);
  const sP = dsin(petal);
  const dirX = tang.x * cP - tang.y * sP;
  const dirY = tang.x * sP + tang.y * cP;
  const driftGain =
    p.grip * T.driftAccel * Math.min(1, absOmega / 600) *
    Math.max(0, 1 - speed / T.driftSatSpeed);
  ax += dirX * driftGain;
  ay += dirY * driftGain;

  // translational damping (+ stumbling when spin is nearly gone)
  const drag =
    p.muMove + (absOmega < T.lowSpinThreshold ? T.lowSpinDrag : 0);
  const dampen = Math.max(0, 1 - drag * DT);
  b.vx = (b.vx + ax * DT) * dampen;
  b.vy = (b.vy + ay * DT) * dampen;

  // spin decay from tip friction (faster while travelling)
  const decay = p.muSpin * (T.spinDecayBase + T.spinDecaySpeed * speed) * DT;
  if (absOmega > decay) b.omega -= Math.sign(b.omega) * decay;
  else b.omega = 0;

  // Xtreme Line (gear rack) engagement — the rack follows the real molded
  // curve (railRadiusAt: oval base + concave dips), so riding through a
  // concave section naturally slings the bey across the stadium.
  if (b.railTicks < 0) b.railTicks++; // cooldown
  if (
    xtremeDash &&
    s.railArcs.length > 0 &&
    b.railTicks === 0 &&
    Math.abs(r - railRadiusAt(s, angle)) < s.railHalfWidth &&
    speed > T.railMinSpeed &&
    absOmega > OMEGA_STOP * 2
  ) {
    for (const arc of s.railArcs) {
      if (inArc(arc, angle)) {
        b.railTicks = T.railTicks;
        const ct = railTangentAt(s, angle);
        const vt = b.vx * ct.x + b.vy * ct.y;
        b.railDir = vt >= 0 ? 1 : -1;
        pushEvent(w, "dashStart", i, speed);
        break;
      }
    }
  }
  if (b.railTicks > 0) {
    const railR = railRadiusAt(s, angle);
    const inBand =
      Math.abs(r - railR) < s.railHalfWidth * 2.5 &&
      s.railArcs.some((a) => inArc(a, angle));
    if (!inBand) {
      // flung off the rack — dart across the stadium
      b.railTicks = -T.railCooldownTicks;
      b.vx += -ur.x * T.railFlingRadial * p.dashFactor;
      b.vy += -ur.y * T.railFlingRadial * p.dashFactor;
      pushEvent(w, "dashEnd", i, Math.sqrt(b.vx * b.vx + b.vy * b.vy));
    } else {
      b.railTicks--;
      const ct = railTangentAt(s, angle);
      const a = T.railAccel * p.dashFactor;
      b.vx += ct.x * b.railDir * a * DT;
      b.vy += ct.y * b.railDir * a * DT;
      // radial spring keeps the gear meshed with the curved rack
      const dr = r - railR;
      b.vx += -ur.x * dr * T.railSpring * DT;
      b.vy += -ur.y * dr * T.railSpring * DT;
      if (b.railTicks === 0) b.railTicks = -T.railCooldownTicks;
    }
  }

  // integrate
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  b.phase += b.omega * DT;

  // wall / pockets
  const r2 = Math.sqrt(b.x * b.x + b.y * b.y);
  const wallR = s.rWall - p.radiusM * 0.6;
  if (r2 > wallR) {
    const u = { x: b.x / r2, y: b.y / r2 };
    const vr = b.vx * u.x + b.vy * u.y;
    const angleNow = datan2(b.y, b.x);
    const pocket = pocketAt(s, angleNow);
    if (pocket && vr > s.exitSpeed) {
      b.exited = pocket.kind;
      b.alive = false;
      pushEvent(w, "exit", i, vr);
      return;
    }
    if (!pocket && vr > T.overTopSpeed) {
      b.exited = "top";
      b.alive = false;
      pushEvent(w, "exit", i, vr);
      return;
    }
    if (vr > 0) {
      // bounce + wall spin-kick (spinning contact walks along the wall)
      b.vx -= (1 + s.wallRestitution) * vr * u.x;
      b.vy -= (1 + s.wallRestitution) * vr * u.y;
      const kick = p.spinDir * Math.min(0.3, Math.abs(b.omega) * T.wallSpinKick);
      b.vx += -u.y * kick;
      b.vy += u.x * kick;
      pushEvent(w, "wallHit", i, vr);
    }
    const over = r2 - wallR;
    b.x -= u.x * over;
    b.y -= u.y * over;
  }

  // spin finish detection
  if (Math.abs(b.omega) < OMEGA_STOP && b.stoppedTick < 0) {
    b.stoppedTick = w.tick;
  }
}

function collide(w: WorldState, cfg: WorldConfig): void {
  const [b1, b2] = w.beys;
  const [p1, p2] = cfg.beys;
  if (!b1.alive || !b2.alive) return;
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = p1.radiusM + p2.radiusM;
  if (dist >= minDist || dist < 1e-9) return;

  const n = { x: dx / dist, y: dy / dist };
  const t = { x: -n.y, y: n.x };

  // separate
  const overlap = minDist - dist;
  b1.x -= n.x * overlap * 0.5;
  b1.y -= n.y * overlap * 0.5;
  b2.x += n.x * overlap * 0.5;
  b2.y += n.y * overlap * 0.5;

  // normal impulse
  const rvx = b2.vx - b1.vx;
  const rvy = b2.vy - b1.vy;
  const vn = rvx * n.x + rvy * n.y;
  let jn = 0;
  if (vn < 0) {
    jn = (-(1 + T.restitution) * vn) / (1 / p1.massKg + 1 / p2.massKg);
    b1.vx -= (jn / p1.massKg) * n.x;
    b1.vy -= (jn / p1.massKg) * n.y;
    b2.vx += (jn / p2.massKg) * n.x;
    b2.vy += (jn / p2.massKg) * n.y;
  }

  // smash impulses from rim slip (same-direction spins collide hardest)
  const vSlip = Math.abs(b1.omega * p1.radiusM + b2.omega * p2.radiusM) * 0.5;
  const smash1 =
    vSlip * T.smashScale * p1.attackFactor *
    (1 - p1.attackVariance / 2 + p1.attackVariance * rand(w)) *
    p2.defenseFactor;
  const smash2 =
    vSlip * T.smashScale * p2.attackFactor *
    (1 - p2.attackVariance / 2 + p2.attackVariance * rand(w)) *
    p1.defenseFactor;
  const d1 = p1.spinDir;
  const d2 = p2.spinDir;
  b2.vx += (smash1 / p2.massKg) * t.x * d1;
  b2.vy += (smash1 / p2.massKg) * t.y * d1;
  b1.vx -= (smash1 / p1.massKg) * t.x * d1 * T.recoilShare;
  b1.vy -= (smash1 / p1.massKg) * t.y * d1 * T.recoilShare;
  b1.vx -= (smash2 / p1.massKg) * t.x * d2;
  b1.vy -= (smash2 / p1.massKg) * t.y * d2;
  b2.vx += (smash2 / p2.massKg) * t.x * d2 * T.recoilShare;
  b2.vy += (smash2 / p2.massKg) * t.y * d2 * T.recoilShare;

  // spin loss for both
  const loss1 = ((jn + smash2) * T.spinLossK * p1.radiusM) / p1.inertia;
  const loss2 = ((jn + smash1) * T.spinLossK * p2.radiusM) / p2.inertia;
  b1.omega -= Math.sign(b1.omega) * Math.min(Math.abs(b1.omega), loss1);
  b2.omega -= Math.sign(b2.omega) * Math.min(Math.abs(b2.omega), loss2);

  // burst clicks
  const dmg2 = ((jn * T.burstNormalK + smash1 * T.burstSmashK) * T.burstScale) / p2.burstRes;
  const dmg1 = ((jn * T.burstNormalK + smash2 * T.burstSmashK) * T.burstScale) / p1.burstRes;
  applyBurst(w, b1, p1, 0, dmg1, cfg.clicksMax);
  applyBurst(w, b2, p2, 1, dmg2, cfg.clicksMax);

  b1.contacted = true;
  b2.contacted = true;
  if (w.tick - w.lastHitTick >= T.hitEventGapTicks) {
    w.lastHitTick = w.tick;
    pushEvent(w, "hit", 0, jn + smash1 + smash2);
  }
}

function applyBurst(
  w: WorldState,
  b: BeyState,
  p: BeyParams,
  i: 0 | 1,
  dmg: number,
  clicksMax: number,
): void {
  if (p.fixedBurst || dmg <= 0) return;
  const before = Math.floor(b.burstDamage);
  b.burstDamage += dmg;
  if (Math.floor(b.burstDamage) > before) {
    pushEvent(w, "click", i, Math.floor(b.burstDamage));
  }
  if (b.burstDamage >= clicksMax) {
    b.alive = false; // burst finish — exited stays null
  }
}

function resolveFinish(w: WorldState, cfg: WorldConfig): void {
  if (w.finish || w.draw) return;
  const [b1, b2] = w.beys;

  const terminal = (b: BeyState): "exit" | "burst" | "stop" | null => {
    if (b.exited === "top") return "exit";
    if (b.exited) return "exit";
    if (!b.alive) return "burst";
    if (b.stoppedTick >= 0) return "stop";
    return null;
  };
  const t1 = terminal(b1);
  const t2 = terminal(b2);
  if (!t1 && !t2) {
    if (w.tick >= cfg.maxTicks) {
      const a1 = Math.abs(b1.omega);
      const a2 = Math.abs(b2.omega);
      if (a1 === a2) w.draw = true;
      else {
        w.finish = {
          type: "spin",
          winner: a1 > a2 ? 0 : 1,
          ownFinish: false,
          tick: w.tick,
        };
      }
    }
    return;
  }
  if (t1 && t2) {
    w.draw = true; // simultaneous → no points, re-battle per rules
    return;
  }
  const loser = t1 ? 0 : 1;
  const lb = loser === 0 ? b1 : b2;
  const kind = t1 ?? t2;
  if (lb.exited === "top") {
    w.draw = true; // flew out over the top: no count, replay round
    return;
  }
  w.finish = {
    type:
      kind === "burst"
        ? "burst"
        : kind === "stop"
          ? "spin"
          : lb.exited === "xtreme"
            ? "xtreme"
            : "over",
    winner: (1 - loser) as 0 | 1,
    ownFinish: kind === "exit" && !lb.contacted,
    tick: w.tick,
  };
}

/** Advance one fixed tick. Deterministic. */
export function step(w: WorldState, cfg: WorldConfig, s: StadiumSpec): void {
  if (w.finish || w.draw) return;
  w.tick++;
  const [b1, b2] = w.beys;
  if (b1.alive) stepBey(w, s, b1, cfg.beys[0], 0, cfg.xtremeDashEnabled);
  if (b2.alive) stepBey(w, s, b2, cfg.beys[1], 1, cfg.xtremeDashEnabled);
  collide(w, cfg);
  resolveFinish(w, cfg);
}

/** Run a whole battle headless. */
export function simulateBattle(
  cfg: WorldConfig,
  s: StadiumSpec,
): WorldState {
  const w = createWorld(cfg);
  while (!w.finish && !w.draw && w.tick < cfg.maxTicks + 1) {
    step(w, cfg, s);
  }
  return w;
}

/** Lockstep verification hash of the dynamic state. */
export function hashWorld(w: WorldState): string {
  const vals: number[] = [w.tick, w.rng];
  for (const b of w.beys) {
    vals.push(
      b.x,
      b.y,
      b.vx,
      b.vy,
      b.omega,
      b.burstDamage,
      b.alive ? 1 : 0,
      b.stoppedTick,
    );
  }
  return hashFloats(vals);
}

export { T as SIM_TUNING };
