// The deterministic battle simulation. Fixed timestep, no native trig, one
// PRNG stream — identical results on every device for identical inputs
// (see docs/PHYSICS.md). Rendering interpolates between ticks; the sim never
// depends on wall-clock time.

import { clamp, datan2, dsin, dcos, hashFloats, rngNext, wrapAngle, PI } from "./fxmath";
import type { StadiumSpec } from "./stadium";
import { inArc, pocketAt, railRadiusAt, railTangentAt, surfaceSlope, surfaceZ } from "./stadium";
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
// A top at 30 rad/s (~290 rpm) is still visibly spinning, so calling the
// spin finish there announced the result while the bey was clearly alive.
// Stop means stopped: ~95 rpm, held for a moment so the bey has actually
// wound down and keeled over before the banner appears.
export const OMEGA_STOP = 10; // rad/s below which a bey has "stopped"
/** |ω| must stay under OMEGA_STOP this long before the finish is called */
export const STOP_DWELL_TICKS = 72; // 0.3 s at 240 Hz

const T = {
  // launch — bowl escape speed is ~0.77 m/s, so entries stay below it and
  // mostly tangential; KOs must come from hits and Xtreme Dash, not launches
  v0Base: 0.35,
  v0PerSp: 0.55 / 11000,
  omega0Base: 250,
  omega0PerSp: 0.055,
  entryRadius: 0.075,
  entryTangentDeg: 68,
  // launch drop-in: beys start in the launcher above the bowl and fall in
  launchHeight: 0.13, // m above the local surface (rules cap: 20 cm)
  launchVz: -0.25, // slight downward push from the launcher
  landBounceMinVz: 0.8, // faster impacts than this bounce once
  landBounceKeep: 0.22,
  // motion — drift ceiling scales with grip: attack tips orbit fast and
  // climb OUT to the rack; stamina/defense tips settle toward the center
  driftAccel: 1.6,
  driftSatBase: 0.45,
  driftSatGrip: 0.55,
  lowSpinThreshold: 120,
  lowSpinDrag: 1.6,
  spinDecayBase: 130,
  spinDecaySpeed: 26,
  // rail — a real rack-and-pinion: the bit's bottom gear (r≈4 mm) meshes
  // with the rack and drives the bey toward synchronous speed v = ω·r_gear.
  // Riding is SUSTAINED (the X-gen core loop): attackers lap the bowl on
  // the rack until a concave dip slings them across the center.
  railMinSpeed: 0.45,
  railRideMinDash: 1.0, // only dash-capable bits (flat/rubber/gear) mesh
  railTicks: 240,
  gearRadius: 0.004,
  railMeshAccel: 7, // dash runs BUILD over ~a lap, not instantly
  railMaxSpeed: 1.9,
  railSpring: 60,
  railCooldownTicks: 120, // a dash run is an event, not a machine gun
  railFlingRadial: 0.4,
  dipSlingSpeed: 1.3, // riding a dip faster than this slings the bey inward
  dipSlingBoost: 0.55,
  dipRadiusFrac: 0.94, // "inside a dip" = rail radius below rRail×this
  railTripSpeed: 0.55, // radial slam speed that trips instead of meshing
  tripSpinKeep: 0.82,
  tripClicks: 0.5, // a trip shocks the latch, but less than a joint hit
  gearEventEvery: 10,
  // the rack is a raised ridge: it physically holds beys in unless they
  // arrive hard enough to hop over it
  // Tuned on the balance batch WITH continuous containment (scratchpad
  // rail-sweep): 1.15→95% KO in 4 s (rack does nothing), 2.0→30% KO but a
  // near-wall. 1.9 keeps the rack holding most drift while a real smash can
  // still punch a bey over it — ~40% KO, ~12 s, ~13 clashes per battle.
  railBreakSpeed: 1.9, // only true smashes clear the ridge
  railBumpRestitution: 0.42,
  railBarrierInner: 0.75, // barrier sits at railR - halfWidth×this
  // collisions (rim slip ≈ 16 m/s at full spin → smash impulse ~0.01–0.02
  // kg·m/s → Δv ~0.3–0.5 m/s and spin loss ~15–40 rad/s per solid hit)
  restitution: 0.28,
  smashScale: 0.0013,
  recoilShare: 0.45,
  spinLossK: 0.5,
  burstNormalK: 2.2,
  burstSmashK: 9,
  burstScale: 850,
  // bursts are JOINT hits: the impact must land on one of the ratchet's N
  // latch points (in the bey's rotating frame) and exceed a real impulse —
  // grazes and off-joint hits never advance the latch
  burstMinImpulse: 0.12,
  jointWindow: 0.9, // |wrap(contactAngle×N)| below this = on a joint (~29%)
  hitEventGapTicks: 6,
  /** below this combined impulse a contact is resting/settling, not a clash */
  hitEventMinImpulse: 0.0025,
  // walls / casing — hard smashes loft beys into the clear casing (clank
  // + knocked back in), or out through its loose gaps
  wallSpinKick: 0.0002,
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
  side: number,
  total: number,
): BeyState {
  // 2 players keep the classic corners (byte-identical with old replays);
  // free-for-all spreads entries evenly around the bowl
  const baseAngle =
    total <= 2 ? (side === 0 ? PI - 0.55 : 0.55) : PI / 2 + (side * 6.283185307179586) / total;
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
  // spawn back along the flight path so the fall lands at the entry point
  const vx = speed * dcos(dir);
  const vy = speed * dsin(dir);
  const tFall = Math.sqrt((2 * T.launchHeight) / 9.81);
  return {
    x: x - vx * tFall,
    y: y - vy * tFall,
    vx,
    vy,
    z: T.launchHeight,
    vz: T.launchVz,
    airborne: true,
    omega,
    burstDamage: 0,
    alive: true,
    exited: null,
    stoppedTick: -1,
    stopDwell: 0,
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
    beys: cfg.beys.map((p, i) => makeBey(p, cfg.launches[i]!, i, cfg.beys.length)),
    finish: null,
    draw: false,
    eliminatedOrder: [],
    ffaWinner: null,
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
  bey: number,
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
  i: number,
  xtremeDash: boolean,
  clicksMax: number,
  other: BeyState,
): void {
  const r = Math.sqrt(b.x * b.x + b.y * b.y);
  const ur = r > 1e-9 ? { x: b.x / r, y: b.y / r } : { x: 1, y: 0 };
  const angle = datan2(b.y, b.x);
  const absOmega = Math.abs(b.omega);

  // airborne drop-in: ballistic flight from the launcher, spin conserved,
  // no ground forces/rail/walls until the tip meets the surface
  if (b.airborne) {
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.vz -= G * DT;
    b.z += b.vz * DT;
    b.phase += b.omega * DT;
    const r2 = Math.sqrt(b.x * b.x + b.y * b.y);
    const floor = surfaceZ(s, Math.min(r2, s.rWall));
    if (b.z <= floor) {
      b.z = floor;
      if (b.vz < -T.landBounceMinVz) {
        b.vz = -b.vz * T.landBounceKeep; // hard landing: one small hop
        pushEvent(w, "land", i, -b.vz);
      } else {
        b.vz = 0;
        b.airborne = false; // settled — ground sim takes over
        pushEvent(w, "land", i, Math.abs(b.vz) + 0.2);
      }
    }
    return;
  }
  b.z = 0;

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
  const satSpeed = T.driftSatBase + p.grip * T.driftSatGrip;
  const driftGain =
    p.grip * T.driftAccel * Math.min(1, absOmega / 600) *
    Math.max(0, 1 - speed / satSpeed);
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
      if (!inArc(arc, angle)) continue;
      const vr = b.vx * ur.x + b.vy * ur.y; // outward radial speed
      if (vr >= T.railBreakSpeed) {
        // launched clean over the ridge by a huge hit — teeth just graze
        b.omega *= 0.95;
        pushEvent(w, "gear", i, vr);
        break;
      }
      if (vr > T.railTripSpeed) {
        // slammed into the rack: teeth clash instead of meshing — the bey
        // is tripped: bounced off, destabilized, and takes a burst click
        b.railTicks = -T.railCooldownTicks;
        b.vx -= ur.x * vr * 1.6;
        b.vy -= ur.y * vr * 1.6;
        const jolt = (rand(w) - 0.5) * 0.5;
        b.vx += -ur.y * jolt;
        b.vy += ur.x * jolt;
        b.omega *= T.tripSpinKeep;
        applyBurst(w, b, p, i, (T.tripClicks * 120) / p.burstRes, clicksMax);
        pushEvent(w, "trip", i, vr);
      } else if (p.dashFactor >= T.railRideMinDash) {
        // only grippy dash bits mesh and ride; others just bump the ridge
        b.railTicks = T.railTicks;
        const ct = railTangentAt(s, angle);
        const vt = b.vx * ct.x + b.vy * ct.y;
        b.railDir = vt >= 0 ? 1 : -1;
        pushEvent(w, "dashStart", i, speed);
      }
      break;
    }
  }
  if (b.railTicks > 0) {
    const railR = railRadiusAt(s, angle);
    // while meshed the teeth are a positional constraint — only leaving the
    // rack's arc (or a dip sling / mesh end) releases the bey
    const inBand = s.railArcs.some((a) => inArc(a, angle));
    if (!inBand) {
      // flung off the rack — dart across the stadium
      b.railTicks = -T.railCooldownTicks;
      b.vx += -ur.x * T.railFlingRadial * p.dashFactor;
      b.vy += -ur.y * T.railFlingRadial * p.dashFactor;
      pushEvent(w, "dashEnd", i, Math.sqrt(b.vx * b.vx + b.vy * b.vy));
    } else {
      b.railTicks--;
      const ct = railTangentAt(s, angle);
      // rack-and-pinion drive: accelerate toward synchronous speed
      // (spin → travel), efficiency scaled by the bit's dash stat
      const meshEff = 0.45 + 0.55 * Math.min(1, p.dashFactor / 1.6);
      const vSync = Math.min(T.railMaxSpeed, absOmega * T.gearRadius) * meshEff;
      const vAlong = (b.vx * ct.x + b.vy * ct.y) * b.railDir;
      // dip sling: riding through a concave section at speed hurls the bey
      // across the bowl AT THE OPPONENT — the signature X attack run
      if (railR < s.rRail * T.dipRadiusFrac && vAlong > T.dipSlingSpeed) {
        b.railTicks = -T.railCooldownTicks;
        let dx = -ur.x;
        let dy = -ur.y;
        if (other.alive && !other.airborne) {
          // lead the target: aim at where the opponent will BE over the
          // crossing time, not where it is (misses caused self-ejections)
          const cross = Math.max(0.05, vAlong + T.dipSlingBoost * p.dashFactor);
          const dist0 = Math.sqrt((other.x - b.x) ** 2 + (other.y - b.y) ** 2);
          const tFly = dist0 / cross;
          const ox = other.x + other.vx * tFly - b.x;
          const oy = other.y + other.vy * tFly - b.y;
          const od = Math.sqrt(ox * ox + oy * oy);
          if (od > 1e-6) {
            dx = ox / od;
            dy = oy / od;
          }
        }
        b.vx += dx * T.dipSlingBoost * p.dashFactor;
        b.vy += dy * T.dipSlingBoost * p.dashFactor;
        pushEvent(w, "dashEnd", i, vAlong);
      } else {
        const dv = Math.min(Math.max(0, vSync - vAlong), T.railMeshAccel * DT);
        b.vx += ct.x * b.railDir * dv;
        b.vy += ct.y * b.railDir * dv;
        // driving the rack costs spin (energy conservation, loosely)
        b.omega -= Math.sign(b.omega) * dv * 6;
        // gear teeth = holonomic constraint: snap to the rack curve and
        // absorb radial velocity (stable at any riding speed)
        const rNow = Math.sqrt(b.x * b.x + b.y * b.y);
        if (rNow > 1e-9) {
          const k = railR / rNow;
          b.x *= k;
          b.y *= k;
        }
        const vrM = b.vx * ur.x + b.vy * ur.y;
        b.vx -= vrM * ur.x;
        b.vy -= vrM * ur.y;
        if (b.railTicks % T.gearEventEvery === 0) pushEvent(w, "gear", i, vAlong);
        if (b.railTicks === 0) b.railTicks = -T.railCooldownTicks;
      }
    }
  }

  // integrate
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  b.phase += b.omega * DT;

  // the gear rack is a PHYSICAL ridge even when not meshed (cooldown, slow
  // or dying beys): crossing outward needs real speed, otherwise the teeth
  // hold the bey inside the bowl — only hard knockbacks hop over
  if (xtremeDash && s.railArcs.length > 0 && b.railTicks <= 0) {
    const angleB = datan2(b.y, b.x);
    if (s.railArcs.some((a) => inArc(a, angleB))) {
      const railRB = railRadiusAt(s, angleB);
      const inner = railRB - s.railHalfWidth * T.railBarrierInner;
      const rB = Math.sqrt(b.x * b.x + b.y * b.y);
      // Containment is CONTINUOUS, not just on the crossing tick: a bey that
      // is already past the ridge line and still drifting outward gets held
      // too. Only checking the crossing let beys leak over the rack whenever
      // the crossing happened during a dash or a rail cooldown.
      if (rB > inner) {
        const uB = { x: b.x / rB, y: b.y / rB };
        const vrB = b.vx * uB.x + b.vy * uB.y;
        if (vrB > 0 && vrB < T.railBreakSpeed) {
          b.vx -= (1 + T.railBumpRestitution) * vrB * uB.x;
          b.vy -= (1 + T.railBumpRestitution) * vrB * uB.y;
          const over = rB - inner;
          b.x -= uB.x * over;
          b.y -= uB.y * over;
          pushEvent(w, "gear", i, vrB); // teeth graze as the ridge holds
        }
      }
    }
  }

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
      // flying over the wall: the transparent casing knocks it back in,
      // unless it finds one of the loose gaps — then it falls out (over
      // finish for the opponent)
      const inGap = s.coverGaps.some((g) => inArc(g, angleNow));
      if (inGap) {
        b.exited = "top";
        b.alive = false;
        pushEvent(w, "exit", i, vr);
        return;
      }
      b.vx -= (1 + 0.35) * vr * u.x;
      b.vy -= (1 + 0.35) * vr * u.y;
      b.omega *= 0.96;
      pushEvent(w, "coverHit", i, vr);
      const over2 = r2 - wallR;
      b.x -= u.x * over2;
      b.y -= u.y * over2;
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

  // spin finish detection: only after the bey has been under the threshold
  // long enough to have visibly stopped (a brief dip must not end a battle)
  if (Math.abs(b.omega) < OMEGA_STOP) {
    b.stopDwell++;
    if (b.stopDwell >= STOP_DWELL_TICKS && b.stoppedTick < 0) {
      b.stoppedTick = w.tick;
    }
  } else {
    b.stopDwell = 0;
  }
}

