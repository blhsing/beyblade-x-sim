// The deterministic battle simulation. Fixed timestep, no native trig, one
// PRNG stream — identical results on every device for identical inputs
// (see docs/PHYSICS.md). Rendering interpolates between ticks; the sim never
// depends on wall-clock time.

import { clamp, datan2, dsin, dcos, hashFloats, rngNext, wrapAngle, PI } from "./fxmath";
import { normalizeLauncherForSpin } from "./launcher";
import type { PocketSpec, Point2, StadiumSpec } from "./stadium";
import {
  inArc,
  pocketAtPoint,
  pocketBasinPolygon,
  pocketGuardGradientAt,
  pocketPath,
  pocketSecureAtPoint,
  pocketThroatAtPoint,
  railClosestPoint,
  railReleaseDirectionAt,
  stadiumBoundaryNormalAt,
  stadiumBoundarySignedDistance,
  stadiumTerrainAt,
  surfaceGradientAt,
  surfaceZAt,
} from "./stadium";
import type {
  BeyParams,
  BeyState,
  BurstReleaseState,
  LaunchParams,
  WorldConfig,
  WorldState,
} from "./types";

export const DT = 1 / 240;
export const TICKS_PER_SECOND = 240;
/** Increment whenever deterministic state evolution changes incompatibly. */
export const PHYSICS_VERSION = 7;

const G = 9.81;
// Stop means visually and mechanically settled, not merely crossing a low-
// spin threshold while the top is still skating/wobbling around the dish.
export const OMEGA_STOP = 2; // low-spin regime; finish still requires exactly 0
export const STOP_LINEAR_SPEED = 0.005; // m/s: ≤3 mm over the full dwell
/** all stop conditions must remain true this long before a Spin Finish */
export const STOP_DWELL_TICKS = 144; // 0.6 s at 240 Hz
/** Zone loss needs a short confirmation after translational rest. Spin is
 * deliberately irrelevant: a retained Bey can still rotate in the basin. */
export const POCKET_DWELL_TICKS = 24; // 0.1 s, evaluated after collisions
/** Maximum center movement per fixed tick that is visually/mechanically at
 * rest. Over the complete confirmation this permits under 0.5 mm of drift. */
export const POCKET_REST_DISPLACEMENT = 0.00002;
/** Effective lower-body/support clearance against pocket cheeks. The Blade
 * may overhang a real pocket while the Bit and Ratchet continue inside. */
export const POCKET_SUPPORT_CLEARANCE_M = 0.008;

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
  // Once rotation reaches zero the Blade/Ratchet is leaning on the stadium,
  // so it slides under Coulomb contact instead of rolling like an upright Bit.
  // Static friction then holds it on the shallow inner bowl after at most one
  // inward slide rather than allowing repeated center-crossing oscillations.
  toppledKineticFriction: 0.28,
  toppledStaticFriction: 0.34,
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
  // Only a near-threshold tooth clash trips the Bit. Lower-energy contact is
  // held by the swept molded-ridge rebound without random lateral injection.
  railTripSpeed: 0.47,
  tripSpinKeep: 0.82,
  gearEventEvery: 10,
  // The inferred local envelope is 2.4 + 2.2 = 4.6 mm. Its ideal
  // gravity-equivalent crossing speed is sqrt(2gh)≈0.30 m/s; 0.50 models
  // tooth/guide climb loss. A successful swept crossing pays that energy.
  railBreakSpeed: 0.50,
  railBumpRestitution: 0.42,
  railBarrierInner: 0.75, // barrier sits at railR - halfWidth×this
  pocketEntrySpeed: 0.45, // committed outward crossing, above a slow wall graze
  // Concave molded loss zones retain incoming momentum. Polymer contact
  // dissipates energy gradually; the rising basin rim redirects a Bey instead
  // of acting like an invisible capture brake.
  pocketLinearDrag: 0.7,
  pocketRimRestitution: 0.38,
  pocketRimFriction: 0.08,
  // collisions (rim slip ≈ 16 m/s at full spin → smash impulse ~0.01–0.02
  // kg·m/s → Δv ~0.3–0.5 m/s and spin loss ~15–40 rad/s per solid hit)
  restitution: 0.28,
  smashScale: 0.0013,
  recoilShare: 0.45,
  spinLossK: 0.5,
  burstSmashK: 9,
  // Ratchet Burst is a DISCRETE latch slip, not material damage. A collision
  // must be a new closing impact, hit an opening flank of a latch joint and
  // exceed the Ratchet's yield load. Sustained overlap cannot count as a
  // stream of impacts, and even an exceptional hit slips at most two teeth.
  latchYieldLoad: 0.12,
  latchResistanceRef: 60,
  latchImpactMinNormal: 0.0015,
  latchImpactGapTicks: 6,
  latchMaxSlipPerImpact: 2,
  latchExtraSlipRatio: 1.5,
  latchSeatYieldRatio: 0.55,
  latchMaxSeatPerImpact: 1,
  hitEventGapTicks: 6,
  /** below this combined impulse a contact is resting/settling, not a clash */
  hitEventMinImpulse: 0.0025,
  // walls / casing — hard smashes loft beys into the clear casing (clank
  // + knocked back in), or out through its loose gaps
  wallSpinKick: 0.0002,
  overTopSpeed: 1.9,
};

const LAUNCHER: Record<LaunchParams["launcher"], { v: number; w: number }> = {
  entry: { v: 0.82, w: 0.86 },
  winder: { v: 0.9, w: 1.0 },
  longWinder: { v: 0.98, w: 1.08 },
  string: { v: 1.05, w: 1.0 },
  hold: { v: 1.0, w: 1.12 },
  winderL: { v: 0.9, w: 1.0 },
  stringL: { v: 1.05, w: 1.0 },
};

