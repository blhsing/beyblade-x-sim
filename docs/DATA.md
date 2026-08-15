# Parts Data Pipeline

## Source

[beyblade.phstudy.org](https://beyblade.phstudy.org/) — unofficial BEYBLADE X
database by phstudy (Taipei). Its data is served as open static JSON under
`/data/`. The stats mirror official TAKARA TOMY app data; weights are
fan-measured (±0.2–0.3 g). **Images on that site are licensed to that site
only and are never downloaded, bundled, or hotlinked by this project.**

Fetched endpoints (→ `data/raw/`, gitignored):

| File | Content |
|---|---|
| `main.json` | All TT parts + complete beys ("Series"), 6-locale names, stats |
| `hardcoded.json` | Promo/collab/event records (TT) |
| `part_weights.json` | Measured weight (g) + diameter per part ID |
| `part_code_names.json` | Code→name dictionary (Bit / Assist Blade / Over Blade) |
| `ui_i18n.json` | zh-TW terminology reference (not shipped; consulted for i18n) |

## Pipeline

1. `node tools/fetch-parts.mjs` — downloads the endpoints above with polite
   headers, prints sizes. Re-run any time to refresh (new releases).
2. `node tools/normalize-parts.mjs` — produces `app/public/data/parts.json`
   (committed):
   - keeps TAKARA TOMY records (Hasbro excluded from v1), drops `invalid` rows;
   - dedupes colorways: `group_id` = one mechanical part; colorway product IDs
     kept as `variants`;
   - merges measured weight/diameter; resolves canonical zh-TW / en / ja names
     (set-code prefixes and colorway suffixes stripped; bit/assist/over names
     via `part_code_names.json`);
   - carries stats `{attack, defense, stamina, dash, burst, height}`,
     `rotation`, line (BX/UX/CX), `fixedBurst`, release date, and the
     site-provided `stat_ranges` for normalization;
   - emits official complete-bey presets (`combos`) from Series records with
     part references by group.

## Usage in-game

`parts.json` is the single game DB: deck builder lists parts from it; the
physics core derives simulation parameters from stats + weight + geometry
codes (ratchet `N-HH`, bit tip code). Bey visuals are **parametric meshes**
generated from category/code/type — no third-party art.

## License / credit

Data credited in-app (關於 screen) to phstudy with a link. Before any
distribution beyond the developer, contact phstudy (public email on site) and
re-review. This repo commits only the normalized `parts.json`, not raw dumps.
