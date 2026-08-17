// High-detail, reference-driven Ratchet and Bit geometry for Beyblade X.
//
// This module intentionally has no dependency on parts.ts.  The upper-part
// renderer can adopt it without creating an import cycle, and the catalog
// tables below keep the dimensions encoded on the real parts close to the
// geometry which consumes them.

import * as THREE from "three";

import type { PartEntry } from "../core/types";
import modelReferenceManifestJson from "./model-reference-manifest.json";
import {
  absPlastic,
  paintedMetal,
  pomTranslucent,
  rubberMat,
} from "./materials";

const TAU = Math.PI * 2;
const BIT_RADIAL = 512;
const RATCHET_RADIAL = 256;
const AXIAL_RINGS = 25;
const PRIMITIVE_RADIAL = 128;
const SPHERE_RINGS = 48;

interface LowerReferenceEntry {
  colors?: string[];
  radialProfile?: number[];
  sideProfile?: [number, number][];
}

const LOWER_REFERENCE_PARTS = (modelReferenceManifestJson as unknown as {
  parts: Record<string, Record<string, LowerReferenceEntry>>;
}).parts;

function lowerReference(
  category: "ratchet" | "bit",
  part: PartEntry | null | undefined,
): LowerReferenceEntry | null {
  if (!part) return null;
  const table = LOWER_REFERENCE_PARTS[category] ?? {};
  return table[part.key] ?? table[part.group] ?? table[part.code] ?? null;
}

function periodicSample(values: readonly number[], theta: number): number {
  if (values.length === 0) return 1;
  const unit = ((theta / TAU) % 1 + 1) % 1;
  const p = unit * values.length;
  const i = Math.floor(p) % values.length;
  const f = p - Math.floor(p);
  return THREE.MathUtils.lerp(values[i] ?? 1, values[(i + 1) % values.length] ?? 1, f);
}

const mm = (value: number): number => value / 1000;
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const smoothstep = (a: number, b: number, value: number): number => {
  const t = clamp01((value - a) / Math.max(1e-9, b - a));
  return t * t * (3 - 2 * t);
};
const fract = (value: number): number => value - Math.floor(value);

function tint(color: number, lightnessDelta: number): number {
  return new THREE.Color(color).offsetHSL(0, 0, lightnessDelta).getHex();
}

type PartColorInput = number | readonly number[];

function colorValues(input: PartColorInput): number[] {
  return typeof input === "number" ? [input] : [...input];
}

