// Swipeable gallery picker: horizontally scroll-snapped cards with lazy
// high-fidelity 3D thumbnails, a live detail panel (stat bars + description),
// tap or swipe to focus, 選擇 to confirm. Used for bey/deck pickers and the
// 零件庫 part pickers.

import { resolveCombo } from "../core/derive";
import type { PartCategory, PartEntry } from "../core/types";
import { ZH } from "../i18n/zh";
import { comboThumb, partThumb } from "../render/thumbs";
import { button, el, overlay } from "./dom";
import type { GameApp } from "./app";

export interface GalleryItem {
  key: string;
  title: string;
  sub?: string;
  desc?: string;
  bars?: { label: string; v: number; max: number; color: string }[];
  /** filter-chip tags, e.g. type/line/source */
  tags?: string[];
  thumb: (() => string | Promise<string>) | null;
}

export interface GalleryFilter {
  label: string;
  tag: string;
}

export function openGallery(
  title: string,
  items: GalleryItem[],
  currentKey: string | null,
  onPick: (key: string) => void,
  onBack: () => void,
  filters?: GalleryFilter[],
): void {
  const o = overlay();
  o.style.zIndex = "40";
  const strip = el("div", { class: "gstrip" });
  const detail = el("div", { class: "panel gdetail" });
  let focusKey = currentKey ?? items[0]?.key ?? "";

  const renderDetail = (): void => {
    const it = items.find((x) => x.key === focusKey);
    detail.replaceChildren();
    if (!it) return;
    detail.append(el("div", { style: "font-weight:700" }, it.title));
    if (it.sub) detail.append(el("div", { class: "label" }, it.sub));
    for (const b of it.bars ?? []) {
      const pct = Math.min(100, (b.v / b.max) * 100);
      detail.append(
        el(
          "div",
          { class: "row" },
          el("span", { class: "label fixed", style: "width:3.2em" }, b.label),
          el(
            "div",
            { style: "flex:1;height:9px;border:1px solid #35408a;border-radius:5px;overflow:hidden" },
            el("div", { style: `width:${pct}%;height:100%;background:${b.color}` }),
          ),
          el("span", { class: "label fixed", style: "width:2.4em;text-align:right" }, String(b.v)),
        ),
      );
    }
    if (it.desc) detail.append(el("div", { class: "label", style: "line-height:1.6" }, it.desc));
  };

  const cards = new Map<string, HTMLElement>();
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const card = e.target as HTMLElement;
        const key = card.dataset.key!;
        const it = items.find((x) => x.key === key);
        const img = card.querySelector("img");
        if (it?.thumb && img && !img.src) {
          const result = it.thumb();
          if (typeof result === "string") {
            if (result) img.src = result;
          } else {
            void result.then((url) => {
              if (url && img.isConnected) img.src = url;
            });
          }
        }
      }
    },
    { root: strip, rootMargin: "0px 300px" },
  );

  const setFocus = (key: string): void => {
    focusKey = key;
    for (const [k, c] of cards) c.classList.toggle("focus", k === key);
    renderDetail();
  };

  for (const it of items) {
    const img = el("img", { alt: "" });
    const card = el("div", { class: "gcard", "data-key": it.key }, img, el("div", { class: "label" }, it.title));
    card.addEventListener("click", () => {
      setFocus(it.key);
      card.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    });
    cards.set(it.key, card);
    strip.append(card);
    io.observe(card);
  }

  // focus follows the card nearest the strip center while swiping
  let raf = 0;
  strip.addEventListener("scroll", () => {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      const mid = strip.scrollLeft + strip.clientWidth / 2;
      let best: { key: string; d: number } | null = null;
      for (const [k, c] of cards) {
        if (c.style.display === "none") continue;
        const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
        if (!best || d < best.d) best = { key: k, d };
      }
      if (best && best.key !== focusKey) setFocus(best.key);
    });
  });

  // filter chips: quickly narrow the strip (type / line / custom …)
  const chipRow = el("div", { class: "gchips" });
  if (filters && filters.length > 0) {
    let activeTag: string | null = null;
    const chips = new Map<string | null, HTMLElement>();
    const applyFilter = (): void => {
      let firstVisible: string | null = null;
      for (const it of items) {
        const card = cards.get(it.key)!;
        const show = !activeTag || (it.tags?.includes(activeTag) ?? false);
        card.style.display = show ? "" : "none";
        if (show && firstVisible === null) firstVisible = it.key;
      }
      for (const [tag, chip] of chips) chip.classList.toggle("on", tag === activeTag);
      const focusedVisible = cards.get(focusKey)?.style.display !== "none";
      if (!focusedVisible && firstVisible) {
        setFocus(firstVisible);
        cards.get(firstVisible)?.scrollIntoView({ inline: "center", block: "nearest" });
      }
    };
    const addChip = (label: string, tag: string | null): void => {
      const chip = el("button", { class: "gchip" }, label);
      chip.addEventListener("click", () => {
        activeTag = activeTag === tag ? null : tag;
        applyFilter();
      });
      chips.set(tag, chip);
      chipRow.append(chip);
    };
    addChip("全部", null);
    for (const f of filters) addChip(f.label, f.tag);
    chips.get(null)?.classList.add("on");
  }

  o.append(
    el("div", { class: "title", style: "font-size:20px" }, title),
    chipRow,
    strip,
    detail,
    el(
      "div",
      { class: "row", style: "width:min(92vw,420px)" },
      button(ZH.ready, () => {
        io.disconnect();
        o.remove();
        onPick(focusKey);
      }, "btn primary"),
      button(ZH.back, () => {
        io.disconnect();
        o.remove();
        onBack();
      }),
    ),
  );
  document.body.append(o);
  setFocus(focusKey);
  cards.get(focusKey)?.scrollIntoView({ inline: "center", block: "nearest" });
}

