// Reference-driven Beyblade X upper-part geometry.
//
// Unlike the legacy stat/type renderer, this module resolves each physical
// part by catalog key.  The generated reference manifest supplies an exact
// alpha-cut top texture and a 256-direction silhouette trace.  The trace is
// wrapped around a dense, rounded side section, so close-up highlights retain
// the polygon density of the previous meshes while the plan view matches the
// released toy.

import * as THREE from "three";

import type { ResolvedCombo } from "../core/derive";
import type { PartCategory, PartEntry } from "../core/types";
import {
  absPlastic,
  diecastMetal,
  paintedMetal,
  preloadStickerImage,
  publicAssetUrl,
  stickerImageTexture,
} from "./materials";
import modelReferenceManifestJson from "./model-reference-manifest.json";
import stickerManifestJson from "./sticker-manifest.json";

export type UpperModelCategory =
  | "blade"
  | "mainBlade"
  | "assistBlade"
  | "metalBlade"
  | "overBlade";

export interface ModelReferenceEntry {
  texture: string;
  colors: string[];
  radialProfile: number[];
}

export interface ModelReferenceManifest {
  schemaVersion: 1;
  radialSamples: number;
  sideSamples: number;
  parts: Record<string, Record<string, ModelReferenceEntry>>;
}

export interface ResolvedUpperProfile {
  values: number[];
  source: "reference" | "fallback";
  reference: ModelReferenceEntry | null;
  silhouette: BladeSilhouetteSpec;
}

export interface BladeSilhouetteSpec {
  /** Deliberate primary contact regions, not incidental mould serrations. */
  contacts: number;
  kind: "swept" | "guard" | "round" | "oval" | "asymmetric" | "square";
  depth: number;
  phase?: number;
  asymmetric?: boolean;
}

export interface UpperBuildOptions {
  /** Add the full assembled-CX catalog top as a comparison/validation skin. */
  compositeOverlay?: boolean;
  /** Disable image maps while retaining traced geometry (useful to inspectors). */
  referenceTop?: boolean;
}

export type ReferenceRecolorMode = "none" | "plastic" | "metal";

/** Sticker diameter is about 43–45% of the upper; UV radius is half of that. */
export const REFERENCE_STICKER_RADIUS_UV = 0.225;

export const UPPER_DETAIL = {
  /** 512 × 60 × 2 = 61,440 triangles for a standard BX/UX upper. */
  bladeAngular: 512,
  bladeSection: 60,
  topRadial: 256,
  lockChipAngular: 192,
} as const;

export const MODEL_REFERENCE_MANIFEST =
  modelReferenceManifestJson as unknown as ModelReferenceManifest;

const STICKER_MANIFEST = stickerManifestJson as {
  blades: Record<string, string>;
  lockChips: Record<string, string>;
};

const MODEL_CATEGORIES = new Set<UpperModelCategory>([
  "blade",
  "mainBlade",
  "assistBlade",
  "metalBlade",
  "overBlade",
]);

const TAU = Math.PI * 2;
const DEFAULT_PROFILE_SAMPLES = 256;

/** Look up a generated reference without inventing aliases or geometry. */
export function lookupModelReference(
  category: UpperModelCategory,
  key: string,
): ModelReferenceEntry | null {
  const table = MODEL_REFERENCE_MANIFEST.parts[category];
  if (!table) return null;
  const exact = table[key];
  if (exact) return exact;
  const upper = key.toUpperCase();
  for (const [candidate, value] of Object.entries(table)) {
    if (candidate.toUpperCase() === upper) return value;
  }
  return null;
}

/** Exact-key first, then a mechanical-group/code alias for color variants. */
export function modelReferenceForPart(
  part: PartEntry | null | undefined,
): ModelReferenceEntry | null {
  if (!part || !MODEL_CATEGORIES.has(part.category as UpperModelCategory)) return null;
  const category = part.category as UpperModelCategory;
  return (
    lookupModelReference(category, part.key) ??
    lookupModelReference(category, part.group) ??
    lookupModelReference(category, part.code)
  );
}

/** Base-relative asset path stored in the generated manifest. */
export function upperReferenceUrl(part: PartEntry | null | undefined): string | null {
  if (!part) return null;
  if (part.category === "lockChip") return STICKER_MANIFEST.lockChips[part.key] ?? null;
  return modelReferenceForPart(part)?.texture ?? null;
}

/** Resolve an upper asset beneath virtual app roots such as `/beyblade/`. */
export function resolvedUpperReferenceUrl(
  part: PartEntry | null | undefined,
  baseUri?: string,
): string | null {
  const url = upperReferenceUrl(part);
  if (!url) return null;
  if (baseUri !== undefined) return publicAssetUrl(url, baseUri);
  if (typeof document === "undefined") return url;
  return publicAssetUrl(url);
}

