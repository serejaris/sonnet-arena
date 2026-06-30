import * as THREE from "three";

/**
 * M1 blockout: a simple enclosed boxy arena (ground + 4 outer walls +
 * a handful of interior obstacles). No textures, flat colors only —
 * real art is M4's job (asset-swap milestone, see PLAN.md).
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

const GROUND_COLOR = 0x445544;
const WALL_COLOR = 0x55555f;
const OBSTACLE_COLOR = 0x8a6d3b;

// [width, height, depth, centerX, centerZ]
const OBSTACLE_LAYOUT: Array<[number, number, number, number, number]> = [
  [3, 2, 3, 6, 6],
  [2, 3, 2, -7, 3],
  [4, 1.5, 4, -5, -8],
  [2, 2.5, 6, 9, -6],
];

export function createLevel(scene: THREE.Scene): Level {
  const colliderMeshes: THREE.Mesh[] = [];
  const half = ARENA_SIZE / 2;

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE),
    new THREE.MeshStandardMaterial({ color: GROUND_COLOR }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  colliderMeshes.push(ground);

  const wallMaterial = new THREE.MeshStandardMaterial({ color: WALL_COLOR });

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

  const northWall = new THREE.Mesh(northSouthGeometry, wallMaterial);
  northWall.position.set(0, WALL_HEIGHT / 2, -half);

  const southWall = new THREE.Mesh(northSouthGeometry, wallMaterial);
  southWall.position.set(0, WALL_HEIGHT / 2, half);

  const eastWall = new THREE.Mesh(eastWestGeometry, wallMaterial);
  eastWall.position.set(half, WALL_HEIGHT / 2, 0);

  const westWall = new THREE.Mesh(eastWestGeometry, wallMaterial);
  westWall.position.set(-half, WALL_HEIGHT / 2, 0);

  for (const wall of [northWall, southWall, eastWall, westWall]) {
    scene.add(wall);
    colliderMeshes.push(wall);
  }

  const obstacleMaterial = new THREE.MeshStandardMaterial({ color: OBSTACLE_COLOR });
  for (const [width, height, depth, x, z] of OBSTACLE_LAYOUT) {
    const obstacle = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      obstacleMaterial,
    );
    obstacle.position.set(x, height / 2, z);
    scene.add(obstacle);
    colliderMeshes.push(obstacle);
  }

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  return { colliderMeshes, spawnPosition: new THREE.Vector3(0, 0, 0) };
}