export interface LatchImpact {
  /** closing normal impulse J (kg·m/s); zero for resting overlap */
  normalImpulse: number;
  /** tangential impulse delivered by the attacking blade */
  incomingSmash: number;
  attackerSpinDir: 1 | -1;
  /** current discrete distance from the fully seated detent */
  currentClicks: number;
}

export interface LatchImpactResponse {
  /** smoothly weighted opening load at the joint */
  openingLoad: number;
  /** Ratchet-specific load at which the tooth begins to slip */
  yieldLoad: number;
  /** 0..1 Blade-flank efficiency transmitting rim impulse as torque */
  torqueCoupling: number;
  /** signed whole-detent change: positive unlocks, negative re-seats */
  detentDelta: number;
  /** 0..1 excess unlock load available to separate the assembly */
  overloadSeverity: number;
}

function latchYieldLoad(p: BeyParams): number {
  const resistance = Math.sqrt(Math.max(0.1, p.burstRes) / T.latchResistanceRef);
  // Burst resistance belongs primarily to the Bit's Gear Structure. The
  // first Ratchet digit describes OUTER perimeter protrusions, not nine
  // internal lock teeth, so it must not multiply the latch's yield strength.
  return T.latchYieldLoad * resistance;
}

function latchClicksForLoad(openingLoad: number, yieldLoad: number): number {
  if (openingLoad <= yieldLoad || yieldLoad <= 0) return 0;
  const excessRatio = (openingLoad - yieldLoad) / yieldLoad;
  return Math.min(
    T.latchMaxSlipPerImpact,
    1 + Math.floor(excessRatio / T.latchExtraSlipRatio),
  );
}

/** Pure deterministic Ratchet load model used by collisions and tests. */
export function latchImpactResponse(
  p: BeyParams,
  impact: LatchImpact,
): LatchImpactResponse {
  const yieldLoad = latchYieldLoad(p);
  if (impact.normalImpulse < T.latchImpactMinNormal) {
    return {
      openingLoad: 0,
      yieldLoad,
      torqueCoupling: 0,
      detentDelta: 0,
      overloadSeverity: 0,
    };
  }

  // collidePair resolves contact at the full Blade radius. Its radial normal
  // impulse therefore has no torque arm in this circular approximation; only
  // the tangential smash load can turn Blade against the Ratchet/Bit lock.
  // attackVariance is the available proxy for how strongly the victim's
  // non-circular Blade flanks couple that rim load into the central stack.
  const torqueCoupling = clamp(0.25 + p.attackVariance * 0.65, 0.25, 0.72);
  const transmittedLoad = impact.incomingSmash * T.burstSmashK * torqueCoupling;
  const unlocking = impact.attackerSpinDir === p.spinDir;
  const openingLoad = unlocking ? transmittedLoad : -transmittedLoad;
  let detentDelta = 0;
  if (unlocking) {
    detentDelta = latchClicksForLoad(transmittedLoad, yieldLoad);
  } else if (
    impact.currentClicks > 0 &&
    transmittedLoad > yieldLoad * T.latchSeatYieldRatio
  ) {
    // Reverse torque drives a partially-open latch back toward its seated
    // stop. It never leaks positive damage; alternating impacts therefore
    // do not monotonically accumulate forever.
    detentDelta = -Math.min(T.latchMaxSeatPerImpact, impact.currentClicks);
  }
  return {
    openingLoad,
    yieldLoad,
    torqueCoupling,
    detentDelta,
    // 0 at first yield, 1 at ≥4× yield. This value is presentation metadata
    // only; it never changes finish scoring or the number of latch clicks.
    overloadSeverity: unlocking
      ? clamp((transmittedLoad / Math.max(1e-9, yieldLoad) - 1) / 3, 0, 1)
      : 0,
  };
}

/**
 * The complete deterministic ballistic hand-off shared by simulation and
 * presentation. Render code stages the mounted bey at `x/y/z` and follows
 * WorldState after release; the fixed-step simulation consumes these exact
 * same initial values in makeBey(). `flightSeconds` and `landingX/Y` are the
 * analytic centre-plane crossing, useful for miss prediction. The raised
 * bowl can touch a normal launch earlier, at a stadium-specific fixed tick.
 */
export interface LaunchKinematics {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  omega: number;
  /** nominal shoot-position angle around the stadium */
  baseAngle: number;
  /** horizontal velocity heading after the player's aim error */
  heading: number;
  /** analytic time to the stadium's centre plane (z=0), not raised bowl */
  flightSeconds: number;
  landingX: number;
  landingY: number;
}

/** Positive root of z(t) = height + vz*t - g*t^2/2. */
function fallTime(height: number, vz: number): number {
  return (vz + Math.sqrt(vz * vz + 2 * G * height)) / G;
}

/**
 * Compute the release pose and flight of one bey.
 *
 * The launcher mount is deliberately fixed for each shoot side/direction.
 * Earlier code back-solved the spawn from a desired landing point, which
 * made every gesture magically converge on the same safe patch of floor.
 * Here power, aim and tilt change where the bey actually lands.  Ordinary
 * launch ranges still enter the bowl, while a badly side-pulled or outward-
 * tilted launcher can throw the bey outside the casing for an own finish.
 */
