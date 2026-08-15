# BEYBLADE X Tournament Rules → Game Rules Engine

Compiled 2026-08-15 from: TAKARA TOMY official regulation (JP, 8th ed.+ era),
the zh-TW Official Rules v12 translation (2026-03, beybladehub.app), TT event
pages/FAQ, WBO X Format materials, and JP community rulebooks. Full source
list at bottom. Items marked ⚠ need re-verification against the official PDFs
(image-based, not machine-readable in this environment).

## 1. Point system (official TT default)

| Finish | zh-TW (official rules v12) | 點數 | Condition |
|---|---|---|---|
| Spin Finish | 迴轉勝利 | **1** | Opponent stops rotating (in its original spin direction) first, inside 戰鬥區域 |
| Burst Finish | 爆裂勝利 | **2** | Opponent's bey bursts (parts separate) first |
| Over Finish | 擊飛勝利 | **2** | Opponent's bey ends up *entirely* in the 擊飛區域 (Over Zone) and cannot return |
| Xtreme Finish | 極限勝利 | **3** | Opponent's bey ends up *entirely* in the 極限區域 (Xtreme Zone) and cannot return |
| Own Finish 自滅 | 自滅 | **1 to opponent** | Your bey exits into a zone *without ever contacting* the opponent's bey → opponent gets 1 pt only (not 2/3) |

- **First to 4 points wins the match** (official 1v1). 3-player official matches
  (Wide Xtreme Stadium): first to 5.
- **Zone re-entry:** a bey that enters a pocket but comes back out has NOT
  finished — battle continues (official FAQ).
- **Over the top:** bey flying out over the stadium wall (not through a
  pocket) → no count, round replayed.
- Anime-dub zh-TW variants of the finish names (旋轉決勝/場外決勝/爆裂決勝/
  極限決勝) exist; the game uses the official-rules 勝利 forms by default.

## 2. Match procedure

1. Position selection by 猜拳; positions locked for the whole match.
2. Judge calls **「Three, Two, One, Go-Shoot!」** — both players launch
   simultaneously exactly on "Shoot".
3. Valid launch: released within **20 cm** above stadium floor; launcher may
   not cross the centerline during the stance (8th ed.; a winder tip
   protruding across is OK); launcher spin direction must match bey spin
   direction; no touching the stadium.
4. **Mislaunch (發射失誤/過早發射/過晚發射):** 2 mislaunches accumulated in the
   same round → opponent +1 point and the round restarts. Scoring a point
   resets your mislaunch counter. Simultaneous 2nd mislaunches by both → the
   2nd is voided, restart.
5. **Draws (平手):** both stop simultaneously → no points; double KO
   (both exit zones) → no points; round replayed with same beys.
6. WBO extras: 1 relaunch OR 1 review call per battle per player.

## 3. Formats

### 3on3 (TT official, used from Best-4 in G2/G3 events)
- 3 beys, battle order pre-declared (slots 01/02/03), **order locked**.
- **No part name may repeat across the deck** — color variants count as the
  same part. ⚠ CX Lock Chip exception: 戰神 (VALKYRIE) and 帝王 (EMPEROR)
  Lock Chips may each be used once; other lock chip types may repeat.
- Slot pairing #1v#1, #2v#2, #3v#3; if 3 rounds don't decide, both players
  secretly re-order and continue.
- 殿堂 (Hall of Fame) parts: banned in 1v1, allowed in 3on3. ⚠
- Typical official structure: preliminaries 1-bey first-to-4; finals 3on3.

### WBO Deck Format (variation)
- Counter-picking: choose which bey to send after seeing opponent's pick.
- First Stage to 4 points; Final Stage to **7**; 3on3 events to 5.
- Side deck allowed (per-match no-duplicate constraint).
- **MN (Metal Needle) bit banned** (stadium damage), organizer-toggleable.

### Limited Rule (official variant)
- Restricted-parts list; using a restricted part gives the opponent starting
  points (handicap mechanism).

## 4. Stadium & equipment

- **Xtreme Stadium (BX-10)** — official tournament stadium. Overall
  **440 × 455 × 155 mm**; Tornado Ridge (battle bowl) diameter **210 mm** ⚠
  (some sources read this as the flat-center diameter; refine from photos).