const BAR_COLORS = { attack: "#d23b3b", defense: "#3b6bd2", stamina: "#3bd26b", dash: "#d2833b", burst: "#8a5ad2" };

/** Standard filter chips for combo pickers (type + line + source). */
export const COMBO_FILTERS: GalleryFilter[] = [
  { label: "攻擊", tag: "attack" },
  { label: "防禦", tag: "defense" },
  { label: "持久", tag: "stamina" },
  { label: "平衡", tag: "balance" },
  { label: "BX", tag: "BX" },
  { label: "UX", tag: "UX" },
  { label: "CX", tag: "CX" },
  { label: "⭐ 自訂", tag: "custom" },
];

/** Standard filter chips for part pickers. */
export const PART_FILTERS: GalleryFilter[] = [
  { label: "攻擊", tag: "attack" },
  { label: "防禦", tag: "defense" },
  { label: "持久", tag: "stamina" },
  { label: "平衡", tag: "balance" },
  { label: "BX", tag: "BX" },
  { label: "UX", tag: "UX" },
  { label: "CX", tag: "CX" },
];

/** Gallery items for combo selection (official + customs, optional 自動). */
export function comboItems(app: GameApp, includeAuto: boolean): GalleryItem[] {
  const out: GalleryItem[] = [];
  if (includeAuto) {
    out.push({ key: "auto", title: `${ZH.deck}：自動`, sub: "由電腦依性格自行組裝", thumb: null });
  }
  for (const opt of app.comboOptions()) {
    let sel;
    try {
      sel = app.resolveComboRef(opt.value);
    } catch {
      continue;
    }
    const stats = { attack: 0, defense: 0, stamina: 0, dash: 0, burst: 0 };
    let desc: string | undefined;
    let weight = 0;
    const tags: string[] = [opt.value.startsWith("custom:") ? "custom" : "official"];
    try {
      const rc = resolveCombo(app.index, sel);
      for (const p of Object.values(rc.parts)) {
        stats.attack += p.stats.attack;
        stats.defense += p.stats.defense;
        stats.stamina += p.stats.stamina;
        stats.dash += p.stats.dash;
        stats.burst += p.stats.burst;
        weight += p.weightG ?? 0;
      }
      // Filter a combo by its upper system, not by a reused lower part.  Expand
      // CX keeps its catalog composite outside the physical-parts map so it is
      // not double-counted by the simulator, but it still owns the picker tag.
      const upper = rc.compositeMainBlade ?? rc.compositeBlade ?? rc.parts.mainBlade ?? rc.parts.blade;
      if (upper) {
        desc = upper.desc ?? undefined;
        if (upper.type) tags.push(upper.type);
        if (upper.line) tags.push(upper.line);
      }
    } catch {
      /* keep zeros */
    }
    out.push({
      key: opt.value,
      title: opt.label,
      sub: `${ZH.weight} 約 ${weight.toFixed(1)} g`,
      desc,
      tags,
      bars: [
        { label: "攻擊", v: stats.attack, max: 160, color: BAR_COLORS.attack },
        { label: "防禦", v: stats.defense, max: 160, color: BAR_COLORS.defense },
        { label: "持久", v: stats.stamina, max: 150, color: BAR_COLORS.stamina },
        { label: "加速", v: stats.dash, max: 45, color: BAR_COLORS.dash },
        { label: "耐久", v: stats.burst, max: 110, color: BAR_COLORS.burst },
      ],
      thumb: () => comboThumb(app.index, sel, opt.value),
    });
  }
  return out;
}

/** Gallery items for one part category. */
export function partItems(app: GameApp, category: PartCategory, optionalNone: boolean): GalleryItem[] {
  const out: GalleryItem[] = [];
  if (optionalNone) out.push({ key: "", title: "（無）", thumb: null });
  for (const p of app.db.parts[category]) {
    // This row represents the absence of a separate Ratchet in integrated
    // assemblies, not a standalone object with renderable geometry.
    if (category === "ratchet" && p.integratedRatchet) continue;
    out.push(partItem(p));
  }
  return out;
}

export function partItem(p: PartEntry): GalleryItem {
  const typeZh = p.type
    ? { attack: "攻擊", defense: "防禦", stamina: "持久", balance: "平衡" }[p.type]
    : null;
  const zh = p.name["zh-TW"] === p.code ? p.name["zh-TW"] : `${p.name["zh-TW"]} ${p.code}`;
  return {
    key: p.key,
    title: `${zh}${p.variantLabel ? `（${p.variantLabel}）` : ""}`,
    sub: [typeZh, p.line, p.weightG ? `${p.weightG} g` : null].filter(Boolean).join("・"),
    desc: p.desc ?? undefined,
    tags: [p.type ?? "", p.line ?? ""].filter(Boolean),
    bars: [
      { label: "攻擊", v: p.stats.attack, max: 85, color: BAR_COLORS.attack },
      { label: "防禦", v: p.stats.defense, max: 70, color: BAR_COLORS.defense },
      { label: "持久", v: p.stats.stamina, max: 80, color: BAR_COLORS.stamina },
      ...(p.stats.dash ? [{ label: "加速", v: p.stats.dash, max: 45, color: BAR_COLORS.dash }] : []),
      ...(p.stats.burst ? [{ label: "耐久", v: p.stats.burst, max: 80, color: BAR_COLORS.burst }] : []),
    ],
    thumb: () => partThumb(p),
  };
}