export function launchKinematics(
  params: BeyParams,
  launch: LaunchParams,
  side: number,
  total: number,
): LaunchKinematics {
  // 2 players keep the familiar opposing shoot positions; free-for-all
  // distributes physical mounts evenly around the casing.
  const baseAngle =
    total <= 2 ? (side === 0 ? PI - 0.55 : 0.55) : PI / 2 + (side * 6.283185307179586) / total;
  const launcher = normalizeLauncherForSpin(launch.launcher, launch.spinDir);
  const lk = LAUNCHER[launcher];
  const sp = clamp(launch.sp, 0, 11000);
  const speed = (T.v0Base + sp * T.v0PerSp) * lk.v;

  // The mount is calibrated once from a clean 9,250-SP tournament pull. It
  // depends on the shoot side and drive direction, never on this gesture's
  // power/aim/tilt. That preserves the former balanced entry for a clean
  // pull without forcing bad pulls back to the same target.
  const nominalHeading =
    baseAngle + PI + (launch.spinDir * T.entryTangentDeg * PI) / 180;
  const referenceSpeed =
    (T.v0Base + 9250 * T.v0PerSp) * LAUNCHER.string.v;
  const referenceTravel = referenceSpeed * fallTime(T.launchHeight, T.launchVz);
  const targetX = T.entryRadius * dcos(baseAngle);
  const targetY = T.entryRadius * dsin(baseAngle);
  const x = targetX - referenceTravel * dcos(nominalHeading);
  const y = targetY - referenceTravel * dsin(nominalHeading);

  const heading = nominalHeading + (clamp(launch.aimDeg, -150, 150) * PI) / 180;
  // tiltDeg is the launcher leaning toward (+) or into (-) the nearby rim.
  // Its horizontal component is radial from the real mount, so extreme
  // positive lean visibly sends the released bey outside instead of being
  // treated as a harmless change to a preselected entry radius.
  const tiltDeg = clamp(launch.tiltDeg, -30, 70);
  const tilt = (tiltDeg * PI) / 180;
  const radialLength = Math.sqrt(x * x + y * y);
  const radialX = radialLength > 1e-12 ? x / radialLength : dcos(baseAngle);
  const radialY = radialLength > 1e-12 ? y / radialLength : dsin(baseAngle);
  const tiltRatio = clamp((dsin(tilt) / Math.max(0.01, dcos(tilt))) * 0.72, -0.35, 2.2);
  const vx = speed * dcos(heading) + speed * tiltRatio * radialX;
  const vy = speed * dsin(heading) + speed * tiltRatio * radialY;
  const vz = T.launchVz + tiltDeg * 0.0045;
  const flightSeconds = fallTime(T.launchHeight, vz);
  const omega =
    launch.spinDir *
    (T.omega0Base + sp * T.omega0PerSp) *
    lk.w *
    params.staminaFactor;

  return {
    x,
    y,
    z: T.launchHeight,
    vx,
    vy,
    vz,
    omega,
    baseAngle,
    heading,
    flightSeconds,
    landingX: x + vx * flightSeconds,
    landingY: y + vy * flightSeconds,
  };
}

