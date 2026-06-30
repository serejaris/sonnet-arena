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

const CAPSULE_RADIUS = 0.4;
const CAPSULE_HEIGHT = 1.8;
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

  update(delta: number): void {
    if (!this.controls.isLocked) return;

    this.applyInput(delta);
    this.velocity.y += GRAVITY * delta;
    this.position.addScaledVector(this.velocity, delta);
    this.resolveCollisions(delta);

    if (this.position.y < RESPAWN_Y_THRESHOLD) {
      this.position.copy(this.spawnPosition);
      this.velocity.set(0, 0, 0);
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

    this.moveDir.set(0, 0, 0);
    if (moveForward !== 0 || moveRight !== 0) {
      this.moveDir
        .addScaledVector(this.forwardVec, moveForward)
        .addScaledVector(this.rightVec, moveRight)
        .normalize(); // normalize so diagonal movement isn't faster
    }

    this.velocity.x = this.moveDir.x * MOVE_SPEED;
    this.velocity.z = this.moveDir.z * MOVE_SPEED;

    if (this.input.jump && this.onGround) {
      this.velocity.y = JUMP_SPEED;
      this.onGround = false;
    }
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
