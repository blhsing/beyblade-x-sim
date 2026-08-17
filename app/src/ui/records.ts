// 對戰紀錄: player profiles (W/L) + recent match records, backed by the
// synced tier DB (pull refresh) with localStorage as the offline cache.

import { localMatches, localProfiles, pull, replayPhysicsCompatible } from "../game/persist";
import { ZH } from "../i18n/zh";
import { button, el, overlay } from "./dom";
import { playReplay } from "./replay";
import type { GameApp } from "./app";

export function showRecords(app: GameApp): void {
  const o = overlay();
  const panel = el("div", { class: "panel", style: "max-height:88vh; overflow-y:auto" });
  panel.append(el("div", { class: "title", style: "font-size:22px" }, ZH.menu.records));

  const body = el("div", { style: "display:flex; flex-direction:column; gap:8px" });
  const render = (): void => {
    body.replaceChildren();
    const profiles = Object.values(localProfiles()).sort((a, b) => b.wins - a.wins);
    if (profiles.length > 0) {
      body.append(el("div", { class: "label" }, "選手戰績"));
      for (const p of profiles.slice(0, 12)) {
        body.append(
          el("div", { class: "m card", style: "flex-direction:row; justify-content:space-between" },
            el("span", {}, p.name),
            el("span", { class: "label" }, `${p.wins} 勝 ${p.losses} 敗`),
          ),
        );
      }
    }
    const matches = localMatches();
    body.append(el("div", { class: "label" }, `最近對戰（${matches.length}）`));
    for (const m of matches.slice(0, 20)) {
      const d = new Date(m.ts);
      const when = `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
      const actions = el("div", { class: "row" });
      if (m.replay && m.replay.battles.length > 0 && replayPhysicsCompatible(m.replay)) {
        actions.append(
          button(ZH.replay, () => void playReplay(app, m, () => showRecords(app)), "btn small"),
        );
      } else if (m.replay && m.replay.battles.length > 0) {
        actions.append(el("span", { class: "label" }, "舊版物理紀錄（無法精確重播）"));
      }
      if (m.id) {
        actions.append(
          button(ZH.share, () => {
            let base = window.location.pathname;
            if (!base.endsWith("/")) base = base.slice(0, base.lastIndexOf("/") + 1);
            const link = `${window.location.origin}${base}?replay=${encodeURIComponent(m.id!)}`;
            void navigator.clipboard
              ?.writeText(link)
              .then(() => window.alert(`${ZH.linkCopied}\n${link}`))
              .catch(() => window.prompt(ZH.share, link));
          }, "btn small"),
        );
      }
      body.append(
        el("div", { class: "card", style: "gap:4px" },
          el("div", {}, `${m.players[0]?.name} ${m.scores[0]}：${m.scores[1]} ${m.players[1]?.name}`),
          el("div", { class: "label" }, `${when}｜${m.mode}｜${m.stadium}｜勝者：${m.winner}`),
          actions,
        ),
      );
    }
    if (matches.length === 0 && profiles.length === 0) {
      body.append(el("div", { class: "subtitle" }, "尚無紀錄"));
    }
  };
  render();

  panel.append(
    body,
    button("重新整理（同步）", () => void pull().then(render), "btn small"),
    button(ZH.back, () => app.showMenu()),
  );
  o.append(panel);
  app.setScreen(o);
}
