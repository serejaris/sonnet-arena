import * as THREE from "three";
import { createLevel } from "./level";
import { PlayerController } from "./playerController";
import { NetworkClient } from "./network";
import { Hud } from "./hud";
import { WeaponController } from "./weapon";

function setupScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202030);

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const level = createLevel(scene);

  // M4: the camera needs to be part of the scene graph for its own children
  // (the weapon view-model, see weapon.ts) to be traversed/rendered by
  // renderer.render(scene, camera) — otherwise anything parented under
  // `camera` sits outside `scene` and never draws. The camera object itself
  // has no visible geometry, so this is a no-op for everything else.
  scene.add(camera);

  return { scene, camera, renderer, level };
}

function setupPlayer(
  {
    camera,
    renderer,
    level,
  }: Pick<ReturnType<typeof setupScene>, "camera" | "renderer" | "level">,
  hud: Hud,
) {
  const controller = new PlayerController(
    camera,
    renderer.domElement,
    level.colliderMeshes,
    level.spawnPosition,
  );

  // Standard PointerLockControls pattern: pointer lock can only be requested
  // from a user gesture, so the overlay's click is that gesture. The
  // overlay itself is shown/hidden off the controls' own lock/unlock events
  // (which PointerLockControls fires in response to the browser's
  // pointerlockchange/pointerlockerror events). The crosshair follows the
  // same lock/unlock events — only meaningful while actually playing.
  const overlay = document.getElementById("overlay");
  overlay?.addEventListener("click", () => controller.controls.lock());
  controller.controls.addEventListener("lock", () => {
    overlay?.classList.add("hidden");
    hud.setCrosshairVisible(true);
  });
  controller.controls.addEventListener("unlock", () => {
    overlay?.classList.remove("hidden");
    hud.setCrosshairVisible(false);
  });

  return controller;
}

function startRenderLoop({
  scene,
  camera,
  renderer,
  controller,
  network,
}: ReturnType<typeof setupScene> & { controller: PlayerController; network: NetworkClient }) {
  const clock = new THREE.Clock();

  function tick() {
    const delta = Math.min(clock.getDelta(), 0.1); // clamp to avoid spikes after tab-switch

    // Local prediction (unchanged from M1) — returns this tick's input
    // intent so it can be sent to the server and buffered for
    // reconciliation. null while the pointer isn't locked (nothing to send).
    const frameInput = controller.update(delta);
    if (frameInput) {
      network.sendInput(frameInput, delta);
    }

    network.updateRemoteInterpolation(delta);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

const sceneSetup = setupScene();
const hud = new Hud();
const controller = setupPlayer(sceneSetup, hud);
const network = new NetworkClient(sceneSetup.scene, controller, hud);
new WeaponController(
  sceneSetup.scene,
  sceneSetup.camera,
  controller,
  network,
  sceneSetup.level.colliderMeshes,
);
network.connect().catch((err) => console.error("colyseus connect failed", err));
startRenderLoop({ ...sceneSetup, controller, network });
