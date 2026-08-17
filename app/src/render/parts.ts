// Beyblade X assembly entry points. Catalog-keyed upper/lower builders consume
// measured dimensions, traced silhouettes, surface references, palettes, and
// code-specific mechanisms. The legacy swept-solid helper remains only as the
// null-data fallback and for geometry compatibility tests.

import * as THREE from "three";

import type { ResolvedCombo } from "../core/derive";
import type { BeyParams, PartEntry } from "../core/types";
import stickerManifest from "./sticker-manifest.json";
import {
  absPlastic,
  diecastMetal,
  paintedMetal,
  stickerMaterial,
  stickerImageTexture,
  stickerTexture,
} from "./materials";
import {
  bitFamily as lowerBitFamily,
  bitHasGear as lowerBitHasGear,
  bitHeight as lowerBitHeight,
  bitHeightForPart as lowerBitHeightForPart,
  bitTipHeight as lowerBitTipHeight,
  buildBitModel,
  buildRatchetModel,
  ratchetSpec as lowerRatchetSpec,
} from "./lower-parts";
import { buildBxUxUpper, buildCxUpper } from "./upper-parts";

const BLADE_STICKERS = stickerManifest.blades as Record<string, string>;
const LOCK_CHIP_STICKERS = stickerManifest.lockChips as Record<string, string>;

export function bladeStickerUrl(part: PartEntry | null | undefined): string | null {
  return part ? (BLADE_STICKERS[part.key] ?? null) : null;
}

export function lockChipStickerUrl(part: PartEntry | null | undefined): string | null {
  return part ? (LOCK_CHIP_STICKERS[part.key] ?? null) : null;
}

/** Official colourway names (phstudy `part_colors`) → linear render colours. */
export const COLOR_NAMES: Record<string, number> = {
  red: 0xc22e2e, blue: 0x2e55c2, navy: 0x1d2a66, cyan: 0x2eb8c2,
  green: 0x2ea34a, yellow: 0xd8c22e, orange: 0xd8802e, purple: 0x7a3fc2,
  pink: 0xd85f9e, white: 0xe8e8f0, black: 0x22222a, gray: 0x8a8a94,
  grey: 0x8a8a94, silver: 0xc8ccd8, gold: 0xcfae4a, bronze: 0xb08048,
  brown: 0x7a5636, clear: 0xd8e0f0, lime: 0x9ed82e, magenta: 0xc22ea3,
  turquoise: 0x2ec2a3, violet: 0x8a4ad8,
  "yellow-green": 0xa8cf38,
};

export const TYPE_COLORS: Record<string, number> = {
  attack: 0xc23c3c,
  defense: 0x3c66c2,
  stamina: 0x3cb26a,
  balance: 0xc2a23c,
};