/** Preload an exact catalog top. Node-side geometry tests receive a placeholder. */
export function preloadUpperReference(
  part: PartEntry | null | undefined,
): Promise<THREE.Texture | null> {
  const url = upperReferenceUrl(part) ?? (
    part?.category === "blade" ? (STICKER_MANIFEST.blades[part.key] ?? null) : null
  );
  if (!url) return Promise.resolve(null);
  if (typeof document === "undefined") return Promise.resolve(new THREE.Texture());
  return preloadStickerImage(url);
}

export async function preloadUpperReferences(
  parts: Iterable<PartEntry | null | undefined>,
): Promise<(THREE.Texture | null)[]> {
  return Promise.all([...parts].map((part) => preloadUpperReference(part)));
}

// Primary contact counts and broad outline families come from the released
// moulds.  The traced reference always wins; this registry is deterministic
// coverage for an unavailable/deferred texture rather than a stat-derived
// approximation.
const SILHOUETTES: Record<string, BladeSilhouetteSpec> = Object.create(null) as Record<
  string,
  BladeSilhouetteSpec
>;

function registerSilhouettes(keys: string[], spec: BladeSilhouetteSpec): void {
  for (const key of keys) SILHOUETTES[key] = spec;
}

registerSilhouettes(["DRANSWORD", "PHOENIXFEATHER"], {
  contacts: 3,
  kind: "swept",
  depth: 0.19,
});
registerSilhouettes(["SHARKEDGE", "SHARKSCALE"], {
  contacts: 2,
  kind: "swept",
  depth: 0.25,
});
registerSilhouettes(["KNIGHTSHIELD"], { contacts: 6, kind: "guard", depth: 0.08 });
registerSilhouettes(["HELLSSCYTHE"], { contacts: 4, kind: "swept", depth: 0.11 });
registerSilhouettes(["WIZARDARROW", "STARSCREAM"], {
  contacts: 2,
  kind: "round",
  depth: 0.07,
});
registerSilhouettes(["DRANZERSPIRAL", "DRIGERSLASH"], {
  contacts: 2,
  kind: "swept",
  depth: 0.14,
});
registerSilhouettes(["COBALTDRAKE", "COBALTDRAGOON", "IMPACTDRAKE"], {
  contacts: 4,
  kind: "swept",
  depth: 0.14,
});
registerSilhouettes(["KNIGHTLANCE", "KNIGHTMAIL"], {
  contacts: 6,
  kind: "guard",
  depth: 0.09,
});
registerSilhouettes(["VIPERTAIL", "LEONCLAW", "HELLSCHAIN", "WHALEWAVE"], {
  contacts: 5,
  kind: "swept",
  depth: 0.1,
});
registerSilhouettes(
  [
    "DRANDAGGER",
    "PHOENIXRUDDER",
    "GOLEMROCK",
    "SHELTERDRAKE",
    "DRANSTRIKE",
    "KNIGHTFORTRESS",
  ],
  { contacts: 6, kind: "guard", depth: 0.1 },
);
registerSilhouettes(["RHINOHORN", "WYVERNGALE", "TYRANNOBEAT", "PTERASWING"], {
  contacts: 3,
  kind: "guard",
  depth: 0.13,
});
registerSilhouettes(["PHOENIXWING", "AEROPEGASUS", "SHINOBISHADOW"], {
  contacts: 3,
  kind: "swept",
  depth: 0.14,
});
registerSilhouettes(["UNICORNSTING", "WEISSTIGER"], {
  contacts: 3,
  kind: "asymmetric",
  depth: 0.12,
  asymmetric: true,
});
registerSilhouettes(["SPHINXCOWL"], { contacts: 9, kind: "guard", depth: 0.065 });
registerSilhouettes(["BLACKSHELL", "OROCHICLUSTER"], {
  contacts: 8,
  kind: "guard",
  depth: 0.085,
});
registerSilhouettes(["DRANBUSTER"], {
  contacts: 1,
  kind: "asymmetric",
  depth: 0.28,
  asymmetric: true,
});
registerSilhouettes(["WIZARDROD"], { contacts: 5, kind: "round", depth: 0.025 });
registerSilhouettes(["HELLSHAMMER", "HELLSHUMMER"], {
  contacts: 3,
  kind: "swept",
  depth: 0.18,
});
registerSilhouettes(["SILVERWOLF"], { contacts: 3, kind: "round", depth: 0.025 });
registerSilhouettes(["SAMURAISABER", "WARRIORSABER"], {
  contacts: 4,
  kind: "round",
  depth: 0.08,
});
registerSilhouettes(["GHOSTCIRCLE", "CLOCKMIRAGE", "HEAVENSRING"], {
  contacts: 60,
  kind: "round",
  depth: 0.012,
});
registerSilhouettes(["SCORPIOSPEAR"], {
  contacts: 6,
  kind: "guard",
  depth: 0.07,
});
registerSilhouettes(["WYVERNHOVER"], { contacts: 2, kind: "oval", depth: 0.07 });
registerSilhouettes(["MUMMYCURSE"], { contacts: 4, kind: "guard", depth: 0.08 });
registerSilhouettes(["METEORDRAGOON"], {
  contacts: 3,
  kind: "asymmetric",
  depth: 0.17,
  asymmetric: true,
});
registerSilhouettes(["SAMURAICALIBUR", "DARK", "MIGHT", "ECLIPSE"], {
  contacts: 4,
  kind: "square",
  depth: 0.09,
});
registerSilhouettes(["BRAVE", "ARC", "REAPER", "BRUSH", "VOLT", "FLAME", "BLAST"], {
  contacts: 3,
  kind: "swept",
  depth: 0.12,
});
registerSilhouettes(["HUNT", "FANG", "FLARE"], {
  contacts: 4,
  kind: "guard",
  depth: 0.09,
});
registerSilhouettes(["RAGE", "FRAGE", "WHIP", "WHIPO"], {
  contacts: 3,
  kind: "round",
  depth: 0.07,
});
registerSilhouettes(["BLITZ", "BBLITZ"], { contacts: 4, kind: "swept", depth: 0.13 });
registerSilhouettes(["FORTRESS", "GFORTRESS"], {
  contacts: 6,
  kind: "guard",
  depth: 0.07,
});
registerSilhouettes(["DELTA", "PDELTA"], { contacts: 3, kind: "swept", depth: 0.11 });

