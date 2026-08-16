// Offscreen thumbnail renders of beys and single parts (cached dataURLs)
// for the swipeable gallery pickers. Uses the same parametric mesh builders
// as the battle view, so what you pick is exactly what you get.

import * as THREE from "three";

import { deriveBeyParams, resolveCombo, type PartIndex } from "../core/derive";
import type { ComboSelection, PartEntry } from "../core/types";
import { buildBeyMesh, lobedShape } from "./scene";

let renderer: THREE.WebGLRenderer | null = null;
let scene: THREE.Scene | null = null;
let camera: THREE.PerspectiveCamera | null = null;
const cache = new Map<string, string>();

function ensure(): boolean {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(224, 224);
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
    return true;
  } catch {
    return false;
  }
}

function snapshot(group: THREE.Group): string {
  if (!ensure()) return "";
  group.rotation.z = 0.5;
  scene!.add(group);
  renderer!.render(scene!, camera!);
  const url = renderer!.domElement.toDataURL("image/png");
  scene!.remove(group);
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
  return url;
}

/** Thumbnail of a full assembled combo. */
export function comboThumb(index: PartIndex, sel: ComboSelection, key: string): string {
  const hit = cache.get("c:" + key);
  if (hit) return hit;
  try {
    const rc = resolveCombo(index, sel);
    const url = snapshot(buildBeyMesh(rc, deriveBeyParams(rc), 0x5a70d6));
    cache.set("c:" + key, url);
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
export function partThumb(entry: PartEntry): string {
  const hit = cache.get("p:" + entry.category + ":" + entry.key);
  if (hit) return hit;
  const g = new THREE.Group();
  const color = entry.type ? PART_TYPE_COLORS[entry.type]! : 0x9aa4c8;
  const metal = new THREE.MeshStandardMaterial({ color, metalness: 0.85, roughness: 0.3 });
  const plastic = new THREE.MeshStandardMaterial({
    color: 0xf0f0f8,
    roughness: 0.35,
    transparent: true,
    opacity: 0.9,
  });
  switch (entry.category) {
    case "blade":
    case "mainBlade":
    case "metalBlade":
    case "overBlade": {
      const mesh = new THREE.Mesh(
        new THREE.ExtrudeGeometry(lobedShape(0.024, 6 + (entry.stats.attack % 5), 0.09, 1.3), {
          depth: 0.007,
          bevelEnabled: true,
          bevelSize: 0.0007,
          bevelThickness: 0.0007,
        }),
        metal,
      );
      g.add(mesh);
      break;
    }
    case "assistBlade": {
      g.add(new THREE.Mesh(new THREE.ExtrudeGeometry(lobedShape(0.02, 8, 0.06, 1.1), { depth: 0.005, bevelEnabled: false }), plastic));
      break;
    }
    case "ratchet": {
      const lobes = Number.parseInt(entry.code, 10) || 5;
      g.add(new THREE.Mesh(new THREE.ExtrudeGeometry(lobedShape(0.018, lobes, 0.16, 1.2), { depth: Math.max(0.004, entry.stats.height / 9000), bevelEnabled: false }), plastic));
      break;
    }
    case "bit": {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.009, 0.01, 18), plastic);
      base.rotation.x = Math.PI / 2;
      base.position.z = 0.008;
      g.add(base);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.004, 0.007, 12), new THREE.MeshStandardMaterial({ color: 0x2a2a32 }));
      tip.rotation.x = -Math.PI / 2;
      tip.position.z = 0.0015;
      g.add(tip);
      break;
    }
    case "lockChip": {
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.004, 20), metal));
      g.children[0]!.rotation.x = Math.PI / 2;
      break;
    }
  }
  const url = snapshot(g);
  cache.set("p:" + entry.category + ":" + entry.key, url);
  return url;
}
