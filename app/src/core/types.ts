// Shared types for the parts DB and the simulation core.

export type PartCategory =
  | "blade"
  | "ratchet"
  | "bit"
  | "lockChip"
  | "mainBlade"
  | "assistBlade"
  | "metalBlade"
  | "overBlade";

export type PartType = "attack" | "defense" | "stamina" | "balance" | null;

export type Rotation =
  | "right"
  | "left"
  | "both-right-origin"
  | "both-left-origin"
  | null;

export interface PartStats {
  attack: number;
  defense: number;
  stamina: number;
  dash: number;
  burst: number; // burst resistance
  height: number; // ratchet/assist height, units of 0.1 mm
}

export interface PartEntry {
  key: string; // unique, e.g. "DRANSWORD", "DRANSWORD#2", "3-60", "F"
  group: string;
  category: PartCategory;
  code: string;
  name: { "zh-TW": string; en: string; ja: string };
  variantLabel: string | null;
  type: PartType;
  stats: PartStats;
  rotation: Rotation;
  weightG: number | null;
  diameterMm: number | null;
  /** official colorway name from phstudy part_colors (e.g. "blue", "gold") */
  color?: string | null;
  /** Full mould palette for the representative release, ordered primary → accents. */
  colors?: string[];
  /** Exact Bit rack tooth count measured from the released part. */
  gearTeeth?: number | null;
  /** Full physical Bit height, including the portion captured by the Ratchet. */
  totalHeightMm?: number | null;
  /** Visible Bit height from contact point to the Ratchet mounting face. */
  exposedHeightMm?: number | null;
  /** Contact behavior of a Bit, normalized from its official code. */
  tipFamily?:
    | "flat" | "ball" | "needle" | "point" | "taper" | "spike"
    | "rubberFlat" | "rubberHybrid" | "special" | "integrated" | null;
  /** This part contains the Ratchet mechanism and is not freely combinable. */
  integratedRatchet?: boolean;
  /** short zh-TW flavor/performance description */
  desc?: string | null;
  line: "BX" | "UX" | "CX" | null;
  /** The Ratchet supplies a fixed numeric Burst-resistance stat instead of
   * inheriting the selected Bit's value. This never means Burst immunity. */
  fixedBurst: boolean;
  releaseAt: string | null;
  /** Source row chosen as the default appearance for this mechanical entry. */
  canonicalVariantId?: string | null;
  /** Source row applied while resolving an official preset (runtime only). */
  selectedVariantId?: string;
  /** The selected source row uses a different palette than this entry's reference image. */
  variantColorOverride?: boolean;
  variants: {
    id: string;
    setId: string | null;
    colors?: string[];
    /** Release/colorway suffix such as a metal-coat or clear-edition label. */
    label?: string | null;
  }[];
}

export interface PartsDb {
  generatedAt: string;
  source: string;
  statRanges: Record<string, Record<string, number>> | null;
  parts: Record<PartCategory, PartEntry[]>;
  combos: ComboPreset[];
}

export interface ComboPreset {
  code: string;
  line: "BX" | "UX" | "CX" | null;
  releaseAt: string | null;
  parts: ComboSelection;
}

/** A player's assembled bey, referencing part keys (null = slot unused). */
export interface ComboSelection {
  blade: string | null; // BX/UX line main body (null when CX stack used)
  ratchet: string | null;
  bit: string | null;
  lockChip: string | null;
  mainBlade: string | null;
  assistBlade: string | null;
  metalBlade: string | null;
  overBlade: string | null;
  /** Exact source-part IDs for official presets, used to restore stock palettes. */
  variantIds?: Partial<Record<PartCategory, string>>;
}

export type SpinDir = 1 | -1; // +1 right (cw from above), -1 left

/** Physics parameters derived from a combo (see core/derive.ts). */
export interface BeyParams {
  label: string;
  massKg: number;
  radiusM: number;
  inertia: number; // kg·m² about spin axis
  cogHeightM: number;
  attackFactor: number; // tangential impulse scale on contact
  attackVariance: number; // 0..1 randomness of attack impulses
  defenseFactor: number; // reduces received knockback
  burstRes: number; // Bit-led yield resistance of the Ratchet latch
  dashFactor: number; // xtreme rail acceleration multiplier
  grip: number; // tip traction → traversal drive
  muSpin: number; // spin decay rate (1/s at full contact)
  muMove: number; // translational damping (1/s)
  spinDir: SpinDir;
  /** outer Ratchet perimeter protrusion metadata; NOT internal Bit Gear
   * Structure latch teeth and never a Burst-immunity/strength multiplier */
  latchCount: number;
  staminaFactor: number; // scales effective spin energy
}

/**
 * Every mechanically distinct Takara Tomy BEYBLADE X launcher sold through
 * the current catalog.  Colour-only editions (BX-28, BX-51, prize colours)
 * reuse the matching mechanism here; L launchers remain distinct because
 * their housing, prongs and gear train are mirrored for left spin.
 */
