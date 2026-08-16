// Physically-based material library + procedural texture generation.
//
// Nothing here loads an external asset: every map is drawn into a canvas at
// runtime (docs/DATA.md — third-party Beyblade imagery is licensed to its
// source site and must never be bundled). What makes the result read as real
// is not resolution but the *microstructure*: injection-moulded plastic has
// orange peel, die-cast zinc has circular tooling marks, POM is milky and
// translucent, rubber is matte with fine pores. Those are the maps below.
//
// Reference for which material belongs to which part: docs/MODELING.md §1.4.

import * as THREE from "three";

const texCache = new Map<string, THREE.Texture>();

function cached(key: string, make: () => THREE.Texture): THREE.Texture {
  let t = texCache.get(key);
  if (!t) {
    t = make();
    texCache.set(key, t);
  }
  return t;
}

function canvas(size: number, draw: (c: CanvasRenderingContext2D, s: number) => void): HTMLCanvasElement {
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  draw(cv.getContext("2d")!, size);
  return cv;
}

function texture(cv: HTMLCanvasElement, opts: { srgb?: boolean; repeat?: number } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv);
  if (opts.srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (opts.repeat) t.repeat.set(opts.repeat, opts.repeat);
  return t;
}

/** Height field → tangent-space normal map (Sobel), the honest way to get
 * surface microstructure without shipping textures. */
function heightToNormal(height: HTMLCanvasElement, strength = 2.4): HTMLCanvasElement {
  const s = height.width;
  const src = height.getContext("2d")!.getImageData(0, 0, s, s).data;
  const at = (x: number, y: number): number => {
    const xi = ((x % s) + s) % s;
    const yi = ((y % s) + s) % s;
    return src[(yi * s + xi) * 4]! / 255;
  };
  return canvas(s, (c) => {
    const out = c.createImageData(s, s);
    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const dx =
          at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1) -
          (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1));
        const dy =
          at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1) -
          (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1));
        const nx = dx * strength;
        const ny = dy * strength;
        const len = Math.hypot(nx, ny, 1);
        const i = (y * s + x) * 4;
        out.data[i] = ((nx / len) * 0.5 + 0.5) * 255;
        out.data[i + 1] = ((ny / len) * 0.5 + 0.5) * 255;
        out.data[i + 2] = ((1 / len) * 0.5 + 0.5) * 255;
        out.data[i + 3] = 255;
      }
    }
    c.putImageData(out, 0, 0);
  });
}

function valueNoise(c: CanvasRenderingContext2D, s: number, cells: number, alpha: number): void {
  const step = s / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      const v = Math.floor(110 + Math.random() * 90);
      c.fillStyle = `rgba(${v},${v},${v},${alpha})`;
      c.fillRect(x * step, y * step, step + 1, step + 1);
    }
  }
}

// ---- microstructure maps ---------------------------------------------------

/** Injection-moulded ABS: shallow "orange peel" ripple + faint flow lines. */
export function orangePeelNormal(): THREE.Texture {
  return cached("orangePeel", () => {
    const h = canvas(256, (c, s) => {
      c.fillStyle = "#808080";
      c.fillRect(0, 0, s, s);
      c.filter = "blur(3px)";
      valueNoise(c, s, 48, 0.5);
      c.filter = "blur(9px)";
      valueNoise(c, s, 12, 0.35);
      c.filter = "none";
      c.globalAlpha = 0.16; // mould flow lines
      c.strokeStyle = "#b8b8b8";
      for (let i = 0; i < 14; i++) {
        c.beginPath();
        const y = Math.random() * s;
        c.moveTo(0, y);
        c.bezierCurveTo(s * 0.3, y + 14, s * 0.7, y - 14, s, y + 6);
        c.stroke();
      }
      c.globalAlpha = 1;
    });
    return texture(heightToNormal(h, 1.1), { repeat: 3 });
  });
}

/** Die-cast / machined metal: concentric tooling arcs (spun on a lathe). */
export function spunMetalNormal(): THREE.Texture {
  return cached("spunMetal", () => {
    const h = canvas(512, (c, s) => {
      c.fillStyle = "#808080";
      c.fillRect(0, 0, s, s);
      for (let i = 0; i < 1400; i++) {
        const r = Math.random() * s * 0.72;
        const a0 = Math.random() * Math.PI * 2;
        c.globalAlpha = 0.05 + Math.random() * 0.1;
        c.strokeStyle = Math.random() > 0.5 ? "#ffffff" : "#2a2a2a";
        c.lineWidth = 0.6 + Math.random() * 0.9;
        c.beginPath();
        c.arc(s / 2, s / 2, r, a0, a0 + 0.25 + Math.random() * 1.1);
        c.stroke();
      }
      c.globalAlpha = 1;
    });
    return texture(heightToNormal(h, 1.7));
  });
}

