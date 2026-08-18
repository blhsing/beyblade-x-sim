import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { markBeyReflective } from "../src/render/rt";

function mesh(name: string, material: THREE.Material): THREE.Mesh {
  const result = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
  result.name = name;
  return result;
}

describe("Bey reflection masks", () => {
  it("does not double-light reference art, stickers, or the blur ring", () => {
    const root = new THREE.Group();
    const reference = mesh("upper:blade:DRANSWORD:reference-top", new THREE.MeshBasicMaterial());
    const sticker = mesh("upper:blade:DRANSWORD:fallback-sticker", new THREE.MeshPhysicalMaterial({
      metalness: 0.25,
      clearcoat: 1,
    }));
    const composite = mesh("upper:cx:composite-reference", new THREE.MeshBasicMaterial());
    const blur = mesh("blurRing", new THREE.MeshBasicMaterial());
    root.add(reference, sticker, composite, blur);

    markBeyReflective(root);

    expect(root.userData.rtReflect).toBe(0);
    for (const child of [reference, sticker, composite, blur]) {
      expect(child.userData.rtReflect).toBe(0);
    }
  });

  it("keeps restrained material-aware reflections on modeled surfaces", () => {
    const root = new THREE.Group();
    const bareMetal = mesh("upper:blade:body", new THREE.MeshPhysicalMaterial({ metalness: 1 }));
    const coatedMetal = mesh("zone:m85-metal-ring", new THREE.MeshPhysicalMaterial({ metalness: 0.55 }));
    const plastic = mesh("zone:ratchet-base", new THREE.MeshPhysicalMaterial({
      metalness: 0,
      clearcoat: 0.7,
    }));
    root.add(bareMetal, coatedMetal, plastic);

    markBeyReflective(root);

    expect(bareMetal.userData.rtReflect).toBe(0.38);
    expect(coatedMetal.userData.rtReflect).toBe(0.24);
    expect(plastic.userData.rtReflect).toBe(0.06);
    expect(bareMetal.userData.rtReflect).toBeLessThan(0.72);
  });
});