/** Stable per-part variation so each mould reads as its own part. */
export function partSeed(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/**
 * Global tessellation budget. These are small objects filling a lot of the
 * screen (a blade is 48 mm across but framed close), so silhouettes and
 * specular highlights are only as good as the polygon count — the sweeps
 * below run at hundreds of angular steps rather than the tens you would use
 * for background props.
 */
export const DETAIL = {
  /** angular steps around a swept part */
  sweep: 512,
  /** angular steps around a lathe/cylinder/torus */
  radial: 128,
  /** rings on spheres and capsules */
  rings: 48,
};

/** Cross-section point: radius as a fraction of the outline, and height. */
interface SectionPt {
  f: number;
  z: number;
}

/**
 * Resample a cross-section along a closed spline so the swept surface has
 * real curvature between control points instead of hard facets — moulded
 * parts have radiused edges everywhere and the highlight rolls across them.
 */
function refineSection(section: SectionPt[], per = 4): SectionPt[] {
  const pts = section.map((p) => new THREE.Vector2(p.f, p.z));
  const curve = new THREE.SplineCurve(pts);
  // Catmull-Rom overshoots at corners, which would quietly inflate a part
  // past its measured diameter and height — clamp back to the control
  // envelope so smoothing can round an edge but never resize the part.
  let fMax = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (const p of section) {
    fMax = Math.max(fMax, p.f);
    zMin = Math.min(zMin, p.z);
    zMax = Math.max(zMax, p.z);
  }
  const out: SectionPt[] = [];
  const n = section.length * per;
  for (let i = 0; i < n; i++) {
    const v = curve.getPoint(i / n);
    out.push({
      f: Math.min(fMax, Math.max(0, v.x)),
      z: Math.min(zMax, Math.max(zMin, v.y)),
    });
  }
  return out;
}

/**
 * Sweep a closed cross-section around the axis, scaling its radius by
 * `outline(theta)`. The section is given in order around the solid (e.g.
 * centre-top → outer top → outer bottom → centre-bottom) and is closed
 * automatically.
 */
export function sweepSolid(
  rawSection: SectionPt[],
  outline: (theta: number) => number,
  segs = DETAIL.sweep,
): THREE.BufferGeometry {
  const section = refineSection(rawSection);
  const n = section.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) {
    const th = (s / segs) * Math.PI * 2;
    const R = outline(th);
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    for (const p of section) {
      pos.push(cos * R * p.f, sin * R * p.f, p.z);
    }
  }
  for (let s = 0; s < segs; s++) {
    const a = s * n;
    const b = ((s + 1) % segs) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a + i, b + i, b + j, a + i, b + j, a + j);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---- plan-view outlines ----------------------------------------------------

/** Asymmetric attack outline: N contact blades, each with a long swept
 * leading edge and an abrupt trailing undercut — the shape that actually
 * transfers momentum on impact. */
function attackOutline(R: number, blades: number, depth: number, sweep: number) {
  return (th: number): number => {
    const p = ((th * blades) / (Math.PI * 2)) % 1; // 0..1 within one blade
    const ramp = Math.pow(p, sweep); // slow rise…
    const drop = Math.pow(1 - Math.min(1, (1 - p) * 7), 3); // …sharp fall
    return R * (1 - depth + depth * Math.max(ramp * (1 - drop), 0));
  };
}

/** Defense outline: near-circular with wide, shallow, symmetric guards. */
function defenseOutline(R: number, lobes: number, depth: number) {
  return (th: number): number => R * (1 - depth * 0.5 + depth * 0.5 * Math.cos(lobes * th));
}

/** Stamina outline: a smooth circular wall with fine tooling serrations. */
function staminaOutline(R: number, teeth: number, depth: number) {
  return (th: number): number => R * (1 - depth + depth * (0.5 + 0.5 * Math.cos(teeth * th)));
}

function outlineFor(
  type: string | null,
  R: number,
  attackStat: number,
  seed: number,
): (theta: number) => number {
  if (type === "attack") {
    const blades = Math.max(3, Math.min(6, Math.round(3 + attackStat / 45)));
    return attackOutline(R, blades, 0.16 + seed * 0.06, 0.7 + seed * 0.5);
  }
  if (type === "defense") return defenseOutline(R, 6 + Math.round(seed * 4) * 2, 0.07);
  if (type === "stamina") return staminaOutline(R, 24 + Math.round(seed * 12), 0.022);
  // balance: a few broad blades on an otherwise round body
  return (th: number): number =>
    R * (0.95 + 0.05 * Math.cos(4 * th)) * (1 - 0.06 + 0.06 * Math.pow(Math.max(0, Math.cos(3 * th)), 2));
}

// ---- blade -----------------------------------------------------------------

/** Radius (m) straight from the dataset when measured, else the derived one. */
export function partRadiusM(part: PartEntry | null | undefined, fallback: number): number {
  const d = part?.diameterMm;
  return d && d > 0 ? d / 2000 : fallback;
}

function bladeColorOf(part: PartEntry | null | undefined, accent: number): number {
  const named = part?.color ? COLOR_NAMES[part.color.toLowerCase()] : undefined;
  return named ?? (part?.type ? TYPE_COLORS[part.type]! : accent);
}

function partPaletteOf(part: PartEntry | null | undefined, fallback: number): number[] {
  const colors = (part?.colors ?? [])
    .map((name) => COLOR_NAMES[name.toLowerCase()])
    .filter((color): color is number => color !== undefined);
  const primary = part?.color ? COLOR_NAMES[part.color.toLowerCase()] : undefined;
  if (primary !== undefined && colors[0] !== primary) colors.unshift(primary);
  return colors.length > 0 ? colors : [fallback];
}

/**
 * A BX/UX Blade: die-cast metal upper (the part that actually hits) sitting
 * on a moulded plastic core, with the emblem boss on top. Height ≈ 11 mm,
 * diameter from the dataset (45–52.5 mm).
 */
export function buildBlade(
  part: PartEntry | null | undefined,
  accent: number,
  R: number,
  baseZ = 0,
  withSticker = true,
): THREE.Group {
  if (part) {
    return buildBxUxUpper(part, accent, R, baseZ, { referenceTop: withSticker });
  }
  const g = new THREE.Group();
  const type = null;
  const seed = partSeed("?");
  const color = accent;
  const outline = outlineFor(type, R, 40, seed);

  // A real blade is mostly MOULDED COLOUR PLASTIC (PMMA/ABS) with a zinc
  // alloy ring exposed at the contact points and a die-cut sticker over the
  // crown — not a solid metal puck. Building it that way is what makes it
  // read as the actual toy (docs/MODELING.md §1.4).
  const top = baseZ + 0.0112;

  // 1. plastic body: the full silhouette, in the part's colourway
  const body = sweepSolid(
    [
      { f: 0.0, z: top },
      { f: 0.5, z: top },
      { f: 0.86, z: top - 0.0014 }, // crown slopes gently to the rim
      { f: 1.0, z: top - 0.004 },
      { f: 1.0, z: top - 0.0076 }, // outer wall
      { f: 0.88, z: top - 0.0098 }, // undercut
      { f: 0.42, z: baseZ + 0.0008 },
      { f: 0.0, z: baseZ + 0.0008 },
    ],
    outline,
  );
  const bodyMesh = new THREE.Mesh(body, absPlastic(color, { rough: 0.3, coat: 0.85 }));
  bodyMesh.castShadow = true;
  bodyMesh.receiveShadow = true;
  g.add(bodyMesh);

  // 2. metal contact ring: a band of bare zinc alloy exposed around the
  // striking edge, inset so the plastic wraps above and below it
  const ring = sweepSolid(
    [
      { f: 1.0, z: top - 0.0034 },
      { f: 1.005, z: top - 0.0044 },
      { f: 1.005, z: top - 0.0074 },
      { f: 1.0, z: top - 0.0084 },
      { f: 0.9, z: top - 0.0074 },
      { f: 0.9, z: top - 0.0044 },
    ],
    outline,
  );
  const ringMesh = new THREE.Mesh(
    ring,
    seed > 0.72
      ? paintedMetal(color, 0.3) // metal-coat variants are tinted
      : diecastMetal(0xd3d7e2, { rough: 0.24 + seed * 0.08 }),
  );
  ringMesh.castShadow = true;
  g.add(ringMesh);

  if (withSticker) {
    // 3. the sticker: the exact center graphic extracted from the Wiki's
    // top-down Blade artwork. The procedural badge remains only as a fallback
    // for unpublished/future parts. 43% matches the real sticker-to-Blade
    // diameter measured from those source images.
    const stickerR = R * 0.43;
    const stickerGeo = new THREE.CircleGeometry(stickerR, DETAIL.radial);
    const sourceUrl = bladeStickerUrl(part);
    const stickerMap = sourceUrl
      ? stickerImageTexture(sourceUrl)
      : stickerTexture({
          key: "?",
          label: "BEY",
          base: color,
          accent: new THREE.Color(color).offsetHSL(0.5, 0.1, 0.12).getHex(),
          seed,
        });
    const sticker = new THREE.Mesh(stickerGeo, stickerMaterial(stickerMap));
    sticker.position.z = top + 0.0002;
    g.add(sticker);

    // moulded lip that the sticker sits inside
    const lip = new THREE.Mesh(
      new THREE.TorusGeometry(stickerR * 1.06, R * 0.02, 16, DETAIL.radial),
      absPlastic(new THREE.Color(color).multiplyScalar(0.45).getHex(), { rough: 0.4 }),
    );
    lip.position.z = top;
    g.add(lip);
  }
  return g;
}

/** CX main blade sits on an assist blade; both are wider, thinner discs. */
export function buildCxStack(
  rc: ResolvedCombo,
  accent: number,
  R: number,
  baseZ = 0,
): THREE.Group {
  return buildCxUpper(rc, accent, R, baseZ, {
    referenceTop: true,
    // Official presets carry a catalog composite. It is the exact visible
    // top surface; component meshes beneath it preserve the physical stack.
    compositeOverlay: !!rc.compositeBlade,
  });
}

// ---- ratchet ---------------------------------------------------------------

/** `3-60` → 3 protrusions, 6.0 mm tall (docs/MODELING.md §1.2). */
export function ratchetSpec(code: string | undefined): { count: number; heightM: number } {
  const spec = lowerRatchetSpec(code);
  return { count: spec.count, heightM: spec.heightM };
}

/**
 * Ratchet: a translucent POM disc whose N protrusions both index the blade
 * and act as the burst latch joints the physics core models. Height is the
 * real millimetre value from the code.
 */
export function buildRatchet(part: PartEntry | null | undefined, topZ: number): THREE.Group {
  const color = COLOR_NAMES[part?.color?.toLowerCase() ?? ""] ?? 0xf2f2f8;
  return buildRatchetModel(part, topZ, partPaletteOf(part, color));
}

// ---- bit -------------------------------------------------------------------

type BitFamily = ReturnType<typeof lowerBitFamily>;

export function bitFamily(code: string): BitFamily {
  return lowerBitFamily(code);
}

/** Gear-ringed bits (`GF`, `GB`, `GN`, `GP`, `GR`, `GU`) mesh with the
 * stadium's Xtreme Line — the ring is real teeth, not a decal. */
export function bitHasGear(code: string): boolean {
  return lowerBitHasGear(code);
}

/** Height of a bit's tip: contact point → the flange's underside. */
export function bitTipHeight(code: string): number {
  return lowerBitTipHeight(code);
}

/** Total bit height: contact point → the face the ratchet screws onto. */
export function bitHeight(code: string): number {
  return lowerBitHeight(code);
}

export function bitHeightForPart(part: PartEntry | null | undefined): number {
  return lowerBitHeightForPart(part);
}

/**
 * Build a bit with its CONTACT POINT at `baseZ` (the sim places a bey's mesh
 * origin on the dish surface, so the tip has to be the local zero).
 */
export function buildBit(part: PartEntry | null | undefined, baseZ = 0): THREE.Group {
  const color = COLOR_NAMES[part?.color?.toLowerCase() ?? ""] ?? TYPE_COLORS[part?.type ?? "attack"]!;
  return buildBitModel(part, baseZ, partPaletteOf(part, color));
}

// ---- whole bey -------------------------------------------------------------

/**
 * Assemble a full top from its resolved parts. Local +Z is up; the tip sits
 * at z ≈ 0 so the sim's contact point and the mesh's agree.
 */
export function buildBeyMesh(
  rc: ResolvedCombo | null,
  params: BeyParams,
  accent: number,
): THREE.Group {
  const g = new THREE.Group();
  const bladePart = rc?.parts.blade ?? rc?.parts.mainBlade ?? rc?.parts.metalBlade ?? rc?.compositeBlade;
  const R = partRadiusM(bladePart, params.radiusM);

  // stack upward from the tip, which sits at local z = 0 because the sim
  // places the mesh origin on the dish surface: bit → ratchet → blade
  const bitCode = rc?.parts.bit?.code ?? "F";
  const bitTop = bitHeightForPart(rc?.parts.bit) || bitHeight(bitCode);
  const { heightM } = ratchetSpec(rc?.parts.ratchet?.code);
  const ratchetTopZ = bitTop + heightM;

  // named so a burst can detach each part and throw it (docs/RULES.md: a
  // burst finish is the bey coming apart, so it should visibly come apart)
  const bit = buildBit(rc?.parts.bit, 0);
  bit.name = "part:bit";
  g.add(bit);
  const ratchet = buildRatchet(rc?.parts.ratchet, ratchetTopZ);
  ratchet.name = "part:ratchet";
  g.add(ratchet);
  const upper = rc?.isCx
    ? buildCxStack(rc, accent, R, ratchetTopZ)
    : buildBlade(bladePart, accent, R, ratchetTopZ);
  upper.name = "part:blade";
  g.add(upper);

  // spin-blur shader ring: streaks that counter-rotate in the local frame,
  // which is what sells 1000+ rpm far better than geometry alone
  const color = bladeColorOf(bladePart, accent);
  const blurMat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: {
      uColor: { value: new THREE.Color(color).multiplyScalar(1.15) },
      uPhase: { value: 0 },
      uIntensity: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv - 0.5;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uPhase;
      uniform float uIntensity;
      varying vec2 vUv;
      void main() {
        float r = length(vUv) * 2.0;
        float band = smoothstep(0.55, 0.82, r) * (1.0 - smoothstep(0.94, 1.0, r));
        float a = atan(vUv.y, vUv.x);
        float streaks = 0.55 + 0.45 * sin(a * 9.0 + uPhase);
        float alpha = uIntensity * band * streaks;
        if (alpha < 0.004) discard;
        gl_FragColor = vec4(uColor, alpha);
      }`,
  });
  const blur = new THREE.Mesh(new THREE.PlaneGeometry(R * 2.3, R * 2.3, 2, 2), blurMat);
  blur.position.z = ratchetTopZ + 0.005;
  blur.name = "blurRing";
  g.add(blur);
  return g;
}
