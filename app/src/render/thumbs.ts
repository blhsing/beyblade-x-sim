// Offscreen thumbnail renders of beys and single parts (cached dataURLs)
// for the grid/swipe gallery pickers. Uses the same parametric mesh builders
// as the battle view, so what you pick is exactly what you get.

import * as THREE from "three";

import { deriveBeyParams, resolveCombo, type PartIndex } from "../core/derive";
import type { ComboSelection, PartEntry } from "../core/types";
import { preloadStickerImage } from "./materials";
import {
  bladeStickerUrl,
  buildBit,
  buildBlade,
  buildRatchet,
  COLOR_NAMES,
  lockChipStickerUrl,
  partRadiusM,
  ratchetSpec,
} from "./parts";
import { buildBeyMesh } from "./scene";
import {
  buildCatalogUpperPart,
  preloadUpperReference,
  preloadUpperReferences,
} from "./upper-parts";

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
let overheadCamera: THREE.OrthographicCamera | null = null;
const cache = new Map<string, string>();

const CATALOG_THUMB_SIZE = 224;
export const VERSUS_THUMB_SIZE = 448;
/** 62 mm square framing fits the widest 52.5 mm catalog Blade with margin. */
export const VERSUS_THUMB_HALF_FRAME_M = 0.031;
const VERSUS_CAPTURE_MIN_BUDGET_MS = 90;

function ensure(): boolean {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(CATALOG_THUMB_SIZE, CATALOG_THUMB_SIZE);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    scene = new THREE.Scene();
    scene.add(new THREE.AmbientLight(0xffffff, 0.75));
    const key = new THREE.DirectionalLight(0xfff4e4, 2.2);
    key.position.set(0.3, 0.5, 0.8);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xbfd0ff, 0.8);
    rim.position.set(-0.5, -0.2, 0.4);
    scene.add(rim);
    camera = new THREE.PerspectiveCamera(35, 1, 0.005, 5);
    camera.position.set(0, -0.075, 0.062);
    camera.lookAt(0, 0, 0.012);
    // A dedicated camera, but deliberately the same renderer/context. Versus
    // cards need a true overhead product view rather than enlarging the
    // gallery's three-quarter 224 px capture.
    overheadCamera = new THREE.OrthographicCamera(
      -VERSUS_THUMB_HALF_FRAME_M,
      VERSUS_THUMB_HALF_FRAME_M,
      VERSUS_THUMB_HALF_FRAME_M,
      -VERSUS_THUMB_HALF_FRAME_M,
      0.005,
      5,
    );
    overheadCamera.position.set(0, 0, 0.15);
    overheadCamera.lookAt(0, 0, 0.009);
    return true;
  } catch {
    return false;
  }
}

function snapshot(
  group: THREE.Group,
  options: { size?: number; overhead?: boolean } = {},
): string {
  const materials = new Set<THREE.Material>();
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (Array.isArray(m.material)) {
      for (const material of m.material) materials.add(material);
    } else if (m.material) {
      materials.add(m.material);
    }
  });
  // Catalog image textures are deliberately shared by the global texture
  // cache, but each thumbnail owns its materials/programs. Release those GPU
  // resources after capture so browsing the whole catalog stays bounded.
  const dispose = (): void => {
    group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    for (const material of materials) material.dispose();
  };
  if (!ensure()) {
    dispose();
    return "";
  }
  const size = options.size ?? CATALOG_THUMB_SIZE;
  try {
    renderer!.setSize(size, size, false);
    group.rotation.z = options.overhead ? 0.18 : 0.5;
    scene!.add(group);
    renderer!.render(scene!, options.overhead ? overheadCamera! : camera!);
    return renderer!.domElement.toDataURL("image/png");
  } finally {
    scene!.remove(group);
    // Leave the singleton at its normal catalog size for subsequent callers.
    if (size !== CATALOG_THUMB_SIZE) {
      renderer!.setSize(CATALOG_THUMB_SIZE, CATALOG_THUMB_SIZE, false);
    }
    dispose();
  }
}

