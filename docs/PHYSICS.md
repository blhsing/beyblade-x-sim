# Physics Model (core simulation)

Implemented in `app/src/core/` (`sim.ts`, `stadium.ts`, `derive.ts`,
`fxmath.ts`). Design goals: *believable* spinning-top battles driven by real
part stats, and *bit-exact determinism* across devices.

## Determinism contract

Current deterministic replay/lockstep version: **4**. Version 4 replaces the
pocket capture brake with reversible catch-tray dynamics and retained-zone
scoring based on secure translational rest rather than zero spin. It also
calibrates the shared rack envelope to a nominal inferred 4.6 mm, debits climb
energy at swept crossings, and replaces BX-32's faceted sides with dense round
lobes while retaining its two authored release jogs. Version 3 replaced the
sparse polygonal X-Line evaluator with a shared deterministic piecewise-cubic
centerline while retaining authored linear release jogs.
Peers or archived replays produced by another physics version must not be
hash-compared.

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
spin direction), discrete `burstDamage` detents, last distinct latch-impact
tick, deterministic terminal `burstRelease` snapshot, rail state, live-pocket
identity, settle dwell and last disturbance tick, contact flag (for the
own-finish rule), visual phase.

## Forces & behaviours per tick

1. **Bowl gravity**: surface is an analytic profile mapped over the product
   boundary (circular BX-10; homothetic obround BX-32), from parabolic dish
   through tornado ridge to the steeper wall band. Its 2-D gradient pulls
   downhill rather than assuming every stadium is circular.
2. **Tornado drift**: tip traction converts spin into tangential travel
   (`grip × min(1, ω/600) × (1 − v/v_sat)`), signed by spin direction —
   attack types with grippy flat/rubber tips orbit hard; needle tips barely
   drift. This produces the characteristic circling + flower patterns.
3. **Damping**: translational drag `muMove` (tip-type dependent), plus a
   stumble term when `ω < 120 rad/s`. Recessed trays add only mild polymer-on-
   plastic loss, so they do not erase entry momentum.
4. **Spin decay**: `muSpin × (base + k·speed)` — travelling costs spin.
   Solo endurance lands in the real 60–180 s band depending on tip.
5. **Xtreme Line (gear rack)**: each product owns one traced 2-D centerline
   used by physics and rendering. Ordinary spans use cached XY cubic-Hermite
   curves with a closed C1 seam; only explicitly authored near-radial release
   jogs remain sharp and linear. A dash-capable Bit can mesh, accelerate along
   the actual curve tangent and leave only on one of those inward ramps.
   Release keeps the dogleg's inward tangent—there is no opponent-seeking or
   generic radial sling. The modeled guide is a 2.4 mm shoulder plus 2.2 mm
   tooth rise (4.6 mm nominal local peak, inferred from patent/Bit engagement;
   not a published factory dimension). A normal crossing needs approximately
   0.50 m/s and pays the corresponding climb energy exactly once; slower
   crossings deflect instead of leaking through or treating the rack as an
   invisible full-height wall.
6. **Wall & pockets**: wall bounce (restitution + spin-driven tangential
   kick). Each product opening is an explicit 2-D throat/catch union shared
   with rendering and debris. A Bey must cross the clearance-adjusted wall
   outward through the real throat with sufficient speed to enter the live,
   recessed sloped tray. Incoming linear and angular momentum continue across
   the throat; the Bey can circulate, collide with another Bey, rebound with
   low tangential loss from the cheeks/backstop, and return through the open
   mouth when it carries enough momentum uphill. Entry alone is not a finish.
   Official stadiums have no invented angular side gaps.
7. **Collisions** (circle-circle): normal impulse (restitution 0.25,
   mass-weighted) + two directed "smash" impulses derived from **rim slip**
   `|ω₁r₁ + ω₂r₂|/2` — same-direction spins collide hardest, opposite-spin
   pairs grind (signed ω makes this emerge naturally). Attack stat scales
   smash and its variance (PRNG); defense divides received impulse; both
   sides lose spin ∝ received impulse.