- **Xtreme Line (X 衝擊線):** gear rack molded into the stadium floor near the
  edge; meshes with gear teeth on the bey's **bit**, triggering **Xtreme
  Dash** — sudden tangential acceleration slinging the bey across the field.
- **Exits:** Over Zones = corner pockets (2 pts); Xtreme Zone = wider central
  exit at the end of an Xtreme Line (3 pts). ⚠ Exact pocket count/layout
  unresolved (sources say "3 exits on one side" vs "4 pockets"); game models
  geometry as data (default: 2 over pockets flanking 1 xtreme zone on the
  attack side) — refine from product photos.
- Other stadiums: Wide Xtreme (BX-32, 3-player), Double Xtreme (BX-37),
  legacy Burst stadium (no rail → xtreme finish impossible).
- **Launchers:** Winder Launcher (baseline), String Launcher (BX-17, UX-02…),
  Hold/Long-Winder customs. Launcher must match bey spin direction.

## 5. Physical reference numbers (for the simulation)

| Quantity | Value |
|---|---|
| Assembled bey mass | typical ~35 g; range 30–50 g; outliers to ~62 g (ratchet-integrated) |
| Blade mass / diameter | per-part from phstudy `part_weights` (e.g. DRANSWORD 34.8 g, ⌀48.5 mm) |
| Ratchet code `N-HH` | N = perimeter protrusions; HH = height in 0.1 mm (60 → 6.0 mm) |
| Ratchet mass | ~6.4 g (3-60) |
| Shoot Power (SP, Beybattle Pass units) | string launcher avg ≈ 7,000–7,500; hold launcher avg ≈ 9,000; peak ≈ 10,050 (display cap 9,999) |
| SP caveat | SP is a launch-impulse proxy, not RPM — community testing found weak SP↔RPM correlation for string launchers |
| Launch height limit | 20 cm above stadium floor |

Game mapping: SP ∈ [0, 11000]; drag-launch integrates pull speed into SP;
initial spin ω₀ and entry speed derived from SP with launcher-type curves.

## 6. RuleSet options (game implementation)

`RuleSet` fields (defaults = TT official 1v1):

```
pointsToWin: 4                      // 4 | 5 | 7 | custom
finishPoints: { spin:1, over:2, burst:2, xtreme:3 }
ownFinishRule: true                 // self-KO w/o contact = 1 pt to opponent
format: "single"                    // "single" | "3on3" | "wboDeck"
deckSize: 3                         // for 3on3/deck
noDuplicateParts: true              // color variants count as duplicates
cxLockChipException: true           // ⚠ per official 3on3 rule
counterPick: false                  // true in WBO deck format
reorderOnTie: true                  // secret re-order after 3 undecided
mislaunchPenalty: true              // 2 per round → opponent +1, restart
relaunchesPerBattle: 0              // 1 in WBO
stadium: "bx10"                     // "bx10" | "wide" | "double" | "burstStd"
xtremeDashEnabled: true
zoneReentry: true                   // returning bey continues battle
overTheTop: "replay"                // "replay" | "overFinish"
drawPolicy: "noPoints"              // "noPoints" | "rebattle" | "suddenDeath"
mnBitBanned: false                  // true in WBO
hallOfFameParts: "3on3Only"         // "3on3Only" | "allowed" | "banned"
limitedRule: null                   // optional restricted list + handicap pts
```

Presets: 官方標準 (all defaults) · 官方3on3 · WBO標準 · WBO決賽 (pointsToWin 7)
· 自訂.

## 7. Sources

Official: beyblade.takaratomy.co.jp regulation.pdf + event/ex/xtreme.html +
help/ FAQ; takaratomyasia.com REGULATION 6th Edition (EN); zh-TW Official
Rules v12 via beybladehub.app/rules + /guide/rules; beyblade.com (Hasbro)
tournament rules PDFs. Community: WBO X Format (worldbeyblade.org/rules/x,
Cloudflare-blocked; legacy Google-Doc ruleset readable), okuyama3093.com rules
breakdown, note.com bey_bee (8th-ed changes; SP by launcher),
note.com spiningdays (SP vs RPM), beyblade.wiki (BX-10), beybxdb.com (ratchet
naming, weights), bey.au / beybladesuperleague.co.uk / texasbeybladeleague.com
(community rulebooks). ⚠ marks items to re-verify against the official PDFs
(needs OCR) and product photography.