const CATEGORY_FALLBACKS: Record<UpperModelCategory, BladeSilhouetteSpec> = {
  blade: { contacts: 6, kind: "guard", depth: 0.07 },
  mainBlade: { contacts: 4, kind: "guard", depth: 0.07 },
  assistBlade: { contacts: 6, kind: "guard", depth: 0.055 },
  metalBlade: { contacts: 4, kind: "swept", depth: 0.1 },
  overBlade: { contacts: 4, kind: "guard", depth: 0.065 },
};

function canonicalKey(value: string): string {
  return value.toUpperCase().replace(/#\d+$/, "").trim();
}

export function bladeSilhouetteSpec(
  partOrKey: PartEntry | string,
  category: UpperModelCategory = "blade",
): BladeSilhouetteSpec {
  if (typeof partOrKey === "string") {
    return SILHOUETTES[canonicalKey(partOrKey)] ?? CATEGORY_FALLBACKS[category];
  }
  return (
    SILHOUETTES[canonicalKey(partOrKey.key)] ??
    SILHOUETTES[canonicalKey(partOrKey.group)] ??
    SILHOUETTES[canonicalKey(partOrKey.code)] ??
    CATEGORY_FALLBACKS[partOrKey.category as UpperModelCategory] ??
    CATEGORY_FALLBACKS[category]
  );
}

function positiveModulo(value: number, modulus: number): number {
  return ((value % modulus) + modulus) % modulus;
}

/** Linear periodic sampling; theta=0 is image-right and increases CCW. */
export function sampleRadialProfile(profile: readonly number[], theta: number): number {
  if (profile.length === 0) return 1;
  const p = (positiveModulo(theta, TAU) / TAU) * profile.length;
  const i0 = Math.floor(p) % profile.length;
  const i1 = (i0 + 1) % profile.length;
  const f = p - Math.floor(p);
  return THREE.MathUtils.lerp(profile[i0] ?? 1, profile[i1] ?? 1, f);
}

function sanitizeReferenceProfile(values: readonly number[]): number[] | null {
  if (values.length < 8) return null;
  const finite = values.map((value) => Number(value));
  if (finite.some((value) => !Number.isFinite(value) || value <= 0)) return null;
  const max = Math.max(...finite);
  if (!(max > 0)) return null;
  return finite.map((value) => THREE.MathUtils.clamp(value / max, 0.38, 1));
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % TAU;
  return Math.min(d, TAU - d);
}

function fallbackValue(spec: BladeSilhouetteSpec, theta: number): number {
  if (spec.kind === "oval") return 1 - spec.depth * (0.5 - 0.5 * Math.cos(theta * 2));
  if (spec.kind === "asymmetric" && spec.contacts === 1) {
    const sword = Math.exp(-Math.pow(circularDistance(theta, spec.phase ?? 0) / 0.34, 2));
    const counter = 0.36 * Math.exp(-Math.pow(circularDistance(theta, Math.PI) / 0.8, 2));
    const shoulder = 0.18 * Math.exp(-Math.pow(circularDistance(theta, Math.PI * 0.62) / 0.42, 2));
    return 1 - spec.depth + spec.depth * Math.min(1, sword + counter + shoulder);
  }

  const contacts = Math.max(1, spec.contacts);
  const phase = spec.phase ?? 0;
  const unit = positiveModulo(((theta - phase) * contacts) / TAU, 1);
  let lobe: number;
  switch (spec.kind) {
    case "swept": {
      const rise = Math.pow(unit, 0.72);
      const trailingCut = 1 - Math.pow(Math.max(0, (unit - 0.84) / 0.16), 2);
      lobe = rise * Math.max(0, trailingCut);
      break;
    }
    case "square":
      lobe = Math.pow(Math.max(0, Math.cos((unit - 0.5) * Math.PI)), 0.22);
      break;
    case "round":
      lobe = 0.5 + 0.5 * Math.cos((unit - 0.5) * TAU);
      break;
    default:
      lobe = Math.pow(Math.max(0, Math.cos((unit - 0.5) * Math.PI)), 0.55);
      break;
  }
  let value = 1 - spec.depth + spec.depth * lobe;
  if (spec.asymmetric) value *= 0.975 + 0.025 * Math.cos(theta - 0.4);
  return value;
}

export function fallbackRadialProfile(
  partOrKey: PartEntry | string,
  category: UpperModelCategory = "blade",
  samples = DEFAULT_PROFILE_SAMPLES,
): number[] {
  const spec = bladeSilhouetteSpec(partOrKey, category);
  const values = Array.from({ length: samples }, (_, i) =>
    fallbackValue(spec, (i / samples) * TAU),
  );
  const max = Math.max(...values);
  return values.map((value) => value / max);
}

export function resolveUpperProfile(part: PartEntry): ResolvedUpperProfile {
  const reference = modelReferenceForPart(part);
  const traced = reference ? sanitizeReferenceProfile(reference.radialProfile) : null;
  return {
    values: traced ?? fallbackRadialProfile(part, part.category as UpperModelCategory),
    source: traced ? "reference" : "fallback",
    reference,
    silhouette: bladeSilhouetteSpec(part, part.category as UpperModelCategory),
  };
}

export interface SweepOptions {
  angularSegments?: number;
  sectionSegments?: number;
  innerFraction?: number;
}

/**
 * Dense rounded contact body.  The periodic section is a flattened lens with
 * a real central opening, avoiding the degenerate axis triangles produced by
 * a disc fan while preserving a watertight manifold around the outer metal.
 */
export function profiledUpperGeometry(
  radialProfile: readonly number[],
  radiusM: number,
  heightM: number,
  options: SweepOptions = {},
): THREE.BufferGeometry {
  const angular = Math.max(32, Math.round(options.angularSegments ?? UPPER_DETAIL.bladeAngular));
  const section = Math.max(12, Math.round(options.sectionSegments ?? UPPER_DETAIL.bladeSection));
  const inner = THREE.MathUtils.clamp(options.innerFraction ?? 0.21, 0.05, 0.65);
  const positions = new Float32Array(angular * section * 3);
  const uvs = new Float32Array(angular * section * 2);
  const indices = new Uint32Array(angular * section * 6);

  let pi = 0;
  let ui = 0;
  for (let a = 0; a < angular; a++) {
    const theta = (a / angular) * TAU;
    const tracedR = radiusM * sampleRadialProfile(radialProfile, theta);
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    for (let s = 0; s < section; s++) {
      const phi = (s / section) * TAU;
      const radialT = 0.5 + 0.5 * Math.cos(phi);
      const radial = tracedR * (inner + (1 - inner) * radialT);
      const vertical = Math.sin(phi);
      const roundedZ = Math.sign(vertical) * Math.pow(Math.abs(vertical), 0.48);
      positions[pi++] = cos * radial;
      positions[pi++] = sin * radial;
      positions[pi++] = heightM * (0.5 + 0.5 * roundedZ);
      uvs[ui++] = a / angular;
      uvs[ui++] = s / section;
    }
  }

  let ii = 0;
  for (let a = 0; a < angular; a++) {
    const nextA = (a + 1) % angular;
    for (let s = 0; s < section; s++) {
      const nextS = (s + 1) % section;
      const p0 = a * section + s;
      const p1 = nextA * section + s;
      const p2 = nextA * section + nextS;
      const p3 = a * section + nextS;
      indices[ii++] = p0;
      indices[ii++] = p1;
      indices[ii++] = p2;
      indices[ii++] = p0;
      indices[ii++] = p2;
      indices[ii++] = p3;
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

/** Silhouette-conforming top fan with square-image UVs and a +Z normal. */
export function profiledTopGeometry(
  radialProfile: readonly number[],
  radiusM: number,
  segments: number = UPPER_DETAIL.topRadial,
): THREE.BufferGeometry {
  const count = Math.max(32, Math.round(segments));
  const positions = new Float32Array((count + 1) * 3);
  const uvs = new Float32Array((count + 1) * 2);
  const indices = new Uint32Array(count * 3);
  uvs[0] = 0.5;
  uvs[1] = 0.5;
  for (let i = 0; i < count; i++) {
    const theta = (i / count) * TAU;
    const r = radiusM * sampleRadialProfile(radialProfile, theta);
    const x = Math.cos(theta) * r;
    const y = Math.sin(theta) * r;
    const p = (i + 1) * 3;
    positions[p] = x;
    positions[p + 1] = y;
    positions[p + 2] = 0;
    const uv = (i + 1) * 2;
    uvs[uv] = 0.5 + x / (radiusM * 2);
    uvs[uv + 1] = 0.5 + y / (radiusM * 2);
    const j = i * 3;
    indices[j] = 0;
    indices[j + 1] = i + 1;
    indices[j + 2] = ((i + 1) % count) + 1;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeVertexNormals();
  return geometry;
}

const COLOR_NAMES: Record<string, number> = {
  red: 0xc42e32,
  blue: 0x2859c6,
  navy: 0x17265f,
  cyan: 0x27b8ca,
  green: 0x299548,
  yellow: 0xd8c127,
  orange: 0xd77a28,
  purple: 0x7540b8,
  pink: 0xd55b9c,
  white: 0xededf2,
  black: 0x202128,
  gray: 0x858894,
  grey: 0x858894,
  silver: 0xc9cdd7,
  gold: 0xcdaa45,
  bronze: 0xaa7842,
  brown: 0x765235,
  clear: 0xd9e2ef,
  lime: 0x9dd42e,
  magenta: 0xc12b9f,
  turquoise: 0x28b99c,
  violet: 0x8748d1,
  "yellow-green": 0xa5cb35,
};

function parseColor(value: string | null | undefined): number | null {
  if (!value) return null;
  const named = COLOR_NAMES[value.toLowerCase()];
  if (named !== undefined) return named;
  if (/^#[0-9a-f]{6}$/i.test(value)) return Number.parseInt(value.slice(1), 16);
  return null;
}

function paletteFor(part: PartEntry, reference: ModelReferenceEntry | null): number[] {
  const colors = [...(part.colors ?? []), ...(reference?.colors ?? [])]
    .map(parseColor)
    .filter((value): value is number => value !== null);
  const named = parseColor(part.color);
  if (named !== null) colors.unshift(named);
  return [...new Set(colors)];
}

/** Metal paint comes from release metadata, never a key hash. */
export function isMetalCoated(part: PartEntry | null | undefined): boolean {
  if (!part) return false;
  const text = [
    part.variantLabel,
    part.desc,
    part.name.en,
    part.name.ja,
    part.name["zh-TW"],
  ]
    .filter(Boolean)
    .join(" ");
  return /metal\s*coat|metallic\s*coat|painted\s*metal|塗層|塗装|塗裝|鍍|镀|メタルコート|コーティング/i.test(
    text,
  );
}

/**
 * Catalog variants commonly reuse the canonical top photograph. Preserve
 * bare-metal highlights for ordinary recolors and target the metal itself for
 * explicitly coated releases. Base releases whose image already matches do
 * not pay the shader cost.
 */
export function referenceRecolorMode(
  part: PartEntry | null | undefined,
  reference: ModelReferenceEntry | null = modelReferenceForPart(part),
): ReferenceRecolorMode {
  if (!part || !reference || !parseColor(part.colors?.[0] ?? part.color)) return "none";
  if (isMetalCoated(part)) return "metal";
  const category = part.category as UpperModelCategory;
  const canonical = MODEL_CATEGORIES.has(category)
    ? lookupModelReference(category, part.group)
    : null;
  const reusesCanonical =
    canonical !== null && canonical.texture === reference.texture && part.key !== part.group;
  if (part.variantColorOverride || reusesCanonical) {
    return "plastic";
  }
  return "none";
}

function fallbackMaterial(kind: "metal" | "plastic", color: number): THREE.Material {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: kind === "metal" ? 0.95 : 0,
    roughness: kind === "metal" ? 0.3 : 0.38,
  });
}

function sideMaterial(
  part: PartEntry,
  category: UpperModelCategory,
  palette: readonly number[],
): THREE.Material {
  const plasticOnly = category === "assistBlade" || category === "overBlade";
  const plasticColor = palette[0] ?? 0x7b88aa;
  if (typeof document === "undefined") {
    return fallbackMaterial(plasticOnly ? "plastic" : "metal", plasticOnly ? plasticColor : 0xd2d6df);
  }
  if (plasticOnly) return absPlastic(plasticColor, { rough: 0.34, coat: 0.75 });
  if (isMetalCoated(part)) return paintedMetal(plasticColor, 0.29);
  return diecastMetal(0xd2d6df, { rough: 0.27, aniso: 0.78 });
}

function plasticMaterial(color: number): THREE.Material {
  if (typeof document === "undefined") return fallbackMaterial("plastic", color);
  return absPlastic(color, { rough: 0.31, coat: 0.82 });
}

function referenceTexture(url: string): THREE.Texture {
  if (typeof document === "undefined") return new THREE.Texture();
  return stickerImageTexture(url);
}

function referenceTopMaterial(
  url: string,
  targetColor: number,
  mode: ReferenceRecolorMode | "lock",
  stickerRadius = REFERENCE_STICKER_RADIUS_UV,
): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: referenceTexture(url) },
      uTarget: { value: new THREE.Color(targetColor) },
      uMode: {
        value: mode === "none" ? 0 : mode === "plastic" ? 1 : mode === "metal" ? 2 : 3,
      },
      uStickerRadius: { value: stickerRadius },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D uMap;
      uniform vec3 uTarget;
      uniform int uMode;
      uniform float uStickerRadius;
      varying vec2 vUv;

      void main() {
        vec4 texel = texture2D(uMap, vUv);
        if (texel.a < 0.045) discard;
        vec3 color = texel.rgb;
        float hi = max(color.r, max(color.g, color.b));
        float lo = min(color.r, min(color.g, color.b));
        float saturation = hi > 0.0001 ? (hi - lo) / hi : 0.0;
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        bool sticker = distance(vUv, vec2(0.5)) <= uStickerRadius;
        if (!sticker && uMode != 0) {
          // Ordinary releases recolor saturated PMMA/ABS and leave silver,
          // white highlights, black recesses, and zinc contact faces intact.
          float plasticWeight = smoothstep(0.18, 0.46, saturation)
            * smoothstep(0.055, 0.18, luminance)
            * (1.0 - smoothstep(0.9, 1.0, luminance));
          // Metal coats target neutral zinc pixels while retaining engraved
          // shading and specular luminance from the source photograph.
          float metalWeight = (1.0 - smoothstep(0.12, 0.34, saturation))
            * smoothstep(0.14, 0.38, luminance)
            * (1.0 - smoothstep(0.94, 1.0, luminance));
          // Lock Chips often reuse a white canonical photo for colored
          // releases, so recolor neutral outer plastic as well as saturated
          // pixels while preserving the smaller central emblem disc.
          float lockWeight = smoothstep(0.07, 0.22, luminance)
            * (1.0 - smoothstep(0.96, 1.0, luminance));
          float weight = uMode == 1 ? plasticWeight : (uMode == 2 ? metalWeight : lockWeight);
          float targetLuminance = max(dot(uTarget, vec3(0.2126, 0.7152, 0.0722)), 0.04);
          vec3 relitTarget = clamp(uTarget * (luminance / targetLuminance), 0.0, 1.0);
          color = mix(color, relitTarget, weight * 0.84);
        }

        // Isolated product photos already contain a large softbox reflection.
        // Rendering that baked highlight beneath the live stadium lighting made
        // spinning tops turn into broad white smears. Compress only the bright
        // end, most strongly on neutral pixels, and retain hue/chroma so printed
        // art and colored plastic stay legible instead of becoming flat grey.
        float gradedHi = max(color.r, max(color.g, color.b));
        float gradedLo = min(color.r, min(color.g, color.b));
        float gradedSat = gradedHi > 0.0001 ? (gradedHi - gradedLo) / gradedHi : 0.0;
        float gradedLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float neutral = 1.0 - smoothstep(0.08, 0.3, gradedSat);
        float highlight = smoothstep(0.56, 0.96, gradedLum);
        float glareCompression = highlight * mix(0.12, 0.34, neutral);
        color *= 1.0 - glareCompression;
        float postLum = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float saturationBoost = smoothstep(0.08, 0.42, gradedSat) * highlight * 0.18;
        color = clamp(vec3(postLum) + (color - vec3(postLum)) * (1.0 + saturationBoost), 0.0, 1.0);
        gl_FragColor = vec4(color, texel.a);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: true,
    side: THREE.DoubleSide,
  });
  material.toneMapped = false;
  material.userData.referenceTop = true;
  material.userData.referenceRecolorMode = mode;
  material.userData.bakedGlareReduction = 0.34;
  return material;
}

function topMaterial(
  url: string | null,
  fallbackColor: number,
  part: PartEntry | null = null,
  reference: ModelReferenceEntry | null = modelReferenceForPart(part),
): THREE.Material {
  if (!url) return new THREE.MeshBasicMaterial({ color: fallbackColor, side: THREE.DoubleSide });
  const mode = referenceRecolorMode(part, reference);
  const target = parseColor(part?.colors?.[0] ?? part?.color) ?? fallbackColor;
  return referenceTopMaterial(url, target, mode);
}

interface LayerDetail {
  angular: number;
  section: number;
  inner: number;
}

const LAYER_DETAIL: Record<UpperModelCategory, LayerDetail> = {
  blade: { angular: 512, section: 60, inner: 0.21 },
  mainBlade: { angular: 448, section: 56, inner: 0.22 },
  assistBlade: { angular: 256, section: 20, inner: 0.3 },
  metalBlade: { angular: 448, section: 44, inner: 0.24 },
  overBlade: { angular: 320, section: 28, inner: 0.27 },
};

function partRadius(part: PartEntry, fallback: number): number {
  return part.diameterMm && part.diameterMm > 0 ? part.diameterMm / 2000 : fallback;
}

function buildReferenceLayer(
  part: PartEntry,
  radiusM: number,
  baseZ: number,
  heightM: number,
  referenceTop: boolean,
): THREE.Group {
  const category = part.category as UpperModelCategory;
  const detail = LAYER_DETAIL[category] ?? LAYER_DETAIL.blade;
  const resolved = resolveUpperProfile(part);
  const palette = paletteFor(part, resolved.reference);
  const group = new THREE.Group();
  group.name = `upper:${category}:${part.key}`;
  group.userData = {
    category,
    key: part.key,
    profileSource: resolved.source,
    referenceUrl: resolved.reference?.texture ?? null,
    contacts: resolved.silhouette.contacts,
    metalCoated: isMetalCoated(part),
  };

  const bodyGeometry = profiledUpperGeometry(resolved.values, radiusM, heightM, {
    angularSegments: detail.angular,
    sectionSegments: detail.section,
    innerFraction: detail.inner,
  });
  const body = new THREE.Mesh(bodyGeometry, sideMaterial(part, category, palette));
  body.name = `${group.name}:body`;
  body.position.z = baseZ;
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  // The translucent/opaque moulded core is visible through the gaps between
  // zinc regions. The catalog top above it supplies the exact region edges.
  if (category === "blade" || category === "mainBlade" || category === "metalBlade") {
    const coreColor = referenceRecolorMode(part, resolved.reference) === "plastic"
      ? (palette[0] ?? 0x355d9d)
      : (palette[1] ?? palette[0] ?? 0x355d9d);
    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(radiusM * 0.73, radiusM * 0.78, heightM * 0.7, 192, 4),
      plasticMaterial(coreColor),
    );
    core.name = `${group.name}:core`;
    core.rotation.x = Math.PI / 2;
    core.position.z = baseZ + heightM * 0.48;
    core.castShadow = true;
    group.add(core);
  }

  if (referenceTop) {
    const top = new THREE.Mesh(
      profiledTopGeometry(resolved.values, radiusM),
      topMaterial(
        resolved.reference?.texture ?? null,
        palette[0] ?? 0x9aa4bf,
        part,
        resolved.reference,
      ),
    );
    top.name = `${group.name}:reference-top`;
    top.position.z = baseZ + heightM + 0.00006;
    top.renderOrder = 2;
    group.add(top);

    // Newly announced/collaboration blades sometimes have an isolated
    // emblem before the Wiki publishes a full Blade render. Keep the exact
    // sticker at its real scale over the deterministic mould silhouette.
    if (!resolved.reference && category === "blade") {
      const stickerUrl = STICKER_MANIFEST.blades[part.key];
      if (stickerUrl) {
        const sticker = new THREE.Mesh(
          new THREE.CircleGeometry(radiusM * 0.43, 192),
          topMaterial(stickerUrl, palette[0] ?? 0x9aa4bf),
        );
        sticker.name = `${group.name}:fallback-sticker`;
        sticker.position.z = baseZ + heightM + 0.00012;
        sticker.renderOrder = 3;
        group.add(sticker);
      }
    }
  }
  return group;
}

