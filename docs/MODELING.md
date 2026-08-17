# Modeling reference (real-world dimensions and materials)

Everything the renderer builds is parametric — no third-party meshes ship
with this project. Transparent catalog renders are normalized into sourced
top/side references, then traced into high-density silhouettes and used as
alpha-cut surface maps. This file is the measured reference those parameters
come from, so geometry can be checked against reality instead of taste.

Units in the renderer are **metres** (the sim is SI), so a 48.5 mm blade is
`0.0485`.

## 1. Beyblade (BX / UX / CX systems)

### 1.1 Overall

A Beyblade X top is a three-part stack (BX/UX) or a four-part stack (CX):

```
BX/UX:  Blade (metal upper + plastic core)  ─┐
        Ratchet (N protrusions, height mm)   ├─ screwed together, burst-latched
        Bit (tip, sometimes gear-ringed)    ─┘

CX:     Lock Chip → Main Blade → Assist Blade → Ratchet → Bit
```

**Per-part diameters and weights are real** and already in
`app/public/data/parts.json` (`diameterMm`, `weightG`, from the phstudy
dataset which mirrors the official Takara Tomy app). Measured ranges:

| Part | Diameter | Mass |
| --- | --- | --- |
| Blade (BX/UX) | 45.0 – 52.5 mm (Dran Sword 48.5, Shark Edge 49.0, Knight Shield 48.0) | 26 – 36 g |
| Main Blade (CX) | 51.0 – 52.5 mm | 29 – 32 g |
| Assist Blade (CX) | 45.0 – 48.0 mm | 4.6 – 5.2 g |
| Ratchet | ≈ 26 mm across the protrusions | 5 – 9 g |
| Bit | ≈ 19 mm flange | 2 – 5 g |

The renderer reads `diameterMm` per part and falls back to the derived
`BeyParams.radiusM` only when the dataset has no measurement.

### 1.2 Ratchet naming → geometry

The ratchet code is literally its geometry: **first number = count of
protrusions, second number = height in tenths of a millimetre.**
`3-60` = 3 protrusions, 6.0 mm tall; `9-60` = 9 protrusions, 6.0 mm;
`4-80` = 4 protrusions, 8.0 mm. Heights in the dataset run 5.0 – 8.5 mm.
Those same protrusions are the burst latch joints the physics core uses
(`BeyParams.latchCount`, docs/PHYSICS.md).

Material: translucent glass-filled nylon / POM, faintly milky, low
roughness. Standard Ratchets use separate molded ring/cover/base pieces; only
M-85 carries the visible riveted metal underside ring. Codes ending in 5 use
the compact Simple/O-type joint, and zero-series Ratchets have a smooth
zero-lobe perimeter.

### 1.3 Bit codes → tip shape

Bits are the tip and set the movement pattern. Code families, with the
shapes the renderer builds:

| Family | Codes | Tip shape |
| --- | --- | --- |
| Flat | `F`, `LF`, `UF`, `FF`, `WF` | wide flat disc, sharp edge — aggressive skidding |
| Ball | `B`, `O`, `DB`, `FB`, `WB`, `LO` | hemisphere |
| Needle | `N`, `HN`, `MN`, `GN` | narrow cone to a small radius |
| Point | `P`, `GP`, `TP`, `D`, `S` | very fine point |
| Taper | `T`, `HT` | tall truncated cone |
| Rush | `R`, `LR`, `GR` | small hard-plastic flat with a shortened 10-tooth gear |
| Rubber | `RA`, `M` | a rubber contact insert or sleeve, matte and grippy |
| Extended Gear | `GF`, `GB`, `GP`, `GN`, `GR`, `GU` | the normal gear teeth continue down around the contact shape |

`MN` (Metal Needle) has a metal insert, not an all-metal body. Every ordinary
X Bit has a molded X-Line gear (usually 12 teeth; code-specific counts range
from 10 to 20). The gear is modelled as geometry, not a texture. Exact exposed
and total heights come from `part_weights.json` and the keyed Bit catalog.

### 1.4 Materials

- **Blade upper**: die-cast zinc alloy, either bare (spun/brushed, strongly
  anisotropic highlight) or painted; metallic ≈ 0.9, roughness 0.25 – 0.4.
