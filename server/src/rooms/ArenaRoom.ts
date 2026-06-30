import { Room, Client } from "colyseus";
import type { MeshBVH } from "three-mesh-bvh";
import { ArenaState, Player } from "../schema/ArenaState.js";
import { buildLevelBVH, SPAWN_POSITION } from "../level.js";
import { stepPlayerPhysics } from "../physics.js";

// Backs getPlayerCount() for /healthz — simple module-level counter,
// no event-emitter abstraction needed for one number.
let playerCount = 0;

// Sanity clamp against a malicious/buggy client sending a huge dt (e.g. tab
// backgrounded then foregrounded) — basic server-authoritative guard, not a
// full anti-cheat pass.
const MAX_DT = 0.1;

// M2 input message. EXTENDS PLAN.md's literal table ({seq, dx, dz, jump, dt})
// with `rotY`: the camera yaw in radians. Player.rotY exists in the schema
// specifically so other clients can render facing direction, and `input` is
// the only message channel that carries client state up to the server — so
// rotY rides along here rather than opening a second message type for it.
// Documented deviation, see CLAUDE.md "Известные отклонения".
interface InputMessage {
  seq: number;
  dx: number;
  dz: number;
  jump: boolean;
  dt: number;
  rotY: number;
}

// Per-session physics state that is NOT part of the broadcast schema:
// velocityY persists frame-to-frame (gravity integration), grounded gates
// jump. velocity.x/z are not stored here because they're fully recomputed
// from input every tick (mirrors playerController.ts's applyInput, which
// overwrites velocity.x/z wholesale and only ever accumulates velocity.y).
interface PhysicsSessionState {
  velocityY: number;
  grounded: boolean;
}

// Colyseus 0.17's Room<T> generic takes an options shape ({ state, metadata, client }),
// not the bare state class directly (that was the pre-0.17 API). `this.state` is still
// typed as ArenaState via this shape.
export class ArenaRoom extends Room<{ state: ArenaState }> {
  maxClients = 40; // generous, per PLAN.md "stream viewer count ~40"

  private readonly levelBVH: MeshBVH = buildLevelBVH();
  private readonly physicsStates = new Map<string, PhysicsSessionState>();

  onCreate(_options: any) {
    this.setState(new ArenaState());

    this.onMessage("input", (client, message: InputMessage) => {
      const player = this.state.players.get(client.sessionId);
      const physicsState = this.physicsStates.get(client.sessionId);
      if (!player || !physicsState) return;

      const dt = Number.isFinite(message.dt) ? Math.min(Math.max(message.dt, 0), MAX_DT) : 0;

      const result = stepPlayerPhysics(
        {
          x: player.x,
          y: player.y,
          z: player.z,
          velocityY: physicsState.velocityY,
          grounded: physicsState.grounded,
        },
        { dx: message.dx, dz: message.dz, jump: message.jump, dt, rotY: message.rotY },
        this.levelBVH,
      );

      player.x = result.x;
      player.y = result.y;
      player.z = result.z;
      player.rotY = message.rotY; // trusted directly — yaw isn't security-sensitive for this demo
      player.lastProcessedInputSeq = message.seq;

      physicsState.velocityY = result.velocityY;
      physicsState.grounded = result.grounded;
    });

    // Placeholder handlers — combat logic implemented in M3.
    this.onMessage("shoot", (_client, _message) => {
      // implemented in M3
    });

    this.onMessage("respawn", (_client, _message) => {
      // implemented in M3
    });
  }

  onJoin(client: Client, options: any) {
    const player = new Player();
    player.x = SPAWN_POSITION.x;
    player.y = SPAWN_POSITION.y;
    player.z = SPAWN_POSITION.z;
    player.name = options?.name ?? "Player";

    this.state.players.set(client.sessionId, player);
    this.physicsStates.set(client.sessionId, { velocityY: 0, grounded: false });
    playerCount++;

    client.send("welcome", {
      sessionId: client.sessionId,
      spawnPoint: { x: SPAWN_POSITION.x, y: SPAWN_POSITION.y, z: SPAWN_POSITION.z },
    });
  }

  onLeave(client: Client) {
    this.state.players.delete(client.sessionId);
    this.physicsStates.delete(client.sessionId);
    playerCount--;
  }
}

export function getPlayerCount(): number {
  return playerCount;
}