function referenceColorValues(
  category: "ratchet" | "bit",
  part: PartEntry | null | undefined,
): number[] {
  return (lowerReference(category, part)?.colors ?? [])
    .filter((value) => /^#[0-9a-f]{6}$/i.test(value))
    .map((value) => Number.parseInt(value.slice(1), 16));
}

function mergedColorValues(
  category: "ratchet" | "bit",
  part: PartEntry | null | undefined,
  input: PartColorInput,
): number[] {
  return [...new Set([...colorValues(input), ...referenceColorValues(category, part)])];
}

function mostDistinctColor(primary: number, candidates: readonly number[]): number | null {
  const base = new THREE.Color(primary);
  let best: { color: number; distance: number } | null = null;
  for (const candidate of candidates) {
    const color = new THREE.Color(candidate);
    const distance =
      (base.r - color.r) ** 2 + (base.g - color.g) ** 2 + (base.b - color.b) ** 2;
    if (!best || distance > best.distance) best = { color: candidate, distance };
  }
  return best?.color ?? null;
}

function palette(input: PartColorInput): readonly [number, number, number] {
  const values = typeof input === "number" ? [input] : [...input];
  const primary = values[0] ?? 0x315bc5;
  return [primary, values[1] ?? tint(primary, 0.24), values[2] ?? tint(primary, 0.12)];
}

function zoneMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "rubber" | "metal",
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.userData.materialZone = zone;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

interface RadiusRing {
  z: number;
  r: number;
}

function sampleRings(control: readonly RadiusRing[], count = AXIAL_RINGS): RadiusRing[] {
  const sorted = [...control].sort((a, b) => a.z - b.z);
  const z0 = sorted[0]!.z;
  const z1 = sorted.at(-1)!.z;
  const out: RadiusRing[] = [];
  for (let i = 0; i < count; i++) {
    const z = THREE.MathUtils.lerp(z0, z1, i / (count - 1));
    let j = 0;
    while (j + 1 < sorted.length && sorted[j + 1]!.z < z) j++;
    const a = sorted[j]!;
    const b = sorted[Math.min(sorted.length - 1, j + 1)]!;
    const t = a === b ? 0 : clamp01((z - a.z) / Math.max(1e-9, b.z - a.z));
    out.push({ z, r: THREE.MathUtils.lerp(a.r, b.r, smoothstep(0, 1, t)) });
  }
  return out;
}

/** Closed high-density loft.  The outline callback makes molded gears and
 * asymmetric tips part of the surface rather than decals or floating boxes. */
function loftSolid(
  control: readonly RadiusRing[],
  outline: (theta: number, z: number, baseRadius: number) => number = (_t, _z, r) => r,
  radial = BIT_RADIAL,
): THREE.BufferGeometry {
  const rings = sampleRings(control);
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const z0 = rings[0]!.z;
  const z1 = rings.at(-1)!.z;

  for (let iz = 0; iz < rings.length; iz++) {
    const ring = rings[iz]!;
    for (let ia = 0; ia < radial; ia++) {
      const theta = (ia / radial) * TAU;
      const radius = Math.max(0.00002, outline(theta, ring.z, ring.r));
      positions.push(Math.cos(theta) * radius, Math.sin(theta) * radius, ring.z);
      uvs.push(ia / radial, (ring.z - z0) / Math.max(1e-9, z1 - z0));
    }
  }

  for (let iz = 0; iz < rings.length - 1; iz++) {
    for (let ia = 0; ia < radial; ia++) {
      const next = (ia + 1) % radial;
      const a = iz * radial + ia;
      const b = iz * radial + next;
      const c = (iz + 1) * radial + next;
      const d = (iz + 1) * radial + ia;
      indices.push(a, b, d, b, c, d);
    }
  }

  const bottomCenter = positions.length / 3;
  positions.push(0, 0, z0);
  uvs.push(0.5, 0.5);
  const topCenter = positions.length / 3;
  positions.push(0, 0, z1);
  uvs.push(0.5, 0.5);
  const topOffset = (rings.length - 1) * radial;
  for (let ia = 0; ia < radial; ia++) {
    const next = (ia + 1) % radial;
    indices.push(bottomCenter, next, ia);
    indices.push(topCenter, topOffset + ia, topOffset + next);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/** An annular loft gives a Ratchet its real central Bit socket while keeping
 * roughly the same triangle budget as the existing 512-step solid sweep. */
function loftAnnulus(
  control: readonly RadiusRing[],
  innerRadius: number,
  outline: (theta: number, z: number, baseRadius: number) => number,
): THREE.BufferGeometry {
  const rings = sampleRings(control);
  const radial = RATCHET_RADIAL;
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const z0 = rings[0]!.z;
  const z1 = rings.at(-1)!.z;

  for (let surface = 0; surface < 2; surface++) {
    for (let iz = 0; iz < rings.length; iz++) {
      const ring = rings[iz]!;
      for (let ia = 0; ia < radial; ia++) {
        const theta = (ia / radial) * TAU;
        const radius = surface === 0
          ? Math.max(innerRadius + 0.0002, outline(theta, ring.z, ring.r))
          : innerRadius * (1 + 0.035 * Math.cos(theta * 4));
        positions.push(Math.cos(theta) * radius, Math.sin(theta) * radius, ring.z);
        uvs.push(ia / radial, (ring.z - z0) / Math.max(1e-9, z1 - z0));
      }
    }
  }

  const surfaceStride = rings.length * radial;
  for (let iz = 0; iz < rings.length - 1; iz++) {
    for (let ia = 0; ia < radial; ia++) {
      const next = (ia + 1) % radial;
      const o0 = iz * radial + ia;
      const o1 = iz * radial + next;
      const o2 = (iz + 1) * radial + next;
      const o3 = (iz + 1) * radial + ia;
      indices.push(o0, o1, o3, o1, o2, o3);

      const i0 = surfaceStride + iz * radial + ia;
      const i1 = surfaceStride + iz * radial + next;
      const i2 = surfaceStride + (iz + 1) * radial + next;
      const i3 = surfaceStride + (iz + 1) * radial + ia;
      indices.push(i0, i3, i1, i1, i3, i2);
    }
  }

  const topOuter = (rings.length - 1) * radial;
  const bottomInner = surfaceStride;
  const topInner = surfaceStride + topOuter;
  for (let ia = 0; ia < radial; ia++) {
    const next = (ia + 1) % radial;
    indices.push(ia, bottomInner + ia, next, next, bottomInner + ia, bottomInner + next);
    indices.push(topOuter + ia, topOuter + next, topInner + ia,
      topOuter + next, topInner + next, topInner + ia);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

function zCylinder(
  radiusTop: number,
  radiusBottom: number,
  height: number,
  z: number,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "rubber" | "metal" = "plastic",
  radial = PRIMITIVE_RADIAL,
): THREE.Mesh {
  const mesh = zoneMesh(
    new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radial, 8),
    material,
    name,
    zone,
  );
  mesh.rotation.x = Math.PI / 2;
  mesh.position.z = z;
  return mesh;
}

// -------------------------------------------------------------------------
// Ratchets

export type RatchetProfile =
  | "zero" | "attack-one" | "directional-two" | "impact-three"
  | "deflect-four" | "weight-five" | "alternating-six"
  | "defense-seven" | "wide-eight" | "rapid-nine" | "integrated" | "invalid";

export interface RatchetModelSpec {
  code: string;
  count: number;
  heightM: number;
  profile: RatchetProfile;
  simple: boolean;
  metal: boolean;
  integrated: boolean;
  valid: boolean;
}

const RAT_PROFILE: Record<number, RatchetProfile> = {
  0: "zero",
  1: "attack-one",
  2: "directional-two",
  3: "impact-three",
  4: "deflect-four",
  5: "weight-five",
  6: "alternating-six",
  7: "defense-seven",
  8: "wide-eight",
  9: "rapid-nine",
};

export function ratchetSpec(code: string | undefined): RatchetModelSpec {
  const raw = (code ?? "").trim();
  if (!raw || /integrated|一体型/i.test(raw)) {
    return {
      code: raw,
      count: 0,
      heightM: 0,
      profile: "integrated",
      simple: true,
      metal: false,
      integrated: true,
      valid: true,
    };
  }
  if (raw === "M-85") {
    return {
      code: raw,
      count: 5,
      heightM: mm(8.5),
      profile: "weight-five",
      simple: true,
      metal: true,
      integrated: false,
      valid: true,
    };
  }
  const match = /^(\d)-(\d{2})$/.exec(raw);
  if (!match) {
    return {
      code: raw,
      count: 0,
      heightM: 0,
      profile: "invalid",
      simple: false,
      metal: false,
      integrated: false,
      valid: false,
    };
  }
  const count = Number.parseInt(match[1]!, 10);
  const heightCode = Number.parseInt(match[2]!, 10);
  return {
    code: raw,
    count,
    heightM: heightCode / 10000,
    profile: RAT_PROFILE[count] ?? "invalid",
    simple: heightCode % 10 === 5,
    metal: false,
    integrated: false,
    valid: count >= 0 && count <= 9,
  };
}

function ratchetLobe(spec: RatchetModelSpec, theta: number, direction: 1 | -1): number {
  if (spec.count === 0) return 0;
  const count = spec.count;
  const period = TAU / count;
  const directedTheta = theta * direction;
  const u = fract(directedTheta / period + 0.5);
  const centered = u - 0.5;
  const triangle = Math.max(0, 1 - Math.abs(centered) * 2);

  switch (count) {
    case 1: {
      const main = Math.pow(Math.max(0, Math.cos(theta)), 4);
      const counterweight = 0.28 * Math.pow(Math.max(0, -Math.cos(theta)), 2);
      return Math.max(main, counterweight);
    }
    case 2: {
      // The production molds are visibly directional: a short leading wall
      // and a longer trailing ramp, mirrored for left-origin versions.
      const ramp = u < 0.24 ? u / 0.24 : u < 0.72 ? 1 - (u - 0.24) / 0.48 : 0;
      return Math.pow(Math.max(0, ramp), 0.55);
    }
    case 3:
      return Math.pow(triangle, 0.62);
    case 4:
      return Math.pow(triangle, 1.45);
    case 5:
      return Math.pow(triangle, 0.42);
    case 6: {
      const blade = Math.floor(fract(directedTheta / TAU) * count);
      return Math.pow(triangle, blade % 2 === 0 ? 0.48 : 1.75) * (blade % 2 === 0 ? 1 : 0.68);
    }
    case 7:
      return Math.pow(triangle, 0.3);
    case 8:
      return Math.pow(triangle, 0.9);
    case 9:
      return Math.pow(triangle, 2.35);
    default:
      return 0;
  }
}

export function buildRatchetModel(
  part: PartEntry | null | undefined,
  topZ: number,
  colorInput: PartColorInput = 0xe6e8ef,
): THREE.Group {
  const [color, coverColor, baseColor] = palette(mergedColorValues("ratchet", part, colorInput));
  const group = new THREE.Group();
  const spec = ratchetSpec(part?.code ?? part?.group);
  group.name = `ratchet:${spec.code || "integrated"}`;
  group.userData.ratchetSpec = spec;
  if (!spec.valid || spec.integrated) return group;

  const baseZ = topZ - spec.heightM;
  const outerR = spec.count === 8 ? mm(14.2) : spec.count === 0 ? mm(12.8) : mm(13);
  const heightMm = spec.heightM * 1000;
  const skirt = heightMm >= 8 ? 0.9 : heightMm >= 7 ? 0.84 : heightMm >= 6 ? 0.78 : 0.72;
  const control: RadiusRing[] = [
    { z: baseZ, r: outerR * skirt * 0.9 },
    { z: baseZ + spec.heightM * 0.08, r: outerR * skirt },
    { z: baseZ + spec.heightM * 0.24, r: outerR * (skirt + 0.03) },
    { z: baseZ + spec.heightM * 0.42, r: outerR * 0.88 },
    { z: baseZ + spec.heightM * 0.82, r: outerR },
    { z: topZ - spec.heightM * 0.05, r: outerR * 0.97 },
    { z: topZ, r: outerR * 0.78 },
  ];
  const direction: 1 | -1 = part?.rotation === "both-left-origin" ? -1 : 1;
  const traced = lowerReference("ratchet", part)?.radialProfile;
  const geometry = loftAnnulus(control, mm(4.45), (theta, z, radius) => {
    if (spec.count === 0) return radius;
    const zn = (z - baseZ) / Math.max(1e-9, spec.heightM);
    const contactBand = smoothstep(0.3, 0.55, zn) * (1 - smoothstep(0.96, 1, zn));
    const lobe = ratchetLobe(spec, theta, direction);
    const amplitude = spec.count === 9 ? 0.11 : spec.count === 8 ? 0.13 : spec.count === 7 ? 0.15 : 0.18;
    const designed = 1 - amplitude * contactBand * (1 - lobe);
    const reference = traced?.length
      ? THREE.MathUtils.lerp(1, periodicSample(traced, theta), contactBand * 0.72)
      : 1;
    return radius * designed * reference;
  });
  group.add(zoneMesh(geometry, pomTranslucent(color), "zone:ratchet-ring", "plastic"));

  // The white/opaque Ratchet cover is a separate molded component on the
  // original, rather than a metal cylinder painted over the colored ring.
  const cover = zCylinder(mm(4.75), mm(4.55), mm(1.25), topZ - mm(0.62),
    pomTranslucent(coverColor), "zone:ratchet-cover");
  group.add(cover);

  const base = new THREE.Mesh(
    new THREE.TorusGeometry(mm(5.65), mm(0.72), 20, PRIMITIVE_RADIAL),
    pomTranslucent(baseColor),
  );
  base.name = "zone:ratchet-base";
  base.userData.materialZone = "plastic";
  base.position.z = baseZ + mm(0.72);
  base.castShadow = true;
  group.add(base);

  if (spec.simple) {
    const snap = new THREE.Mesh(
      new THREE.TorusGeometry(mm(4.05), mm(0.52), 16, PRIMITIVE_RADIAL),
      pomTranslucent(coverColor),
    );
    snap.name = "joint:simple-o-ring";
    snap.userData.materialZone = "plastic";
    snap.position.z = topZ - mm(1.25);
    group.add(snap);
  } else {
    const latchMat = pomTranslucent(coverColor);
    for (const side of [-1, 1]) {
      const latch = zoneMesh(
        new THREE.BoxGeometry(mm(2.6), mm(1.25), mm(1.1), 6, 4, 4),
        latchMat,
        "joint:twist-latch",
        "plastic",
      );
      latch.position.set(side * mm(4.25), 0, topZ - mm(1.1));
      group.add(latch);
    }
  }

  if (spec.metal) {
    const metal = new THREE.Mesh(
      new THREE.TorusGeometry(mm(8.25), mm(1.15), 24, PRIMITIVE_RADIAL),
      paintedMetal(0xbfc5d0, 0.3),
    );
    metal.name = "zone:m85-metal-ring";
    metal.userData.materialZone = "metal";
    metal.position.z = baseZ + mm(0.75);
    metal.castShadow = true;
    group.add(metal);
    for (let i = 0; i < 3; i++) {
      const rivet = zCylinder(mm(0.55), mm(0.55), mm(0.42), baseZ + mm(0.42),
        paintedMetal(0xaeb5c2, 0.28), "zone:m85-rivet", "metal", 32);
      const angle = (i / 3) * TAU;
      rivet.position.x = Math.cos(angle) * mm(7.8);
      rivet.position.y = Math.sin(angle) * mm(7.8);
      group.add(rivet);
    }
  }

  return group;
}

// -------------------------------------------------------------------------
// Bits

export type BitFamily =
  | "flat" | "ball" | "needle" | "point" | "taper" | "spike"
  | "rubberFlat" | "rubberHybrid" | "special" | "integrated" | "invalid";

type BitShape =
  | "flat" | "ball" | "bound-spike" | "cyclone" | "dot" | "disk-ball"
  | "disk-spike" | "elevate" | "free-ball" | "free-flat" | "glide"
  | "gear-ball" | "gear-flat" | "gear-needle" | "gear-point"
  | "gear-rush" | "gear-unite" | "hexa" | "high-needle" | "high-taper"
  | "ignition" | "jolt" | "kick" | "level" | "low-flat" | "low-orb"
  | "low-rush" | "merge" | "metal-needle" | "needle" | "narrow"
  | "orb" | "operate" | "point" | "quake" | "rush" | "rubber-accel"
  | "spike" | "taper" | "trans-kick" | "trans-point" | "turbo"
  | "unite" | "under-flat" | "under-needle" | "vortex" | "wedge"
  | "wall-ball" | "wall-wedge" | "yielding" | "zap";

export interface BitModelSpec {
  code: string;
  family: BitFamily;
  shape: BitShape;
  gearTeeth: number;
  /** Contact point to the exposed Ratchet-facing shoulder. */
  exposedHeightM: number;
  /** Complete loose-part height, including the shaft hidden in a Ratchet. */
  totalHeightM: number;
  /** Contact point to the beginning of the main molded body. */
  tipHeightM: number;
  gearExtended: boolean;
  rubber: boolean;
  metal: boolean;
  free: boolean;
  spring: boolean;
  trans: boolean;
  integrated: boolean;
  valid: boolean;
  modes?: readonly { name: string; heightM: number; contact: string }[];
}

interface BitOptions {
  gearExtended?: boolean;
  rubber?: boolean;
  metal?: boolean;
  free?: boolean;
  spring?: boolean;
  trans?: boolean;
  integrated?: boolean;
  modes?: BitModelSpec["modes"];
}

function defineBit(
  code: string,
  family: BitFamily,
  shape: BitShape,
  gearTeeth: number,
  exposedMm: number,
  totalMm: number,
  tipMm: number,
  options: BitOptions = {},
): BitModelSpec {
  return Object.freeze({
    code,
    family,
    shape,
    gearTeeth,
    exposedHeightM: mm(exposedMm),
    totalHeightM: mm(totalMm),
    tipHeightM: mm(tipMm),
    gearExtended: options.gearExtended ?? false,
    rubber: options.rubber ?? false,
    metal: options.metal ?? false,
    free: options.free ?? false,
    spring: options.spring ?? false,
    trans: options.trans ?? false,
    integrated: options.integrated ?? false,
    valid: true,
    modes: options.modes,
  });
}

// Gear counts and the two height columns are retained verbatim from
// data/raw/part_weights.json.  Disk Spike was added before that source gained
// measurements; its released mold uses the standard twelve-tooth gear and is
// effectively the same exposed height as Spike.
const BIT_SPECS: Readonly<Record<string, BitModelSpec>> = Object.freeze({
  A: defineBit("A", "flat", "flat", 16, 12.2, 29.6, 3.0),
  B: defineBit("B", "ball", "ball", 12, 12.4, 29.8, 4.5),
  BS: defineBit("BS", "spike", "bound-spike", 12, 13.6, 29.6, 5.9, { spring: true }),
  C: defineBit("C", "flat", "cyclone", 12, 12.3, 29.8, 3.1),
  D: defineBit("D", "ball", "dot", 12, 12.3, 29.8, 3.5),
  DB: defineBit("DB", "ball", "disk-ball", 12, 14.6, 31.9, 4.6),
  DS: defineBit("DS", "spike", "disk-spike", 12, 12.3, 29.8, 5.0),
  E: defineBit("E", "point", "elevate", 12, 11.8, 29.0, 3.0),
  F: defineBit("F", "flat", "flat", 12, 12.3, 29.7, 2.9),
  FB: defineBit("FB", "ball", "free-ball", 12, 12.3, 29.7, 3.8, { free: true }),
  FF: defineBit("FF", "flat", "free-flat", 12, 12.7, 29.8, 3.0, { free: true }),
  G: defineBit("G", "ball", "glide", 16, 12.4, 30.2, 4.2),
  GB: defineBit("GB", "ball", "gear-ball", 12, 12.3, 29.7, 4.2, { gearExtended: true }),
  GF: defineBit("GF", "flat", "gear-flat", 12, 12.3, 29.6, 3.2, { gearExtended: true }),
  GN: defineBit("GN", "needle", "gear-needle", 12, 12.0, 29.4, 5.1, { gearExtended: true }),
  GP: defineBit("GP", "point", "gear-point", 12, 12.4, 30.0, 3.7, { gearExtended: true }),
  GR: defineBit("GR", "flat", "gear-rush", 10, 12.3, 29.7, 3.0, { gearExtended: true }),
  GU: defineBit("GU", "point", "gear-unite", 12, 12.1, 29.7, 4.0, { gearExtended: true }),
  H: defineBit("H", "special", "hexa", 16, 12.2, 29.4, 3.6),
  HN: defineBit("HN", "needle", "high-needle", 12, 13.3, 30.7, 6.8),
  HT: defineBit("HT", "taper", "high-taper", 12, 13.3, 30.6, 6.3),
  I: defineBit("I", "flat", "ignition", 16, 10.0, 27.6, 2.7),
  J: defineBit("J", "flat", "jolt", 16, 12.2, 29.5, 3.2),
  K: defineBit("K", "taper", "kick", 12, 12.5, 29.6, 5.0),
  L: defineBit("L", "flat", "level", 16, 12.5, 29.5, 4.2),
  LF: defineBit("LF", "flat", "low-flat", 12, 11.3, 28.7, 2.7),
  LO: defineBit("LO", "ball", "low-orb", 12, 11.2, 28.5, 3.2),
  LR: defineBit("LR", "flat", "low-rush", 10, 11.3, 28.7, 2.7),
  M: defineBit("M", "rubberHybrid", "merge", 18, 15.4, 33.8, 6.0, { rubber: true }),
  MN: defineBit("MN", "needle", "metal-needle", 12, 12.4, 29.7, 5.8, { metal: true }),
  N: defineBit("N", "needle", "needle", 12, 12.3, 29.4, 5.8),
  Nr: defineBit("Nr", "ball", "narrow", 10, 12.3, 30.0, 4.8),
  O: defineBit("O", "ball", "orb", 12, 12.3, 29.8, 3.6),
  Op: defineBit("Op", "integrated", "operate", 16, 20.5, 37.8, 5.0, {
    integrated: true,
    trans: true,
    modes: [
      { name: "defense", heightM: mm(8), contact: "small-ball" },
      { name: "attack", heightM: mm(8.5), contact: "hollow-taper-flat" },
    ],
  }),
  P: defineBit("P", "point", "point", 12, 12.4, 29.8, 3.8),
  Q: defineBit("Q", "special", "quake", 12, 12.3, 29.6, 3.5),
  R: defineBit("R", "flat", "rush", 10, 12.3, 29.7, 2.9),
  RA: defineBit("RA", "rubberFlat", "rubber-accel", 16, 12.3, 30.0, 3.2, { rubber: true }),
  S: defineBit("S", "spike", "spike", 12, 12.3, 29.8, 5.6),
  T: defineBit("T", "taper", "taper", 12, 12.3, 29.7, 5.2),
  TK: defineBit("TK", "taper", "trans-kick", 12, 11.2, 29.5, 4.8, {
    trans: true,
    modes: [
      { name: "low", heightM: mm(11.2), contact: "kick" },
      { name: "high", heightM: mm(12.2), contact: "kick" },
    ],
  }),
  TP: defineBit("TP", "point", "trans-point", 12, 11.5, 28.6, 3.8, {
    trans: true,
    modes: [
      { name: "low", heightM: mm(11.5), contact: "point" },
      { name: "high", heightM: mm(12.5), contact: "point" },
    ],
  }),
  Tr: defineBit("Tr", "integrated", "turbo", 12, 21.0, 38.3, 6.5, {
    integrated: true,
    spring: true,
    trans: true,
    modes: [
      { name: "high-rpm", heightM: mm(9), contact: "sharp" },
      { name: "low-rpm", heightM: mm(6.5), contact: "flat" },
    ],
  }),
  U: defineBit("U", "point", "unite", 12, 12.3, 29.3, 4.0),
  UF: defineBit("UF", "flat", "under-flat", 12, 10.2, 27.5, 2.5),
  UN: defineBit("UN", "needle", "under-needle", 12, 10.2, 27.5, 4.0),
  V: defineBit("V", "flat", "vortex", 12, 12.3, 29.4, 3.2),
  W: defineBit("W", "spike", "wedge", 10, 12.7, 29.7, 5.0),
  WB: defineBit("WB", "ball", "wall-ball", 16, 13.0, 30.7, 4.2),
  WW: defineBit("WW", "spike", "wall-wedge", 16, 13.2, 30.6, 5.0),
  Y: defineBit("Y", "ball", "yielding", 20, 15.0, 31.5, 5.5),
  Z: defineBit("Z", "point", "zap", 16, 11.5, 28.8, 3.3),
});

function normalizeBitCode(code: string | undefined): string {
  const raw = (code ?? "").trim();
  if (BIT_SPECS[raw]) return raw;
  if (raw.toLowerCase() === "nr") return "Nr";
  if (raw.toLowerCase() === "op") return "Op";
  if (raw.toLowerCase() === "tr") return "Tr";
  return raw.toUpperCase();
}

const INVALID_BIT: BitModelSpec = Object.freeze({
  code: "",
  family: "invalid",
  shape: "flat",
  gearTeeth: 0,
  exposedHeightM: 0,
  totalHeightM: 0,
  tipHeightM: 0,
  gearExtended: false,
  rubber: false,
  metal: false,
  free: false,
  spring: false,
  trans: false,
  integrated: false,
  valid: false,
});

export function bitSpec(code: string | undefined): BitModelSpec {
  return BIT_SPECS[normalizeBitCode(code)] ?? { ...INVALID_BIT, code: (code ?? "").trim() };
}

export function bitFamily(code: string): BitFamily {
  return bitSpec(code).family;
}

/** Every normal X Bit is geared. Gear-prefixed names mean the teeth extend
 * down the tip, not that the other Bits lack an X-Line gear. */
export function bitHasGear(code: string): boolean {
  return bitSpec(code).gearTeeth > 0;
}

export function bitTipHeight(code: string): number {
  return bitSpec(code).tipHeightM;
}

export function bitHeight(code: string): number {
  return bitSpec(code).exposedHeightM;
}

/** Effective visible assembly height, including switchable Op/Tr modes. */
export function bitHeightForPart(part: PartEntry | null | undefined): number {
  const spec = bitSpec(part?.code ?? part?.group);
  if (!spec.valid) return 0;
  if (!spec.integrated || !spec.modes?.length || !part?.stats.height) {
    return spec.exposedHeightM;
  }
  const canonicalModeHeight = spec.modes[0]!.heightM;
  const selectedModeHeight = part.stats.height / 10000;
  return Math.max(mm(4), spec.exposedHeightM + selectedModeHeight - canonicalModeHeight);
}

function gearWave(theta: number, teeth: number): number {
  if (teeth <= 0) return 0;
  const u = fract((theta / TAU) * teeth);
  const tooth = Math.max(0, 1 - Math.abs(u - 0.5) / 0.34);
  return smoothstep(0, 1, tooth);
}

function addTipGearRibs(
  group: THREE.Group,
  teeth: number,
  radius: number,
  z: number,
  height: number,
  material: THREE.Material,
  extended: boolean,
): void {
  if (!extended) return;
  const geometry = new THREE.BoxGeometry(mm(0.95), mm(1.45), height, 3, 4, 4);
  const ribs = new THREE.InstancedMesh(geometry, material, teeth);
  ribs.name = "zone:extended-gear-ribs";
  ribs.userData.materialZone = "plastic";
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion();
  for (let i = 0; i < teeth; i++) {
    const angle = (i / teeth) * TAU;
    quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), angle);
    matrix.compose(
      new THREE.Vector3(Math.cos(angle) * radius, Math.sin(angle) * radius, z),
      quaternion,
      new THREE.Vector3(1, 1, 1),
    );
    ribs.setMatrixAt(i, matrix);
  }
  ribs.instanceMatrix.needsUpdate = true;
  ribs.castShadow = true;
  group.add(ribs);
}

function addSphereTip(
  group: THREE.Group,
  radius: number,
  baseZ: number,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "rubber" | "metal" = "plastic",
  zScale = 1,
): THREE.Mesh {
  const mesh = zoneMesh(
    new THREE.SphereGeometry(radius, PRIMITIVE_RADIAL, SPHERE_RINGS),
    material,
    name,
    zone,
  );
  mesh.scale.z = zScale;
  mesh.position.z = baseZ + radius * zScale;
  group.add(mesh);
  return mesh;
}

function addTorus(
  group: THREE.Group,
  radius: number,
  tube: number,
  z: number,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "rubber" | "metal" = "plastic",
): THREE.Mesh {
  const mesh = zoneMesh(
    new THREE.TorusGeometry(radius, tube, 20, PRIMITIVE_RADIAL),
    material,
    name,
    zone,
  );
  mesh.position.z = z;
  group.add(mesh);
  return mesh;
}

function addFlatContact(
  group: THREE.Group,
  baseZ: number,
  radius: number,
  height: number,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "rubber" = "plastic",
  recess = false,
): void {
  const lift = recess ? mm(0.28) : 0;
  group.add(zCylinder(radius * 0.92, radius, height, baseZ + height / 2 + lift,
    material, name, zone));
  if (recess) {
    addTorus(group, radius * 0.63, radius * 0.22, baseZ + mm(0.22), material,
      `${name}:recess-rim`, zone);
  }
}

function addNeedleContact(
  group: THREE.Group,
  baseZ: number,
  height: number,
  topRadius: number,
  material: THREE.Material,
  name: string,
  zone: "plastic" | "metal" = "plastic",
): void {
  group.add(zCylinder(topRadius, mm(0.16), height, baseZ + height / 2,
    material, name, zone));
}

function addSpiralFins(
  group: THREE.Group,
  baseZ: number,
  radius: number,
  height: number,
  material: THREE.Material,
  direction: 1 | -1,
  name: string,
): void {
  addFlatContact(group, baseZ, radius * 0.72, height, material, `${name}:core`);
  const geometry = new THREE.BoxGeometry(radius * 0.78, mm(0.8), height * 0.72, 8, 3, 4);
  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * TAU;
    const fin = zoneMesh(geometry, material, `${name}:spiral-fin`, "plastic");
    fin.rotation.z = angle + direction * 0.43;
    fin.position.set(
      Math.cos(angle) * radius * 0.48,
      Math.sin(angle) * radius * 0.48,
      baseZ + height * 0.56,
    );
    group.add(fin);
  }
}

function addWall(
  group: THREE.Group,
  baseZ: number,
  radius: number,
  height: number,
  material: THREE.Material,
  name: string,
): void {
  const wall = zoneMesh(
    new THREE.CylinderGeometry(radius, radius, height, PRIMITIVE_RADIAL, 8, true),
    material,
    name,
    "plastic",
  );
  wall.rotation.x = Math.PI / 2;
  wall.position.z = baseZ + height / 2 + mm(0.32);
  group.add(wall);
  addTorus(group, radius, mm(0.35), baseZ + mm(0.38), material, `${name}:lower-rim`);
}

function buildIntegratedBit(
  part: PartEntry | null | undefined,
  spec: BitModelSpec,
  baseZ: number,
  colorInput: PartColorInput,
): THREE.Group {
  const [color, accentColor] = palette(colorInput);
  const group = new THREE.Group();
  const hard = absPlastic(color, { rough: 0.28, coat: 0.72 });
  const pale = absPlastic(accentColor, { rough: 0.3, coat: 0.68 });
  const attackMode = part?.key?.endsWith("#2") ?? false;
  const h = bitHeightForPart(part);
  const topZ = baseZ + h;
  const lobes = spec.shape === "operate" ? (attackMode ? 2 : 4) : 4;
  const outerR = spec.shape === "operate" ? mm(13.2) : mm(12.6);
  const control: RadiusRing[] = [
    { z: baseZ + mm(2.4), r: mm(3.2) },
    { z: baseZ + mm(5.1), r: mm(4.7) },
    { z: baseZ + mm(7.0), r: mm(8.7) },
    { z: topZ - mm(5.0), r: outerR * 0.84 },
    { z: topZ - mm(1.0), r: outerR },
    { z: topZ, r: outerR * 0.78 },
  ];
  const body = loftSolid(control, (theta, z, radius) => {
    const upper = smoothstep(topZ - mm(7), topZ - mm(3.5), z);
    const lobe = Math.pow(Math.max(0, Math.cos(theta * lobes)), spec.shape === "operate" ? 0.7 : 1.1);
    const gear = z < baseZ + mm(8) ? gearWave(theta, spec.gearTeeth) : 0;
    return radius * (1 - upper * 0.14 * (1 - lobe) + 0.075 * gear);
  });
  group.add(zoneMesh(body, hard, `zone:${spec.shape}-integrated-body`, "plastic"));

  if (spec.shape === "operate") {
    if (attackMode) {
      addFlatContact(group, baseZ, mm(3.8), mm(3.4), hard,
        "mode:operate-attack-hollow-flat", "plastic", true);
    } else {
      addSphereTip(group, mm(1.9), baseZ, hard, "mode:operate-defense-ball", "plastic", 0.82);
    }
    const selector = addTorus(group, mm(5.2), mm(0.65), baseZ + mm(7.5), pale,
      "mechanism:operate-mode-selector");
    selector.rotation.z = attackMode ? Math.PI / 4 : 0;
  } else {
    const deployed = !attackMode;
    if (deployed) {
      addNeedleContact(group, baseZ, mm(6.5), mm(1.5), hard,
        "mode:turbo-high-rpm-sharp");
    } else {
      addFlatContact(group, baseZ, mm(3.7), mm(2.8), hard,
        "mode:turbo-low-rpm-flat");
    }
    for (const side of [-1, 1]) {
      const slider = zoneMesh(
        new THREE.BoxGeometry(mm(4.8), mm(2.1), mm(2.0), 8, 4, 4),
        pale,
        "mechanism:turbo-centrifugal-slider",
        "plastic",
      );
      slider.position.set(side * (deployed ? mm(7.6) : mm(5.7)), 0, topZ - mm(4.4));
      group.add(slider);
    }
    for (let i = 0; i < 3; i++) {
      addTorus(group, mm(2.2), mm(0.18), baseZ + mm(5.2 + i * 0.55), pale,
        "mechanism:turbo-return-spring");
    }
  }
  group.userData.mode = attackMode ? "secondary" : "primary";
  return group;
}

function buildContactTip(
  group: THREE.Group,
  spec: BitModelSpec,
  baseZ: number,
  contactColor: number,
  plastic: THREE.Material,
): void {
  const h = spec.tipHeightM;
  const rubber = rubberMat(contactColor);
  const metal = paintedMetal(0xc5cad4, 0.25);

  switch (spec.shape) {
    case "flat":
      addFlatContact(group, baseZ, spec.gearTeeth === 16 ? mm(4.3) : mm(3.7), h,
        plastic, "tip:flat", "plastic", true);
      break;
    case "low-flat":
    case "under-flat":
      addFlatContact(group, baseZ, spec.shape === "under-flat" ? mm(3.45) : mm(4.0), h,
        plastic, `tip:${spec.shape}`);
      break;
    case "rush":
    case "low-rush":
    case "gear-rush":
    case "jolt":
      addFlatContact(group, baseZ, spec.shape === "jolt" ? mm(2.75) : mm(3.0), h,
        plastic, `tip:${spec.shape}`);
      break;
    case "free-flat":
      addFlatContact(group, baseZ, mm(3.25), h, plastic, "tip:free-flat", "plastic", true);
      break;
    case "gear-flat":
      addFlatContact(group, baseZ, mm(4.1), h, plastic, "tip:gear-flat", "plastic", true);
      break;
    case "rubber-accel":
      addFlatContact(group, baseZ, mm(4.35), h, rubber, "tip:rubber-accel", "rubber", true);
      break;
    case "ball":
      addSphereTip(group, mm(3.25), baseZ, plastic, "tip:ball", "plastic", 0.82);
      break;
    case "orb":
    case "low-orb":
      addSphereTip(group, spec.shape === "low-orb" ? mm(2.25) : mm(2.45), baseZ,
        plastic, `tip:${spec.shape}`, "plastic", 0.78);
      break;
    case "free-ball":
      addSphereTip(group, mm(2.25), baseZ, plastic, "tip:free-ball", "plastic", 0.8);
      break;
    case "glide":
      addSphereTip(group, mm(3.45), baseZ, plastic, "tip:glide-low-friction-ball", "plastic", 0.72);
      break;
    case "gear-ball":
      addSphereTip(group, mm(3.2), baseZ, plastic, "tip:gear-ball", "plastic", 0.82);
      break;
    case "narrow":
      addSphereTip(group, mm(1.75), baseZ, plastic, "tip:narrow", "plastic", 1.25);
      break;
    case "needle":
    case "high-needle":
    case "under-needle":
    case "gear-needle":
      addNeedleContact(group, baseZ, h, mm(1.65), plastic, `tip:${spec.shape}`);
      break;
    case "metal-needle":
      addNeedleContact(group, baseZ, h, mm(1.65), metal, "tip:metal-needle", "metal");
      break;
    case "spike":
      addNeedleContact(group, baseZ, h, mm(1.3), plastic, "tip:spike");
      break;
    case "bound-spike":
      addNeedleContact(group, baseZ, h * 0.82, mm(1.45), plastic, "tip:bound-spike");
      for (let i = 0; i < 3; i++) {
        addTorus(group, mm(1.8), mm(0.16), baseZ + h * 0.68 + i * mm(0.48), plastic,
          "mechanism:bound-spike-spring");
      }
      break;
    case "disk-spike":
      addNeedleContact(group, baseZ, h, mm(1.55), plastic, "tip:disk-spike");
      addTorus(group, mm(4.7), mm(0.75), baseZ + h * 0.82, plastic,
        "feature:disk-spike-stabilizer");
      break;
    case "disk-ball":
      addSphereTip(group, mm(3.0), baseZ, plastic, "tip:disk-ball", "plastic", 0.8);
      addTorus(group, mm(5.25), mm(0.72), baseZ + h * 0.86, plastic,
        "feature:disk-ball-stabilizer");
      break;
    case "point":
    case "gear-point":
    case "trans-point": {
      const ringR = spec.shape === "gear-point" ? mm(3.7) : mm(3.35);
      addFlatContact(group, baseZ + mm(0.5), ringR, h - mm(0.5), plastic,
        `tip:${spec.shape}:flat-annulus`);
      addSphereTip(group, mm(1.05), baseZ, plastic, `tip:${spec.shape}:center-ball`, "plastic", 0.72);
      break;
    }
    case "unite":
    case "gear-unite":
      addSphereTip(group, mm(3.05), baseZ, plastic, `tip:${spec.shape}:rounded-body`, "plastic", 0.72);
      addFlatContact(group, baseZ + mm(0.42), mm(2.75), mm(1.0), plastic,
        `tip:${spec.shape}:flat-underside`);
      addSphereTip(group, mm(0.55), baseZ + mm(0.48), plastic,
        `tip:${spec.shape}:shallow-center-nub`, "plastic", 0.55);
      break;
    case "taper":
    case "high-taper":
      group.add(zCylinder(mm(3.7), mm(1.25), h, baseZ + h / 2,
        plastic, `tip:${spec.shape}`));
      break;
    case "kick":
    case "trans-kick": {
      const kick = zCylinder(mm(3.45), mm(1.15), h, baseZ + h / 2 + mm(0.2),
        plastic, `tip:${spec.shape}`, "plastic", 10);
      kick.rotation.y = 0.16;
      group.add(kick);
      break;
    }
    case "quake": {
      const quake = zCylinder(mm(3.7), mm(3.2), h, baseZ + h / 2 + mm(0.45),
        plastic, "tip:quake-diagonal-cut", "plastic", 12);
      quake.rotation.y = 0.28;
      group.add(quake);
      break;
    }
    case "hexa":
      group.add(zCylinder(mm(3.55), mm(2.6), h, baseZ + h / 2,
        plastic, "tip:hexa-six-faces", "plastic", 6));
      break;
    case "cyclone":
      addSpiralFins(group, baseZ, mm(3.9), h, plastic, -1, "tip:cyclone-left-spiral");
      break;
    case "vortex":
      addSpiralFins(group, baseZ, mm(4.35), h, plastic, 1, "tip:vortex-right-spiral");
      break;
    case "dot":
      addSphereTip(group, mm(2.75), baseZ + mm(0.25), plastic, "tip:dot-rounded-core", "plastic", 0.68);
      for (let i = 0; i < 9; i++) {
        const angle = (i / 9) * TAU;
        const nub = addSphereTip(group, mm(0.42), baseZ, plastic, "tip:dot-contact-nub", "plastic", 0.7);
        nub.position.x = Math.cos(angle) * mm(1.75);
        nub.position.y = Math.sin(angle) * mm(1.75);
      }
      break;
    case "elevate":
      addFlatContact(group, baseZ, mm(3.35), mm(2.4), plastic, "tip:elevate-flat");
      addSphereTip(group, mm(0.75), baseZ, plastic, "tip:elevate-center-bump", "plastic", 0.7);
      addTorus(group, mm(5.45), mm(0.78), baseZ + h * 0.82, plastic,
        "feature:elevate-lift-disk");
      break;
    case "level":
      addFlatContact(group, baseZ, mm(2.55), mm(1.2), plastic, "tip:level-low-step");
      group.add(zCylinder(mm(3.35), mm(3.35), mm(1.1), baseZ + mm(1.72),
        plastic, "tip:level-mid-step"));
      group.add(zCylinder(mm(4.05), mm(4.05), mm(1.0), baseZ + mm(2.72),
        plastic, "tip:level-high-step"));
      break;
    case "ignition":
      addFlatContact(group, baseZ, mm(3.15), h, plastic, "tip:ignition-cylinder");
      for (let i = 0; i < 8; i++) {
        const angle = (i / 8) * TAU;
        const nub = zoneMesh(new THREE.BoxGeometry(mm(1.1), mm(0.75), h * 0.7, 3, 3, 4),
          plastic, "tip:ignition-perimeter-nub", "plastic");
        nub.rotation.z = angle;
        nub.position.set(Math.cos(angle) * mm(3.2), Math.sin(angle) * mm(3.2), baseZ + h * 0.55);
        group.add(nub);
      }
      break;
    case "wedge":
    case "wall-wedge":
      group.add(zCylinder(mm(2.45), mm(0.72), h, baseZ + h / 2,
        plastic, `tip:${spec.shape}`, "plastic", 20));
      if (spec.shape === "wall-wedge") addWall(group, baseZ, mm(4.5), h * 0.82, plastic, "feature:wall-wedge");
      break;
    case "wall-ball":
      addSphereTip(group, mm(2.75), baseZ, plastic, "tip:wall-ball", "plastic", 0.8);
      addWall(group, baseZ, mm(4.6), h * 0.82, plastic, "feature:wall-ball");
      break;
    case "merge":
      group.add(zCylinder(mm(3.5), mm(1.15), h, baseZ + h / 2,
        plastic, "tip:merge-hard-core", "plastic", 24));
      addTorus(group, mm(2.7), mm(1.05), baseZ + h * 0.52, rubber,
        "tip:merge-rubber-sleeve", "rubber");
      break;
    case "yielding":
      addSphereTip(group, mm(4.0), baseZ, plastic, "tip:yielding-large-ball", "plastic", 0.76);
      for (let i = 0; i < 4; i++) {
        const angle = (i / 4) * TAU;
        const wing = zoneMesh(new THREE.BoxGeometry(mm(4.2), mm(1.45), mm(1.5), 8, 4, 4),
          plastic, "feature:yielding-stabilizer-wing", "plastic");
        wing.rotation.z = angle;
        wing.position.set(Math.cos(angle) * mm(4.4), Math.sin(angle) * mm(4.4), baseZ + h * 0.78);
        group.add(wing);
      }
      break;
    case "zap":
      addFlatContact(group, baseZ + mm(0.32), mm(4.2), h - mm(0.32), plastic, "tip:zap-flat");
      addSphereTip(group, mm(0.9), baseZ, plastic, "tip:zap-center-point", "plastic", 0.7);
      break;
    default:
      addFlatContact(group, baseZ, mm(3.4), h, plastic, `tip:${spec.shape}`);
      break;
  }
}

export function buildBitModel(
  part: PartEntry | null | undefined,
  baseZ = 0,
  colorInput: PartColorInput = 0x315bc5,
): THREE.Group {
  const spec = bitSpec(part?.code ?? part?.group);
  const supplied = colorValues(colorInput);
  const referenceColors = referenceColorValues("bit", part);
  let [color, contactColor, mechanismColor] = palette(
    mergedColorValues("bit", part, colorInput),
  );
  if (spec.rubber) {
    contactColor = part?.variantColorOverride && supplied[1] !== undefined
      ? supplied[1]
      : (mostDistinctColor(color, referenceColors) ?? supplied[1] ?? contactColor);
  }
  const group = new THREE.Group();
  group.name = `bit:${spec.code || "invalid"}`;
  group.userData.bitSpec = spec;
  if (!spec.valid) return group;

  if (spec.integrated) {
    const integrated = buildIntegratedBit(part, spec, baseZ, colorInput);
    group.add(integrated);
    return group;
  }

  const plastic = absPlastic(color, { rough: 0.27, coat: 0.72 });
  const contactPlastic = absPlastic(contactColor, { rough: 0.27, coat: 0.72 });
  const h = spec.exposedHeightM;
  const topZ = baseZ + h;
  const tipJoin = baseZ + Math.max(mm(1.7), spec.tipHeightM * 0.62);
  const gearR = spec.gearTeeth >= 18 ? mm(9.6)
    : spec.gearTeeth >= 16 ? mm(9.35)
      : spec.gearTeeth <= 10 ? mm(8.25)
        : mm(8.85);
  const gearBandBottom = topZ - (spec.gearTeeth <= 10 ? mm(4.5) : mm(5.5));
  const sideProfile = lowerReference("bit", part)?.sideProfile;
  const referenceControl = sideProfile?.filter(([, y]) => baseZ + y * h >= tipJoin)
    .filter((_, index) => index % 4 === 0)
    .map(([radius, y]) => ({ z: baseZ + y * h, r: radius * gearR * 0.91 }));
  const bodyControl: RadiusRing[] = referenceControl && referenceControl.length >= 6
    ? [
        { z: tipJoin, r: referenceControl[0]!.r },
        ...referenceControl,
        { z: topZ, r: referenceControl.at(-1)!.r },
      ]
    : [
        { z: tipJoin, r: mm(2.45) },
        { z: Math.min(topZ - mm(6.4), tipJoin + mm(1.2)), r: mm(3.15) },
        { z: topZ - mm(5.45), r: gearR * 0.74 },
        { z: topZ - mm(4.65), r: gearR },
        { z: topZ - mm(1.15), r: gearR * 0.98 },
        { z: topZ, r: gearR * 0.69 },
      ];
  const body = loftSolid(bodyControl, (theta, z, radius) => {
    const band = smoothstep(gearBandBottom - mm(0.4), gearBandBottom + mm(0.3), z)
      * (1 - smoothstep(topZ - mm(0.3), topZ, z));
    return radius * (1 + band * 0.095 * gearWave(theta, spec.gearTeeth));
  });
  group.add(zoneMesh(body, plastic, "zone:bit-molded-body-and-gear", "plastic"));

  buildContactTip(group, spec, baseZ, contactColor, contactPlastic);
  addTipGearRibs(group, spec.gearTeeth, mm(3.6), baseZ + spec.tipHeightM * 0.56,
    Math.max(mm(1.8), spec.tipHeightM * 0.72), plastic, spec.gearExtended);

  if (spec.free) {
    addTorus(group, mm(3.3), mm(0.42), baseZ + spec.tipHeightM + mm(0.2),
      absPlastic(mechanismColor, { rough: 0.25, coat: 0.75 }),
      "mechanism:free-bearing-collar");
    group.add(zCylinder(mm(1.65), mm(1.65), mm(2.6), baseZ + spec.tipHeightM + mm(1.0),
      absPlastic(contactColor, { rough: 0.25, coat: 0.7 }), "mechanism:free-inner-shaft"));
  }
  if (spec.trans) {
    const collar = addTorus(group, mm(4.05), mm(0.55), topZ - mm(6.0),
      absPlastic(mechanismColor, { rough: 0.28, coat: 0.68 }), "mechanism:trans-height-collar");
    collar.rotation.z = part?.key?.endsWith("#2") ? Math.PI / 3 : 0;
  }

  return group;
}
