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
Those protrusions shape perimeter attack exposure; they are not internal
Burst-latch teeth. Burst resistance comes primarily from the Bit Gear Structure.
The count remains in `BeyParams.latchCount` as geometry metadata only.

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

Both selectable stadiums use a tight clear-cover contour derived from the
playable-floor boundary plus the traced pocket concavities, rather than the
rectangular shipping envelope. A 3 mm recessed air seam remains visible as a
thin hole between the molded floor and lower safety wall. The cover shader is
deliberately high-transmission and low-reflection (0.985 transmission, 0.13
roughness, 0.22 clearcoat, 0.18 dielectric specular intensity and 0.28
environment intensity), so background play
remains readable through the casing instead of being covered by a white gloss.
Initial fixed and sensor-driven camera fits use the complete X-Line and pocket
geometry as their non-croppable silhouette; clear casing may crop at the edge.

### 2.1 BX-10 Xtreme Stadium (tournament standard)

- Configured outer body **440 × 455 mm**, square-ish moulded shell. These
  physical measurements are retained for the simulator; Takara Tomy's public
  product page and assembly sheet do not publish an engineering drawing.
- **Tornado Ridge diameter 210 mm** — the raised circular ridge that returns
  tops toward the centre; the bowl inside it is the battle dish.
- **Xtreme Line**: a gear rack moulded into the floor (green on the standard
  release) that meshes with gear-ringed Bits to trigger the Xtreme Dash.
- The material line printed on Takara Tomy's BX-10 sheet identifies the cover
  and body as **PVC**, the green Xtreme Line as **PA**, and the four fasteners
  as **PP**. The pale battle tray and mostly transparent, faceted outer casing
  are shaded separately; no ABS or polycarbonate chemistry is inferred.
