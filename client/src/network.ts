import * as THREE from "three";
import { Client, getStateCallbacks } from "@colyseus/sdk";
import type { NetworkInput } from "./playerController";
import type { PlayerController } from "./playerController";
import type { Hud } from "./hud";
import { createRemoteCharacter, type AnimName, type RemoteCharacter } from "./character";

/**
 * M2/M3 networking: connects to the Colyseus "arena" room, sends this
 * client's predicted input every tick, reconciles the local player's
 * predicted position against the server's authoritative state, renders/
 * interpolates every other connected player, sends combat messages
 * (`shoot`/`respawn`) and reacts to the server's combat broadcasts
 * (`hit`/`death`) plus the local player's own hp/alive schema fields.
 *
 * The room is joined without a compile-time root schema (the client package
 * intentionally has no dependency on server/src/schema/ArenaState.ts — see
 * CLAUDE.md). Colyseus's reflection protocol means decoded state objects
 * (`room.state`, individual `Player` entries) carry their fields at runtime
 * regardless; this file only declares the minimal local shape it actually
 * reads from them.
 */

// Player.x/y/z/rotY/hp/alive/lastProcessedInputSeq as decoded by the SDK at
// runtime (see server/src/schema/ArenaState.ts for the authoritative
// definition).
interface RemotePlayerState {
  x: number;
  y: number;
  z: number;
  rotY: number;
  hp: number;
  alive: boolean;
  lastProcessedInputSeq: number;
}

// Server broadcasts, per PLAN.md's network protocol contract / the M3 server
// report in server/src/rooms/ArenaRoom.ts.
interface HitMessage {
  targetId: string;
  shooterId: string;
  damage: number;
  newHp: number;
}

interface DeathMessage {
  targetId: string;
  killerId: string;
}

// One input this client sent, kept around until the server confirms it was
// processed (lastProcessedInputSeq >= seq), for reconciliation replay.
interface BufferedInput extends NetworkInput {
  seq: number;
  dt: number;
}

interface RemoteSnapshot {
  x: number;
  y: number;
  z: number;
  rotY: number;
  /** Local performance.now() timestamp this snapshot was received at. */
  t: number;
}

// Per-remote-player character model/animation state (M4 asset swap). The
// glTF clone loads asynchronously (see character.ts), so `loaded` starts
// null and this whole struct is populated in place once it resolves —
// `mesh`/`snapshots` above don't wait on it, interpolation works from the
// very first snapshot regardless of asset load latency.
interface RemoteCharacterState {
  loaded: RemoteCharacter | null;
  /** The continuous locomotion/death state currently playing (excludes the transient "shoot" overlay — see shootUntil). */
  currentAnim: AnimName;
  alive: boolean;
  /** performance.now() timestamp until which a triggered "shoot" one-shot should keep playing uninterrupted by the idle/run/jump/death state machine. */
  shootUntil: number;
}

interface RemotePlayer {
  mesh: THREE.Object3D;
  snapshots: RemoteSnapshot[];
  character: RemoteCharacterState;
}

// Fixed render-behind delay for remote-player interpolation (Gambetta-style
// entity interpolation): we always render remote players slightly in the
// past so there are (usually) two real snapshots to lerp between instead of
// extrapolating or visibly teleporting between 20Hz state updates.
const INTERP_DELAY_MS = 100;

// Cap on buffered snapshots per remote player — generous relative to what
// INTERP_DELAY_MS actually needs, just bounds memory if a tab is
// backgrounded and misses render frames for a while.
const MAX_SNAPSHOTS = 10;

// Animation state thresholds (M4). Real server-authoritative x/z/y are
// exact (no sensor noise), so these only need to clear float jitter, not
// filter real signal — well below playerController.ts's MOVE_SPEED (6 m/s)
// and JUMP_SPEED (9 m/s, decelerating under gravity) so genuine
// movement/jumps clear them comfortably.
const RUN_SPEED_THRESHOLD = 0.5; // m/s horizontal
const JUMP_RISE_SPEED_THRESHOLD = 1.0; // m/s vertical, rising only
const ANIM_CROSSFADE_S = 0.15;

