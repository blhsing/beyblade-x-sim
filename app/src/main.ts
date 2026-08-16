// Boot: load the parts DB and start the game shell (zh-TW UI).

import type { PartsDb } from "./core/types";
import { flushPending, pull } from "./game/persist";
import { GameApp } from "./ui/app";

async function boot(): Promise<void> {
  if (import.meta.env.PROD && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  void pull().then(() => flushPending()); // sync profiles/records/combos
  const res = await fetch("data/parts.json");
  if (!res.ok) throw new Error(`parts.json HTTP ${res.status}`);
  const db = (await res.json()) as PartsDb;
  const root = document.getElementById("app")!;
  let app: GameApp;
  try {
    app = new GameApp(db, root);
  } catch (err) {
    throw new Error(
      `此裝置或瀏覽器無法建立 WebGL 3D 環境（請確認未停用硬體加速）。${String(err)}`,
    );
  }
  app.showMenu();
}

boot().catch((err) => {
  const div = document.createElement("div");
  div.style.cssText = "position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#ff8a80;font-size:16px;padding:24px;text-align:center";
  div.textContent = `載入失敗：${err}`;
  document.body.append(div);
});
