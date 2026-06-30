import { Room, Client } from "colyseus";
import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { ArenaState, Player } from "../schema/ArenaState.js";
import { buildLevelBVH, RESPAWN_POINTS, SPAWN_POSITION } from "../level.js";
import { stepPlayerPhysics } from "../physics.js";
import { resolveShot, SHOT_COOLDOWN_MS, SHOT_DAMAGE } from "../combat.js";

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
// lastShotAt (M3): server-side fire-rate guard timestamp, deliberately keyed
// off Date.now() at receipt time, never the client-supplied shoot.ts — a
// client could lie about ts to dodge a ts-based cooldown.
interface PhysicsSessionState {
  velocityY: number;
  grounded: boolean;
  lastShotAt: number;
}

interface Vec3Message {
  x: number;
  y: number;
  z: number;
}

// M3 "shoot" message, per PLAN.md's network protocol contract table.
interface ShootMessage {
  origin: Vec3Message;
  dir: Vec3Message;
  ts: number;
}

function isFiniteVec3(v: unknown): v is Vec3Message {
  if (!v || typeof v !== "object") return false;
  const { x, y, z } = v as Vec3Message;
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z);
}

// Colyseus 0.17's Room<T> generic takes an options shape ({ state, metadata, client }),
// not the bare state class directly (that was the pre-0.17 API). `this.state` is still
// typed as ArenaState via this shape.
export class ArenaRoom extends Room<{ state: ArenaState }> {
  maxClients = 40; // generous, per PLAN.md "stream viewer count ~40"

  private readonly levelBVH: MeshBVH = buildLevelBVH();
  private readonly physicsStates = new Map<string, PhysicsSessionState>();
  // Round-robins through RESPAWN_POINTS across all respawns in the room
  // (not keyed per-session) — simplest way to guarantee consecutive
  // respawns spread out instead of everyone landing on the same point.
  private respawnPointIndex = 0;

  onCreate(_options: any) {
    this.setState(new ArenaState());

    this.onMessage("input", (client, message: InputMessage) => {
      const player = this.state.players.get(client.sessionId);
      const physicsState = this.physicsStates.get(client.sessionId);
      if (!player || !physicsState) return;
      if (!player.alive) return; // dead players stay put until they respawn

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

    this.onMessage("shoot", (client, message: ShootMessage) => {
      const shooter = this.state.players.get(client.sessionId);
      const physicsState = this.physicsStates.get(client.sessionId);
      if (!shooter || !physicsState) return; // defensive: unknown/already-left session
      if (!shooter.alive) return; // dead players can't shoot

      const now = Date.now();
      if (now - physicsState.lastShotAt < SHOT_COOLDOWN_MS) return; // fire-rate guard

      if (!isFiniteVec3(message?.origin) || !isFiniteVec3(message?.dir)) return;

      const dir = new THREE.Vector3(message.dir.x, message.dir.y, message.dir.z);
      if (dir.lengthSq() < 1e-8) return; // can't normalize a zero-length direction
      dir.normalize();
      const origin = new THREE.Vector3(message.origin.x, message.origin.y, message.origin.z);

      // Consume the cooldown only for a well-formed shot attempt — malformed
      // payloads are rejected for free above without gating the next real shot.
      physicsState.lastShotAt = now;

      const hit = resolveShot(origin, dir, this.levelBVH, this.state.players.entries(), client.sessionId);
      if (!hit) return; // miss — client already rendered its own local tracer, no broadcast needed

      const target = this.state.players.get(hit.targetId);
      if (!target) return; // target left the room between resolveShot and here

      const newHp = Math.max(0, target.hp - SHOT_DAMAGE);
      target.hp = newHp;

      this.broadcast("hit", {
        targetId: hit.targetId,
        shooterId: client.sessionId,
        damage: SHOT_DAMAGE,
        newHp,
      });

      if (newHp <= 0) {
        target.alive = false;
        shooter.kills += 1;
        target.deaths += 1;
        this.broadcast("death", { targetId: hit.targetId, killerId: client.sessionId });
      }
    });

    this.onMessage("respawn", (client, _message) => {
      const player = this.state.players.get(client.sessionId);
      const physicsState = this.physicsStates.get(client.sessionId);
      if (!player || !physicsState) return;
      if (player.alive) return; // only meaningful after death

      const spawn = RESPAWN_POINTS[this.respawnPointIndex % RESPAWN_POINTS.length];
      this.respawnPointIndex++;

      player.x = spawn.x;
      player.y = spawn.y;
      player.z = spawn.z;
      player.hp = 100;
      player.alive = true;

      // Mirrors onJoin's initial physics state — next physics tick determines
      // real groundedness via collision, this just guarantees no stale
      // pre-death falling velocity carries over.
      physicsState.velocityY = 0;
      physicsState.grounded = false;
    });
  }

  onJoin(client: Client, options: any) {
    const player = new Player();
    player.x = SPAWN_POSITION.x;
    player.y = SPAWN_POSITION.y;
    player.z = SPAWN_POSITION.z;
    player.name = options?.name ?? "Player";

    this.state.players.set(client.sessionId, player);
    this.physicsStates.set(client.sessionId, { velocityY: 0, grounded: false, lastShotAt: 0 });
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
