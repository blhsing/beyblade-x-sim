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
const imageLoads = new Map<string, Promise<THREE.Texture>>();

/** Resolve public assets relative to the page, including virtual-app paths
 * such as production's `/beyblade/`. Leading slashes in generated manifests
 * are treated as app-relative rather than origin-relative for compatibility
 * with older manifests. */
export function publicAssetUrl(url: string, baseUri = document.baseURI): string {
  return new URL(url.replace(/^\/+/, ""), baseUri).href;
}

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

/**
 * A catalog-sourced sticker image. TextureLoader returns its Texture
 * immediately so live scenes can start rendering while the browser decodes
 * it; `preloadStickerImage` exposes the same cached load to thumbnail code,
 * which must wait before taking its one-frame canvas snapshot.
 */
export function stickerImageTexture(url: string): THREE.Texture {
  const resolvedUrl = publicAssetUrl(url);
  const key = `sticker-image:${resolvedUrl}`;
  let t = texCache.get(key);
  if (!t) {
    t = new THREE.Texture();
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    texCache.set(key, t);
    const target = t;
    const pending = new Promise<THREE.Texture>((resolve) => {
      new THREE.ImageLoader().load(
        resolvedUrl,
        (image) => {
          target.image = image;
          target.needsUpdate = true;
          resolve(target);
        },
        undefined,
        () => {
          // A missing/deferred network asset must never suppress the entire
          // Bey mesh or permanently blank a cached gallery thumbnail.
          const fallback = document.createElement("canvas");
          fallback.width = fallback.height = 1;
          const context = fallback.getContext("2d")!;
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, 1, 1);
          target.image = fallback;
          target.needsUpdate = true;
          resolve(target);
        },
      );
    });
    imageLoads.set(resolvedUrl, pending);
  }
  return t;
}

