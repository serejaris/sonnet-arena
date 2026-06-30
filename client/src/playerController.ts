import * as THREE from "three";
import { PointerLockControls } from "three/examples/jsm/controls/PointerLockControls.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshBVH } from "three-mesh-bvh";

/**
 * FPS-style capsule controller: WASD + jump + gravity, collided against the
 * level's static geometry via a BVH (three-mesh-bvh) shapecast. Pattern is
 * the standard segment-vs-triangle push-out approach from three-mesh-bvh's
 * own character-movement reference demo (see PLAN.md "Movement controller
 * reference"). Camera yaw/pitch comes entirely from PointerLockControls;
 * this class only ever moves the camera's *position*.
 */

const GRAVITY = -30;
const JUMP_SPEED = 9;
const MOVE_SPEED = 6;

// Exported so M2 networking code (remote-player placeholder meshes) can size
// avatars consistently with the actual collision capsule, without duplicating
// the numbers.
export const CAPSULE_RADIUS = 0.4;
export const CAPSULE_HEIGHT = 1.8;
const EYE_HEIGHT = CAPSULE_HEIGHT - 0.1;

// Below this, the player is assumed to have fallen out of the level.
const RESPAWN_Y_THRESHOLD = -25;

interface InputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
}

/**
 * Snapshot of the input that drove one local physics tick — this is what
 * gets sent to the server (plus `seq`/`dt`) and re-applied verbatim during
 * reconciliation replay. `dz`/`dx` are camera-relative axis intents (the
 * same `moveForward`/`moveRight` accumulators applyInput already computes
 * before rotating them into world space), NOT a world-space vector — this
 * matches server/src/physics.ts's `PlayerInput` exactly (see CLAUDE.md
 * "Известные отклонения" / the server M2 report this client was built
 * against), so replaying an input client-side and processing it
 * server-side both rotate it by the same `rotY` and land on the same result.
 */
export interface NetworkInput {
  dz: number;
  dx: number;
  jump: boolean;
  rotY: number;
}

function buildLevelBVH(meshes: THREE.Mesh[]): MeshBVH {
  const geometries = meshes.map((mesh) => {
    mesh.updateWorldMatrix(true, false);
    return mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  });
  // Baking each mesh's world matrix into its own geometry clone means the
  // merged result is already in world space — no per-frame collider
  // transform needed when shapecasting against it.
  const merged = mergeGeometries(geometries, false);
  return new MeshBVH(merged);
}

export class PlayerController {
  readonly controls: PointerLockControls;

  private readonly camera: THREE.PerspectiveCamera;
  private readonly levelBVH: MeshBVH;
  private readonly spawnPosition: THREE.Vector3;

  /** Capsule base (feet) position, world space. */
  private readonly position = new THREE.Vector3();
  private readonly velocity = new THREE.Vector3();
  private onGround = false;

  private readonly input: InputState = {
    forward: false,
    backward: false,
    left: false,
    right: false,
    jump: false,
  };

  private readonly forwardVec = new THREE.Vector3();
  private readonly rightVec = new THREE.Vector3();
  private readonly moveDir = new THREE.Vector3();

  private readonly segment = new THREE.Line3();
  private readonly bounds = new THREE.Box3();
  private readonly triPoint = new THREE.Vector3();
  private readonly capsulePoint = new THREE.Vector3();
  private readonly correction = new THREE.Vector3();

  // This frame's input intent, recorded by applyInput() and handed back to
  // the caller of update() so it can be sent over the network unchanged.
  private lastDz = 0;
  private lastDx = 0;
  private lastYaw = 0;

  // Scratch state for predictReplayStep()'s reconciliation replay, kept
  // separate from the live forwardVec/rightVec/moveDir above so replaying a
  // historical input never depends on (or clobbers) the live camera-driven
  // path. Mirrors server/src/physics.ts's dummyYaw trick exactly: a real
  // THREE.Camera is required because Camera.getWorldDirection() negates the
  // base Object3D result to match the "-Z is forward" convention — a plain
  // Object3D would silently invert movement (see CLAUDE.md deviations).
  private readonly replayYawCamera = new THREE.PerspectiveCamera();
  private readonly replayForwardVec = new THREE.Vector3();
  private readonly replayRightVec = new THREE.Vector3();
  private readonly replayMoveDir = new THREE.Vector3();