function createRemotePlayerWrapper(): THREE.Object3D {
  // Empty until the shared character template (character.ts) finishes
  // loading and this player's clone is attached — interpolation still
  // works immediately since applySnapshot/interpolateRemote only ever
  // touch this wrapper's position/rotation, never its children.
  return new THREE.Group();
}

/** Shortest-path lerp between two angles (radians), avoiding the ±π wraparound jump. */
function lerpAngle(from: number, to: number, t: number): number {
  const twoPi = Math.PI * 2;
  let delta = (to - from) % twoPi;
  if (delta > Math.PI) delta -= twoPi;
  if (delta < -Math.PI) delta += twoPi;
  return from + delta * t;
}

function applySnapshot(mesh: THREE.Object3D, snapshot: RemoteSnapshot): void {
  mesh.position.set(snapshot.x, snapshot.y, snapshot.z);
  mesh.rotation.y = snapshot.rotY;
}

/** Interpolates `mesh` to `renderTime` using the buffered snapshots, per the M2 task spec's ~100ms delay scheme. */
function interpolateRemote(remote: RemotePlayer, renderTime: number): void {
  const snapshots = remote.snapshots;
  if (snapshots.length === 0) return;
  if (snapshots.length === 1) {
    applySnapshot(remote.mesh, snapshots[0]);
    return;
  }

  const oldest = snapshots[0];
  const newest = snapshots[snapshots.length - 1];

  if (renderTime <= oldest.t) {
    applySnapshot(remote.mesh, oldest);
    return;
  }
  if (renderTime >= newest.t) {
    // Network hiccup / no fresher data yet — hold at the latest known
    // snapshot rather than extrapolate (simplest, avoids overshoot jitter).
    applySnapshot(remote.mesh, newest);
    return;
  }

  for (let i = 0; i < snapshots.length - 1; i++) {
    const from = snapshots[i];
    const to = snapshots[i + 1];
    if (renderTime >= from.t && renderTime <= to.t) {
      const span = to.t - from.t;
      const alpha = span > 0 ? (renderTime - from.t) / span : 1;
      remote.mesh.position.set(
        THREE.MathUtils.lerp(from.x, to.x, alpha),
        THREE.MathUtils.lerp(from.y, to.y, alpha),
        THREE.MathUtils.lerp(from.z, to.z, alpha),
      );
      remote.mesh.rotation.y = lerpAngle(from.rotY, to.rotY, alpha);
      return;
    }
  }
}

export class NetworkClient {
  private room: Awaited<ReturnType<Client["joinOrCreate"]>> | null = null;
  private localSessionId: string | null = null;
  private seq = 0;
  private pendingInputs: BufferedInput[] = [];
  private readonly remotePlayers = new Map<string, RemotePlayer>();

