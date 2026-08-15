# Physics Model (core simulation)

Implemented in `app/src/core/` (`sim.ts`, `stadium.ts`, `derive.ts`,
`fxmath.ts`). Design goals: *believable* spinning-top battles driven by real
part stats, and *bit-exact determinism* across devices.

## Determinism contract

- Fixed timestep **1/240 s**; sim never reads wall-clock time.
- Only IEEE-deterministic ops in the sim path (`+ − × ÷ sqrt abs floor`).
  `Math.sin/cos/atan2` are forbidden — `fxmath.ts` provides polynomial
  `dsin/dcos/datan2` (err ≤ 5e-6 / 1e-4). Rendering may use native Math.
- One PRNG stream (mulberry32, integer ops) stored in world state; every
  random draw is part of the replay.
- `hashWorld()` = FNV-1a-64 over the dynamic state → lockstep verification.
- Same `WorldConfig` (seed + derived params + launch params) ⇒ identical
  battle on every device. Tests assert this (`app/test/core.test.ts`).

## State per bey

`x y vx vy` (m, m/s in the stadium plane), signed spin `ω` (rad/s, sign =
spin direction), accumulated `burstDamage` (clicks), rail state, contact flag
(for the own-finish rule), visual phase.

## Forces & behaviours per tick

1. **Bowl gravity**: surface is an analytic profile `z(r)` (parabolic dish to
   the tornado ridge, steeper rim band to the wall). Acceleration
   `−g·dz/dr` pulls toward center.
2. **Tornado drift**: tip traction converts spin into tangential travel
   (`grip × min(1, ω/600) × (1 − v/v_sat)`), signed by spin direction —
   attack types with grippy flat/rubber tips orbit hard; needle tips barely
   drift. This produces the characteristic circling + flower patterns.
3. **Damping**: translational drag `muMove` (tip-type dependent), plus a
   stumble term when `ω < 120 rad/s`.
4. **Spin decay**: `muSpin × (base + k·speed)` — travelling costs spin.
   Solo endurance lands in the real 60–180 s band depending on tip.
5. **Xtreme Line (gear rack)**: arcs at radius `rRail`. A bey crossing the
   band with enough speed engages: ~0.15 s of strong tangential acceleration
   (× bit `dash` factor) with a radial spring holding it on the rack, then a
   fling with an inward radial boost — the Xtreme Dash. Cooldown prevents
   immediate re-engage.
6. **Wall & pockets**: wall bounce (restitution + spin-driven tangential
   kick). Pocket arcs: radial exit speed above threshold ⇒ `over` / `xtreme`
   exit. Extreme speed outside a pocket ⇒ `top` (over-the-top: replay).
7. **Collisions** (circle-circle): normal impulse (restitution 0.25,
   mass-weighted) + two directed "smash" impulses derived from **rim slip**
   `|ω₁r₁ + ω₂r₂|/2` — same-direction spins collide hardest, opposite-spin
   pairs grind (signed ω makes this emerge naturally). Attack stat scales
   smash and its variance (PRNG); defense divides received impulse; both
   sides lose spin ∝ received impulse.
8. **Burst**: each hit adds `impulse × k / burstRes` clicks; integer click
   crossings emit haptic/audio events; `burstDamage ≥ clicksMax(4)` ⇒ burst
   (parts scatter). `fixedBurst` ratchets (and CX locked configs) are immune.

## Finishes (official mapping)

`spin` |ω| < 30 rad/s first · `over` pocket exit (2 pts) · `xtreme` central
zone exit (3 pts) · `burst` (2 pts) · own-finish flag when a bey exits
without ever touching the opponent (1 pt to opponent). Simultaneous terminal
events in one tick ⇒ draw (no points, re-battle). Over-the-top ⇒ replay.

## Stats → parameters (`derive.ts`)

- **mass** = Σ measured part weights (phstudy `part_weights`, fallbacks per
  category); **radius** from blade diameter; **inertia** `= (0.5+0.3·stamina̅)·m·r²`
  (stamina designs are rim-weighted).
- **attackFactor/variance** from summed attack; **defenseFactor** from
  defense; **burstRes** from bit burst stat + defense; **dashFactor** from
  bit dash; **grip/muSpin/muMove** from bit code archetype (flat/rubber/
  needle/ball/point) blended with bit stats; **spin direction** from
  blade/lock-chip rotation (dual-spin blades choose at launch).
- Ratchet height code (`N-HH`, HH in 0.1 mm) sets center-of-gravity height;
  `fixedBurst` ratchets lock the burst mechanism.

## Launch mapping

SP (shoot power, 0–11000, Beybattle-Pass-like) → entry speed
`0.45 + SP·1.25/11000` m/s (× launcher curve: winder 0.9 / string 1.05 /
hold 1.0) and `ω₀ = 250 + 0.055·SP` rad/s (× hold 1.12 × staminaFactor);
aim ±25° rotates the entry direction; tilt shifts entry radius. Typical
7000 SP ⇒ ~6100 RPM, consistent with community measurements.

## Tuning

All constants live in `SIM_TUNING` (`sim.ts`) and stadium specs
(`stadium.ts`). Calibration workflow (M3+): headless 1000-battle batches per
matchup archetype; compare finish-type distribution and battle length against
real tournament footage; adjust one constant at a time.
