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

## Accounts and sessions

`/game/auth/*`: `config` (GET, public), `google`, `signup`, `signin`, `me`,
`signout`, `nickname`, `change-password`, `change-email`. Sessions are bearer
tokens with a sliding 10-year expiry (`/me` renews) so a player stays signed
in until an explicit sign-out. `_users`/`_emails`/`_sessions` are private
collections: excluded from the public `/game/db` API and exchanged between
tiers only when `X-Beyblade-Peer-Key` matches `BEYBLADE_PEER_KEY`. Public DB
writes require a session token.

**There is no email verification and the server sends no mail.** Identity
comes from Google; the password fallback treats email as a plain identifier.

**Google Sign-In.** The client renders the Google Identity Services button,
receives an ID token, and POSTs it to `/game/auth/google`. The server
validates it via Google's `tokeninfo` endpoint and then checks the claims
that matter: `aud` must equal our client id, `iss` must be Google, `exp` must
be in the future, and `email_verified` must be true. A first sign-in creates
the account; an existing account with the same (Google-verified) address is
linked to that Google `sub`. Volume here is low enough for `tokeninfo`;
switch to local JWKS validation if that changes.

Setup — the client id must be registered by a human in Google Cloud Console
(APIs & Services → Credentials → OAuth client ID → Web application), then:

```
BEYBLADE_GOOGLE_CLIENT_ID=<id>.apps.googleusercontent.com
```

Authorized JavaScript origins must be **HTTPS with a real domain**
(`http://localhost:5173` is allowed for development). Consequently the
HTTP/bare-IP tier cannot offer Google Sign-In: the client detects this,
hides the button, and leaves password and guest sign-in available.

**Guest play:** sign in with a nickname only. Guests hold no token, so they
never write to the server (no profile, records, combos or prefs); their
identity lives in `sessionStorage` and disappears with the session. Online
play still works — the room relay itself is unauthenticated.

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