function collide(w: WorldState, cfg: WorldConfig): void {
  for (let i = 0; i < w.beys.length; i++) {
    for (let j = i + 1; j < w.beys.length; j++) {
      collidePair(w, cfg, i, j);
    }
  }
}

function collidePair(w: WorldState, cfg: WorldConfig, i: number, j: number): void {
  const b1 = w.beys[i]!;
  const b2 = w.beys[j]!;
  const p1 = cfg.beys[i]!;
  const p2 = cfg.beys[j]!;
  if (!b1.alive || !b2.alive) return;
  if (b1.airborne || b2.airborne) return; // mid-air beys pass over
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

  // smash impulses from rim slip (same-direction spins collide hardest).
  // Heavy-tailed magnitude: most contacts are tooth grazes, a few are
  // full-face bombs — that top end is what actually ejects beys.
  const vSlip = Math.abs(b1.omega * p1.radiusM + b2.omega * p2.radiusM) * 0.5;
  const g1 = rand(w);
  const g2 = rand(w);
  const heavy1 = 0.22 + (0.9 + p1.attackVariance) * g1 * g1;
  const heavy2 = 0.22 + (0.9 + p2.attackVariance) * g2 * g2;
  const smash1 = vSlip * T.smashScale * p1.attackFactor * heavy1 * p2.defenseFactor;
  const smash2 = vSlip * T.smashScale * p2.attackFactor * heavy2 * p1.defenseFactor;
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

  // burst clicks — physics of the latch: the lock only advances when the
  // impact lands ON one of the ratchet's N latch joints (checked in each
  // bey's rotating frame at the instant of contact) AND carries a real
  // impulse. Grazes and off-joint hits knock the bey around but never
  // crack it. Where the joints are at impact time is deterministic chaos —
  // exactly like the real toy.
  const hitAngle1 = datan2(n.y, n.x) - b1.phase; // impact spot on bey1's rim
  const hitAngle2 = datan2(-n.y, -n.x) - b2.phase;
  const onJoint1 = Math.abs(wrapAngle(hitAngle1 * p1.latchCount)) < T.jointWindow;
  const onJoint2 = Math.abs(wrapAngle(hitAngle2 * p2.latchCount)) < T.jointWindow;
  const imp1 = jn * T.burstNormalK + smash2 * T.burstSmashK;
  const imp2 = jn * T.burstNormalK + smash1 * T.burstSmashK;
  if (onJoint1 && imp1 > T.burstMinImpulse) {
    applyBurst(w, b1, p1, i, latchDamage(imp1, p1), cfg.clicksMax);
  }
  if (onJoint2 && imp2 > T.burstMinImpulse) {
    applyBurst(w, b2, p2, j, latchDamage(imp2, p2), cfg.clicksMax);
  }

  b1.contacted = true;
  b2.contacted = true;
  // A clash needs a real impact behind it. This used to fire on the tick gap
  // alone, so two spent beys resting against each other overlapped every
  // tick and threw sparks and clang forever after the match was decided.
  const clash = jn + smash1 + smash2;
  if (clash > T.hitEventMinImpulse && w.tick - w.lastHitTick >= T.hitEventGapTicks) {
    w.lastHitTick = w.tick;
    pushEvent(w, "hit", i, clash);
  }
}