/** Casting/impact scuffs, used as a roughness map so wear catches the light. */
export function wearRoughness(base: number, amount = 0.28): THREE.Texture {
  return cached(`wear${base}${amount}`, () => {
    const b = Math.round(base * 255);
    return texture(
      canvas(256, (c, s) => {
        c.fillStyle = `rgb(${b},${b},${b})`;
        c.fillRect(0, 0, s, s);
        const up = Math.round(Math.min(255, base * 255 + amount * 255));
        c.strokeStyle = `rgb(${up},${up},${up})`;
        for (let i = 0; i < 260; i++) {
          c.globalAlpha = 0.15 + Math.random() * 0.5;
          c.lineWidth = 0.5 + Math.random() * 1.6;
          const x = Math.random() * s;
          const y = Math.random() * s;
          const a = Math.random() * Math.PI * 2;
          const l = 3 + Math.random() * 26;
          c.beginPath();
          c.moveTo(x, y);
          c.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
          c.stroke();
        }
        c.globalAlpha = 1;
      }),
    );
  });
}

/** Rubber: fine pores/matte grain. */
export function rubberNormal(): THREE.Texture {
  return cached("rubber", () => {
    const h = canvas(256, (c, s) => {
      c.fillStyle = "#808080";
      c.fillRect(0, 0, s, s);
      for (let i = 0; i < 5200; i++) {
        const v = Math.random() > 0.5 ? 190 : 60;
        c.fillStyle = `rgba(${v},${v},${v},0.5)`;
        const rr = 0.6 + Math.random() * 1.5;
        c.beginPath();
        c.arc(Math.random() * s, Math.random() * s, rr, 0, Math.PI * 2);
        c.fill();
      }
    });
    return texture(heightToNormal(h, 1.3), { repeat: 4 });
  });
}

/** Skin: pores + fine creases (hands). */
export function skinNormal(): THREE.Texture {
  return cached("skin", () => {
    const h = canvas(256, (c, s) => {
      c.fillStyle = "#808080";
      c.fillRect(0, 0, s, s);
      for (let i = 0; i < 4200; i++) {
        c.fillStyle = `rgba(70,70,70,${0.18 + Math.random() * 0.3})`;
        c.beginPath();
        c.arc(Math.random() * s, Math.random() * s, 0.5 + Math.random() * 1.1, 0, Math.PI * 2);
        c.fill();
      }
      c.strokeStyle = "rgba(60,60,60,0.35)"; // criss-cross creases
      c.lineWidth = 0.7;
      for (let i = 0; i < 120; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const a = Math.random() * Math.PI;
        c.beginPath();
        c.moveTo(x, y);
        c.lineTo(x + Math.cos(a) * 20, y + Math.sin(a) * 20);
        c.stroke();
      }
    });
    return texture(heightToNormal(h, 0.9), { repeat: 6 });
  });
}

/** Table surface the stadium sits on (matters for the anchored AR view). */
export function tableMaps(): { map: THREE.Texture; normalMap: THREE.Texture } {
  const key = "table";
  const map = cached(key + "c", () =>
    texture(
      canvas(512, (c, s) => {
        c.fillStyle = "#8a6440";
        c.fillRect(0, 0, s, s);
        for (let y = 0; y < s; y += 2) {
          const w = 0.5 + 0.5 * Math.sin(y * 0.11) + 0.3 * Math.sin(y * 0.037 + 2);
          c.globalAlpha = 0.1 + 0.1 * w;
          c.fillStyle = y % 64 < 3 ? "#5d4127" : "#7a5636";
          c.fillRect(0, y, s, 2);
        }
        c.globalAlpha = 0.12;
        c.strokeStyle = "#4c3520";
        for (let i = 0; i < 40; i++) {
          const y0 = Math.random() * s;
          c.beginPath();
          c.moveTo(0, y0);
          c.bezierCurveTo(s * 0.3, y0 + 8, s * 0.7, y0 - 8, s, y0 + 4);
          c.stroke();
        }
        c.globalAlpha = 1;
      }),
      { srgb: true, repeat: 3 },
    ),
  );
  const normalMap = cached(key + "n", () => {
    const h = canvas(256, (c, s) => {
      c.fillStyle = "#808080";
      c.fillRect(0, 0, s, s);
      c.globalAlpha = 0.5;
      for (let y = 0; y < s; y += 1) {
        const v = 128 + Math.sin(y * 0.35) * 22 + (Math.random() - 0.5) * 26;
        c.fillStyle = `rgb(${v | 0},${v | 0},${v | 0})`;
        c.fillRect(0, y, s, 1);
      }
      c.globalAlpha = 1;
    });
    return texture(heightToNormal(h, 0.7), { repeat: 3 });
  });
  return { map, normalMap };
}

// ---- material factories ----------------------------------------------------

const NORMAL_SCALE = (x: number): THREE.Vector2 => new THREE.Vector2(x, x);

