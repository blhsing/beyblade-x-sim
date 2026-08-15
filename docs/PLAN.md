# BEYBLADE X 戰鬥陀螺模擬對戰 — Project Plan

> Working title: **BEYBLADE X 模擬對戰** (final name TBD).
> An unofficial, non-commercial fan simulation for personal/developer use.
> Game UI language: Traditional Chinese (zh-TW). Dev docs: English.

## 1. Context

Goal: a mobile simulation of TAKARA TOMY's BEYBLADE X toy line that is
*aesthetically realistic* and *physically accurate*, with the complete official
parts catalogue available for customization, official tournament rules (with
variations as options), a tournament mode and a quick match mode, human and bot
players, an immersive first-person launch experience (drag to pull the
winder/string), and a 3D stadium anchored in physical space via device motion
sensors. iOS + Android, initially distributed to the developer only.

## 2. Requirements (from brief)

| # | Requirement |
|---|---|
| R1 | Simulation of TAKARA TOMY BEYBLADE X (not Hasbro-first; TT data is source of truth) |
| R2 | UI fully in Traditional Chinese (zh-TW) |
| R3 | All official parts selectable; free customization (build combos from parts) |
| R4 | Realistic aesthetics; physically accurate battle simulation |
| R5 | Mobile app, iOS + Android, developer-only distribution initially |
| R6 | Official BEYBLADE X tournament rules; variations exposed as options |
| R7 | Tournament mode: selectable player count; each slot = named human or bot |
| R8 | Quick match: human vs bot, human vs human |
| R9 | Bot skill level and character individually selectable |
| R10 | WebSocket game servers following the two existing DeskFerry tiers |
| R11 | Launch UX: screen shows launcher as if held; other hand drags to pull winder/string |
| R12 | Stadium fixed in physical space via gyroscope/sensors (phone up ⇒ stadium down on screen) |

## 3. Research Summary

### 3.1 Parts data — beyblade.phstudy.org (researched 2026-08-15)

The best available structured source. Unofficial fan DB (by phstudy, Taipei;
zh-TW native) whose data is served as **open static JSON** — no auth, no CORS
gate. Endpoints under `https://beyblade.phstudy.org/data/`:

- `main.json` (~4 MB): 1,334 TT records — all parts + complete beys ("Series"),
  with 6-locale names (zh-TW included), stats, spin direction, product codes,
  release dates.
- `hardcoded.json`: 180 promo/collab records. `hasbro.json`: 733 Hasbro records.
- `part_weights.json`: fan-measured weight (±0.2–0.3 g) + diameter per part.
- `part_code_names.json`: code→name dictionary for Bits / Assist Blades / Over Blades.
- `ui_i18n.json`: 688 professionally translated UI keys × 5 locales — our
  zh-TW terminology reference.

Part system (9 collections): **BX/UX line** = Blade 鋼鐵戰刃 + Ratchet 固鎖輪盤 +
Bit 軸心. **CX line** = Lock Chip 紋章鎖 + Main Blade 主要戰刃 (+ Metal Blade
金屬戰刃 / Over Blade 超越戰刃) + Assist Blade 輔助戰刃 + Ratchet + Bit.

Functional (colorway-deduped via `group_id`) catalogue as of 2026-08:
**106 Blades, 43 Ratchets, 53 Bits, 2 Lock Chips, 22 Main Blades, 18 Assist
Blades, 5 Metal Blades, 5 Over Blades** ≈ 254 mechanically distinct parts.
Stats per part: `attack, defense, stamina, dash, burst(resistance), height`
plus weight/diameter and rotation (`right | left | both-right-origin | both-left-origin`).
Top-level `stat_ranges` gives per-category maxima for normalization.

**Licensing:** the JSON stats are effectively official TT app data; the site's
*images* are third-party licensed to that site only — **we must not bundle or
hotlink phstudy images**. We generate our own visuals (procedural/parametric
3D). Data is fetched at build time by the developer, cached locally, and the
site is credited in-app. Contacting phstudy (public email) before any wider
distribution is noted as a TODO.

### 3.2 Server tiers — DeskFerry (C:\src\DeskFerry)

DeskFerry's relay is a room-based WebSocket rendezvous server with three
protocol-compatible implementations. The **two deployed tiers** to mirror:

| Tier | Host | Impl | Transport | Notes |
|---|---|---|---|---|
| 1 (primary) | Azure App Service | C#/.NET 8 minimal API | **WSS** (TLS by Azure) | zip-deploy via `az webapp deploy`; WebSockets enabled in config; in-process ANCM |
| 2 (fallback) | OCI Always Free VM | Go static binary + systemd | **WS over HTTP:80, no TLS** | scp+systemd deploy; healthcheck timer + watchdog hardening |
| (dev) | localhost | Go or Python/FastAPI | WS | `go run` locally |