- **Blade core / underlay**: ABS, glossy injection-moulded, faint orange-peel.
- **Ratchet**: translucent POM/nylon, clearcoat.
- **Bit**: POM (hard tips), rubber (`RA`/`M`, matte roughness ≈ 0.9),
  metal (`MN`).
- Official colourways come from the dataset's `color` field.
- Official presets retain their exact source-part palette, so multi-color
  Ratchets/Bits and recolored/metal-coated variants do not collapse to one
  generic tint.

### 1.5 Reference-driven topology

`tools/fetch-model-reference.py` uses the public MediaWiki API to normalize
isolated part renders. The generated manifest stores 256 radial samples for
upper parts/Ratchets and 96 side samples for Bits. BX/UX upper bodies retain
about 61k triangles; lower parts retain at least about 25k. Full catalog tops
are UV-mapped with alpha-cut gaps, while CX is assembled from its real layers:
Lock Chip + Main + Assist, or Expand Lock Chip + Metal + Over + Assist.

## 2. Stadiums

### 2.1 BX-10 Xtreme Stadium (tournament standard)

- Outer body **440 × 455 × 155 mm**, square-ish moulded shell.
- **Tornado Ridge diameter 210 mm** — the raised circular ridge that returns
  tops toward the centre; the bowl inside it is the battle dish.
- **Xtreme Line**: a gear rack moulded into the floor (green on the standard
  release) that meshes with gear-ringed Bits to trigger the Xtreme Dash.
- **Three exits, all on one side**: two corner **Over Zones** (2 pt) flanking
  one wide central **Xtreme Zone** (3 pt).
- Colours: white body, green X-Line, transparent outer casing panels.

### 2.2 BX-32 Wide Xtreme Stadium

- **600 × 440 mm**, the largest Beyblade X stadium, and — usefully for this
  project — **designed for three players**, which is exactly the free-for-all
  (大亂鬥) mode's stadium.

## 3. Launchers

Three real types, all modelled:

- **Winder launcher** — ripcord ("winder") pulled straight out through the
  side; the entry-level launcher, geared.
- **String launcher** — the string is built into the unit; pull the handle
  and the string retracts itself. Highest control, tournament favourite.
- **Gear grip / custom grip** — a pistol-style grip that clips onto either
  launcher for stability; sold separately and legal in tournaments.

All three mount the bey underneath on a sprung claw that releases at speed.

## 4. Hands

Modelled anatomically rather than as blobs: palm, four fingers of three
phalanges each with realistic curl when gripping, opposed thumb, and a
wrist. Skin uses a subsurface-ish shading (high roughness, warm
transmission tint) rather than plain diffuse.

## 5. Rendering realism

Browsers have **no hardware ray tracing** — neither WebGL2 nor WebGPU
exposes RT cores, so a literal path tracer is not available at 60 fps on a
phone. The equivalent, and what this project implements, is a custom
fragment-shader pass that **ray-marches the depth and normal buffers**:

- screen-space ray-traced reflections (metal blades reflect the stadium and
  each other, not just the environment probe),
- ray-marched contact shadows where geometry meets the dish,
- hemispherical ray-marched ambient occlusion.

That runs on top of physically-based materials lit by an image-based
lighting probe generated from a procedural studio environment.

## Sources

- [Beyblade Wiki — Xtreme Stadium](https://beyblade.wiki/xtreme-stadium/)
- [Beyblade Wiki — Wide Xtreme Stadium](https://beyblade.fandom.com/wiki/Wide_Xtreme_Stadium)
- [Beyblade Wiki — Ratchet 3-60](https://beyblade.fandom.com/wiki/Ratchet_-_3-60)
- [Beyblade X Database — Bits](https://www.beybxdb.com/parts-system-guide/parts/bit)
- [Beyblade X Database — Ratchets](https://www.beybxdb.com/parts-system-guide/parts/ratchet)
- [Beyblade Wiki — Dran Sword blade](https://beyblade.fandom.com/wiki/Blade_-_DranSword)
- [TheGamer — Beyblade X launcher types](https://www.thegamer.com/beyblade-x-launcher-types-guide/)
- Per-part diameters/weights: phstudy dataset (docs/DATA.md).
