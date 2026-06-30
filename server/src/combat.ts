import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";
import { CAPSULE_HEIGHT, CAPSULE_RADIUS } from "./physics.js";

/**
 * Server-authoritative hit resolution for the "shoot" message. Per PLAN.md's
 * "Hit detection" stack decision: the client raycasts locally for instant
 * tracer/muzzle-flash feedback, but the server NEVER trusts a client-reported
 * hit — it always re-raycasts here against its own authoritative positions
 * and the same level MeshBVH used for movement collision.
 *
 * Pure functions only (mirrors physics.ts's shape): no Colyseus/Room
 * dependency, so this is independently testable and ArenaRoom.ts stays a
 * thin message-handling shell around it.
 */

// Generous given the ~40x40 arena (PLAN.md's own framing for the figure).
export const WEAPON_RANGE = 100;

// 25 dmg/hit -> 4 hits to kill at 100 hp, a casual-arena-shooter pace (not
// instant 1-2 shot, not a bullet-sponge grind) — picked as the sensible
// default the task description calls out, no project precedent to override it.
export const SHOT_DAMAGE = 25;

// Minimal abuse-prevention fire-rate guard, not full anti-cheat: rejects a
// session firing more often than 4 shots/sec server-side, independent of
// whatever rate the client's weapon model claims to allow.
export const SHOT_COOLDOWN_MS = 250;

export interface ShootTarget {
  x: number;
  y: number;
  z: number;
  alive: boolean;
}

export interface ShotResult {
  targetId: string;
  /** Distance along the ray from origin to the closest-approach point — used to pick the nearest of several candidate hits. */
  distance: number;
}

// Scratch objects for closestRaySegmentDistance, reused across calls. Safe
// for the same reason physics.ts's scratch objects are: Node is
// single-threaded and each call fully consumes scratch state before
// returning, so no call observes another call's in-flight values.
const segDir = new THREE.Vector3();
const originToSegStart = new THREE.Vector3();
const closestOnRay = new THREE.Vector3();
const closestOnSeg = new THREE.Vector3();

/**
 * Closest distance between a ray (origin, unit dir, s >= 0 only — a ray has
 * no far end of its own) and a bounded segment [segStart, segEnd].
 *
 * Adapted from the standard closest-point-between-two-segments algorithm
 * (Ericson, "Real-Time Collision Detection" 5.1.9), with segment 1 (the ray)
 * clamped only at its lower bound (s >= 0) instead of both [0,1] — callers
 * clamp the upper bound against weapon range / level-obstruction distance
 * separately, since those are gameplay constraints, not geometry.
 *
 * "Closest-point-between-ray-and-segment" is explicitly sufficient here
 * (not exact capsule entry-point math) — this is an arena shooter, not a
 * simulation requiring precise surface-entry coordinates.
 */
function closestRaySegmentDistance(
  rayOrigin: THREE.Vector3,
  rayDir: THREE.Vector3,
  segStart: THREE.Vector3,
  segEnd: THREE.Vector3,
): { distance: number; rayDistance: number } {
  const EPS = 1e-8;

  segDir.subVectors(segEnd, segStart);
  originToSegStart.subVectors(rayOrigin, segStart);

  const e = segDir.dot(segDir);
  const c = rayDir.dot(originToSegStart); // a (= rayDir.dot(rayDir)) is 1, rayDir is unit

  let s: number;
  let t: number;

  if (e < EPS) {
    // Segment degenerates to a point.
    t = 0;
    s = Math.max(0, -c);
  } else {
    const f = segDir.dot(originToSegStart);
    const b = rayDir.dot(segDir);
    const denom = e - b * b; // a*e - b*b, a = 1
    s = Math.max(0, denom !== 0 ? (b * f - c * e) / denom : 0);
    t = (b * s + f) / e;

    if (t < 0) {
      t = 0;
      s = Math.max(0, -c);
    } else if (t > 1) {
      t = 1;
      s = Math.max(0, b - c);
    }
  }

  closestOnRay.copy(rayOrigin).addScaledVector(rayDir, s);
  closestOnSeg.copy(segStart).addScaledVector(segDir, t);

  return { distance: closestOnRay.distanceTo(closestOnSeg), rayDistance: s };
}

/**
 * Resolves one "shoot" message into at most one hit target. `dir` must
 * already be normalized. `players` is every player in the room (the shooter
 * is excluded internally via `shooterId`, dead players never count as
 * targets).
 *
 * Two-stage check per PLAN.md/level-obstruction requirement:
 *  1. Raycast the level BVH first to find the nearest wall/obstacle distance
 *     — a candidate player hit farther along the ray than this is behind a
 *     wall and discarded.
 *  2. For every other alive player, test the ray's closest approach to their
 *     vertical capsule centerline; within CAPSULE_RADIUS and within both
 *     WEAPON_RANGE and the obstruction distance counts as a candidate.
 * Among valid candidates, the closest (smallest distance along the ray) wins.
 */
export function resolveShot(
  origin: THREE.Vector3,
  dir: THREE.Vector3,
  levelBVH: MeshBVH,
  players: Iterable<[string, ShootTarget]>,
  shooterId: string,
): ShotResult | null {
  const ray = new THREE.Ray(origin, dir);

  const levelHit = levelBVH.raycastFirst(ray, undefined, 0, WEAPON_RANGE);
  const obstructionDistance = levelHit ? levelHit.distance : WEAPON_RANGE;

  let closest: ShotResult | null = null;

  for (const [sessionId, target] of players) {
    if (sessionId === shooterId || !target.alive) continue;

    const segStart = new THREE.Vector3(target.x, target.y + CAPSULE_RADIUS, target.z);
    const segEnd = new THREE.Vector3(target.x, target.y + CAPSULE_HEIGHT - CAPSULE_RADIUS, target.z);

    const { distance, rayDistance } = closestRaySegmentDistance(origin, dir, segStart, segEnd);

    if (distance > CAPSULE_RADIUS) continue; // ray doesn't pass close enough to this player
    if (rayDistance > WEAPON_RANGE) continue; // out of weapon range
    if (rayDistance > obstructionDistance) continue; // a wall is in front of this player

    if (closest && rayDistance >= closest.distance) continue; // a closer candidate already won

    closest = { targetId: sessionId, distance: rayDistance };
  }

  return closest;
}
