#!/usr/bin/env node
// Normalizes phstudy raw JSON (data/raw/) into the game parts DB
// (app/public/data/parts.json). See docs/DATA.md.
//
// - TAKARA TOMY records only (main.json + hardcoded.json), invalid rows dropped
// - one entry per mechanically distinct part; colorways with identical stats
//   are merged as `variants`, colorways with DIFFERENT official stats (e.g.
//   金屬塗層 metal-coat upgrades) become separate entries sharing `group`
// - canonical zh-TW/en/ja names; measured weight/diameter merged per version
//
// Usage: node tools/normalize-parts.mjs

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rawDir = join(root, "data", "raw");
const outFile = join(root, "app", "public", "data", "parts.json");

const COLLECTIONS = {
  BeybladePartsBlade: "blade",
  BeybladePartsRatchet: "ratchet",
  BeybladePartsBit: "bit",
  BeybladePartsLockChip: "lockChip",
  BeybladePartsMainBlade: "mainBlade",
  BeybladePartsAssistBlade: "assistBlade",
  BeybladePartsMetalBlade: "metalBlade",
  BeybladePartsOverBlade: "overBlade",
};
const CODE_NAME_KEYS = { bit: "Bit", assistBlade: "AssistBlade", overBlade: "OverBlade" };
const BIT_FAMILIES = Object.fromEntries([
  [["A", "C", "F", "FF", "GF", "GR", "I", "J", "L", "LF", "LR", "R", "UF", "V"], "flat"],
  [["B", "D", "DB", "FB", "G", "GB", "LO", "Nr", "O", "WB", "Y"], "ball"],
  [["GN", "HN", "MN", "N", "UN"], "needle"],
  [["E", "GP", "GU", "P", "TP", "U", "Z"], "point"],
  [["HT", "K", "T", "TK"], "taper"],
  [["BS", "DS", "S", "W", "WW"], "spike"],
  [["RA"], "rubberFlat"],
  [["M"], "rubberHybrid"],
  [["H", "Q"], "special"],
  [["Op", "Tr"], "integrated"],
].flatMap(([codes, family]) => codes.map((code) => [code, family])));

const loadJson = async (name) =>
  JSON.parse(await readFile(join(rawDir, name), "utf8"));

const main = await loadJson("main.json");
const hardcoded = await loadJson("hardcoded.json");
const weights = await loadJson("part_weights.json");
const codeNames = await loadJson("part_code_names.json");
const partColors = await loadJson("part_colors.json").catch(() => ({}));

// Prefer the ordinary numbered Takara Tomy retail release as the canonical
// appearance of a mould. Event prizes and G/C/H promotional releases often
// precede it in the source object and otherwise turn stock parts gold/clear.
const releaseRank = (r) => {
  const set = String(r.set_id ?? "");
  if (/^(?:BX|UX|CX)-\d+(?:-\d+)?$/i.test(set)) return 0;
  if (/^(?:BX|UX|CX)[A-Z]-\d+(?:-\d+)?$/i.test(set)) return 1;
  return 2;
};

const dataOf = (o) => o.data ?? o;

function isCatalogArtifact(category, groupKey, recs) {
  if (category === "bit" && String(groupKey).trim() === "") return true;
  const tokens = [groupKey, ...recs.flatMap((r) => [r.en_name, r.name?.["zh-TW"]])]
    .filter(Boolean)
    .map(String);
  if (tokens.some((value) => value === "■")) return true;
  if (category === "blade") {
    return tokens.some((value) => value === "BIT" || /^加贈軸心活動/.test(value));
  }
  if (category === "ratchet") {
    return tokens.some((value) => /^(?:P|V|O|D)$/.test(value));
  }
  return category === "bit" && tokens.some((value) => value.trim() === "");
}

// Set codes appear as their own token ("BXH-25-01 蒼龍突擊") or glued to CJK
// ("BXC-13蒼龍至尊S"). Suffix tokens after the name are colorway descriptors
// ("金屬塗層:燦金"). Returns { name, suffix }.
const SET_CODE_TOKEN = /^[A-Za-z]+[0-9A-Za-z]*-\d+(?:-\d+)*[A-Za-z]?$/;
const GLUED_SET_CODE = /^[A-Za-z]+[0-9A-Za-z]*-\d+(?:-\d+)*(?=[^\x00-\x7F])/;
function cleanName(raw) {
  if (!raw) return { name: "", suffix: "" };
  let s = raw.trim().replace(GLUED_SET_CODE, "");
  let tokens = s.split(/\s+/).filter(Boolean);
  while (tokens.length > 1 && SET_CODE_TOKEN.test(tokens[0])) tokens.shift();
  const cut = tokens.findIndex(
    (t, i) =>
      i > 0 && (t.includes(":") || t.includes("：") || /塗層|限定|特別|[Vv]er\.?$/.test(t)),
  );
  if (cut > 0) {
    return { name: tokens.slice(0, cut).join(" "), suffix: tokens.slice(cut).join(" ") };
  }
  return { name: tokens.join(" "), suffix: "" };
}

