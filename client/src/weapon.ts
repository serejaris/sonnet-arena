import * as THREE from "three";
import type { PlayerController } from "./playerController";
import type { NetworkClient } from "./network";

/**
 * M3 client-side weapon: fires on left-click while pointer-locked and the
 * local player is alive. Does an instant LOCAL raycast purely for
 * muzzle-flash/tracer feedback — per PLAN.md's "Hit detection" stack
 * decision, this client-side result is NEVER used to apply damage; only the
 * server's "hit"/"death" broadcasts (handled in network.ts) do that. The
 * actual `shoot` message carries the camera's real world position/direction
 * at fire time, which the server re-raycasts authoritatively.
 *
 * While dead, a left-click sends `respawn` instead of firing — see
 * index.html's `#death-overlay` comment for why this lives in the
 * document-level mousedown handler rather than an overlay click listener.
 */

// Mirrors server/src/combat.ts's WEAPON_RANGE/SHOT_COOLDOWN_MS. Duplicated
// here rather than shared between packages — same intentional-duplication
// convention as client/src/level.ts vs server/src/level.ts (see CLAUDE.md
// "Известные отклонения"). The server is authoritative for both; this copy
// only governs local visual feedback and an additional client-side
// rate-limit gate (on top of, not instead of, the server's own).
const WEAPON_RANGE = 100;
const CLIENT_SHOT_COOLDOWN_MS = 250;

const TRACER_LIFETIME_MS = 100;
const MUZZLE_FLASH_LIFETIME_MS = 70;

export class WeaponController {
  private lastFireTime = -Infinity;

  private readonly raycaster = new THREE.Raycaster();
  private readonly origin = new THREE.Vector3();
  private readonly direction = new THREE.Vector3();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly camera: THREE.PerspectiveCamera,
    private readonly controller: PlayerController,
    private readonly network: NetworkClient,
    private readonly levelColliderMeshes: THREE.Mesh[],
  ) {
    window.addEventListener("mousedown", (event) => this.onMouseDown(event));
  }

  private onMouseDown(event: MouseEvent): void {
    if (event.button !== 0) return; // left click only
    if (!this.controller.controls.isLocked) return;

    if (!this.network.isAlive()) {
      this.network.respawn();
      return;
    }

    this.tryFire();
  }

  private tryFire(): void {
    const now = performance.now();
    if (now - this.lastFireTime < CLIENT_SHOT_COOLDOWN_MS) return;
    this.lastFireTime = now;

    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this.direction);

    this.network.shoot(
      { x: this.origin.x, y: this.origin.y, z: this.origin.z },
      { x: this.direction.x, y: this.direction.y, z: this.direction.z },
    );

    this.fireLocalFeedback();
  }

  /** Instant local-only visual feedback (tracer + muzzle flash) — never used to apply damage. */
  private fireLocalFeedback(): void {
    this.raycaster.set(this.origin, this.direction);
    this.raycaster.far = WEAPON_RANGE;

    const targets: THREE.Object3D[] = [...this.levelColliderMeshes, ...this.network.getRemoteMeshes()];
    const intersections = this.raycaster.intersectObjects(targets, true);

    const hitPoint =
      intersections.length > 0
        ? intersections[0].point.clone()
        : this.origin.clone().addScaledVector(this.direction, WEAPON_RANGE);

    this.spawnTracer(this.origin, hitPoint);
    this.spawnMuzzleFlash();
  }

  private spawnTracer(from: THREE.Vector3, to: THREE.Vector3): void {
    const geometry = new THREE.BufferGeometry().setFromPoints([from, to]);
    const material = new THREE.LineBasicMaterial({ color: 0xffe9a8 });
    const line = new THREE.Line(geometry, material);
    this.scene.add(line);

    setTimeout(() => {
      this.scene.remove(line);
      geometry.dispose();
      material.dispose();
    }, TRACER_LIFETIME_MS);
  }

  private spawnMuzzleFlash(): void {
    // Added directly to the scene (not as a camera child) since `camera` is
    // never itself added to the scene graph in main.ts — a light parented to
    // it wouldn't be picked up by the renderer's light traversal. A static
    // world-space position just in front of the camera is indistinguishable
    // for a ~70ms flash.
    const flash = new THREE.PointLight(0xffe9a8, 8, 6, 2);
    flash.position.copy(this.origin).addScaledVector(this.direction, 0.5);
    this.scene.add(flash);

    setTimeout(() => {
      this.scene.remove(flash);
    }, MUZZLE_FLASH_LIFETIME_MS);
  }
}
