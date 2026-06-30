# sonnet-arena — implementation plan

Browser multiplayer 3D arena shooter (Quake-clone) built fast for a live stream demo. Goal: one link, shared in chat, everyone lands in the same room and shoots each other in a low-poly arena — in a browser, no install.

## Goal & success criteria

- A single `http://...` link works for everyone on stream simultaneously.
- All players join one shared room automatically (no lobby UI, no codes).
- Movement + shooting feels responsive despite real network latency between viewers and the server.
- Built and live within one stream session — every architectural choice below is optimized for *days not weeks*, with explicit cut-lines if behind schedule.

## Architecture

```
Browser (client)                         LXC container (server)
┌─────────────────────────┐              ┌──────────────────────────────┐
│ Three.js renderer        │   ws://      │ Node.js process               │
│ PointerLockControls cam  │ ───────────► │ Colyseus room "arena"         │
│ bvhecctrl capsule move   │ ◄─────────── │  - authoritative state        │
│ client-side prediction   │  state diff  │  - 20Hz snapshot broadcast    │
│ remote-player interp.    │   @20Hz      │  - server-side hit raycast    │
│ static bundle served by  │ ◄──────────► │ same process serves static    │
│ same origin (no CORS)    │   http GET   │ client bundle on same port    │
└─────────────────────────┘              └──────────────────────────────┘
```