function makeBey(
  params: BeyParams,
  launch: LaunchParams,
  side: number,
  total: number,
): BeyState {
  const kinematics = launchKinematics(params, launch, side, total);
  return {
    x: kinematics.x,
    y: kinematics.y,
    vx: kinematics.vx,
    vy: kinematics.vy,
    z: kinematics.z,
    vz: kinematics.vz,
    airborne: true,
    omega: kinematics.omega,
    burstDamage: 0,
    burstOverload: 0,
    burstRelease: null,
    lastLatchImpactTick: -999,
    alive: true,
    exited: null,
    pocketIndex: -1,
    pocketDwell: 0,
    pocketDisturbedTick: -999,
    pocketBlockingTick: -999,
    pocketLastX: kinematics.x,
    pocketLastY: kinematics.y,
    stoppedTick: -1,
    stopDwell: 0,
    contacted: false,
    // held out of play until its release moment (see step()); players do
    // not let go in unison, so a late release drops in late
    pendingTicks: Math.max(0, Math.round(launch.delayTicks ?? 0)),
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

/** Stable presentation seed without consuming/changing the physics PRNG. */
function burstReleaseSeed(w: WorldState, bey: number): number {
  let x = (w.rng ^ Math.imul(w.tick + 1, 0x9e3779b1) ^ Math.imul(bey + 1, 0x85ebca6b)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
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

interface PocketEdgeContact {
  point: Point2;
  distance: number;
}

function closestPocketEdge(
  polygon: readonly Point2[],
  x: number,
  y: number,
): PocketEdgeContact {
  let best: PocketEdgeContact = { point: { x, y }, distance: Infinity };
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const c = polygon[(i + 1) % polygon.length]!;
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const denom = dx * dx + dy * dy;
    const t = denom > 1e-14
      ? clamp(((x - a.x) * dx + (y - a.y) * dy) / denom, 0, 1)
      : 0;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const distance = Math.sqrt((x - px) ** 2 + (y - py) ** 2);
    if (distance < best.distance) best = { point: { x: px, y: py }, distance };
  }
  return best;
}

/** Keep a live Bey inside the concave molded basin while leaving the bowl-side
 * mouth open. Returns false when it really climbs back into the bowl. */
function constrainPocket(
  s: StadiumSpec,
  b: BeyState,
  pocket: PocketSpec,
  clearance: number,
  tick: number,
): boolean {
  // A pocket wall constrains the Bit/lower support area, not an upright
  // Blade-sized disk. Real Beys can lean and overhang the lip while their tip
  // continues around the concavity; using the full 49--52 mm Blade footprint
  // made the narrow BX-32 Xtreme pockets mathematically impossible to enter
  // or settle. Keep a conservative 8 mm lower-body clearance instead.
  const supportClearance = Math.min(POCKET_SUPPORT_CLEARANCE_M, clearance * 0.35);
  const path = pocketPath(s, pocket);
  const dx = b.x - path.boundary.x;
  const dy = b.y - path.boundary.y;
  const along = dx * path.axis.x + dy * path.axis.y;
  const inside = pocketAtPoint(s, b.x, b.y) === pocket;
  if (inside && along <= pocket.throat.outwardDepth * 0.32) {
    // Mouth traversal may be tipped/airborne in reality; only the deeper
    // basin applies a full horizontal footprint constraint.
    return true;
  }
  if (inside && pocketSecureAtPoint(s, pocket, b.x, b.y, supportClearance)) return true;
  if (
    !inside &&
    along < -pocket.throat.inwardDepth * 0.55 &&
    stadiumBoundarySignedDistance(s, b.x, b.y) < 0
  ) return false;

  const nearest = closestPocketEdge(
    pocketBasinPolygon(s, pocket),
    b.x,
    b.y,
  );
  if (!Number.isFinite(nearest.distance) || nearest.distance < 1e-12) return true;
  const towardCurrentX = (b.x - nearest.point.x) / nearest.distance;
  const towardCurrentY = (b.y - nearest.point.y) / nearest.distance;
  const inwardX = inside ? towardCurrentX : -towardCurrentX;
  const inwardY = inside ? towardCurrentY : -towardCurrentY;
  const inwardVelocity = b.vx * inwardX + b.vy * inwardY;
  if (inwardVelocity < 0) {
    const normalDelta = (1 + T.pocketRimRestitution) * inwardVelocity;
    b.vx -= normalDelta * inwardX;
    b.vy -= normalDelta * inwardY;

    // Coulomb-like tangential loss at the molded cheek. Cap it by the normal
    // impact so a glancing Bey keeps circulating instead of sticking dead.
    const tangentX = -inwardY;
    const tangentY = inwardX;
    const tangentVelocity = b.vx * tangentX + b.vy * tangentY;
    const maxTangentDelta = -inwardVelocity * T.pocketRimFriction;
    const tangentDelta = clamp(tangentVelocity, -maxTangentDelta, maxTangentDelta);
    b.vx -= tangentDelta * tangentX;
    b.vy -= tangentDelta * tangentY;
  }
  b.pocketDisturbedTick = tick;
  const inset = inside ? Math.max(0.0002, supportClearance) : 0.0002;
  b.x = nearest.point.x + inwardX * inset;
  b.y = nearest.point.y + inwardY * inset;
  return true;
}

function stepBey(
  w: WorldState,
  s: StadiumSpec,
  b: BeyState,
  p: BeyParams,
  i: number,
  xtremeDash: boolean,
  other: BeyState,
): void {
  const r = Math.sqrt(b.x * b.x + b.y * b.y);
  const ur = r > 1e-9 ? { x: b.x / r, y: b.y / r } : { x: 1, y: 0 };
  const angle = datan2(b.y, b.x);
  const absOmega = Math.abs(b.omega);
  let activePocket = b.pocketIndex >= 0 ? s.pockets[b.pocketIndex] ?? null : null;
  if (b.pocketIndex >= 0 && !activePocket) {
    b.pocketIndex = -1;
    b.pocketDwell = 0;
  }

  // airborne drop-in: ballistic flight from the launcher, spin conserved,
  // no ground forces/rail/walls until the tip meets the surface
  if (b.airborne) {
    b.x += b.vx * DT;
    b.y += b.vy * DT;
    b.vz -= G * DT;
    b.z += b.vz * DT;
    b.phase += b.omega * DT;
    // Outside the wall there is no imaginary continuation of the bowl. A
    // poor launch really falls beside the stadium and is an untouched over
    // finish instead of being clamped/teleported through the wall next tick.
    const outside = stadiumBoundarySignedDistance(s, b.x, b.y) > 0;
    const floor = outside ? 0 : surfaceZAt(s, b.x, b.y);
    if (b.z <= floor) {
      b.z = floor;
      if (outside) {
        b.vz = 0;
        b.airborne = false;
        b.exited = "launchMiss";
        b.alive = false;
        pushEvent(w, "exit", i, Math.sqrt(b.vx * b.vx + b.vy * b.vy));
        return;
      }
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
  const pocketTerrain = activePocket ? stadiumTerrainAt(s, b.x, b.y) : null;
  const gradient = pocketTerrain && pocketTerrain.normalZ > 1e-9
    ? {
        x: -pocketTerrain.normalX / pocketTerrain.normalZ,
        y: -pocketTerrain.normalY / pocketTerrain.normalZ,
      }
    : surfaceGradientAt(s, b.x, b.y);
  if (!activePocket) {
    const guardGradient = pocketGuardGradientAt(s, b.x, b.y);
    gradient.x += guardGradient.x;
    gradient.y += guardGradient.y;
  }
  const slope = Math.sqrt(gradient.x * gradient.x + gradient.y * gradient.y);
  // Low-speed contact enters static friction instead of endlessly micro-
  // sliding. The bowl still requires zero spin before sleeping; a retained
  // basin occupant may sleep translationally while its Bit keeps rotating.
  // A subsequent real hit raises speed above the gate and wakes it immediately.
  const contactSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
  const gravityAlongSurface = G * slope;
  const staticRest =
    (absOmega === 0 || activePocket !== null) &&
    contactSpeed < STOP_LINEAR_SPEED &&
    (absOmega === 0
      ? gravityAlongSurface <= T.toppledStaticFriction * G
      : Math.abs(slope) < 0.25);
  if (staticRest) {
    b.vx = 0;
    b.vy = 0;
  }
  let ax = staticRest ? 0 : -G * gradient.x;
  let ay = staticRest ? 0 : -G * gradient.y;

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
  if (!activePocket) {
    ax += dirX * driftGain;
    ay += dirY * driftGain;
  }

  // translational damping (+ stumbling when spin is nearly gone)
  const drag =
    p.muMove +
    (absOmega < T.lowSpinThreshold ? T.lowSpinDrag : 0) +
    (activePocket ? T.pocketLinearDrag : 0);
  const dampen = Math.max(0, 1 - drag * DT);
  b.vx = (b.vx + ax * DT) * dampen;
  b.vy = (b.vy + ay * DT) * dampen;

  // At exact zero spin the top is no longer upright on its low-friction Bit:
  // its Blade/Ratchet is scraping the bowl. Constant Coulomb work removes
  // translation in a fraction of a pass. This is deliberately applied to
  // velocity (not position), so a fast toppled Bey still follows the actual
  // slope and a collision can wake it without any teleport or early finish.
  if (absOmega === 0 && !staticRest) {
    const slidingSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (slidingSpeed > 0) {
      const retainedSpeed = Math.max(0, slidingSpeed - T.toppledKineticFriction * G * DT);
      const scale = retainedSpeed / slidingSpeed;
      b.vx *= scale;
      b.vy *= scale;
    }
  }

  // spin decay from tip friction (faster while travelling)
  const decay = p.muSpin * (T.spinDecayBase + T.spinDecaySpeed * speed) * DT;
  if (absOmega > decay) b.omega -= Math.sign(b.omega) * decay;
  else b.omega = 0;

  // Xtreme Line engagement follows the product-specific traced centerline.
  if (b.railTicks < 0) b.railTicks++; // cooldown
  const railContact = railClosestPoint(s, b.x, b.y);
  if (
    !activePocket &&
    xtremeDash &&
    s.railArcs.length > 0 &&
    b.railTicks === 0 &&
    railContact.distance < s.railHalfWidth &&
    speed > T.railMinSpeed &&
    absOmega > OMEGA_STOP * 2
  ) {
    for (const arc of s.railArcs) {
      if (!inArc(arc, railContact.theta)) continue;
      const vr = b.vx * railContact.normal.x + b.vy * railContact.normal.y;
      const vt = b.vx * railContact.tangent.x + b.vy * railContact.tangent.y;
      const canMesh =
        p.dashFactor >= T.railRideMinDash &&
        Math.abs(vt) >= T.railMinSpeed * 0.75 &&
        Math.abs(vt) >= Math.abs(vr) * 0.65;
      if (canMesh) {
        // A Bit arriving substantially along the rack presents its gear teeth
        // to the line and meshes; normal-dominant motion climbs or clashes.
        b.railTicks = T.railTicks;
        b.railDir = vt >= 0 ? 1 : -1;
        pushEvent(w, "dashStart", i, speed);
      } else if (vr >= T.railBreakSpeed) {
        // This early contact probe only decides that the Bey is eligible to
        // climb. The swept resolver below owns the energy debit, spin graze
        // and single gear event at the actual crossing.
        break;
      }
      if (vr > T.railTripSpeed) {
        // slammed into the rack: teeth clash instead of meshing — the bey
        // is tripped: bounced off, destabilized, and takes a burst click
        b.railTicks = -T.railCooldownTicks;
        b.vx -= railContact.normal.x * vr * 1.6;
        b.vy -= railContact.normal.y * vr * 1.6;
        const jolt = (rand(w) - 0.5) * 0.5;
        b.vx += railContact.tangent.x * jolt;
        b.vy += railContact.tangent.y * jolt;
        b.omega *= T.tripSpinKeep;
        pushEvent(w, "trip", i, vr);
      }
      break;
    }
  }
  if (!activePocket && b.railTicks > 0) {
    const nearestRail = railClosestPoint(s, b.x, b.y);
    // while meshed the teeth are a positional constraint — only leaving the
    // rack's arc (or a dip sling / mesh end) releases the bey
    const inBand = s.railArcs.some((a) => inArc(a, nearestRail.theta));
    if (!inBand) {
      // flung off the rack — dart across the stadium
      b.railTicks = -T.railCooldownTicks;
      b.vx += -ur.x * T.railFlingRadial * p.dashFactor;
      b.vy += -ur.y * T.railFlingRadial * p.dashFactor;
      pushEvent(w, "dashEnd", i, Math.sqrt(b.vx * b.vx + b.vy * b.vy));
    } else {
      b.railTicks--;
      const ct = nearestRail.tangent;
      // rack-and-pinion drive: accelerate toward synchronous speed
      // (spin → travel), efficiency scaled by the bit's dash stat
      const meshEff = 0.45 + 0.55 * Math.min(1, p.dashFactor / 1.6);
      const vSync = Math.min(T.railMaxSpeed, absOmega * T.gearRadius) * meshEff;
      // A meshed Bit carries scalar speed through a molded corner. Projecting
      // the old segment's velocity onto the new near-radial jog erased almost
      // all energy exactly where the product redirects the Bey toward center.
      const vAlong = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      // Product ramp release is shape-driven. Keep the true inward tangent;
      // never erase it with a radial projection or replace it with homing.
      const releaseDirection = railReleaseDirectionAt(s, nearestRail.theta, b.railDir);
      if (releaseDirection && vAlong > T.dipSlingSpeed) {
        b.railTicks = -T.railCooldownTicks;
        const releaseSpeed = Math.min(
          T.railMaxSpeed + T.dipSlingBoost,
          vAlong + T.dipSlingBoost * p.dashFactor,
        );
        b.x = nearestRail.point.x;
        b.y = nearestRail.point.y;
        b.vx = releaseDirection.x * releaseSpeed;
        b.vy = releaseDirection.y * releaseSpeed;
        pushEvent(w, "dashEnd", i, vAlong);
      } else {
        const dv = Math.min(Math.max(0, vSync - vAlong), T.railMeshAccel * DT);
        // driving the rack costs spin (energy conservation, loosely)
        b.omega -= Math.sign(b.omega) * dv * 6;
        // Holonomic curve constraint preserves the actual dogleg tangent,
        // including its inward component.
        b.x = nearestRail.point.x;
        b.y = nearestRail.point.y;
        const constrainedSpeed = Math.max(0, vAlong + dv);
        b.vx = ct.x * b.railDir * constrainedSpeed;
        b.vy = ct.y * b.railDir * constrainedSpeed;
        if (b.railTicks % T.gearEventEvery === 0) pushEvent(w, "gear", i, vAlong);
        if (b.railTicks === 0) b.railTicks = -T.railCooldownTicks;
      }
    }
  }

  // integrate
  const previousX = b.x;
  const previousY = b.y;
  b.x += b.vx * DT;
  b.y += b.vy * DT;
  b.phase += b.omega * DT;

  // the gear rack is a PHYSICAL ridge even when not meshed (cooldown, slow
  // or dying beys): crossing outward needs real speed, otherwise the teeth
  // hold the bey inside the bowl — only hard knockbacks hop over
  if (!activePocket && xtremeDash && s.railArcs.length > 0 && b.railTicks <= 0) {
    const closestRail = railClosestPoint(s, b.x, b.y);
    if (s.railArcs.some((a) => inArc(a, closestRail.theta))) {
      const nx = closestRail.normal.x;
      const ny = closestRail.normal.y;
      const signedDistance = closestRail.signedDistance;
      const inner = -s.railHalfWidth * T.railBarrierInner;
      const previousRail = railClosestPoint(s, previousX, previousY);
      const crossedRack =
        s.railArcs.some((a) => inArc(a, previousRail.theta)) &&
        previousRail.signedDistance <= inner &&
        signedDistance > inner;
      // Resolve the physical crossing once. Re-applying containment on every
      // later tick pulled already-cleared Beys backward across an invisible
      // wall as normal speed decayed.
      if (crossedRack) {
        const vrB = b.vx * nx + b.vy * ny;
        if (vrB >= T.railBreakSpeed) {
          // Pay the guide-climb energy once, at the actual swept crossing.
          // Debiting during the earlier contact probe would lower vr before
          // this resolver and incorrectly reflect a legitimate hop.
          const retainedNormalSpeed = Math.sqrt(Math.max(0, vrB * vrB - T.railBreakSpeed * T.railBreakSpeed));
          b.vx += (retainedNormalSpeed - vrB) * nx;
          b.vy += (retainedNormalSpeed - vrB) * ny;
          b.omega *= 0.98;
          pushEvent(w, "gear", i, vrB);
        } else if (vrB > 0) {
          b.vx -= (1 + T.railBumpRestitution) * vrB * nx;
          b.vy -= (1 + T.railBumpRestitution) * vrB * ny;
          const over = signedDistance - inner;
          b.x -= nx * over;
          b.y -= ny * over;
          pushEvent(w, "gear", i, vrB); // teeth graze as the ridge holds
        }
      }
    }
  }

  // Live pockets: crossing a real 2-D throat does not instantly score. The
  // Bey follows the concave terrain, can rebound from the basin rim and escape
  // through the open inner edge, and remains collidable while there.
  const pocketHere = pocketAtPoint(s, b.x, b.y);
  const throatHere = pocketThroatAtPoint(s, b.x, b.y);
  const contactClearance = p.radiusM * 0.6;
  const crossedOutward =
    stadiumBoundarySignedDistance(s, previousX, previousY, contactClearance) <= 0 &&
    stadiumBoundarySignedDistance(s, b.x, b.y, contactClearance) > 0;
  const entryNormal = stadiumBoundaryNormalAt(s, b.x, b.y);
  const entrySpeed = b.vx * entryNormal.x + b.vy * entryNormal.y;
  if (
    !activePocket &&
    pocketHere &&
    throatHere === pocketHere &&
    crossedOutward &&
    entrySpeed >= Math.min(s.exitSpeed, T.pocketEntrySpeed)
  ) {
    b.pocketIndex = s.pockets.indexOf(pocketHere);
    b.pocketDwell = 0;
    b.pocketDisturbedTick = w.tick;
    b.pocketBlockingTick = w.tick;
    b.pocketLastX = b.x;
    b.pocketLastY = b.y;
    b.stopDwell = 0;
    b.railTicks = -T.railCooldownTicks;
    activePocket = pocketHere;
  }
  if (activePocket && !constrainPocket(s, b, activePocket, p.radiusM, w.tick)) {
    b.pocketIndex = -1;
    b.pocketDwell = 0;
    b.pocketDisturbedTick = w.tick;
    activePocket = null;
  }

  // Solid circular/obround bowl wall. Its only official holes are the live
  // pocket throats above; no wall bounce is applied while a Bey occupies one.
  const wallPenetration = stadiumBoundarySignedDistance(s, b.x, b.y, contactClearance);
  if (!activePocket && wallPenetration > 0) {
    const u = stadiumBoundaryNormalAt(s, b.x, b.y);
    const vr = b.vx * u.x + b.vy * u.y;
    const angleNow = datan2(b.y, b.x);
    if (vr > T.overTopSpeed) {
      // Official products have no invented loose casing gaps: their only
      // side apertures are the exact 2-D pocket polygons tested above. Keep
      // legacy `coverGaps` support solely for custom stadium specs.
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
      b.x -= u.x * wallPenetration;
      b.y -= u.y * wallPenetration;
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
    b.x -= u.x * wallPenetration;
    b.y -= u.y * wallPenetration;
  }

}

/**
 * Settle bookkeeping runs AFTER all collisions for the tick. Otherwise a
 * bey at dwell 143 could be declared stopped in stepBey and then visibly
 * kicked (or Burst) by collide() on the same tick while retaining a stale
 * Spin Finish.
 */
function updateStopStates(w: WorldState): void {
  for (const b of w.beys) {
    if (!b.alive || b.exited !== null || b.pendingTicks > 0 || b.airborne) {
      b.stopDwell = 0;
      continue;
    }
    // A translationally retained Bey inside a live Over/Xtreme basin is
    // authorized by the shorter zone dwell (even while spinning); it must
    // never become an ordinary Spin Finish.
    if (b.pocketIndex >= 0) {
      b.stopDwell = 0;
      continue;
    }
    const settledSpeed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    const fullySettled =
      b.omega === 0 && // decay clamps exactly; never announce while visibly rotating
      settledSpeed < STOP_LINEAR_SPEED &&
      Math.abs(b.vz) < 1e-6 &&
      b.railTicks <= 0;
    if (fullySettled) {
      b.stopDwell++;
      if (b.stopDwell >= STOP_DWELL_TICKS && b.stoppedTick < 0) {
        b.stoppedTick = w.tick;
      }
    } else {
      b.stopDwell = 0;
    }
  }
}

function updatePocketStates(w: WorldState, cfg: WorldConfig, s: StadiumSpec): void {
  for (let i = 0; i < w.beys.length; i++) {
    const b = w.beys[i]!;
    if (!b.alive || b.exited !== null || b.pendingTicks > 0 || b.airborne || b.pocketIndex < 0) {
      b.pocketDwell = 0;
      b.pocketLastX = b.x;
      b.pocketLastY = b.y;
      continue;
    }
    const pocket = s.pockets[b.pocketIndex];
    if (!pocket || pocketAtPoint(s, b.x, b.y) !== pocket) {
      b.pocketIndex = -1;
      b.pocketDwell = 0;
      b.pocketLastX = b.x;
      b.pocketLastY = b.y;
      continue;
    }
    // Judge what the Bey actually did after basin constraints and collisions,
    // not a residual velocity vector pressing into a solid molded wall. This
    // matches the visible/physical meaning of "not moving" while still letting
    // a circulating or rebounding Bey retain momentum and escape.
    const dx = b.x - b.pocketLastX;
    const dy = b.y - b.pocketLastY;
    const translationallySettled =
      dx * dx + dy * dy <= POCKET_REST_DISPLACEMENT * POCKET_REST_DISPLACEMENT &&
      b.vz === 0 &&
      b.railTicks <= 0;
    b.pocketLastX = b.x;
    b.pocketLastY = b.y;
    const uninterrupted = b.pocketBlockingTick < w.tick;
    // Continued pocket identity already proves that the center remains in the
    // authored concave zone. Requiring the *entire circular footprint* here
    // stranded real-looking edge rests forever: the reported BX-10 replay had
    // a Bey motionless for more than ten seconds because part of its Blade
    // overhung a sloped basin edge. A stopped occupant cannot climb back out,
    // so translational rest—not spin or an artificial clearance inset—is the
    // terminal condition.
    if (!translationallySettled || !uninterrupted) {
      b.pocketDwell = 0;
      continue;
    }
    b.pocketDwell++;
    if (b.pocketDwell >= POCKET_DWELL_TICKS) {
      b.exited = pocket.kind;
      b.alive = false;
      pushEvent(w, "exit", i, 0);
    }
  }
}

function resolvePocketConstraints(w: WorldState, cfg: WorldConfig, s: StadiumSpec): void {
  for (let i = 0; i < w.beys.length; i++) {
    const b = w.beys[i]!;
    if (!b.alive || b.pocketIndex < 0) continue;
    const pocket = s.pockets[b.pocketIndex];
    if (!pocket) {
      b.pocketIndex = -1;
      b.pocketDwell = 0;
      continue;
    }
    if (!constrainPocket(s, b, pocket, cfg.beys[i]!.radiusM, w.tick)) {
      b.pocketIndex = -1;
      b.pocketDwell = 0;
      b.pocketDisturbedTick = w.tick;
    }
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
  if (b1.pendingTicks > 0 || b2.pendingTicks > 0) return; // not launched yet
  if (b1.airborne || b2.airborne) return; // mid-air beys pass over
  const dx = b2.x - b1.x;
  const dy = b2.y - b1.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const minDist = p1.radiusM + p2.radiusM;
  if (dist >= minDist || dist < 1e-9) return;

  // Even a low-speed overlap requires positional correction. Treat that as
  // a real basin disturbance so a collision tick cannot complete a retained-
  // zone dwell merely because its post-impact speed falls under the sleep gate.
  if (b1.pocketIndex >= 0) {
    b1.pocketDwell = 0;
    b1.pocketDisturbedTick = w.tick;
    b1.pocketBlockingTick = w.tick;
  }
  if (b2.pocketIndex >= 0) {
    b2.pocketDwell = 0;
    b2.pocketDisturbedTick = w.tick;
    b2.pocketBlockingTick = w.tick;
  }

  const n = { x: dx / dist, y: dy / dist };
  const t = { x: -n.y, y: n.x };
  const pre1 = { vx: b1.vx, vy: b1.vy };
  const pre2 = { vx: b2.vx, vy: b2.vy };

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

  // Ratchet detents respond once per PHYSICAL closing impact. The old path
  // re-evaluated tangential slip on every overlap tick, allowing one clash
  // to masquerade as several latch hits. Radial closing impulse identifies
  // a new collision episode; transmitted tangential impulse determines the
  // signed unlock/re-seat torque against the Bit Gear Structure.
  if (
    jn >= T.latchImpactMinNormal &&
    w.tick - b1.lastLatchImpactTick >= T.latchImpactGapTicks
  ) {
    b1.lastLatchImpactTick = w.tick;
    const response = latchImpactResponse(p1, {
      normalImpulse: jn,
      incomingSmash: smash2,
      attackerSpinDir: d2,
      currentClicks: b1.burstDamage,
    });
    applyLatchDetent(
      w,
      b1,
      p1,
      i,
      response.detentDelta,
      cfg.clicksMax,
      response.overloadSeverity,
      {
        tick: w.tick,
        contactAngle: datan2(n.y, n.x),
        normalImpulse: jn,
        tangentialImpulse: d2 === p1.spinDir ? smash2 : -smash2,
        preVx: pre1.vx,
        preVy: pre1.vy,
        postVx: b1.vx,
        postVy: b1.vy,
        omega: b1.omega,
        phase: b1.phase,
        severity: response.overloadSeverity,
        seed: burstReleaseSeed(w, i),
      },
    );
  }
  if (
    jn >= T.latchImpactMinNormal &&
    w.tick - b2.lastLatchImpactTick >= T.latchImpactGapTicks
  ) {
    b2.lastLatchImpactTick = w.tick;
    const response = latchImpactResponse(p2, {
      normalImpulse: jn,
      incomingSmash: smash1,
      attackerSpinDir: d1,
      currentClicks: b2.burstDamage,
    });
    applyLatchDetent(
      w,
      b2,
      p2,
      j,
      response.detentDelta,
      cfg.clicksMax,
      response.overloadSeverity,
      {
        tick: w.tick,
        contactAngle: datan2(-n.y, -n.x),
        normalImpulse: jn,
        tangentialImpulse: d1 === p2.spinDir ? smash1 : -smash1,
        preVx: pre2.vx,
        preVy: pre2.vy,
        postVx: b2.vx,
        postVy: b2.vy,
        omega: b2.omega,
        phase: b2.phase,
        severity: response.overloadSeverity,
        seed: burstReleaseSeed(w, j),
      },
    );
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

function applyLatchDetent(
  w: WorldState,
  b: BeyState,
  p: BeyParams,
  i: number,
  detentDelta: number,
  clicksMax: number,
  overloadSeverity = 0,
  release: BurstReleaseState | null = null,
): void {
  if (detentDelta === 0) return;
  const before = Math.round(b.burstDamage);
  const after = clamp(before + detentDelta, 0, clicksMax);
  if (after === before) return;
  const direction = after > before ? 1 : -1;
  for (let click = before + direction; click !== after + direction; click += direction) {
    pushEvent(w, "click", i, click);
  }
  b.burstDamage = after;
  if (after >= clicksMax) {
    b.burstOverload = clamp(overloadSeverity, 0, 1);
    b.burstRelease = release
      ? { ...release, severity: b.burstOverload, seed: release.seed >>> 0 }
      : null;
    b.alive = false; // burst finish — exited stays null
  }
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
  // The tick cap is a safety/time limit, not a fictional Spin Finish. If
  // several Beys are still alive, the round is unresolved and must re-battle.
  else if (w.tick >= cfg.maxTicks) w.ffaWinner = -1;
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
    // Never call a Spin Finish by comparing two still-rotating Beys at the
    // simulation safety cap. A true Spin Finish is authorized only by the
    // exact-zero, settled dwell above; a live timeout is a draw/re-battle.
    if (w.tick >= cfg.maxTicks) w.draw = true;
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
    // still in the launcher: this player released later than the others
    if (b.pendingTicks > 0) {
      b.pendingTicks--;
      continue;
    }
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
    stepBey(w, s, b, cfg.beys[i]!, i, cfg.xtremeDashEnabled, other);
  }
  collide(w, cfg);
  resolvePocketConstraints(w, cfg, s);
  updatePocketStates(w, cfg, s);
  updateStopStates(w);
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
  const finishType = w.finish?.type === "spin"
    ? 1
    : w.finish?.type === "over"
      ? 2
      : w.finish?.type === "burst"
        ? 3
        : w.finish?.type === "xtreme"
          ? 4
          : 0;
  const vals: number[] = [
    w.tick,
    w.rng,
    w.lastHitTick,
    w.draw ? 1 : 0,
    w.ffaWinner ?? -2,
    w.finish ? 1 : 0,
    finishType,
    w.finish?.winner ?? -1,
    w.finish?.ownFinish ? 1 : 0,
    w.finish?.tick ?? -1,
    w.eliminatedOrder.length,
    ...w.eliminatedOrder,
  ];
  for (const b of w.beys) {
    const exitCode = b.exited === "over"
      ? 1
      : b.exited === "xtreme"
        ? 2
        : b.exited === "top"
          ? 3
          : b.exited === "launchMiss"
            ? 4
            : 0;
    vals.push(
      b.x,
      b.y,
      b.vx,
      b.vy,
      b.z,
      b.vz,
      b.omega,
      b.burstDamage,
      b.burstOverload,
      b.lastLatchImpactTick,
      b.airborne ? 1 : 0,
      b.pendingTicks,
      b.alive ? 1 : 0,
      exitCode,
      b.pocketIndex,
      b.pocketDwell,
      b.pocketDisturbedTick,
      b.pocketBlockingTick,
      b.pocketLastX,
      b.pocketLastY,
      b.stoppedTick,
      b.stopDwell,
      b.contacted ? 1 : 0,
      b.railTicks,
      b.railDir,
      b.phase,
    );
    const release = b.burstRelease;
    vals.push(
      release ? 1 : 0,
      release?.tick ?? -1,
      release?.contactAngle ?? 0,
      release?.normalImpulse ?? 0,
      release?.tangentialImpulse ?? 0,
      release?.preVx ?? 0,
      release?.preVy ?? 0,
      release?.postVx ?? 0,
      release?.postVy ?? 0,
      release?.omega ?? 0,
      release?.phase ?? 0,
      release?.severity ?? 0,
      release?.seed ?? 0,
    );
  }
  return hashFloats(vals);
}

export { T as SIM_TUNING };