const lineOf = (tags = []) => {
  if (tags.includes("cx")) return "CX";
  if (tags.includes("ux")) return "UX";
  if (tags.includes("bx")) return "BX";
  return null;
};

const statSig = (r) => {
  const s = r.defaultStatus ?? {};
  return [s.attack ?? 0, s.defense ?? 0, s.stamina ?? 0, s.dash ?? 0, s.burst ?? 0, s.height ?? 0, s.rotation ?? ""].join(",");
};
const zhOf = (r) => cleanName(r.name?.["zh-TW"] ?? "").name;

// ---- group records --------------------------------------------------------
// pass 1: by group_id/en_name; pass 2: keyless records matched by zh name
const groups = {}; // category -> Map<groupKey, records[]>
for (const [collKey, category] of Object.entries(COLLECTIONS)) {
  const map = (groups[category] = new Map());
  const keyless = [];
  for (const source of [dataOf(main), dataOf(hardcoded)]) {
    for (const rec of Object.values(source[collKey] ?? {})) {
      if (rec.invalid) continue;
      const key = rec.group_id || rec.en_name;
      if (key) {
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(rec);
      } else {
        keyless.push(rec);
      }
    }
  }
  for (const rec of keyless) {
    const zh = zhOf(rec);
    let found = null;
    for (const [key, recs] of map) {
      if (zh && (key === zh || recs.some((r) => r.en_name === zh || zhOf(r) === zh))) {
        found = key;
        break;
      }
    }
    const key = found ?? zh ?? rec.id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(rec);
  }
}

// ---- emit entries (one per stat signature) --------------------------------
const idToEntry = new Map(); // part id -> entry key
const parts = {};
const summary = [];

for (const [category, map] of Object.entries(groups)) {
  const list = [];
  for (const [groupKey, recs] of map) {
    if (isCatalogArtifact(category, groupKey, recs)) continue;
    // partition by stat signature; base = signature of earliest release
    const bySig = new Map();
    for (const r of recs) {
      const sig = statSig(r);
      if (!bySig.has(sig)) bySig.set(sig, []);
      bySig.get(sig).push(r);
    }
    const firstRelease = (rs) =>
      rs.map((r) => r.release_at).filter(Boolean).sort()[0] ?? "9999";
    const sigs = [...bySig.entries()].sort(
      (a, b) => firstRelease(a[1]).localeCompare(firstRelease(b[1])),
    );

    sigs.forEach(([, sigRecs], idx) => {
      // representative: cleanest zh name, then earliest release
      const scored = sigRecs
        .map((r) => ({ r, c: cleanName(r.name?.["zh-TW"] ?? "") }))
        .sort(
          (a, b) =>
            releaseRank(a.r) - releaseRank(b.r) ||
            String(a.r.release_at ?? "9999").localeCompare(String(b.r.release_at ?? "9999")) ||
            (a.c.name.length || 99) - (b.c.name.length || 99) ||
            String(a.r.release_at ?? "").localeCompare(String(b.r.release_at ?? "")),
        );
      const rep = scored[0].r;
      const st = rep.defaultStatus ?? {};
      const code = rep.en_name || groupKey;
      const descriptionText = Object.values(rep.description ?? {}).join(" ");
      const integratedRatchet =
        (category === "ratchet" && groupKey === "RATCHET-integrated") ||
        /integrated\s+RATCHET|ラチェット一体|固鎖一體|核輪一體/i.test(descriptionText);

      const codeTable = CODE_NAME_KEYS[category]
        ? codeNames[CODE_NAME_KEYS[category]]?.[groupKey]
        : null;
      const zh = codeTable?.name?.["zh-TW"] || scored[0].c.name || rep.en_name || groupKey;
      const ja =
        codeTable?.name?.["ja-JP"] ||
        cleanName(rep.name?.["ja-JP"] ?? "").name ||
        rep.yomi ||
        "";

      // variant label for non-base stat versions: colorway descriptor before ":"
      let variantLabel = null;
      if (idx > 0) {
        const suffix = sigRecs
          .map((r) => cleanName(r.name?.["zh-TW"] ?? "").suffix)
          .find(Boolean);
        variantLabel = suffix ? suffix.split(/[:：]/)[0] : `Ver.${idx + 1}`;
      }

      // weight/diameter from this stat version's own colorways
      let weightG = null;
      let diameterMm = null;
      let gearTeeth = null;
      let totalHeightMm = null;
      let exposedHeightMm = null;
      for (const r of [rep, ...sigRecs]) {
        const w = weights[r.id];
        if (w?.weight_g != null) {
          weightG = w.weight_g;
          const mm = /([\d.]+)\s*mm/.exec(w.size ?? "");
          diameterMm = mm ? Number(mm[1]) : null;
          gearTeeth = w.gear == null ? null : Number(w.gear);
          totalHeightMm = w.total_height_mm == null ? null : Number(w.total_height_mm);
          exposedHeightMm = w.exposed_height_mm == null ? null : Number(w.exposed_height_mm);
          break;
        }
      }

      // official colorway name (e.g. "blue", "gold") from part_colors
      let color = null;
      let colors = [];
      for (const r of [rep, ...sigRecs]) {
        const c = partColors[r.id];
        if (Array.isArray(c) && c.length > 0) {
          colors = c.map(String);
          color = colors[0];
          break;
        }
      }

      // short zh-TW description: drop the "included in ..." first line
      let desc = null;
      const rawDesc = rep.description?.["zh-TW"];
      if (rawDesc) {
        const lines = String(rawDesc).split(/\\n|\n/).map((x) => x.trim()).filter(Boolean);
        desc = (lines[1] ?? lines[0] ?? "").slice(0, 120) || null;
      }

      const key = idx === 0 ? groupKey : `${groupKey}#${idx + 1}`;
      for (const r of sigRecs) idToEntry.set(r.id, { category, key });

      list.push({
        key,
        group: groupKey,
        category,
        code,
        name: { "zh-TW": zh, en: rep.en_name || groupKey, ja },
        variantLabel,
        type: rep.type ?? codeTable?.type ?? null,
        stats: {
          attack: st.attack ?? 0,
          defense: st.defense ?? 0,
          stamina: st.stamina ?? 0,
          dash: st.dash ?? 0,
          burst: st.burst ?? 0,
          height: st.height ?? 0,
        },
        rotation: st.rotation ?? null,
        weightG,
        diameterMm,
        color,
        colors,
        gearTeeth,
        totalHeightMm,
        exposedHeightMm,
        tipFamily: category === "bit" ? (BIT_FAMILIES[code] ?? null) : null,
        integratedRatchet,
        desc,
        line: lineOf(rep.tags),
        fixedBurst: rep.fixed_burst ?? false,
        releaseAt: firstRelease(sigRecs) === "9999" ? null : firstRelease(sigRecs),
        canonicalVariantId: rep.id,
        variants: sigRecs.map((r) => ({
          id: r.id,
          setId: r.set_id || null,
          colors: Array.isArray(partColors[r.id]) ? partColors[r.id].map(String) : [],
          label: cleanName(r.name?.["zh-TW"] ?? "").suffix || null,
        })),
      });
    });
  }
  list.sort((a, b) => String(a.releaseAt ?? "9999").localeCompare(String(b.releaseAt ?? "9999")));
  parts[category] = list;
  const nGroups = map.size;
  summary.push(`${category}: ${list.length} (${nGroups} groups)`);
}