/** Bare die-cast zinc (blade uppers). Anisotropic — the spun tooling marks
 * stretch the highlight tangentially, which is the giveaway of real metal. */
export function diecastMetal(color: number, opts: { rough?: number; aniso?: number } = {}): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 1,
    roughness: opts.rough ?? 0.31,
    normalMap: spunMetalNormal(),
    normalScale: NORMAL_SCALE(0.55),
    roughnessMap: wearRoughness(opts.rough ?? 0.31, 0.3),
    envMapIntensity: 1.15,
  });
  m.anisotropy = opts.aniso ?? 0.75;
  return m;
}

/** Painted/coated metal: pigment under a clearcoat lacquer. */
export function paintedMetal(color: number, rough = 0.34): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0.55,
    roughness: rough,
    normalMap: spunMetalNormal(),
    normalScale: NORMAL_SCALE(0.3),
    clearcoat: 0.85,
    clearcoatRoughness: 0.14,
    envMapIntensity: 1.0,
  });
  m.anisotropy = 0.35;
  return m;
}

/** Injection-moulded ABS (blade cores, stadium body, launcher shells). */
export function absPlastic(color: number, opts: { rough?: number; coat?: number } = {}): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: opts.rough ?? 0.42,
    normalMap: orangePeelNormal(),
    normalScale: NORMAL_SCALE(0.35),
    clearcoat: opts.coat ?? 0.45,
    clearcoatRoughness: 0.22,
    envMapIntensity: 0.85,
  });
}

/** Translucent glass-filled POM/nylon — ratchets and some bits. Milky, so
 * a little transmission plus scatter rather than plain alpha. */
export function pomTranslucent(color = 0xf4f4fa): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.28,
    transmission: 0.5,
    thickness: 0.004,
    attenuationDistance: 0.02,
    attenuationColor: new THREE.Color(0xdfe4f5),
    ior: 1.46,
    clearcoat: 0.7,
    clearcoatRoughness: 0.12,
    normalMap: orangePeelNormal(),
    normalScale: NORMAL_SCALE(0.18),
  });
}

/** Clear polycarbonate — stadium casing panels. */
export function clearPanel(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xeaf2ff,
    metalness: 0,
    roughness: 0.06,
    transmission: 0.92,
    thickness: 0.0016,
    ior: 1.585, // polycarbonate
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    transparent: true,
    opacity: 0.42,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
}

/** Bit rubber: matte, grippy, slightly soft-looking. */
export function rubberMat(color = 0x8c1f1f): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    metalness: 0,
    roughness: 0.92,
    sheen: 0.35,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0x552222),
    normalMap: rubberNormal(),
    normalScale: NORMAL_SCALE(0.6),
    envMapIntensity: 0.35,
  });
}

/** Hand skin: subsurface-ish warmth instead of flat diffuse. */
export function skinMat(tone = 0xe2ab86): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: tone,
    metalness: 0,
    roughness: 0.62,
    sheen: 0.5,
    sheenColor: new THREE.Color(0xff9a76),
    sheenRoughness: 0.7,
    clearcoat: 0.12,
    clearcoatRoughness: 0.6,
    normalMap: skinNormal(),
    normalScale: NORMAL_SCALE(0.4),
    envMapIntensity: 0.7,
  });
}

/**
 * Procedural photo-studio environment for image-based lighting: a dark room
 * with a large key softbox, a cooler rim softbox and an overhead strip, plus
 * a warm bounce floor. PMREM-convolved into the scene probe, this is what
 * gives metal its gradient falloff instead of a flat tint.
 */
export function studioEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const env = new THREE.Scene();
  env.background = new THREE.Color(0x0d1018);

  const panel = (
    w: number,
    h: number,
    color: number,
    intensity: number,
    pos: [number, number, number],
    look: [number, number, number] = [0, 0, 0],
  ): void => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(intensity) }),
    );
    m.position.set(...pos);
    m.lookAt(...look);
    env.add(m);
  };

  panel(9, 6, 0xfff1e0, 5.2, [6, 4, 5]);      // key softbox, warm
  panel(7, 7, 0xcfe0ff, 2.1, [-7, 2.5, 3]);   // fill, cool
  panel(12, 3, 0xffffff, 3.0, [0, 9, 0], [0, 0, 0]); // overhead strip
  panel(10, 10, 0x30251c, 0.9, [0, -6, 0], [0, 1, 0]); // warm floor bounce
  panel(9, 5, 0xa8b8e0, 0.8, [0, 2, -8]);     // back rim

  const pmrem = new THREE.PMREMGenerator(renderer);
  const tex = pmrem.fromScene(env, 0.02).texture;
  pmrem.dispose();
  env.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      o.geometry.dispose();
      (o.material as THREE.Material).dispose();
    }
  });
  return tex;
}