/** Reference-derived high-poly BX/UX upper (about 61.7k triangles). */
export function buildBxUxUpper(
  part: PartEntry,
  accent: number,
  radiusM: number,
  baseZ = 0,
  options: UpperBuildOptions = {},
): THREE.Group {
  const reference = modelReferenceForPart(part);
  const palette = paletteFor(part, reference);
  // Accent is intentionally only a final data-gap fallback; it never changes
  // silhouette, paint/coating state, or contact count.
  if (palette.length === 0) part = { ...part, colors: [`#${accent.toString(16).padStart(6, "0")}`] };
  const R = partRadius(part, radiusM);
  const group = buildReferenceLayer(part, R, baseZ, 0.0112, options.referenceTop !== false);
  group.name = `upper:blade:${part.key}`;
  group.userData.system = part.line ?? "BX";
  return group;
}

function buildLockChip(
  part: PartEntry,
  radiusM: number,
  baseZ: number,
  referenceTop: boolean,
): THREE.Group {
  const group = new THREE.Group();
  group.name = `upper:lockChip:${part.key}`;
  const spec: BladeSilhouetteSpec = { contacts: 12, kind: "guard", depth: 0.025 };
  const profile = Array.from({ length: 192 }, (_, i) => fallbackValue(spec, (i / 192) * TAU));
  const color = parseColor(part.colors?.[0] ?? part.color) ?? 0xd0aa42;
  const height = 0.0042;
  const body = new THREE.Mesh(
    profiledUpperGeometry(profile, radiusM, height, {
      angularSegments: UPPER_DETAIL.lockChipAngular,
      sectionSegments: 16,
      innerFraction: 0.16,
    }),
    plasticMaterial(color),
  );
  body.name = `${group.name}:body`;
  body.position.z = baseZ;
  body.castShadow = true;
  group.add(body);
  if (referenceTop) {
    const url = upperReferenceUrl(part);
    const lockTopMaterial = url && part.variantColorOverride
      ? referenceTopMaterial(url, color, "lock", 0.3)
      : topMaterial(url, color);
    const top = new THREE.Mesh(
      profiledTopGeometry(profile, radiusM, 192),
      lockTopMaterial,
    );
    top.name = `${group.name}:reference-top`;
    top.position.z = baseZ + height + 0.00006;
    top.renderOrder = 3;
    group.add(top);
  }
  return group;
}