Patterns worth reusing directly (paths in DeskFerry): room normalization and
lazy room creation (`relay/go/main.go`), JSON control envelope with a single
`type`-tagged struct (`internal/tunnel/protocol_v2.go`), role/proto via HTTP
headers, room password → SHA-256 **proof** (never send the password;
`internal/tunnel/websocket.go:114`), terminal-vs-retryable error taxonomy,
resumable byte stream with ack/replay for mobile reconnects
(`internal/tunnel/resumable.go`), dashboard/status push for spectators, and
least-loaded selection with CAS reservation.

Constraints learned: Tier 2 is HTTP-only — **browsers/PWAs served over HTTPS
cannot open `ws://`** (mixed content). So for the web-tech client, Tier 1 (WSS)
is the online tier; Tier 2 serves native/dev contexts unless TLS (Caddy +
domain) is added to the VM. Relay state is in-memory by design; tournament
persistence lives client-side (and later optionally server-side).

**Do not copy** private hostnames/IPs or `RELAY_ACCESS.private.md` material
into this repo; relay URLs are user configuration.

### 3.3 Tournament rules

Researched separately → `docs/RULES.md`. Baseline (to be confirmed there):
Spin Finish 1 pt / Over Finish 2 pt / Burst Finish 2 pt / Xtreme Finish 3 pt,
first to 4 points; 3on3 deck format for tournaments; simultaneous launch on
「3・2・1 GO SHOOT!」; the Xtreme Stadium's rail and pockets distinguish Over vs
Xtreme finishes. All parameters live in a `RuleSet` object so variations are
toggleable (R6).

## 4. Technology Decisions

### 4.1 Client: TypeScript + Three.js web app, packaged as mobile app

**Decision:** Build the client with web technology (TypeScript, Three.js,
WebGL2, Vite), shipped as a PWA for instant developer install, and wrapped
with Capacitor for real iOS/Android app packaging.

Rationale (evidence-based):

1. **Developer's ecosystem is web games.** Every game project in C:\src
   (fighter, GestureShooter, wrestling, civilization, heroes, maze, …) is a
   static web app; none uses Unity/Godot/Unreal, and no game engine is
   installed on this machine. Toolchain present: Node 24, Go 1.26, .NET 10,
   Python 3.14.
2. **iOS without a Mac.** This is a Windows-only environment. Unity/Unreal iOS
   builds require Xcode on macOS regardless. A PWA installs on iPhone via
   Safari "加入主畫面" with zero Mac involvement — the only path that satisfies
   "iOS, developer-only, now". Capacitor iOS shell is kept ready for a future
   Mac/CI build.
3. **Sensors are available to web.** DeviceOrientation/DeviceMotion (gyro,
   accelerometer) work on both mobile OSes (iOS needs a permission prompt);
   WebXR immersive-ar gives true 6DOF + camera passthrough on Android Chrome.
   Full ARKit on iOS would need the native wrapper later — acceptable, because
   R12 names "gyroscope or other sensors", and the 3DOF gyro window effect
   delivers the described experience on both platforms today.
4. **Determinism.** JS IEEE-754 arithmetic (+ − × ÷ √) is spec-deterministic
   across devices; we avoid `Math.sin/cos/…` inside the sim (own trig tables) —
   enabling lockstep netcode by exchanging launch parameters only.
5. **Server synergy.** DeskFerry tiers are web-reachable (WSS on Azure); a web
   client talks to them natively, and the Azure App Service can host the
   static app too.

Rejected: **Unity + AR Foundation** (best-in-class AR but multi-GB new
toolchain, unfamiliar to this codebase's owner, still Mac-bound for iOS,
licensing overhead); **Godot** (weak mobile AR story); **Unreal** (overkill,
slow mobile iteration); **Flutter/RN + 3D** (awkward 3D/physics fit).

### 4.2 Physics: custom deterministic fixed-timestep sim (no physics engine)

A beyblade battle is two spinning tops in a bowl — a niche regime general
rigid-body engines handle poorly (extreme ω ≈ 400–900 rad/s, gyroscopic
precession, tip friction regimes, ratchet burst clicks). We implement a
purpose-built model (`docs/PHYSICS.md`): 240 Hz fixed timestep, seeded PRNG,
analytic stadium surface, tip-type friction, impulse collisions with burst
click accumulation, Xtreme rail line-constraint, four finish detectors. Part
stats + measured weights parameterize the model. Deterministic by
construction → replays and lockstep multiplayer for free.

### 4.3 Networking: launch-parameter lockstep over a dumb relay