export const LAUNCHER_KINDS = [
  "entry",
  "winder",
  "longWinder",
  "hold",
  "string",
  "winderL",
  "stringL",
] as const;

export type LauncherKind = (typeof LAUNCHER_KINDS)[number];

export interface LaunchParams {
  sp: number; // shoot power, 0..11000 (Beybattle-Pass-like units)
  /** horizontal pull error; normal UI range ±30°, accepted/clamped to ±150°
   * so a severely crooked real-time gesture can visibly miss the stadium */
  aimDeg: number;
  /** outward launcher lean; normal UI range ±20°, accepted -30°..70° */
  tiltDeg: number;
  launcher: LauncherKind;
  spinDir: SpinDir; // effective direction (dual-spin blades choose)
  /** ticks this bey enters AFTER the countdown — players do not release in
   * perfect unison, so a late release really does drop in late instead of
   * everyone magically appearing at once. 0 = dead on the call. */
  delayTicks?: number;
}

export type FinishType = "spin" | "over" | "burst" | "xtreme";

export interface FinishEvent {
  type: FinishType;
  /** index of the WINNING player (opponent of the finished bey) */
  winner: 0 | 1;
  /** true when the losing bey left without ever contacting the opponent */
  ownFinish: boolean;
  tick: number;
}

export interface SimEvent {
  tick: number;
  bey: number;
  kind:
    | "hit"
    | "wallHit"
    | "dashStart"
    | "dashEnd"
    | "click"
    | "exit"
    | "gear" // rack-pinion tooth engagement tick
    | "trip" // slammed into the rack too fast and got tripped
    | "coverHit" // bounced off the transparent casing
    | "land"; // dropped from the launcher onto the stadium surface
  magnitude: number;
}

/** Deterministic terminal Ratchet-release snapshot for presentation. */
export interface BurstReleaseState {
  tick: number;
  /** world-space outward contact normal angle, radians */
  contactAngle: number;
  normalImpulse: number;
  /** signed: positive unlock torque, negative seating torque */
  tangentialImpulse: number;
  preVx: number;
  preVy: number;
  postVx: number;
  postVy: number;
  omega: number;
  phase: number;
  /** same normalized terminal overload as BeyState.burstOverload */
  severity: number;
  /** stable uint32; presentation must not call Math.random() */
  seed: number;
}

export interface BeyState {
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** height above the stadium plane while airborne (launch drop-in) */
  z: number;
  vz: number;
  /** falling from the launcher — no ground forces/rail/walls until landing */
  airborne: boolean;
  /** ticks still to wait before this bey is released into the stadium */
  pendingTicks: number;
  omega: number; // signed rad/s (sign = spin direction)
  /** discrete Ratchet latch slips; bursts when this reaches clicksMax */
  burstDamage: number;
  /** 0..1 normalized overload of the terminal Burst impact. Render uses it
   * to distinguish ordinary Blade release from exceptional Bit ejection. */
  burstOverload: number;
  /** exact terminal release impulse/motion; null until a Ratchet Burst */
  burstRelease: BurstReleaseState | null;
  /** tick of the last physically distinct latch-loading collision */
  lastLatchImpactTick: number;
  alive: boolean;
  exited: "over" | "xtreme" | "top" | "launchMiss" | null;
  /** Index of the live catch zone currently occupied; -1 while in the bowl. */
  pocketIndex: number;
  /** Consecutive translationally-settled ticks inside the same catch zone. */
  pocketDwell: number;
  /** Last fixed tick on which entry, a basin-rim contact, or another Bey
   * disturbed this pocket occupant; retained for deterministic diagnostics. */
  pocketDisturbedTick: number;
  /** Entry or another-Bey contact tick. Unlike a molded-rim correction, this
   * always blocks the current tick from counting as retained rest. */
  pocketBlockingTick: number;
  /** Previous post-constraint center used to distinguish real visible motion
   * from residual velocity that points into a molded pocket wall. */
  pocketLastX: number;
  pocketLastY: number;
  stoppedTick: number; // tick when fully settled (-1 = still in play)
  /** consecutive ticks with zero spin AND settled linear motion */
  stopDwell: number;
  contacted: boolean; // has touched the opponent at least once
  railTicks: number; // remaining xtreme dash ticks (0 = not dashing)
  railDir: 1 | -1; // tangential direction of current dash
  phase: number; // visual rotation phase (rad)
}

export interface WorldConfig {
  seed: number;
  /** 2 = standard battle; 3+ = free-for-all */
  beys: BeyParams[];
  launches: LaunchParams[];
  xtremeDashEnabled: boolean;
  clicksMax: number;
  maxTicks: number;
}

export interface WorldState {
  tick: number;
  rng: number;
  beys: BeyState[];
  /** standard 2-bey result (null in free-for-all worlds) */
  finish: FinishEvent | null;
  /** simultaneous finish in the same tick → draw (no points) */
  draw: boolean;
  /** free-for-all: elimination order + survivor (-1 = simultaneous wipe) */
  eliminatedOrder: number[];
  ffaWinner: number | null;
  events: SimEvent[];
  lastHitTick: number;
}