**Stack decision and why:**
- **Client:** Three.js + vanilla TS, capsule-vs-mesh collision via `three-mesh-bvh` (or `@pmndrs/bvhecctrl` if it saves hand-rolled controller code) against a low-poly blockout level.
- **Server framework: Colyseus.** Picked over raw WebSocket / Socket.IO / geckos.io because it gives rooms, automatic state-diff sync (`@colyseus/schema`), reconnection, and a documented Docker/PM2 deploy recipe for free — raw WS or Socket.IO mean hand-building delta sync, which doesn't fit a days-not-weeks budget. geckos.io's WebRTC/UDP path adds NAT/STUN ops complexity we don't want on a one-off demo box.
- **Reference to fork from:** [`r48n34/ai-fps`](https://github.com/r48n34/ai-fps) (Colyseus + Three.js/react-three-fiber, full PVP loop — move/shoot/reload/respawn/scoreboard) is the closest existing match; use it as a structural reference rather than starting from a blank file. [`felixgren/three-arena`](https://github.com/felixgren/three-arena) (Socket.IO, single-file, deliberately easy to fork) is a fallback if Colyseus integration eats too much time. Movement controller reference: [`gkjohnson/three-mesh-bvh`](https://github.com/gkjohnson/three-mesh-bvh) capsule-collision demo, or [`pmndrs/bvhecctrl`](https://github.com/pmndrs/bvhecctrl) for a ready-made controller. [`mrdoob/three-quake`](https://github.com/mrdoob/three-quake) is a useful Quake-asset/renderer reference, not a multiplayer base.
- **Networking model:** authoritative server + client-side prediction + server reconciliation (own player) + interpolation (remote players), per the standard Gabriel Gambetta recipe. Server simulates at its own internal tick; Colyseus broadcasts state patches at **20Hz** (its default, and the right number for a casual arena shooter at our scale — bandwidth scales with tick rate, prediction is what makes it feel responsive, not a higher broadcast rate).
- **Room model:** one hardcoded room — client calls `client.joinOrCreate("arena")`. No lobby, no codes. Late joiners get full current state automatically from Colyseus on join. `maxClients` set generously for stream viewer count (~40).
- **Hit detection:** client raycasts locally for instant muzzle-flash/tracer feedback, sends `{origin, dir, timestamp}` to server; **server re-raycasts against its own authoritative positions and applies damage** — client-reported hit results are never trusted directly. No lag-compensation rewind buffer in v1 (explicit cut, see Risks).

## Contracts

### 1. Network protocol contract (Colyseus room `"arena"`)

**State schema** (`@colyseus/schema`):

```ts
class Player extends Schema {
  @type("number") x: number; @type("number") y: number; @type("number") z: number;
  @type("number") rotY: number;       // yaw only — pitch is client-local camera, never synced
  @type("number") hp: number;          // 0-100
  @type("number") kills: number;
  @type("number") deaths: number;
  @type("string") name: string;
  @type("boolean") alive: boolean;
}
class ArenaState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
}
```

**Client → server messages:**
| type | payload | frequency |
|---|---|---|
| `input` | `{ seq, dx, dz, jump, dt }` | every client physics tick (~60Hz), seq is the prediction-reconciliation key |
| `shoot` | `{ origin: {x,y,z}, dir: {x,y,z}, ts }` | on fire |
| `respawn` | `{}` | once, after death |

**Server → client messages (besides automatic state patches):**
| type | payload | meaning |
|---|---|---|
| `welcome` | `{ sessionId, spawnPoint }` | sent once on join |
| `hit` | `{ targetId, shooterId, damage, newHp }` | broadcast for hit-marker/sound FX |
| `death` | `{ targetId, killerId }` | broadcast for kill-feed UI |

State patches are automatic via Colyseus schema diffing at 20Hz — not hand-rolled.

### 2. HTTP contract

One Node process serves both the static client bundle and the WS upgrade, same origin, same port (no CORS to configure):

| route | response |
|---|---|
| `GET /` | client `index.html` + bundled assets |
| `GET /healthz` | `200 {"status":"ok","players":N}` — used by smoke test and manual go/no-go check |
| `ws://<host>:<port>/` | Colyseus WS upgrade, default path |

### 3. Asset contract

- Path convention: `client/public/models/<category>/<name>.glb` — categories `characters/`, `weapons/`, `props/`.
- Format: glTF/GLB only. Anything sourced as FBX/OBJ gets converted at import time (`FBX2glTF` or headless Blender) — never shipped as FBX to the client.
- Units: 1 unit = 1 meter, model forward = -Z (Three.js convention), scale baked in before export.
- Animation clips renamed on import to a fixed vocabulary: `idle`, `run`, `jump`, `shoot`, `death` — keeps the client's animation-mixer code asset-agnostic regardless of source pack.
- Every imported pack gets one line in `CREDITS.md`: source, license, URL. CC0 is the default; CC-BY is allowed only with the attribution text recorded; CC-BY-NC is not used (this is a public demo).
- Source packs (already vetted, all CC0 unless noted) — see `CREDITS.md` for the running list:
  - **KayKit Character Pack — Adventurers 1.0** (`git clone https://github.com/KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0`) — player model + melee/ranged weapon props, rigged + animated.
  - **KayKit Character Pack — Skeletons 1.0** — enemy/opponent models, 90+ animations.
  - **KayKit Dungeon Remastered 1.0** — arena/level geometry and props.
  - **Kenney Blaster Kit** (parse download link from `https://kenney.nl/assets/blaster-kit`) — ranged weapon models + projectile/impact FX props.
  - Optional stretch: Quaternius Ultimate Monsters / Ultimate Guns via the Poly Pizza API (`/list/{id}`, CC0-filtered) if more variety is wanted once core loop works.

### 4. Deployment contract (corp-server)

**Container primitive: LXC, not Docker.** corp-server's documented convention reserves Docker for a future VM ("LXC плохо подходит для Docker-heavy задач" — `docs/live-agent-sandbox-prd.md`); every existing app workload, including the closest precedent (CT242's public Node game-server preview), runs as a native Node process in an LXC managed by systemd. Following that convention instead of introducing Docker is the deliberate "container of choice" here — it matches existing ops tooling and has a working precedent on this exact infra.