// ---- official complete beys ("Series") -> combo presets -------------------
const comboSeen = new Map();
for (const source of [dataOf(main), dataOf(hardcoded)]) {
  for (const rec of Object.values(source.BeybladeSeries ?? {})) {
    if (rec.invalid) continue;
    const ref = (id) => (id && idToEntry.get(id)?.key) || null;
    const sourceIds = {
      blade: rec.blade_id || null,
      ratchet: rec.ratchet_id || null,
      bit: rec.bit_id || null,
      lockChip: rec.lock_chip_id || null,
      mainBlade: rec.main_blade_id || null,
      assistBlade: rec.assist_blade_id || null,
      metalBlade: rec.metal_blade_id || null,
      overBlade: rec.over_blade_id || null,
    };
    const partRefs = {
      blade: ref(rec.blade_id),
      ratchet: ref(rec.ratchet_id),
      bit: ref(rec.bit_id),
      lockChip: ref(rec.lock_chip_id),
      mainBlade: ref(rec.main_blade_id),
      assistBlade: ref(rec.assist_blade_id),
      metalBlade: ref(rec.metal_blade_id),
      overBlade: ref(rec.over_blade_id),
      variantIds: Object.fromEntries(Object.entries(sourceIds).filter(([, id]) => id)),
    };
    const completeUpper = partRefs.blade || (
      partRefs.lockChip && partRefs.assistBlade &&
      (partRefs.mainBlade || (partRefs.metalBlade && partRefs.overBlade))
    );
    if (!completeUpper || !partRefs.ratchet || !partRefs.bit) continue;
    // dedupe by resolved composition (different colorways of one combo share it)
    const compKey = Object.values(partRefs).slice(0, 8).join("|");
    if (!rec.en_name) continue;
    const candidate = {
      code: rec.en_name,
      line: lineOf(rec.tags),
      releaseAt: rec.release_at ?? null,
      parts: partRefs,
      _rank: releaseRank(rec),
    };
    const existing = comboSeen.get(compKey);
    if (!existing || candidate._rank < existing._rank) comboSeen.set(compKey, candidate);
  }
}
const combos = [...comboSeen.values()].map(({ _rank, ...combo }) => combo).sort((a, b) =>
  String(a.releaseAt ?? "9999").localeCompare(String(b.releaseAt ?? "9999")),
);

const out = {
  generatedAt: new Date().toISOString(),
  source: "https://beyblade.phstudy.org/ (unofficial fan DB; data only, no images)",
  statRanges: main.stat_ranges ?? null,
  parts,
  combos,
};

await mkdir(dirname(outFile), { recursive: true });
await writeFile(outFile, JSON.stringify(out, null, 1) + "\n", "utf8");
console.log(`wrote ${outFile}`);
console.log(summary.join("\n"));
console.log(`combos: ${combos.length}`);