  // Mirrors the schema default (Player.alive = true) so shooting is enabled
  // from the moment the local player connects, before the first state patch
  // arrives.
  private localAlive = true;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly controller: PlayerController,
    private readonly hud: Hud,
  ) {}

  async connect(): Promise<void> {
    const endpoint = import.meta.env.DEV
      ? "ws://localhost:2567"
      : location.origin.replace(/^http/, "ws");

    const client = new Client(endpoint);
    const room = await client.joinOrCreate("arena");
    this.room = room;
    this.localSessionId = room.sessionId;
    console.log("joined", room.sessionId);

    room.onMessage("welcome", (message: { sessionId: string; spawnPoint: { x: number; y: number; z: number } }) => {
      console.log("welcome", message);
    });

    const $ = getStateCallbacks(room);

    $(room.state as any).players.onAdd((player: RemotePlayerState, sessionId: string) => {
      if (sessionId === this.localSessionId) {
        // Reconciliation: re-run whenever ANY of this player's fields change
        // (x/y/z/rotY/hp/alive/lastProcessedInputSeq all live on the same
        // instance, and arrive together in one state patch). hp/alive are
        // driven from this same schema-onChange path rather than from the
        // "hit"/"death" broadcasts below — it's the same pattern already
        // established for position, and stays correct even if a broadcast
        // is ever missed.
        $(player as any).onChange(() => {
          this.reconcileLocalPlayer(player);
          this.updateLocalCombatState(player);
        });
        return;
      }

      const mesh = createRemotePlayerWrapper();
      this.scene.add(mesh);
      const snapshots: RemoteSnapshot[] = [
        { x: player.x, y: player.y, z: player.z, rotY: player.rotY, t: performance.now() },
      ];
      applySnapshot(mesh, snapshots[0]);
      const remote: RemotePlayer = {
        mesh,
        snapshots,
        character: { loaded: null, currentAnim: "idle", alive: player.alive, shootUntil: 0 },
      };
      this.remotePlayers.set(sessionId, remote);

      // Fire-and-forget: resolves against the shared cached template (see
      // character.ts), so only the very first remote player pays real load
      // latency. Guarded by the map lookup in case this player already
      // disconnected by the time it resolves.
      createRemoteCharacter()
        .then((rc) => {
          if (!this.remotePlayers.has(sessionId)) return;
          remote.character.loaded = rc;
          mesh.add(rc.root);
          rc.actions.idle?.play();
        })
        .catch((err) => console.error("failed to load remote character model", err));

      $(player as any).onChange(() => {
        const remote = this.remotePlayers.get(sessionId);
        if (!remote) return;
        remote.snapshots.push({
          x: player.x,
          y: player.y,
          z: player.z,
          rotY: player.rotY,
          t: performance.now(),
        });
        if (remote.snapshots.length > MAX_SNAPSHOTS) {
          remote.snapshots.splice(0, remote.snapshots.length - MAX_SNAPSHOTS);
        }
        remote.character.alive = player.alive;
      });
    });

    $(room.state as any).players.onRemove((_player: RemotePlayerState, sessionId: string) => {
      if (sessionId === this.localSessionId) return;
      const remote = this.remotePlayers.get(sessionId);
      if (!remote) return;
      this.scene.remove(remote.mesh);
      // Deliberately no geometry/material .dispose() here: SkeletonUtils.clone
      // (character.ts) reuses the shared template's geometries/materials by
      // reference across every remote player's clone (see its own doc
      // comment) — disposing them on one player leaving would pull the GPU
      // buffers out from under every other still-connected player using the
      // same character model.
      this.remotePlayers.delete(sessionId);
    });

    // Hit-marker confirmation for shots THIS client fired, and a best-effort
    // "shoot" animation trigger for bystanders watching whoever fired (both
    // driven off the same broadcast — misses aren't broadcast at all, so a
    // remote player's shoot animation simply won't play for shots that miss
    // everyone, which is an accepted gap, not a bug). Damage itself is never
    // applied from this broadcast — see updateLocalCombatState/the local
    // player's own hp/alive onChange above for that.
    room.onMessage("hit", (message: HitMessage) => {
      if (message.shooterId === this.localSessionId) {
        this.hud.showHitMarker();
        return;
      }
      const shooter = this.remotePlayers.get(message.shooterId);
      if (shooter) this.triggerRemoteShoot(shooter);
    });

    room.onMessage("death", (message: DeathMessage) => {
      const killerName = this.lookupPlayerName(message.killerId);
      const victimName = this.lookupPlayerName(message.targetId);
      this.hud.addKillFeedEntry(killerName, victimName);
    });
  }

  /** Called once per local physics tick with the input that just drove prediction. */
  sendInput(input: NetworkInput, dt: number): void {
    if (!this.room) return;

    const seq = this.seq++;
    const message = { seq, dz: input.dz, dx: input.dx, jump: input.jump, dt, rotY: input.rotY };
    this.room.send("input", message);
    this.pendingInputs.push(message);
  }

  /** Called once per render frame to advance remote-player interpolation and character animation. */
  updateRemoteInterpolation(delta: number): void {
    const renderTime = performance.now() - INTERP_DELAY_MS;
    const now = performance.now();
    for (const remote of this.remotePlayers.values()) {
      interpolateRemote(remote, renderTime);
      this.updateRemoteAnimationState(remote, now);
      remote.character.loaded?.mixer.update(delta);
    }
  }

  /** Decides idle/run/jump/death every frame from data already tracked on `remote` — see the RemoteCharacterState doc comment. */
  private updateRemoteAnimationState(remote: RemotePlayer, now: number): void {
    if (!remote.character.loaded) return; // model still loading — nothing to animate yet

    if (!remote.character.alive) {
      if (remote.character.currentAnim !== "death") {
        this.setRemoteAnim(remote, "death", true);
      }
      return;
    }

    // A "shoot" one-shot is currently overlaying idle/run/jump — let it
    // finish before the continuous state machine below resumes driving.
    if (now < remote.character.shootUntil) return;

    const desired = this.computeContinuousAnim(remote);
    if (desired !== remote.character.currentAnim) {
      this.setRemoteAnim(remote, desired, false);
    }
  }

  /** idle vs run vs jump, purely from the two most recent position snapshots — see RUN_SPEED_THRESHOLD/JUMP_RISE_SPEED_THRESHOLD. */
  private computeContinuousAnim(remote: RemotePlayer): AnimName {
    const snapshots = remote.snapshots;
    if (snapshots.length < 2) return "idle";

    const from = snapshots[snapshots.length - 2];
    const to = snapshots[snapshots.length - 1];
    const dt = (to.t - from.t) / 1000;
    if (dt <= 0) return remote.character.currentAnim;

    const risingSpeed = (to.y - from.y) / dt;
    if (risingSpeed > JUMP_RISE_SPEED_THRESHOLD) return "jump";

    const horizontalSpeed = Math.hypot(to.x - from.x, to.z - from.z) / dt;
    return horizontalSpeed > RUN_SPEED_THRESHOLD ? "run" : "idle";
  }

  /** Crossfades from whatever continuous action is currently playing into `name`, tracked as the new `currentAnim`. */
  private setRemoteAnim(remote: RemotePlayer, name: AnimName, loopOnce: boolean): void {
    const rc = remote.character.loaded;
    if (!rc) return;
    const next = rc.actions[name];
    if (!next) return; // best-effort — that vocabulary slot has no clip in this pack (see character.ts's CLIP_NAMES)

    const prev = remote.character.currentAnim !== name ? rc.actions[remote.character.currentAnim] : undefined;

    next.reset();
    next.setLoop(loopOnce ? THREE.LoopOnce : THREE.LoopRepeat, loopOnce ? 1 : Infinity);
    next.clampWhenFinished = loopOnce;
    next.play();
    if (prev && prev !== next) {
      next.crossFadeFrom(prev, ANIM_CROSSFADE_S, false);
    }
    remote.character.currentAnim = name;
  }

  /** Best-effort "shoot" one-shot for a remote player another client's shot was attributed to (see the "hit" handler). */
  private triggerRemoteShoot(remote: RemotePlayer): void {
    if (!remote.character.alive) return; // don't overlay a shoot pose on a dead ragdoll-less character
    const action = remote.character.loaded?.actions.shoot;
    if (!action) return;

    this.setRemoteAnim(remote, "shoot", true);
    remote.character.shootUntil = performance.now() + action.getClip().duration * 1000;
  }

  private reconcileLocalPlayer(player: RemotePlayerState): void {
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > player.lastProcessedInputSeq);
    this.controller.applyServerCorrection(
      { x: player.x, y: player.y, z: player.z },
      this.pendingInputs,
    );
  }

  private updateLocalCombatState(player: RemotePlayerState): void {
    this.hud.setHp(player.hp);
    this.localAlive = player.alive;
    if (player.alive) {
      this.hud.hideDeathOverlay();
    } else {
      this.hud.showDeathOverlay();
    }
  }

  private lookupPlayerName(sessionId: string): string {
    const player = (this.room?.state as any)?.players?.get(sessionId);
    if (player && typeof player.name === "string" && player.name.length > 0) {
      return player.name;
    }
    return sessionId.slice(0, 6);
  }

  /** Whether the local player is currently alive — gates shoot input (see weapon.ts). */
  isAlive(): boolean {
    return this.localAlive;
  }

  /** Meshes of every OTHER connected player, for the client's local instant-feedback raycast (see weapon.ts). */
  getRemoteMeshes(): THREE.Object3D[] {
    return [...this.remotePlayers.values()].map((remote) => remote.mesh);
  }

  /** Sends this client's "shoot" message — server re-raycasts authoritatively, see PLAN.md. */
  shoot(origin: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }): void {
    if (!this.room) return;
    this.room.send("shoot", { origin, dir, ts: Date.now() });
  }

  /** Sends the one-shot "respawn" message after death. */
  respawn(): void {
    if (!this.room) return;
    this.room.send("respawn", {});
  }
}