Beyblade has **no mid-battle input** — after launch, physics decides. So online
play needs only: room join → deck reveal → seed agreement → both players'
launch params → identical deterministic sim on both devices (+ periodic state
hashes to detect divergence; host snapshot as recovery). The server stays a
DeskFerry-style **game-agnostic room relay** (Go, `nhooyr.io/websocket`):
rooms by short code, 2 player slots + spectators, JSON control frames, no game
logic server-side. This reuses the proven DeskFerry deployment story on both
tiers unchanged.

### 4.4 Data: build-time pipeline, no bundled third-party images

`tools/fetch-parts.mjs` downloads phstudy JSON → `data/raw/` (gitignored);
`tools/normalize-parts.mjs` dedupes colorways by `group_id`, keeps TT parts,
merges weights + code names, emits `app/public/data/parts.json` (committed) —
zh-TW + en names, stats, physics-relevant fields. Bey visuals are parametric
meshes driven by part category/type/stats/weight, not ripped assets.

## 5. Architecture

```
beyblade/
├── docs/            PLAN, RULES, PHYSICS, PROTOCOL, DATA
├── tools/           fetch-parts.mjs, normalize-parts.mjs  (Node, no deps)
├── data/raw/        downloaded phstudy JSON (gitignored)
├── app/             Vite + TypeScript client
│   ├── public/data/parts.json     normalized game DB (committed)
│   └── src/
│       ├── core/    deterministic sim: fxmath (trig tables, PRNG), types,
│       │            stadium surface, bey dynamics, collisions, rail, finishes
│       ├── game/    RuleSet + match engine (battles→points→winner),
│       │            deck/combo validation, tournament brackets, bot AI
│       ├── render/  three.js scene graph: stadium mesh, parametric bey
│       │            builder, effects (sparks, trails, burst), camera rigs
│       ├── input/   winder drag gesture → shoot power; launch tilt
│       ├── sensors/ DeviceOrientation/Motion wrapper, WebXR AR session,
│       │            calibration, camera anchoring ("stadium fixed in space")
│       ├── net/     relay client (WS), protocol codec, lockstep session
│       ├── ui/      zh-TW screens: menu, 零件庫 deck builder, quick match,
│       │            tournament, match HUD, results
│       └── i18n/    zh-TW string tables (terminology per phstudy ui_i18n)
├── server/relay/    Go room relay (DeskFerry pattern), go.mod, main.go
└── build/           PowerShell build/package scripts (DeskFerry convention)
```

Key module contracts:

- `core` is **pure** (no DOM/three imports) and runs headless in vitest and
  potentially in a web worker. `simulate(config, tick)` advances world state;
  `hashState(world)` → fnv64 for lockstep verify.
- `game` consumes `core` results; `MatchEngine` emits events
  (`battleStart`, `finish{type,winner}`, `points`, `matchEnd`) the UI renders.
- `render` interpolates between the last two sim states (sim 240 Hz, render
  at display Hz).
- `sensors` outputs a camera pose; render composes stadium-anchored view.
- `net` implements `docs/PROTOCOL.md`; offline modes never load it.

## 6. Game Design

### 6.1 Modes
- **快速對戰 Quick match:** 人類 vs 電腦 / 人類 vs 人類 (同機輪流 hot-seat, or
  線上 via relay room code). Single battle or first-to-N.
- **錦標賽 Tournament:** 2–16 slots; each slot = named 人類 or 電腦 (bot skill
  + character per slot); formats: single elimination (季軍賽 optional) and
  round robin; bracket view; per-round deck editing per rules.
- **自由研究 Practice** (stretch): solo launch + physics sandbox.

### 6.2 Rules (`RuleSet` object; defaults = official TT)
Finish points (spin/over/burst/xtreme), points-to-win, deck size (1 or 3on3),
duplicate-part policy, re-launch policy, draw handling, Xtreme rail
enabled, stadium variant. Presets: 官方標準 (official), WBO, 自訂 (custom).
Details in `docs/RULES.md`.

### 6.3 Bots
`BotProfile = { name (zh-TW), skill, character }`.
- **Skill 技術等級** — 新手/見習/高手/達人/冠軍: launch shoot-power mean and
  variance, aim (entry angle/position) error, deck quality (random legal →
  meta-aware), technique moves (weak launch for stamina matchups) unlock at
  higher tiers.
- **Character 性格** — 猛攻型 (attack combos, max power), 鐵壁型 (defense),
  持久型 (stamina, soft launches), 均衡型, 詭道型 (counter-picks vs opponent's
  previous deck, unusual heights). Character drives deck building + launch
  style; skill drives execution quality. Roster of named bots (e.g. 烈火、小靜、
  阿鐵、飛燕、影狼…) ships with pre-assigned profiles; both axes remain
  individually overridable per slot (R9).

