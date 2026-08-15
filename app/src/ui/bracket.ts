// Tournament bracket / standings screen; plays matches in order via runMatch.

import { Tournament } from "../game/tournament";
import { ZH, fmt } from "../i18n/zh";
import { button, el, overlay } from "./dom";
import type { GameApp } from "./app";
import { runMatch } from "./match";
import type { SlotConfig } from "./setup";

export function showBracket(app: GameApp, tour: Tournament, slots: SlotConfig[]): void {
  const o = overlay();
  const panel = el("div", { class: "panel", style: "max-height:86vh; overflow-y:auto" });
  panel.append(el("div", { class: "title", style: "font-size:22px" }, ZH.menu.tournament));

  const nameOf = (i: number | null): string => (i === null ? "—" : tour.slots[i]!.name);
  const list = el("div", { class: "bracket" });
  const rounds = [...new Set(tour.matches.map((m) => m.round))].sort((a, b) => a - b);
  for (const r of rounds) {
    const label = tour.format === "roundRobin" ? "" : fmt(ZH.round, { n: r + 1 });
    if (label) list.append(el("div", { class: "label" }, label));
    for (const m of tour.matches.filter((x) => x.round === r)) {
      const aCls = m.winner !== null && m.winner === m.a ? "win" : "";
      const bCls = m.winner !== null && m.winner === m.b ? "win" : "";
      const tag = m.isThirdPlace ? "（季軍賽）" : "";
      list.append(
        el(
          "div",
          { class: "m" },
          el("span", { class: aCls }, nameOf(m.a)),
          el("span", { class: "label" }, `vs${tag}`),
          el("span", { class: bCls }, nameOf(m.b)),
        ),
      );
    }
  }
  panel.append(list);

  if (tour.format === "roundRobin") {
    const standings = tour
      .standings()
      .map((s) => `${nameOf(s.slot)}：${s.wins} 勝`)
      .join("　");
    panel.append(el("div", { class: "subtitle" }, standings));
  }

  const next = tour.next();
  if (tour.champion !== null && (tour.format === "roundRobin" || next === null)) {
    panel.append(
      el("div", { class: "banner-big", style: "font-size:24px" }, fmt(ZH.champion, { name: nameOf(tour.champion) })),
    );
    if (tour.third !== null) {
      panel.append(el("div", { class: "subtitle" }, `季軍：${nameOf(tour.third)}`));
    }
    panel.append(button(ZH.back, () => app.showMenu(), "btn primary"));
  } else if (next) {
    panel.append(
      button(`${ZH.next}：${nameOf(next.a)} vs ${nameOf(next.b)}`, () => {
        app.enableGyroByDefault();
        const a = slots[next.a!]!;
        const b = slots[next.b!]!;
        void runMatch(app, [a, b], (winner) => {
          tour.report(next.id, winner === 0 ? next.a! : next.b!);
          showBracket(app, tour, slots);
        }, {}, "錦標賽");
      }, "btn primary"),
    );
    panel.append(button(ZH.back, () => app.showMenu()));
  }

  o.append(panel);
  app.setScreen(o);
}