| item | value |
|---|---|
| Primitive | new LXC container, cloned from existing template |
| Hostname | `sonnet-arena-01` |
| Network | private IP on `vmbr1`, `10.50.0.x` |
| Resources | 2 vCPU / 4GB RAM / 20GB disk (well inside the documented 2-4 vCPU / 6-8GB guidance; a 20Hz arena shooter for ≤40 players is light) |
| App process | single Node process (Colyseus server + static client, same port), `0.0.0.0:3100` — reuses the `3100` convention already used by CT242 |
| In-CT service | systemd unit `sonnet-arena-app.service`, `Restart=always` |
| Public exposure | host-side iptables DNAT, `Type=oneshot` systemd unit `sonnet-arena-nat.service`, public port `<CTID>80` per the established convention (e.g. CT244 → `24480`) forwarding to `<ct-ip>:3100` |
| TLS | **none** — corp-server has no reverse proxy/TLS layer yet; the page is served plain `http://`, which is consistent (no mixed-content issue) since nothing on it is loaded over https. Documented limitation, not a blocker for a stream demo. |
| Pre-deploy gate | corp-server's live-change policy requires an issue recording target CTID/IP/port/expected-effect/rollback **before** the NAT rule goes live — this is a hard gate on this infra, filed as part of Milestone 6 below, not skipped because it's "just a demo" |
| Rollback | `systemctl stop sonnet-arena-nat.service` (removes public exposure) + `pct stop <ctid>` |
| Shared link | `http://51.178.66.9:<port>/` |

### 5. Testing contract

| stage | what | gate |
|---|---|---|
| Solo | movement/camera/collision in one browser tab, no networking | feels right before any server work starts |
| Local multiplayer | two browser tabs vs `localhost` server | state sync, interpolation, hit registration all visibly correct |
| Bot load test | small Node script using the Colyseus client SDK spins up N (~30-40) headless fake clients with randomized input | server CPU/bandwidth stay healthy at expected stream concurrency, run **before** trusting the live deploy |
| Network degradation | throttle one tab via devtools (e.g. simulated latency/"Slow 3G") | prediction/reconciliation still feels acceptable, not just on perfect localhost |
| Remote smoke test | hit the actual deployed `http://51.178.66.9:<port>/` from outside the corp-server LAN (phone hotspot + laptop, two different networks) | WS upgrade survives the iptables DNAT path end-to-end — this exact class of bug is the one most likely to surprise us, since it's never been exercised for this app before |
| Go/no-go (right before going live) | `/healthz` returns 200; two real external devices can join, see each other move, shoot, die, respawn; no console errors | all must pass before sharing the link on stream |

## Milestones

| # | milestone | scope |
|---|---|---|
| M0 | Scaffold | Vite + Three.js client, Colyseus server skeleton, structured per `r48n34/ai-fps` as reference, `npm run dev` local loop |
| M1 | Movement & camera | PointerLockControls FPS camera, capsule collision vs. a boxy blockout level, single-player only |
| M2 | Networking skeleton | Colyseus room up, position/rotation sync only — two tabs see each other move |
| M3 | Combat | predicted shooting, server-validated raycast hit, hp/death/respawn, hit-marker + kill feed |
| M4 | Asset swap | blockout → real low-poly arena + KayKit characters + Kenney weapons + normalized animations (per asset contract) |
| M5 | Juice (cut-line candidate) | skybox/lighting pass, muzzle flash, name tags, basic SFX |
| M6 | Deploy | provision LXC per deployment contract, file the corp-server live-change issue, ship the systemd + NAT units, bot load test |
| M7 | Go-live | remote smoke test, go/no-go checklist, share the link on stream |

## Risks & cut-lines

- **No TLS on corp-server** — plain `http://` link. Acceptable for a live demo; flagged, not silently hidden.
- **Untested WS-through-iptables-DNAT path for this app** — mitigated by the explicit remote smoke test in M6/M7, not assumed to "just work" because CT242 ran an HTTP (not WS-heavy) app.
- **LXC resource ceiling unverified for real concurrency** — mitigated by the bot load test in M6, run before relying on the box live.
- **Live-change policy is a hard gate**, not a courtesy — corp-server requires the issue-with-rollback before opening the public port even for a one-off demo; budget time for it in M6.
- **If behind schedule, cut in this order:** M5 entirely → ship one weapon, not several → no enemy AI/bots, PvP-only → no respawn invulnerability frames → reuse the blockout level instead of a fully dressed arena. Never cut: movement feel, shooting that reliably registers, and the "one link, shared room" moment — that's the actual payload for the stream.

## Deliverable

`http://51.178.66.9:<port>/` shared live in stream chat. Viewers open it, land in the same `arena` room automatically, move and shoot each other in real time with low-poly CC0 art, in any modern browser, no install.