  constructor(
    camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
    levelMeshes: THREE.Mesh[],
    spawnPosition: THREE.Vector3 = new THREE.Vector3(0, 0, 0),
  ) {
    this.camera = camera;
    this.controls = new PointerLockControls(camera, domElement);
    this.levelBVH = buildLevelBVH(levelMeshes);
    this.spawnPosition = spawnPosition.clone();

    this.position.copy(this.spawnPosition);
    this.updateCameraPosition();

    window.addEventListener("keydown", (event) => this.setKey(event.code, true));
    window.addEventListener("keyup", (event) => this.setKey(event.code, false));
  }

  /**
   * Advances local prediction by one frame, exactly as M1 did. Returns the
   * input intent that drove this tick (for the M2 networking layer to send
   * to the server and buffer for reconciliation), or `null` while the
   * pointer isn't locked (no input is being produced, mirrors the original
   * early-return — nothing to send).
   */
  update(delta: number): NetworkInput | null {
    if (!this.controls.isLocked) return null;

    this.applyInput(delta);
    this.integratePhysics(delta);
    this.updateCameraPosition();

    return { dz: this.lastDz, dx: this.lastDx, jump: this.input.jump, rotY: this.lastYaw };
  }

  /**
   * Reconciliation: snap to the server's authoritative position for this
   * player, then replay every input the server hasn't acknowledged yet
   * (`pendingInputs`, already filtered to `seq > lastProcessedInputSeq` by
   * the caller) through the exact same physics pipeline `update()` uses.
   * Velocity is intentionally left as-is (not reset from the server, which
   * doesn't sync it) — only position is authoritative, per the schema
   * contract in PLAN.md.
   */
  applyServerCorrection(
    authoritative: { x: number; y: number; z: number },
    pendingInputs: ReadonlyArray<{ dz: number; dx: number; jump: boolean; dt: number; rotY: number }>,
  ): void {
    this.position.set(authoritative.x, authoritative.y, authoritative.z);
    for (const input of pendingInputs) {
      this.predictReplayStep(input);
    }
    this.updateCameraPosition();
  }

  private setKey(code: string, pressed: boolean): void {
    switch (code) {
      case "KeyW":
      case "ArrowUp":
        this.input.forward = pressed;
        break;
      case "KeyS":
      case "ArrowDown":
        this.input.backward = pressed;
        break;
      case "KeyA":
      case "ArrowLeft":
        this.input.left = pressed;
        break;
      case "KeyD":
      case "ArrowRight":
        this.input.right = pressed;
        break;
      case "Space":
        this.input.jump = pressed;
        break;
    }
  }

  private applyInput(_delta: number): void {
    // Forward/right relative to camera yaw, flattened to the ground plane.
    this.camera.getWorldDirection(this.forwardVec);
    this.forwardVec.y = 0;
    this.forwardVec.normalize();
    this.rightVec.crossVectors(this.forwardVec, this.camera.up).normalize();

    let moveForward = 0;
    let moveRight = 0;
    if (this.input.forward) moveForward += 1;
    if (this.input.backward) moveForward -= 1;
    if (this.input.right) moveRight += 1;
    if (this.input.left) moveRight -= 1;

    // Recorded for the networking layer: dz/dx are the raw camera-relative
    // intent (pre-rotation), rotY is the yaw that the server will rotate it
    // by — together they let the server (and our own replay) reconstruct
    // forwardVec/rightVec independently and land on the same moveDir.
    this.lastDz = moveForward;
    this.lastDx = moveRight;
    this.lastYaw = Math.atan2(-this.forwardVec.x, -this.forwardVec.z);

    this.moveDir.set(0, 0, 0);
    if (moveForward !== 0 || moveRight !== 0) {
      this.moveDir
        .addScaledVector(this.forwardVec, moveForward)
        .addScaledVector(this.rightVec, moveRight)
        .normalize(); // normalize so diagonal movement isn't faster
    }

    this.applyMovementVelocity(this.moveDir, this.input.jump);
  }