### 6.4 Launch experience (R11)
Portrait. Lower screen: hands + string launcher (BX-17 style) with bey
mounted, rendered as if the player holds it; stadium visible beyond/through.
Flow: 裝填 (tap to seat bey, ratchet click haptic) → countdown 「3・2・1 GO
SHOOT!」 → **drag downward/sideways to pull the string/winder** — pull speed
over the stroke integrates into shoot power (SP, displayed like the Beybattle
Pass meter); release timing vs countdown affects legality (early = foul per
rules option); phone tilt at release nudges entry angle/position. Haptic click
train during pull (Vibration API; Capacitor haptics in native build).
Winder-launcher variant: repeated shorter strokes. Weak/soft launch supported
by slow deliberate pull.

### 6.5 Stadium anchored in physical space (R12)
- **Mode A (default, both OSes): gyro window.** DeviceOrientation quaternion
  drives the camera; the stadium stays fixed in world frame ~60 cm ahead,
  ~30° below the initial gaze; accelerometer adds micro-parallax so vertical
  phone translation reads as opposite stadium motion. One-tap recenter.
- **Mode B (Android Chrome): WebXR immersive-ar** — plane detection, stadium
  anchored on a real table with camera passthrough, true 6DOF.
- **Mode C (fallback/desktop): touch orbit camera.**
Native wrappers later upgrade Mode B to ARKit/ARCore parity.

### 6.6 Aesthetics
Realistic PBR look: brushed/anodized metal blades, translucent polycarbonate
ratchets/bits with subsurface tint, stadium plastic with decals, HDRI
lighting, contact sparks, motion-blurred spin (shader), slow-mo replay on
finishes. Parametric bey meshes: blade silhouette generated from type +
attack profile; ratchet ring from `N-HH` code (N lobes, HH height); bit tip
geometry from code (F flat, B ball, N needle, …); colors from part line.

## 7. IP & Distribution Policy

Unofficial fan project, non-commercial, developer-only distribution during
development (PWA install + Android APK sideload; TestFlight/store distribution
is out of scope and would require a rights review). Part names/stats are
factual game data credited to phstudy; no TAKARA TOMY artwork, logos, anime
assets, or phstudy images are bundled. In-app 關於 screen credits sources.

## 8. Milestones

| M | Deliverable | Acceptance |
|---|---|---|
| M0 | Repo scaffold, plan docs, parts pipeline | `parts.json` generated with ~254 parts; vite dev runs |
| M1 | Deterministic core sim + tests | vitest green: determinism hash, spin-down, wall/pocket, burst clicks, all 4 finishes |
| M2 | Rules + match engine + bot v0 | headless match human-params vs bot completes with correct scoring incl. 3on3 |
| M3 | 3D stadium + beys + battle rendering | 60 fps mid-range phone; battle visually plausible |
| M4 | Launch UX + gyro anchoring | drag-launch works on iPhone Safari + Android Chrome; stadium counter-moves with phone |
| M5 | zh-TW UI: deck builder + quick match | full loop: build deck → battle bot → result, all zh-TW |
| M6 | Tournament mode | 2–16 mixed human/bot bracket + round robin plays end-to-end |
| M7 | Relay server + online quick match | two phones battle via local relay; state hashes match |
| M8 | Packaging + tier deploys | PWA installed on both OSes; Android APK; deploy scripts for Azure (WSS) tier; OCI tier documented |

## 9. Risks

1. **Physics believability** — highest effort item; mitigate with tunable
   constants (`core/tuning.ts`), replay harness, reference footage comparison.
2. **iOS Safari quirks** — DeviceOrientation permission, no WebXR AR, PWA WSS
   only; mitigated by Mode A + Capacitor path.
3. **Float divergence across devices** — avoided trig/transcendentals; state
   hash detects; host-authoritative fallback.
4. **Part catalogue drift** (new releases) — pipeline re-run refreshes DB.
5. **Battery/thermals** (sensors + WebGL) — cap render scale, pause when idle.

## 10. Verification

- `npm test` in `app/`: core determinism, physics invariants, rules engine.
- Headless bot-vs-bot batch sims (1000 matches) for balance sanity + no-crash.
- `go test ./...` in `server/relay/`; two-browser lockstep smoke test.
- On-device manual checklist per milestone (launch feel, sensor anchoring,
  fps) on one iPhone + one Android.

## 11. Dev Environment

Windows 10; Node 24 (app + tools), Go 1.26 (relay), PowerShell builds.
Android packaging: Capacitor + Android SDK (present via DeskFerry setup).
iOS packaging: later via Mac or CI; PWA meanwhile. No Unity/Unreal required.