/** Canonical standalone part view used by the garage/picker. */
export function buildCatalogUpperPart(
  part: PartEntry,
  accent: number,
  radiusM: number,
  baseZ = 0,
  options: UpperBuildOptions = {},
): THREE.Group {
  if (part.category === "lockChip") {
    return buildLockChip(part, radiusM, baseZ, options.referenceTop !== false);
  }
  const category = part.category as UpperModelCategory;
  const height = category === "blade"
    ? 0.0112
    : category === "mainBlade"
      ? 0.0088
      : category === "assistBlade"
        ? assistHeight(part)
        : category === "metalBlade"
          ? 0.0062
          : 0.0031;
  const reference = modelReferenceForPart(part);
  if (!(part.colors?.length || part.color || reference?.colors.length)) {
    part = { ...part, colors: [`#${accent.toString(16).padStart(6, "0")}`] };
  }
  return buildReferenceLayer(
    part,
    partRadius(part, radiusM),
    baseZ,
    height,
    options.referenceTop !== false,
  );
}

function assistHeight(part: PartEntry | undefined): number {
  if (!part) return 0;
  const measured = part.stats.height > 0 ? part.stats.height / 10000 : 0.0042;
  return THREE.MathUtils.clamp(measured, 0.0035, 0.009);
}

/**
 * Component-correct CX upper. Classic stacks render Main + Assist; Expand
 * stacks replace the synthetic Main placeholder with Metal + Over + Assist.
 */