  /** Shared by the live path (applyInput) and replay (predictReplayStep). */
  private applyMovementVelocity(moveDir: THREE.Vector3, jump: boolean): void {
    this.velocity.x = moveDir.x * MOVE_SPEED;
    this.velocity.z = moveDir.z * MOVE_SPEED;

    if (jump && this.onGround) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
  }

  /** Gravity + integrate + collide + respawn-check — shared tail of update() and predictReplayStep(). */
  private integratePhysics(dt: number): void {
    this.velocity.y += GRAVITY * dt;
    this.position.addScaledVector(this.velocity, dt);
    this.resolveCollisions(dt);

    if (this.position.y < RESPAWN_Y_THRESHOLD) {
      this.position.copy(this.spawnPosition);
      this.velocity.set(0, 0, 0);
    }
  }

  /**
   * Deterministically replays one historical input (used only by
   * applyServerCorrection's reconciliation loop). Unlike applyInput(), the
   * forward/right basis comes from the input's own recorded `rotY` — via the
   * same dummy-camera trick server/src/physics.ts uses — rather than from
   * the live camera, since the camera may have since turned further.
   */
  private predictReplayStep(input: { dz: number; dx: number; jump: boolean; dt: number; rotY: number }): void {
    this.replayYawCamera.rotation.set(0, input.rotY, 0);
    this.replayYawCamera.getWorldDirection(this.replayForwardVec);
    this.replayForwardVec.y = 0;
    this.replayForwardVec.normalize();
    this.replayRightVec.crossVectors(this.replayForwardVec, this.camera.up).normalize();

    this.replayMoveDir.set(0, 0, 0);
    if (input.dz !== 0 || input.dx !== 0) {
      this.replayMoveDir
        .addScaledVector(this.replayForwardVec, input.dz)
        .addScaledVector(this.replayRightVec, input.dx)
        .normalize();
    }

    this.applyMovementVelocity(this.replayMoveDir, input.jump);
    this.integratePhysics(input.dt);
  }

  private resolveCollisions(delta: number): void {
    this.segment.start.set(
      this.position.x,
      this.position.y + CAPSULE_RADIUS,
      this.position.z,
    );
    this.segment.end.set(
      this.position.x,
      this.position.y + CAPSULE_HEIGHT - CAPSULE_RADIUS,
      this.position.z,
    );

    this.bounds.makeEmpty();
    this.bounds.expandByPoint(this.segment.start);
    this.bounds.expandByPoint(this.segment.end);
    this.bounds.min.addScalar(-CAPSULE_RADIUS);
    this.bounds.max.addScalar(CAPSULE_RADIUS);

    const segment = this.segment;
    const triPoint = this.triPoint;
    const capsulePoint = this.capsulePoint;
    const bounds = this.bounds;

    this.levelBVH.shapecast({
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

    const newPosition = this.segment.start;
    newPosition.y -= CAPSULE_RADIUS;

    this.correction.subVectors(newPosition, this.position);
    this.onGround =
      this.correction.y > Math.abs(delta * this.velocity.y * 0.25);

    this.position.copy(newPosition);

    if (this.onGround) {
      this.velocity.set(0, 0, 0);
    } else if (this.correction.lengthSq() > 0) {
      // Strip the component of velocity pointing into whatever we just
      // pushed out of (e.g. stop accelerating into a wall/ceiling) so it
      // doesn't accumulate frame over frame while airborne.
      const normal = this.correction.clone().normalize();
      this.velocity.addScaledVector(normal, -normal.dot(this.velocity));
    }
  }

  private updateCameraPosition(): void {
    this.camera.position.set(
      this.position.x,
      this.position.y + EYE_HEIGHT,
      this.position.z,
    );
  }
}