8. **Burst**: one physically distinct closing impact can transmit signed
   tangential torque through the Blade. Torque in the unlock direction must
   exceed the active joint-resistance yield before it slips one or two discrete
   detents; reverse torque can re-seat one partial detent. Sustained overlap
   cannot generate extra clicks. `burstDamage ≥ clicksMax(4)` releases the
   Ratchet latch: this is a **Burst**, not a crack or material-fracture model.
   A normal release keeps the Ratchet and Bit coupled while the complete upper
   assembly separates; only an exceptional terminal overload ejects the Bit.
   No catalog Ratchet is treated as automatically Burst-immune. The source
   field `fixedBurst` means that Ratchet supplies a constant resistance stat
   instead of inheriting the selected Bit's stat; it does not disable release.

The presentation receives the terminal position, linear velocity, spin axis,
contact impulse and a deterministic seed from the core. Released bodies use
catalog-derived masses, geometry-derived support points/inertia and fixed
1/240 s rigid-body steps against one another and the same stadium terrain used
by play. It does not add random explosion energy, sparks, cosmetic cracks or
frame-rate-dependent scatter.

## Finishes (official scoring, stricter simulation authorization)

Takara Tomy's retained-zone standard is that the complete Bey remains in the
Over/Xtreme Zone and cannot return. The simulation confirms this from the
complete circular footprint and a short uninterrupted translational-rest
dwell. Spin does not prevent retention: a Bey may remain upright and rotating
in a catch tray after its center of mass and Bit contact have come to rest.

`spin` requires ω = 0 (the decay integrator clamps exactly) **and** speed
< 0.005 m/s continuously for 0.6 s; static friction sleeps that zero-spin,
low-speed contact so the qualifying dwell cannot visibly slide · `over` (2
pts) / `xtreme` (3 pts) require the complete Bey footprint to be securely
inside the same catch tray with exactly slept planar/vertical motion for 24
uninterrupted ticks; ω is not part of this test. Motion, wall/Bey impact,
leaving or changing a pocket resets that dwell ·
`burst` (2 pts) · own-finish flag when a bey exits
without ever touching the opponent (1 pt to opponent). Simultaneous terminal
events in one tick ⇒ draw (no points, re-battle). Over-the-top ⇒ replay.
The simulation safety/time cap never compares two still-rotating Beys and
calls that a Spin Finish; if neither has fully settled, the battle is a draw.

## Stats → parameters (`derive.ts`)

- **mass** = Σ measured part weights (phstudy `part_weights`, fallbacks per
  category); **radius** from blade diameter; **inertia** `= (0.5+0.3·stamina̅)·m·r²`
  (stamina designs are rim-weighted).
- **attackFactor/variance** from summed attack; **defenseFactor** from
  defense; **burstRes** from the Bit burst stat + upper-stack defense, except a catalog
  `fixedBurst` Ratchet uses its own fixed burst stat regardless of Bit;
  **dashFactor** from
  bit dash; **grip/muSpin/muMove** from bit code archetype (flat/rubber/
  needle/ball/point) blended with bit stats; **spin direction** from
  blade/lock-chip rotation (dual-spin blades choose at launch).
- Ratchet height code (`N-HH`, HH in 0.1 mm) sets center-of-gravity height;
  `fixedBurst` describes a fixed numeric resistance source, never immunity.

## Launch mapping

SP (shoot power, 0–11000, Beybattle-Pass-like) → entry speed
`0.45 + SP·1.25/11000` m/s (× launcher curve: entry 0.82 / winder 0.9 /
long-winder 0.98 / string 1.05 / hold 1.0) and
`ω₀ = 250 + 0.055·SP` rad/s (× entry 0.86 / long-winder 1.08 / hold 1.12 /
other launchers 1.0 × staminaFactor). L versions use the corresponding
winder/string curve after spin-direction compatibility is enforced. Each
side has a fixed physical launcher mount; aim rotates the horizontal release
velocity and outward tilt adds a radial component, so a sufficiently crooked
gesture can land outside the casing instead of being corrected toward a safe
entry point. Typical 7000 SP ⇒ ~6100 RPM, consistent with community
measurements.

## Tuning

All constants live in `SIM_TUNING` (`sim.ts`) and stadium specs
(`stadium.ts`). Calibration workflow (M3+): headless 1000-battle batches per
matchup archetype; compare finish-type distribution and battle length against
real tournament footage; adjust one constant at a time.
