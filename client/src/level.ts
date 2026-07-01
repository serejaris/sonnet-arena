import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

/**
 * M4 asset swap: the collision blockout below (ground + 4 outer walls +
 * a handful of interior obstacles) is byte-identical to the M1 blockout —
 * every position/size here is exactly what server/src/level.ts mirrors for
 * server-authoritative collision (see CLAUDE.md's "Известные отклонения").
 * Changing any of those numbers here without updating server/src/level.ts
 * to match would desync client visuals from server hit-detection.
 *
 * What changed for M4 is purely visual: the boxes are no longer rendered
 * directly (`mesh.visible = false`) — they stay in the scene graph only so
 * their matrixWorld keeps updating for playerController.ts's BVH build and
 * weapon.ts's local tracer raycast. Real glTF props (see CREDITS.md /
 * PLAN.md § Asset contract) are loaded async and added as non-colliding
 * visual siblings, scaled/rotated to match each box's exact footprint.
 * Loading is fire-and-forget from createLevel()'s point of view: the
 * collider boxes (and therefore the BVH) are ready synchronously on
 * return; the visuals just pop in a frame or two later once the .glb
 * files fetch.
 */

export interface Level {
  /** Every mesh the player capsule should collide against. */
  colliderMeshes: THREE.Mesh[];
  /** Where the player spawns, clear of any obstacle. */
  spawnPosition: THREE.Vector3;
}

const ARENA_SIZE = 40;
const WALL_HEIGHT = 4;
const WALL_THICKNESS = 1;

// [width, height, depth, centerX, centerZ] — keep in sync with
// server/src/level.ts's OBSTACLE_LAYOUT.
const OBSTACLE_LAYOUT: Array<[number, number, number, number, number]> = [
  [3, 2, 3, 6, 6],
  [2, 3, 2, -7, 3],
  [4, 1.5, 4, -5, -8],
  [2, 2.5, 6, 9, -6],
];

const MODEL_PATHS = {
  wall: "/models/props/wall.glb",
  floor: "/models/props/floor.glb",
  crate: "/models/props/crate.glb",
  crateLarge: "/models/props/crate_large.glb",
};

// Native footprint of each prop, measured from its own glTF bounding box
// (via @gltf-transform/core's getBounds(), see CLAUDE.md M4 notes). All
// four sit with their base at local Y=0 and are centered on X/Z — a
// non-uniform scale by (worldSize / nativeSpan) maps a prefab exactly onto
// a collision box's footprint, positioned at the box's ground point
// (x, 0, z), not the box mesh's own centered `position.y`.
const WALL_MODEL_SPAN = 4; // wall.glb: 4m(W) x 4m(H) x 1m(thick)
const FLOOR_MODEL_SPAN = 4; // floor.glb: 4m x 4m footprint
const CRATE_MODEL_SPAN = 1; // crate.glb: 1m unit cube
const CRATE_LARGE_MODEL_SPAN = 1.5; // crate_large.glb: 1.5m unit cube

export function createLevel(scene: THREE.Scene): Level {
  const colliderMeshes: THREE.Mesh[] = [];
  const half = ARENA_SIZE / 2;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE));
  ground.rotation.x = -Math.PI / 2;
  addCollider(scene, colliderMeshes, ground);

  const northSouthGeometry = new THREE.BoxGeometry(
    ARENA_SIZE + WALL_THICKNESS,
    WALL_HEIGHT,
    WALL_THICKNESS,
  );
  const eastWestGeometry = new THREE.BoxGeometry(
    WALL_THICKNESS,
    WALL_HEIGHT,
    ARENA_SIZE + WALL_THICKNESS,
  );

  const northWall = new THREE.Mesh(northSouthGeometry);
  northWall.position.set(0, WALL_HEIGHT / 2, -half);

  const southWall = new THREE.Mesh(northSouthGeometry);
  southWall.position.set(0, WALL_HEIGHT / 2, half);

  const eastWall = new THREE.Mesh(eastWestGeometry);
  eastWall.position.set(half, WALL_HEIGHT / 2, 0);

  const westWall = new THREE.Mesh(eastWestGeometry);
  westWall.position.set(-half, WALL_HEIGHT / 2, 0);

  for (const wall of [northWall, southWall, eastWall, westWall]) {
    addCollider(scene, colliderMeshes, wall);
  }

  for (const [width, height, depth, x, z] of OBSTACLE_LAYOUT) {
    const obstacle = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    obstacle.position.set(x, height / 2, z);
    addCollider(scene, colliderMeshes, obstacle);
  }

  setupLighting(scene);

  loadLevelArt(scene, half).catch((err: unknown) => {
    // Visual-only failure: collision already works without this, so log and
    // move on rather than breaking the level.
    console.error("Level art failed to load; playing with invisible collision boxes only", err);
  });

  return { colliderMeshes, spawnPosition: new THREE.Vector3(0, 0, 0) };
}