function applyBurst(
  w: WorldState,
  b: BeyState,
  p: BeyParams,
  i: number,
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

/**
 * Latch damage from one joint hit.
 *
 * Two things were wrong before. First, damage was proportional to the WHOLE
 * impulse, so a hit that merely cleared burstMinImpulse already advanced the
 * latch by ~1.4 of the 4 clicks — three qualifying hits cracked anything.
 * Only the impulse ABOVE the threshold should move the latch: below it the
 * teeth simply hold.
 *
 * Second, the ratchet's protrusion count did nothing. In the real toy the
 * number is the whole point — a 9-60 locks far harder than a 3-60 because
 * nine teeth share the load, so the torque needed to slip one grows with N.
 * Damage now scales inversely with the tooth count, taking 3 teeth as the
 * baseline (docs/MODELING.md §1.2).
 */
function latchDamage(impulse: number, p: BeyParams): number {
  const excess = impulse - T.burstMinImpulse;
  if (excess <= 0) return 0;
  const teeth = Math.max(1, p.latchCount);
  return (excess * T.burstScale) / (p.burstRes * (teeth / 3));
}

/** Free-for-all resolution: elimination order + last survivor. */
function resolveFfa(w: WorldState, cfg: WorldConfig): void {
  for (let i = 0; i < w.beys.length; i++) {
    const b = w.beys[i]!;
    const out = !b.alive || b.exited !== null || b.stoppedTick >= 0;
    if (out && !w.eliminatedOrder.includes(i)) w.eliminatedOrder.push(i);
  }
  const survivors: number[] = [];
  for (let i = 0; i < w.beys.length; i++) {
    if (!w.eliminatedOrder.includes(i)) survivors.push(i);
  }
  if (survivors.length === 1) w.ffaWinner = survivors[0]!;
  else if (survivors.length === 0) w.ffaWinner = -1; // simultaneous wipe
  else if (w.tick >= cfg.maxTicks) {
    let best = survivors[0]!;
    for (const k of survivors) {
      if (Math.abs(w.beys[k]!.omega) > Math.abs(w.beys[best]!.omega)) best = k;
    }
    w.ffaWinner = best;
  }
}

function resolveFinish(w: WorldState, cfg: WorldConfig): void {
  if (w.finish || w.draw || w.ffaWinner !== null) return;
  if (w.beys.length !== 2) {
    resolveFfa(w, cfg);
    return;
  }
  const [b1, b2] = w.beys as [BeyState, BeyState];

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
  // "top" = escaped through a casing gap and fell out of the stadium —
  // scored as an over finish (own-finish rule applies as usual)
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

/** Advance one fixed tick. Deterministic.
 * afterglow: keep the physics alive AFTER the battle is decided (winner
 * keeps spinning and eventually topples naturally) — presentation only,
 * the recorded result never changes. */
export function step(w: WorldState, cfg: WorldConfig, s: StadiumSpec, afterglow = false): void {
  if ((w.finish || w.draw || w.ffaWinner !== null) && !afterglow) return;
  w.tick++;
  for (let i = 0; i < w.beys.length; i++) {
    const b = w.beys[i]!;
    if (!b.alive) continue;
    // nearest living rival — collision partner and sling target
    let other = b;
    let bestD = Infinity;
    for (let j = 0; j < w.beys.length; j++) {
      if (j === i) continue;
      const o = w.beys[j]!;
      if (!o.alive) continue;
      const d = (o.x - b.x) * (o.x - b.x) + (o.y - b.y) * (o.y - b.y);
      if (d < bestD) {
        bestD = d;
        other = o;
      }
    }
    stepBey(w, s, b, cfg.beys[i]!, i, cfg.xtremeDashEnabled, cfg.clicksMax, other);
  }
  collide(w, cfg);
  if (!afterglow) resolveFinish(w, cfg);
}

/** Run a whole battle headless. */
export function simulateBattle(
  cfg: WorldConfig,
  s: StadiumSpec,
): WorldState {
  const w = createWorld(cfg);
  while (!w.finish && !w.draw && w.ffaWinner === null && w.tick < cfg.maxTicks + 1) {
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
      b.z,
      b.vz,
      b.omega,
      b.burstDamage,
      b.alive ? 1 : 0,
      b.stoppedTick,
    );
  }
  return hashFloats(vals);
}

export { T as SIM_TUNING };