- The continuous Xtreme Line follows a product-specific traced centerline,
  including the centered inward release bay. Its topology was traced from the
  user-supplied straight-on retail raster
  `codex-clipboard-ac6833d8-5c2c-480c-8005-6b05608265a5.png`, normalized to a
  138 mm ring and cross-checked against Takara Tomy's official product views.
  The two circled bay elbows are finite-radius C1 cubic fillets—not line joins.
  The shared XY curve is sampled at no more than 0.0015 rad (over 4,000 render
  sections per loop) and subdivided again when its tangent turns by more than
  0.001 rad. Teeth are spaced around the closed loop by arc length and follow
  a local terrain frame; both ribbon edges sample the actual bowl below them.
  The guide uses a 2.4 mm molded
  shoulder plus 2.2 mm teeth, for a nominal 4.6 mm local peak. The defensible
  photo/patent-scaled interval is about 4.3–5.0 mm: Takara Tomy does not publish
  the mold cross-section, so the 5.0 mm pitch and these vertical dimensions are
  Bit-engagement calibration estimates, not factory specifications. The
  primary mechanical basis is [Tomy's patent JP7349003B1](https://patents.google.com/patent/JP7349003B1/en),
  which identifies Bit gear 23 meshing with guide 93/teeth 93a and supplies
  same-object Bit geometry in Fig. 11.
- The official top-view play diagram has exactly three openings at the front:
  a broad center Xtreme Zone flanked by two Over Zones. Each is a real 2-D
  concave depression in the same one-piece battle surface—not an inserted flat
  tray with separate cheeks/backstop. The rendered basin and deterministic
  terrain share one cached outline and C1 heightfield. The supplied overhead
  raster and official play diagram also show a low rounded retaining lip before
  every mouth; its traced centerline is part of that same terrain and rises
  5.5–6.5 mm in this photo-scaled model. There are no invented rear openings or
  casing gaps.

### 2.2 BX-32 Wide Xtreme Stadium

- Configured body **600 × 440 mm**, from physical/product measurements (the
  official public page confirms the three-player role but does not state its
  dimensions). Its bowl, wall, launch aperture and traced indigo Xtreme Line
  are obround rather than circular.
- Its wide plan silhouette is traced from the unobstructed upper half of the
  user-supplied retail overhead raster
  `codex-clipboard-11c8d883-8577-4d92-aebc-4db4b34113f9.png` and mirrored for
  the packet-obscured lower half. The optical axis comes from the two visible
  mirror-line crossings (midpoint x = 254.5 px), with body-envelope correction
  of 1.330 × 1.140 mm/px. The long round sides, near-radial release shoulders
  and their circled elbows are one high-density C1 curve. Each elbow retains a
  physical bend radius greater than the 6.8 mm visible half-width, so neither
  offset edge folds or reads as an angled polyline. Physics and rendering use
  this identical centerline.
- The official diagram shows exactly two narrow, rounded and tangential rear
  Xtreme openings plus one broad front-center trapezoidal Over opening. The
  narrow mouths continue into broader rounded concavities in the same molded
  battle surface; they are not separate catch trays. Their pocket outlines and
  entry walls are traced independently from the supplied BX-32 overhead and
  cross-checked against the official manual, rather than reusing BX-10
  sectors. The two pale rear walls are easy to miss overhead, so their broad
  wedge silhouette and cast-shadow height were also calibrated from the
  oblique product photograph
  [61mev0MM2vL.jpg](https://m.media-amazon.com/images/I/61mev0MM2vL.jpg), using
  the adjacent 4.6 mm X-Line as a same-perspective scale. The resulting 16.8 mm
  rise and 21 mm full width are explicitly photographic inferences—not
  published factory dimensions. The visible mesh and deterministic collision
  share that complete footprint. Because the oblique view shows a tall,
  near-vertical divider rather than a climbable floor bulge, the rear guards
  are closed high-line-count solids: common 1.7--2.0 m/s approaches rebound,
  while only an exceptional 2.2 m/s impact may vault the wall after losing its
  climb energy. `tools/trace-stadium-features.py` reproduces the plan conversion,
  shadow-edge ratio, overlays, and TypeScript-value check from those source
  images. The
  cover has two red triangular shoot marks and a distinct rear molded shoot
  indicator. BX-32 plastic chemistry is left explicitly unspecified because
  the cited public material does not identify the resin.
- It is officially **designed for three players**, which is exactly the
  free-for-all (大亂鬥) mode's stadium.

### 2.3 Current Takara Tomy stadium families

Official product photography and instructions identify four distinct X-era
stadium mechanisms as of 2026:

- **BX-10 Xtreme Stadium** — standard two-player continuous X-Line.
- **BX-32 Wide Xtreme Stadium** — three-player wide/oval X-Line.
- **BX-37 Double Xtreme Stadium** — battery-powered center area rises and
  falls, creating two X-Dash routes.
- **BX-46 Infinity Stadium** — rail layout enables consecutive “Infinity
  Dash” acceleration and head-on X-Dash collisions.

The app's existing selectable/physics-backed products remain BX-10 and BX-32.
BX-37 and BX-46 require distinct moving-surface/dual-rail simulation rules;
presenting them as cosmetic reskins would not be an accurate model.

## 3. Launchers

Seven mechanically distinct Takara Tomy X configurations are modelled. Pure
colour reissues share the same geometry as their mechanism:

- **Entry Launcher R (BX-22)** — the smallest housing and short winder.
- **Winder Launcher R (BX-01)** — full-size compact geared housing and looped
  winder.
- **Long Winder Launcher R (UX-14)** — the same compact drive class with the
  substantially longer T-handled winder.
- **Hold Launcher R + Long Winder (UX-09)** — long grip-integrated housing,
  four interchangeable rubber panels and the long winder.
- **String Launcher R (BX-18)** — long faceted housing, internal retracting
  spool and T-handle.
- **Winder Launcher L (BX-40)** — left-spin mirrored drive/prongs with its
  official magenta winder.
- **String Launcher L (BX-47)** — left-spin mirrored string drive in the
  translucent-red/grey product colourway.

All mount the bey underneath on three sprung claws. At launch time a saved or
networked incompatible R/L choice is converted to its closest mechanically
compatible launcher; it never silently applies a right-spin gear train to a
left-spin bey. BX-11/BX-29/BX-30/BX-41/BX-42 are detachable grip accessories,
not additional launcher mechanisms, so they do not create extra launcher
types in the picker.

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

- [Takara Tomy — BX-10 official product page](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx10.html)
- [Takara Tomy — BX-10 official assembly/package sheet](https://www.takaratomy.co.jp/support/manual/beyblade/2023071913472.html)
- [Takara Tomy — BX-32 official product page](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx32.html)
- [Tomy patent JP7349003B1 — Bit gear 23 and guide 93/teeth 93a](https://patents.google.com/patent/JP7349003B1/en)
- [Takara Tomy — BX-37 official product page and powered-center description](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx37.html)
- [Takara Tomy — BX-46 official product page and Infinity Dash description](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx46.html)
- [Beyblade Wiki — Xtreme Stadium](https://beyblade.wiki/xtreme-stadium/)
- [Beyblade Wiki — Wide Xtreme Stadium](https://beyblade.fandom.com/wiki/Wide_Xtreme_Stadium)
- [Beyblade Wiki — Ratchet 3-60](https://beyblade.fandom.com/wiki/Ratchet_-_3-60)
- [Beyblade X Database — Bits](https://www.beybxdb.com/parts-system-guide/parts/bit)
- [Beyblade X Database — Ratchets](https://www.beybxdb.com/parts-system-guide/parts/ratchet)
- [Beyblade Wiki — Dran Sword blade](https://beyblade.fandom.com/wiki/Blade_-_DranSword)
- [Takara Tomy — BX-22 Entry Launcher starter](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx22.html)
- [Takara Tomy — BX-18 String Launcher](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx18.html)
- [Takara Tomy — UX-09 Hold Launcher + Long Winder](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/ux09.html)
- [Takara Tomy — UX-14 Long Winder Launcher starter](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/ux14.html)
- [Takara Tomy — BX-40 Winder Launcher L](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx40.html)
- [Takara Tomy — BX-47 String Launcher L](https://beyblade.takaratomy.co.jp/beyblade-x/lineup/bx47.html)
- Per-part diameters/weights: phstudy dataset (docs/DATA.md).