/**
 * Registers a mesh as a collider: added to the scene (so its matrixWorld
 * keeps being updated every frame for the BVH build and weapon.ts's tracer
 * raycast — Raycaster/Mesh.raycast don't check `visible`, only the
 * renderer's draw pass does) but hidden — the loaded glTF props below are
 * the visible stand-ins for these exact same footprints.
 */
function addCollider(scene: THREE.Scene, colliderMeshes: THREE.Mesh[], mesh: THREE.Mesh): void {
  mesh.visible = false;
  scene.add(mesh);
  colliderMeshes.push(mesh);
}

function setupLighting(scene: THREE.Scene): void {
  // Bumped up from the M1 flat-color tuning: textured PBR props read
  // noticeably darker/flatter than flat MeshStandardMaterial boxes did
  // under the same light levels, so both lights are stronger here.
  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x555560, 1.75);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xfff2e0, 1.6);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);
}

async function loadLevelArt(scene: THREE.Scene, half: number): Promise<void> {
  const loader = new GLTFLoader();
  const [wallModel, floorModel, crateModel, crateLargeModel] = await Promise.all([
    loader.loadAsync(MODEL_PATHS.wall),
    loader.loadAsync(MODEL_PATHS.floor),
    loader.loadAsync(MODEL_PATHS.crate),
    loader.loadAsync(MODEL_PATHS.crateLarge),
  ]);

  placeFloor(scene, floorModel.scene, half);
  placeWalls(scene, wallModel.scene, half);
  placeObstacles(scene, crateModel.scene, crateLargeModel.scene);
}

/** One floor.glb tile, non-uniformly scaled to cover the whole ARENA_SIZE ground plane. */
function placeFloor(scene: THREE.Scene, floorPrefab: THREE.Object3D, half: number): void {
  const floor = floorPrefab.clone(true);
  const span = (half * 2) / FLOOR_MODEL_SPAN;
  floor.scale.set(span, 1, span);
  floor.position.set(0, 0, 0);
  scene.add(floor);
}

/** One wall.glb instance per side, stretched along its length to match each outer wall box exactly. */
function placeWalls(scene: THREE.Scene, wallPrefab: THREE.Object3D, half: number): void {
  const span = (ARENA_SIZE + WALL_THICKNESS) / WALL_MODEL_SPAN;

  for (const z of [-half, half]) {
    const wall = wallPrefab.clone(true);
    wall.scale.set(span, 1, 1);
    wall.position.set(0, 0, z);
    scene.add(wall);
  }

  // Rotate 90° about Y so the model's stretched width axis lines up with
  // the world Z axis (the east/west walls' long direction) instead of X —
  // scale is applied in local space before the rotation, so the same
  // scale.set(span, 1, 1) still stretches the right (width) axis.
  for (const x of [half, -half]) {
    const wall = wallPrefab.clone(true);
    wall.scale.set(span, 1, 1);
    wall.rotation.y = Math.PI / 2;
    wall.position.set(x, 0, 0);
    scene.add(wall);
  }
}

/** One crate/crate_large.glb per obstacle, non-uniformly scaled to fill that obstacle's exact box footprint. */
function placeObstacles(
  scene: THREE.Scene,
  cratePrefab: THREE.Object3D,
  crateLargePrefab: THREE.Object3D,
): void {
  for (const [width, height, depth, x, z] of OBSTACLE_LAYOUT) {
    const useLarge = width >= 4 || depth >= 4;
    const prefab = useLarge ? crateLargePrefab : cratePrefab;
    const nativeSpan = useLarge ? CRATE_LARGE_MODEL_SPAN : CRATE_MODEL_SPAN;

    const crate = prefab.clone(true);
    crate.scale.set(width / nativeSpan, height / nativeSpan, depth / nativeSpan);
    crate.position.set(x, 0, z);
    scene.add(crate);
  }
}