/** Wait until an image-backed sticker is decoded and ready for a snapshot. */
export function preloadStickerImage(url: string | null | undefined): Promise<THREE.Texture | null> {
  if (!url) return Promise.resolve(null);
  const t = stickerImageTexture(url);
  return imageLoads.get(publicAssetUrl(url)) ?? Promise.resolve(t);
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

export type BeastKind = "dragon" | "phoenix" | "lion" | "serpent" | "shark" | "knight" | "reaper";

/** Pick the creature from the blade's name — the names say it outright. */
export function beastOf(name: string): BeastKind {
  const n = name.toUpperCase();
  if (/DRAN|DRAGON|DRAGOON|DRAKE|WYVERN/.test(n)) return "dragon";
  if (/PHOENIX|GARUDA|WING|PEGASIS|VALKYRIE|BIRD/.test(n)) return "phoenix";
  if (/LEON|LION|TIGER|BEAR|WOLF|RHINO|CLAW/.test(n)) return "lion";
  if (/VIPER|SNAKE|SERPENT|CROC|WHALE|SHARK.?TAIL/.test(n)) return "serpent";
  if (/SHARK|EDGE|FIN/.test(n)) return "shark";
  if (/HELLS|SCYTHE|CHAIN|DARK|SHADOW|REAPER/.test(n)) return "reaper";
  return "knight"; // KnightShield/Lance, WizardArrow, SamuraiCalibur…
}

/**
 * Beast marks, drawn in a 100-unit space centred on the sticker. These are
 * heraldic silhouettes — a head-on creature the way the real stickers show
 * one — not abstract polygons.
 */
function drawBeast(c: CanvasRenderingContext2D, kind: BeastKind, seed: number): void {
  const p = (pts: [number, number][], close = true): void => {
    c.beginPath();
    c.moveTo(pts[0]![0], pts[0]![1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i]![0], pts[i]![1]);
    if (close) c.closePath();
    c.fill();
    c.stroke();
  };
  const eye = (x: number, y: number, r: number, tilt: number): void => {
    c.save();
    c.translate(x, y);
    c.rotate(tilt);
    c.beginPath();
    c.ellipse(0, 0, r, r * 0.55, 0, 0, Math.PI * 2);
    c.fillStyle = "#c8202a";
    c.fill();
    c.strokeStyle = "#0d1018";
    c.lineWidth = 3;
    c.stroke();
    c.restore();
  };
  const foil = c.fillStyle;

  switch (kind) {
    case "dragon":
      // horned head with a long snout and swept back-horns
      p([[0, -62], [22, -40], [30, -10], [46, 4], [24, 12], [16, 34],
         [0, 22], [-16, 34], [-24, 12], [-46, 4], [-30, -10], [-22, -40]]);
      p([[0, -46], [40, -70], [26, -34]]); // right horn
      p([[0, -46], [-40, -70], [-26, -34]]); // left horn
      p([[0, 10], [14, 40], [0, 58], [-14, 40]]); // jaw
      eye(-15, -14, 9, -0.35);
      eye(15, -14, 9, 0.35);
      break;
    case "phoenix":
      // wings spread from a crested head
      p([[0, -58], [12, -28], [58, -44], [80, -6], [30, 4], [10, 30],
         [0, 46], [-10, 30], [-30, 4], [-80, -6], [-58, -44], [-12, -28]]);
      p([[0, -58], [10, -84], [0, -70], [-10, -84]]); // crest
      eye(-12, -20, 8, -0.5);
      eye(12, -20, 8, 0.5);
      break;
    case "lion":
      // maned head: radiating mane spikes around a broad muzzle
      c.beginPath();
      for (let i = 0; i < 14; i++) {
        const a = (i / 14) * Math.PI * 2;
        const rr = i % 2 ? 44 : 74;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr * 0.94;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.closePath();
      c.fill();
      c.stroke();
      p([[0, 6], [22, 18], [14, 40], [0, 32], [-14, 40], [-22, 18]]);
      eye(-18, -14, 9, 0);
      eye(18, -14, 9, 0);
      break;
    case "serpent":
      // coiled snake with a wedge head
      c.beginPath();
      for (let i = 0; i <= 90; i++) {
        const t = i / 90;
        const a = t * Math.PI * 3.1;
        const rr = 74 - t * 52;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr * 0.92;
        if (i === 0) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
      c.lineWidth = 17;
      c.strokeStyle = foil as string;
      c.stroke();
      c.lineWidth = 5;
      c.strokeStyle = "#0d1018";
      c.stroke();
      p([[62, -30], [92, -10], [62, 8], [52, -12]]); // head
      eye(70, -12, 6, 0);
      break;
    case "shark":
      // side-on shark with dorsal fin and tail
      p([[-78, 4], [-34, -26], [18, -22], [58, -2], [86, -22], [76, 6],
         [86, 30], [56, 12], [16, 22], [-30, 24]]);
      p([[6, -22], [22, -60], [40, -18]]); // dorsal
      p([[-10, 20], [-6, 46], [-34, 24]]); // pelvic
      eye(-46, -6, 7, 0);
      break;
    case "reaper":
      // hooded skull with a scythe blade sweeping behind
      p([[0, -66], [34, -40], [36, 2], [18, 34], [0, 44], [-18, 34],
         [-36, 2], [-34, -40]]);
      c.beginPath();
      c.arc(0, -6, 26, Math.PI * 0.06, Math.PI * 0.94);
      c.lineWidth = 12;
      c.strokeStyle = "#0d1018";
      c.stroke();
      c.lineWidth = 5;
      eye(-13, -16, 8, 0.2);
      eye(13, -16, 8, -0.2);
      break;
    default:
      // knight: crested helm with a visor slit and shoulder wings
      p([[0, -64], [30, -44], [36, -4], [26, 32], [0, 44], [-26, 32],
         [-36, -4], [-30, -44]]);
      p([[0, -64], [8, -92], [0, -78], [-8, -92]]); // plume
      c.fillStyle = "#0d1018";
      c.fillRect(-26, -22, 52, 13); // visor slit
      c.fillStyle = foil as string;
      p([[-36, -6], [-64, 6 + seed * 6], [-34, 16]]);
      p([[36, -6], [64, 6 + seed * 6], [34, 16]]);
      break;
  }
  c.fillStyle = foil as string;
}

/**
 * The printed sticker every Beyblade X blade carries on its crown. Real
 * blades are moulded colour plastic with a glossy die-cut sticker over the
 * centre showing the beast emblem, so this draws one: a metallic-ink ring,
 * radial "energy" wedges, a stylised beast glyph built from the part's own
 * seed (so each blade gets its own recognisable mark), and the part code.
 */
export function stickerTexture(opts: {
  key: string;
  label: string;
  base: number;
  accent: number;
  seed: number;
}): THREE.Texture {
  return cached(`sticker:${opts.key}:${opts.base}:${opts.accent}`, () => {
    const S = 512;
    const hex = (c: number): string => `#${c.toString(16).padStart(6, "0")}`;
    const cv = canvas(S, (c) => {
      const R = S / 2;
      c.clearRect(0, 0, S, S);
      // die-cut disc
      c.save();
      c.beginPath();
      c.arc(R, R, R * 0.98, 0, Math.PI * 2);
      c.clip();

      const g = c.createRadialGradient(R * 0.8, R * 0.7, R * 0.1, R, R, R);
      g.addColorStop(0, hex(opts.base));
      g.addColorStop(0.65, hex(opts.base));
      g.addColorStop(1, "#0d0f16");
      c.fillStyle = g;
      c.fillRect(0, 0, S, S);

      // radial energy wedges in the accent colour
      const wedges = 6 + Math.floor(opts.seed * 6);
      c.fillStyle = hex(opts.accent);
      c.globalAlpha = 0.55;
      for (let i = 0; i < wedges; i++) {
        const a = (i / wedges) * Math.PI * 2 + opts.seed * 2;
        c.beginPath();
        c.moveTo(R, R);
        c.arc(R, R, R * 0.96, a, a + Math.PI / wedges);
        c.closePath();
        c.fill();
      }
      c.globalAlpha = 1;

      // THE BEAST. Every Beyblade X blade is named after its creature
      // (DranSword = dragon, PhoenixWing = phoenix, LeonClaw = lion…), and
      // that creature is the whole point of the sticker art, so draw it.
      const foil = c.createLinearGradient(0, S * 0.2, S, S * 0.9);
      foil.addColorStop(0, "#ffffff");
      foil.addColorStop(0.45, "#e6ecfa");
      foil.addColorStop(0.7, "#9aa6c4");
      foil.addColorStop(1, "#ffffff");
      c.save();
      c.translate(R, R * 1.02);
      c.scale(R / 100, R / 100); // draw in a 100-unit beast space
      c.fillStyle = foil;
      c.strokeStyle = "#0d1018";
      c.lineWidth = 5;
      c.lineJoin = "round";
      drawBeast(c, beastOf(opts.key + opts.label), opts.seed);
      c.restore();

      // part name around the bottom of the disc
      c.fillStyle = "#f2f4ff";
      c.font = `700 ${Math.round(S * 0.072)}px sans-serif`;
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(opts.label.slice(0, 14).toUpperCase(), R, R * 1.68);

      // rim ink + a faint gloss sweep across the laminate
      c.beginPath();
      c.arc(R, R, R * 0.93, 0, Math.PI * 2);
      c.lineWidth = S * 0.03;
      c.strokeStyle = "#0d0f16";
      c.stroke();
      const gloss = c.createLinearGradient(0, 0, S * 0.8, S);
      gloss.addColorStop(0, "rgba(255,255,255,0.34)");
      gloss.addColorStop(0.45, "rgba(255,255,255,0.04)");
      gloss.addColorStop(1, "rgba(255,255,255,0)");
      c.fillStyle = gloss;
      c.fillRect(0, 0, S, S);
      c.restore();
    });
    const t = texture(cv, { srgb: true });
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Glossy laminated sticker over moulded plastic. */
export function stickerMaterial(map: THREE.Texture): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    map,
    transparent: true,
    metalness: 0.25,
    roughness: 0.18,
    clearcoat: 1,
    clearcoatRoughness: 0.05,
    envMapIntensity: 1.1,
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
