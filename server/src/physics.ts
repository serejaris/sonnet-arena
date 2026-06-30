import * as THREE from "three";
import type { MeshBVH } from "three-mesh-bvh";

/**
 * Server-authoritative mirror of client/src/playerController.ts's capsule
 * movement + collision algorithm. Constants and the BVH shapecast approach
 * below must match the client exactly (same gravity, jump speed, capsule
 * radius/height) — otherwise client-side prediction (added later) will
 * visibly diverge from what the server reconciles back to.
 *
 * Unlike the client controller, this is a pure step function: no PointerLockControls,
 * no camera, no persistent class instance. The only piece of "camera" state it needs
 * (yaw, to rotate raw dx/dz input into world-space movement) arrives explicitly as
 * `rotY` in the input, since the server never owns a camera of its own.
 */

const GRAVITY = -30;
const JUMP_SPEED = 9;
const MOVE_SPEED = 6;

// Exported: M3's combat.ts needs the exact same capsule dimensions to build
// the per-player hit-test segment that movement collision already uses here.
export const CAPSULE_RADIUS = 0.4;
export const CAPSULE_HEIGHT = 1.8;

// Below this, the player is assumed to have fallen out of the level — mirrors
// client/src/playerController.ts's RESPAWN_Y_THRESHOLD fall-recovery behavior.
const RESPAWN_Y_THRESHOLD = -25;

const UP = new THREE.Vector3(0, 1, 0);

export interface PlayerPhysicsState {
  x: number;
  y: number;
  z: number;
  velocityY: number;
  grounded: boolean;
}

export interface PlayerInput {
  /** Strafe/right axis intent, e.g. -1 (A/left) .. +1 (D/right). */
  dx: number;
  /** Forward axis intent, e.g. -1 (S/backward) .. +1 (W/forward). */
  dz: number;
  jump: boolean;
  /** Seconds since this input's previous tick. Caller is expected to have clamped this. */
  dt: number;
  /** Camera yaw in radians — used to rotate dx/dz (input-local) into world-space movement. */
  rotY: number;
}

// Scratch objects reused across calls. Safe because Node is single-threaded and every
// call fully consumes its scratch state into the returned plain object before returning
// — no scratch value is read by a later call before this call finishes writing it.
// Must be an actual THREE.Camera (not a plain Object3D): Camera.getWorldDirection()
// negates the base Object3D implementation to match the -Z "looking direction"
// camera convention. playerController.ts calls camera.getWorldDirection() on a real
// PerspectiveCamera client-side — using a plain Object3D here would silently invert
// forward/backward and strafe direction relative to the client.
const dummyYaw = new THREE.PerspectiveCamera();
const forwardVec = new THREE.Vector3();
const rightVec = new THREE.Vector3();
const moveDir = new THREE.Vector3();
const position = new THREE.Vector3();
const velocity = new THREE.Vector3();
const segment = new THREE.Line3();
const bounds = new THREE.Box3();
const triPoint = new THREE.Vector3();
const capsulePoint = new THREE.Vector3();
const correction = new THREE.Vector3();

/**
 * Advances one player's capsule by one input tick: gravity + WASD-style
 * movement (input rotated by rotY) + capsule-vs-level collision via the
 * level BVH. Mirrors playerController.ts's update() -> applyInput() ->
 * resolveCollisions() pipeline, minus anything camera/DOM-related.
 */
export function stepPlayerPhysics(
  current: PlayerPhysicsState,
  input: PlayerInput,
  levelBVH: MeshBVH,
): PlayerPhysicsState {
  const dt = input.dt;

  position.set(current.x, current.y, current.z);
  velocity.set(0, current.velocityY, 0);
  let grounded = current.grounded;

  // --- applyInput (mirrors playerController.applyInput) ---
  dummyYaw.rotation.set(0, input.rotY, 0);
  dummyYaw.getWorldDirection(forwardVec); // getWorldDirection updates the world matrix itself
  forwardVec.y = 0;
  forwardVec.normalize();
  rightVec.crossVectors(forwardVec, UP).normalize();

  moveDir.set(0, 0, 0);
  if (input.dz !== 0 || input.dx !== 0) {
    moveDir.addScaledVector(forwardVec, input.dz).addScaledVector(rightVec, input.dx);
    if (moveDir.lengthSq() > 0) moveDir.normalize();
  }

  velocity.x = moveDir.x * MOVE_SPEED;
  velocity.z = moveDir.z * MOVE_SPEED;

  if (input.jump && grounded) {
    velocity.y = JUMP_SPEED;
    grounded = false;
  }

  // --- gravity + integrate (mirrors update()) ---
  velocity.y += GRAVITY * dt;
  position.addScaledVector(velocity, dt);

  // --- resolveCollisions (mirrors playerController.resolveCollisions) ---
  segment.start.set(position.x, position.y + CAPSULE_RADIUS, position.z);
  segment.end.set(position.x, position.y + CAPSULE_HEIGHT - CAPSULE_RADIUS, position.z);

  bounds.makeEmpty();
  bounds.expandByPoint(segment.start);
  bounds.expandByPoint(segment.end);
  bounds.min.addScalar(-CAPSULE_RADIUS);
  bounds.max.addScalar(CAPSULE_RADIUS);

  levelBVH.shapecast({
    intersectsBounds: (box) => box.intersectsBox(bounds),
    intersectsTriangle: (tri) => {
      const distance = tri.closestPointToSegment(segment, triPoint, capsulePoint);
      if (distance < CAPSULE_RADIUS) {
        const depth = CAPSULE_RADIUS - distance;
        const direction = capsulePoint.sub(triPoint).normalize();
        segment.start.addScaledVector(direction, depth);
        segment.end.addScaledVector(direction, depth);
      }
    },
  });

  const newPosition = segment.start;
  newPosition.y -= CAPSULE_RADIUS;

  correction.subVectors(newPosition, position);
  grounded = correction.y > Math.abs(dt * velocity.y * 0.25);

  position.copy(newPosition);

  if (grounded) {
    velocity.set(0, 0, 0);
  } else if (correction.lengthSq() > 0) {
    const normal = correction.clone().normalize();
    velocity.addScaledVector(normal, -normal.dot(velocity));
  }

  if (position.y < RESPAWN_Y_THRESHOLD) {
    position.set(0, 0, 0);
    velocity.set(0, 0, 0);
  }

  return {
    x: position.x,
    y: position.y,
    z: position.z,
    velocityY: velocity.y,
    grounded,
  };
}
