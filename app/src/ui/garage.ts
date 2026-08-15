// 零件庫: part-by-part custom bey builder (BX/UX Blade+Ratchet+Bit, or the
// CX stack with Lock Chip / Main Blade / Assist Blade and optional Metal /
// Over Blades). Shows live stats + weight; saves named combos to
// localStorage for use in every mode's deck pickers.

import { comboError, resolveCombo } from "../core/derive";
import type { ComboSelection, PartCategory, PartEntry } from "../core/types";
import { pushCombo } from "../game/persist";
import { ZH } from "../i18n/zh";
import { button, el, overlay, row, select } from "./dom";
import type { GameApp } from "./app";

const EMPTY: ComboSelection = {
  blade: null,
  ratchet: null,
  bit: null,
  lockChip: null,
  mainBlade: null,
  assistBlade: null,
  metalBlade: null,
  overBlade: null,
};

const CAT_LABEL: Record<PartCategory, string> = {
  blade: ZH.blade,
  ratchet: ZH.ratchet,
  bit: ZH.bit,
  lockChip: ZH.lockChip,
  mainBlade: ZH.mainBlade,
  assistBlade: ZH.assistBlade,
  metalBlade: ZH.metalBlade,
  overBlade: ZH.overBlade,
};

function partLabel(p: PartEntry): string {
  const v = p.variantLabel ? `（${p.variantLabel}）` : "";
  const t = p.type ? `・${{ attack: "攻", defense: "防", stamina: "持", balance: "均" }[p.type]}` : "";
  const zh = p.name["zh-TW"] === p.code ? p.name["zh-TW"] : `${p.name["zh-TW"]} ${p.code}`;
  return `${zh}${v}${t}`;
}

export function showGarage(app: GameApp, onBack?: () => void): void {
  const o = overlay();
  const panel = el("div", { class: "panel", style: "max-height:88vh; overflow-y:auto" });
  panel.append(el("div", { class: "title", style: "font-size:22px" }, ZH.menu.garage));

  const sel: ComboSelection = { ...EMPTY };
  const sels = new Map<PartCategory, HTMLSelectElement>();
  const cxToggle = el("input", { type: "checkbox" });
  const statsBox = el("div", { class: "card" });

  const mkSelect = (cat: PartCategory, optionalNone: boolean): HTMLSelectElement => {
    const opts = app.db.parts[cat].map((p) => ({ value: p.key, label: partLabel(p) }));
    if (optionalNone) opts.unshift({ value: "", label: "（無）" });
    const s = select(opts, optionalNone ? "" : opts[0]?.value);
    s.addEventListener("change", refresh);
    sels.set(cat, s);
    return s;
  };

  const bxRows = el(
    "div",
    { style: "display:flex; flex-direction:column; gap:6px" },
    el("div", { class: "label" }, CAT_LABEL.blade),
    mkSelect("blade", false),
  );
  const cxRows = el(
    "div",
    { style: "display:none; flex-direction:column; gap:6px" },
    el("div", { class: "label" }, CAT_LABEL.lockChip),
    mkSelect("lockChip", false),
    el("div", { class: "label" }, CAT_LABEL.mainBlade),
    mkSelect("mainBlade", false),
    el("div", { class: "label" }, CAT_LABEL.assistBlade),
    mkSelect("assistBlade", false),
    el("div", { class: "label" }, CAT_LABEL.metalBlade),
    mkSelect("metalBlade", true),
    el("div", { class: "label" }, CAT_LABEL.overBlade),
    mkSelect("overBlade", true),
  );
  const commonRows = el(
    "div",
    { style: "display:flex; flex-direction:column; gap:6px" },
    el("div", { class: "label" }, CAT_LABEL.ratchet),
    mkSelect("ratchet", false),
    el("div", { class: "label" }, CAT_LABEL.bit),
    mkSelect("bit", false),
  );

  const nameInput = el("input", { type: "text", placeholder: ZH.garageName });
  const saveBtn = button(ZH.garageSave, () => {
    const name = nameInput.value.trim();
    if (!name) return;
    app.customs.save(name, { ...sel });
    pushCombo(name, { ...sel }); // mirror to the tier DB
    refreshSaved();
  }, "btn primary");
  const savedList = el("div", { style: "display:flex; flex-direction:column; gap:6px" });

  function refreshSaved(): void {
    savedList.replaceChildren(
      ...app.customs.list().map((c) =>
        row(
          el("span", {}, `⭐ ${c.name}｜${app.comboLabel(c.combo)}`),
          button("刪除", () => {
            app.customs.remove(c.name);
            refreshSaved();
          }, "btn small fixed"),
        ),
      ),
    );
  }

  function refresh(): void {
    const cx = cxToggle.checked;
    bxRows.style.display = cx ? "none" : "flex";
    cxRows.style.display = cx ? "flex" : "none";
    for (const cat of Object.keys(CAT_LABEL) as PartCategory[]) {
      const s = sels.get(cat);
      if (!s) continue;
      const active =
        cat === "ratchet" || cat === "bit"
          ? true
          : cx
            ? cat !== "blade"
            : cat === "blade";
      sel[cat] = active && s.value ? s.value : null;
    }
    const rc = resolveCombo(app.index, sel);
    const err = comboError(rc);
    const total = { attack: 0, defense: 0, stamina: 0, dash: 0, burst: 0 };
    let weight = 0;
    for (const p of Object.values(rc.parts)) {
      total.attack += p.stats.attack;
      total.defense += p.stats.defense;
      total.stamina += p.stats.stamina;
      total.dash += p.stats.dash;
      total.burst += p.stats.burst;
      weight += p.weightG ?? 0;
    }
    const bar = (label: string, v: number, max: number, color: string): HTMLElement => {
      const pct = Math.min(100, (v / max) * 100);
      return el(
        "div",
        { class: "row" },
        el("span", { class: "label fixed", style: "width:3.4em" }, label),
        el(
          "div",
          { style: "flex:1;height:10px;border:1px solid #35408a;border-radius:5px;overflow:hidden" },
          el("div", { style: `width:${pct}%;height:100%;background:${color}` }),
        ),
        el("span", { class: "label fixed", style: "width:2.6em;text-align:right" }, String(v)),
      );
    };
    statsBox.replaceChildren(
      bar("攻擊", total.attack, 160, "#d23b3b"),
      bar("防禦", total.defense, 160, "#3b6bd2"),
      bar("持久", total.stamina, 150, "#3bd26b"),
      bar("加速", total.dash, 45, "#d2833b"),
      bar("耐久", total.burst, 110, "#8a5ad2"),
      el("div", { class: "label" }, `${ZH.weight}：約 ${weight.toFixed(1)} g${err ? `｜⚠ ${err}` : ""}`),
    );
    saveBtn.toggleAttribute("disabled", !!err);
  }
  cxToggle.addEventListener("change", refresh);

  panel.append(
    row(el("label", { class: "label" }, ZH.garageCx, cxToggle)),
    bxRows,
    cxRows,
    commonRows,
    statsBox,
    row(nameInput, saveBtn),
    savedList,
    button(ZH.back, () => (onBack ? onBack() : app.showMenu())),
  );
  refresh();
  refreshSaved();
  o.append(panel);
  app.setScreen(o);
}