/** Thumbnail of a full assembled combo. */
export async function comboThumb(index: PartIndex, sel: ComboSelection, key: string): Promise<string> {
  const selectionFingerprint = JSON.stringify(sel);
  const cacheKey = `c:${key}:${selectionFingerprint}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  try {
    const rc = resolveCombo(index, sel);
    await Promise.all([
      preloadStickerImage(
        rc.isCx ? lockChipStickerUrl(rc.parts.lockChip) : bladeStickerUrl(rc.parts.blade),
      ),
      preloadUpperReferences([
        rc.compositeBlade,
        rc.parts.blade,
        rc.parts.lockChip,
        rc.parts.mainBlade,
        rc.parts.assistBlade,
        rc.parts.metalBlade,
        rc.parts.overBlade,
      ]),
    ]);
    const url = snapshot(buildBeyMesh(rc, deriveBeyParams(rc), 0x5a70d6));
    cache.set(cacheKey, url);
    return url;
  } catch {
    return "";
  }
}

/** High-resolution, true overhead capture for the pre-match versus splash.
 * Reuses the catalog renderer/context and the same canonical mesh pipeline. */
export async function versusThumb(
  index: PartIndex,
  sel: ComboSelection,
  _key: string,
  options: { signal?: AbortSignal; deadlineMs?: number } = {},
): Promise<string> {
  const selectionFingerprint = JSON.stringify(sel);
  // Unlike gallery labels, the resolved selection fully identifies this
  // render. Setup prefetches and match startup must converge on one cache hit.
  const cacheKey = `v:${selectionFingerprint}`;
  const hit = cache.get(cacheKey);
  if (hit) return hit;
  try {
    const rc = resolveCombo(index, sel);
    await Promise.all([
      preloadStickerImage(
        rc.isCx ? lockChipStickerUrl(rc.parts.lockChip) : bladeStickerUrl(rc.parts.blade),
      ),
      preloadUpperReferences([
        rc.compositeBlade,
        rc.parts.blade,
        rc.parts.lockChip,
        rc.parts.mainBlade,
        rc.parts.assistBlade,
        rc.parts.metalBlade,
        rc.parts.overBlade,
      ]),
    ]);
    // Another setup/gallery prefetch may have completed while references were
    // loading. Reuse it instead of issuing a duplicate 448 px capture.
    const warmed = cache.get(cacheKey);
    if (warmed) return warmed;
    // Upper-part reference loading can outlive the intro's fast preparation
    // slot. This check only avoids STARTING a capture after its budget is too
    // low; once build/render starts it is synchronous and is not preemptible.
    // The caller follows a miss with an uncapped, abort-aware real-image retry.
    const remainingMs = options.deadlineMs === undefined
      ? Number.POSITIVE_INFINITY
      : options.deadlineMs - performance.now();
    if (options.signal?.aborted || remainingMs < VERSUS_CAPTURE_MIN_BUDGET_MS) return "";
    const url = snapshot(
      buildBeyMesh(rc, deriveBeyParams(rc), 0x5a70d6),
      { size: VERSUS_THUMB_SIZE, overhead: true },
    );
    cache.set(cacheKey, url);
    return url;
  } catch {
    return "";
  }
}

const PART_TYPE_COLORS: Record<string, number> = {
  attack: 0xc23c3c,
  defense: 0x3c66c2,
  stamina: 0x3cb26a,
  balance: 0xc2a23c,
};

/** Thumbnail of one part alone. */
export async function partThumb(entry: PartEntry): Promise<string> {
  const hit = cache.get("p:" + entry.category + ":" + entry.key);
  if (hit) return hit;
  const g = new THREE.Group();
  const color = COLOR_NAMES[entry.color?.toLowerCase() ?? ""]
    ?? (entry.type ? PART_TYPE_COLORS[entry.type]! : 0x9aa4c8);
  switch (entry.category) {
    case "blade":
    case "mainBlade":
    case "assistBlade":
    case "metalBlade":
    case "overBlade":
    case "lockChip": {
      await preloadUpperReference(entry);
      const fallbackR = entry.category === "lockChip" ? 0.012 : 0.024;
      g.add(buildCatalogUpperPart(entry, color, partRadiusM(entry, fallbackR)));
      break;
    }
    case "ratchet": {
      const { heightM } = ratchetSpec(entry.code);
      g.add(buildRatchet(entry, heightM));
      break;
    }
    case "bit": {
      g.add(buildBit(entry));
      break;
    }
  }
  const url = snapshot(g);
  cache.set("p:" + entry.category + ":" + entry.key, url);
  return url;
}