export function buildCxUpper(
  rc: ResolvedCombo,
  accent: number,
  radiusM: number,
  baseZ = 0,
  options: UpperBuildOptions = {},
): THREE.Group {
  const group = new THREE.Group();
  group.name = "upper:cx";
  const referenceTop = options.referenceTop !== false;
  const assist = rc.parts.assistBlade;
  const main = rc.parts.mainBlade;
  const metal = rc.parts.metalBlade;
  const over = rc.parts.overBlade;
  const expanded = !!metal && !!over;
  let topZ = baseZ;

  const aHeight = assistHeight(assist);
  if (assist) {
    const aR = partRadius(assist, radiusM * 0.94);
    group.add(buildReferenceLayer(assist, aR, baseZ, aHeight, referenceTop));
    topZ = Math.max(topZ, baseZ + aHeight);
  }

  const layerBase = baseZ + aHeight * 0.52;
  if (expanded) {
    if (metal) {
      const mR = partRadius(metal, radiusM);
      group.add(buildReferenceLayer(metal, mR, layerBase, 0.0062, referenceTop));
      topZ = Math.max(topZ, layerBase + 0.0062);
    }
    if (over) {
      const oR = partRadius(over, radiusM * 0.93);
      const overBase = layerBase + 0.0036;
      group.add(buildReferenceLayer(over, oR, overBase, 0.0031, referenceTop));
      topZ = Math.max(topZ, overBase + 0.0031);
    }
  } else if (main) {
    const mainR = partRadius(main, radiusM);
    group.add(buildReferenceLayer(main, mainR, layerBase, 0.0088, referenceTop));
    topZ = Math.max(topZ, layerBase + 0.0088);
  }

  if (rc.parts.lockChip) {
    group.add(buildLockChip(rc.parts.lockChip, radiusM * 0.36, topZ - 0.0007, referenceTop));
    topZ += 0.0035;
  }

  // The full product photo is not needed for normal rendering, but is useful
  // as an exact assembly-validation overlay while component alignment evolves.
  const compositePart = rc.compositeBlade;
  const compositeReference = modelReferenceForPart(compositePart);
  const componentRecolor = [assist, main, metal, over, rc.parts.lockChip]
    .some((part) => part?.variantColorOverride);
  const compositeRecolor = compositePart && compositeReference
    ? referenceRecolorMode(compositePart, compositeReference) !== "none"
    : false;
  if (
    options.compositeOverlay && compositePart && compositeReference &&
    !componentRecolor && !compositeRecolor
  ) {
    const composite = resolveUpperProfile(compositePart);
    const overlay = new THREE.Mesh(
      profiledTopGeometry(composite.values, partRadius(compositePart, radiusM)),
      topMaterial(compositeReference.texture, accent, compositePart, composite.reference),
    );
    overlay.name = "upper:cx:composite-reference";
    // The separately modeled Lock Chip remains fractionally above the full
    // product surface so its exact/recolored emblem is never overwritten.
    overlay.position.z = topZ - 0.00012;
    overlay.renderOrder = 5;
    group.add(overlay);
  }

  group.userData = {
    system: "CX",
    expanded,
    components: {
      lockChip: rc.parts.lockChip?.key ?? null,
      mainBlade: expanded ? null : (main?.key ?? null),
      assistBlade: assist?.key ?? null,
      metalBlade: metal?.key ?? null,
      overBlade: over?.key ?? null,
    },
  };
  return group;
}
