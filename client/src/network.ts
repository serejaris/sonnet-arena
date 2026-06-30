import * as THREE from "three";
import { Client, getStateCallbacks } from "@colyseus/sdk";
import { CAPSULE_HEIGHT, CAPSULE_RADIUS, type NetworkInput } from "./playerController";
import type { PlayerController } from "./playerController";

/**
 * M2 networking: connects to the Colyseus "arena" room, sends this client's
 * predicted input every tick, reconciles the local player's predicted
 * position against the server's authoritative state, and renders/interpolates
 * every other connected player.
 *
 * The room is joined without a compile-time root schema (the client package
 * intentionally has no dependency on server/src/schema/ArenaState.ts — see
 * CLAUDE.md). Colyseus's reflection protocol means decoded state objects
 * (`room.state`, individual `Player` entries) carry their fields at runtime
 * regardless; this file only declares the minimal local shape it actually
 * reads from them.
 */

// Player.x/y/z/rotY/lastProcessedInputSeq as decoded by the SDK at runtime
// (see server/src/schema/ArenaState.ts for the authoritative definition).
interface RemotePlayerState {
  x: number;
  y: number;
  z: number;
  rotY: number;
  lastProcessedInputSeq: number;
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

interface RemotePlayer {
  mesh: THREE.Object3D;
  snapshots: RemoteSnapshot[];
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

function createRemotePlayerMesh(): THREE.Object3D {
  const group = new THREE.Group();

  const cylinderLength = Math.max(CAPSULE_HEIGHT - CAPSULE_RADIUS * 2, 0.01);
  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(CAPSULE_RADIUS, cylinderLength, 4, 8),
    new THREE.MeshStandardMaterial({ color: 0xdd4444 }),
  );
  body.position.y = CAPSULE_HEIGHT / 2;
  group.add(body);

  // Facing indicator — a capsule alone is rotationally symmetric around Y,
  // so without this `rotY` interpolation would be invisible. Sits on the
  // -Z side, matching the rotY=0 -> forward=(0,0,-1) convention shared with
  // playerController.ts / server/src/physics.ts.
  const nose = new THREE.Mesh(
    new THREE.BoxGeometry(0.18, 0.18, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xffe28a }),
  );
  nose.position.set(0, CAPSULE_HEIGHT - 0.3, -CAPSULE_RADIUS - 0.12);
  group.add(nose);

  return group;
}

function disposeMesh(object: THREE.Object3D): void {
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.geometry.dispose();
      if (Array.isArray(child.material)) {
        child.material.forEach((m) => m.dispose());
      } else {
        child.material.dispose();
      }
    }
  });
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

  constructor(
    private readonly scene: THREE.Scene,
    private readonly controller: PlayerController,
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

    const $ = getStateCallbacks(room);

    $(room.state as any).players.onAdd((player: RemotePlayerState, sessionId: string) => {
      if (sessionId === this.localSessionId) {
        // Reconciliation: re-run whenever ANY of this player's fields change
        // (x/y/z/rotY/lastProcessedInputSeq all live on the same instance,
        // and arrive together in one state patch).
        $(player as any).onChange(() => this.reconcileLocalPlayer(player));
        return;
      }

      const mesh = createRemotePlayerMesh();
      this.scene.add(mesh);
      const snapshots: RemoteSnapshot[] = [
        { x: player.x, y: player.y, z: player.z, rotY: player.rotY, t: performance.now() },
      ];
      applySnapshot(mesh, snapshots[0]);
      this.remotePlayers.set(sessionId, { mesh, snapshots });

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
      });
    });

    $(room.state as any).players.onRemove((_player: RemotePlayerState, sessionId: string) => {
      if (sessionId === this.localSessionId) return;
      const remote = this.remotePlayers.get(sessionId);
      if (!remote) return;
      this.scene.remove(remote.mesh);
      disposeMesh(remote.mesh);
      this.remotePlayers.delete(sessionId);
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

  /** Called once per render frame to advance remote-player interpolation. */
  updateRemoteInterpolation(): void {
    const renderTime = performance.now() - INTERP_DELAY_MS;
    for (const remote of this.remotePlayers.values()) {
      interpolateRemote(remote, renderTime);
    }
  }

  private reconcileLocalPlayer(player: RemotePlayerState): void {
    this.pendingInputs = this.pendingInputs.filter((input) => input.seq > player.lastProcessedInputSeq);
    this.controller.applyServerCorrection(
      { x: player.x, y: player.y, z: player.z },
      this.pendingInputs,
    );
  }
}
