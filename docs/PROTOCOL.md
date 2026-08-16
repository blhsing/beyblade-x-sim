# Online Protocol (relay + lockstep)

## Transport

`server/relay/` — a combined web host + room relay in Go (DeskFerry-style:
lazy rooms, in-memory, no game logic). One binary serves the built web app at
`/` (embedded `webroot/`, or `-static DIR` in dev) and the game endpoints
under `/game/` — deliberately NOT `/relay/` so it can co-exist with (or
front-proxy, via `-forward`) a DeskFerry relay on the same host. `-pathbase
/beyblade` supports hosting as an IIS virtual application. Endpoints:

- `GET /game/health`, `GET /game/status` — JSON.
- `GET /game/{room}/ws?role=player|spectator&name=NAME` — WebSocket.

Rooms: normalized codes (lowercase `[a-z0-9-_.]`, ≤64 chars); 2 player slots
+ up to 8 spectators. Server frames (JSON text):

- `{"type":"welcome","slot":0|1|-1,"name":...}` on join
- `{"type":"room","players":["nameA","nameB"]}` on membership change
- `{"type":"error","reason":"room-full"}` then close
- `{"type":"msg","from":slot,"data":<client JSON>}` — relayed payload

Clients send raw JSON payloads; the relay wraps and forwards to everyone
else in the room. Keepalive ping every 20 s; 64 KB frame cap.

Deploy tiers (mirroring DeskFerry; scripts in `build/`):

- **local** — `go run .` → http://127.0.0.1:8080/ (game) + ws /game.
- **Azure App Service (tier 1, WSS)** — deployed as IIS **virtual
  application `/beyblade`** under the existing test site (this account cannot
  create new webapps), Go process via httpPlatformHandler, site WebSockets
  on + IIS webSocket module off in the vapp web.config. Deploy:
  `build\deploy-azure.ps1`. The DeskFerry root app is not modified.
- **OCI Always Free VM (tier 2, HTTP)** — `build\deploy-oci.ps1`, blocked on
  the SSH key (not provisioned per the DeskFerry private runbook). Two modes:
  `standalone` (own port; needs OCI security-list opening) or `front`
  (beyblade owns :80 serving the game and `-forward`s `/relay/*` to DeskFerry
  moved to 127.0.0.1:8081 — run only with explicit approval).

Relay base URLs are user configuration; private hostnames are never committed.

## Accounts, sessions and mail

`/game/auth/*` (signup, verify, signin, me, signout, change-password,
change-email, confirm-email). Passwords are bcrypt-hashed; sessions are
bearer tokens with a sliding 10-year expiry (`/me` renews) so a player stays
signed in until an explicit sign-out. `_users`/`_emails`/`_sessions` are
private collections: excluded from the public `/game/db` API and exchanged
between tiers only when `X-Beyblade-Peer-Key` matches `BEYBLADE_PEER_KEY`.
Public DB writes require a session token.

**Guest play:** clients may sign in with a nickname only. Guests hold no
token, so they never write to the server (no profile, records, combos or
prefs); their identity lives in `sessionStorage` and disappears with the
session. Online play still works — the room relay itself is unauthenticated.

**Mail delivery.** The OCI VM cannot deliver mail itself: outbound port 25 is
blocked by the cloud provider and the instance has no rDNS/PTR or domain, so
direct-to-MX submission is rejected by the major providers regardless of
content. Ports 587/465 are open, so mail must be **relayed through a provider**:

```
BEYBLADE_SMTP_HOST=smtp.example.com:587   # :465 uses implicit TLS automatically
BEYBLADE_SMTP_USER=...
BEYBLADE_SMTP_PASS=...                    # app password for most providers
BEYBLADE_SMTP_FROM=beyblade@example.com
```

Until that is configured the server only logs the code, and with
`BEYBLADE_DEV_MAIL=1` it also returns it in the API response and shows it in
the UI. **That is a development stub, not verification** — it proves nothing
about who owns the address. Remove `BEYBLADE_DEV_MAIL` once SMTP works.

## Game session (client↔client `data` payloads)

Beyblade has no mid-battle input, so online play is **launch-parameter
lockstep**: exchange inputs, then both devices run the identical
deterministic sim (docs/PHYSICS.md).

```
{t:"hello",  name, ver, rulesHash}         on join
{t:"rules",  rules}                        host (slot 0) proposes RuleSet
{t:"deck",   combos:[ComboSelection…]}     both reveal decks (per format)
{t:"pick",   slotIndex}                    wboDeck counter-pick only
{t:"seedq",  q: u32}                       both send random quarter…
{t:"launch", sp, aimDeg, tiltDeg, launcher, spinDir, ready:true}
{t:"go"}                                   host confirms both launches in
{t:"hash",   tick, h}                      every 240 ticks during sim
{t:"result", finish|draw, tick}            end-of-battle cross-check
{t:"score",  scores:[a,b], battleIndex}    host-authoritative bookkeeping
{t:"rematch"} / {t:"leave"}
```

- Battle seed = `seedq_A XOR seedq_B` (neither side controls it).
- Both clients simulate after `go`; spectators receive the same inputs and
  simulate too (zero-bandwidth spectating).
- `hash` mismatch ⇒ divergence: client requests `{t:"state?"}`; host replies
  with a full `WorldState` snapshot to resync (fallback safety net — should
  not happen given the determinism contract; log + telemetry when it does).
- Human launch timing: each player's drag happens locally during the
  synchronized countdown; the resulting `LaunchParams` is what travels.
  Early/late release relative to the countdown maps to the mislaunch rule.

## Offline modes

Hot-seat and vs-bot use the same match engine with no `net/` involvement.
