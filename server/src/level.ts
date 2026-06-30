import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { MeshBVH } from "three-mesh-bvh";

/**
 * Server-authoritative mirror of client/src/level.ts's collision geometry
 * (ground + 4 outer walls + interior obstacles). The literal dimensions and
 * positions below are copied verbatim from client/src/level.ts — this is
 * intentional duplication for a one-off demo, not a shared package, but it
 * means the two files must be kept in sync by hand: if the level layout
 * ever changes, update both or the server will collide players against
 * geometry that doesn't match what's rendered.
 *
 * Only collision geometry lives here — no THREE.Scene, no materials, no
 * lights. `three` and `three-mesh-bvh` run fine in plain Node for pure
 * geometry/math; nothing here touches the DOM or a WebGL context.
 */

const ARENA_SIZE = 40;
const WALL_HEIGHT = 4;
const WALL_THICKNESS = 1;

// [width, height, depth, centerX, centerZ] — keep in sync with
// client/src/level.ts's OBSTACLE_LAYOUT.
const OBSTACLE_LAYOUT: Array<[number, number, number, number, number]> = [
  [3, 2, 3, 6, 6],
  [2, 3, 2, -7, 3],
  [4, 1.5, 4, -5, -8],
  [2, 2.5, 6, 9, -6],
];

export const SPAWN_POSITION = new THREE.Vector3(0, 0, 0);

function buildColliderMeshes(): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  const half = ARENA_SIZE / 2;

  const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE));
  ground.rotation.x = -Math.PI / 2;
  meshes.push(ground);

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

  meshes.push(northWall, southWall, eastWall, westWall);

  for (const [width, height, depth, x, z] of OBSTACLE_LAYOUT) {
    const obstacle = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth));
    obstacle.position.set(x, height / 2, z);
    meshes.push(obstacle);
  }

  return meshes;
}

/** Builds the merged BVH every player capsule collides against. Build once at room startup. */
export function buildLevelBVH(): MeshBVH {
  const meshes = buildColliderMeshes();
  const geometries = meshes.map((mesh) => {
    mesh.updateWorldMatrix(true, false);
    return mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
  });
  const merged = mergeGeometries(geometries, false);
  return new MeshBVH(merged);
}
