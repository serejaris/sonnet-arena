import * as THREE from "three";
import { Client } from "@colyseus/sdk";
import { createLevel } from "./level";
import { PlayerController } from "./playerController";

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

  return { scene, camera, renderer, level };
}

function setupPlayer({
  camera,
  renderer,
  level,
}: Pick<ReturnType<typeof setupScene>, "camera" | "renderer" | "level">) {
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
  // pointerlockchange/pointerlockerror events).
  const overlay = document.getElementById("overlay");
  overlay?.addEventListener("click", () => controller.controls.lock());
  controller.controls.addEventListener("lock", () => overlay?.classList.add("hidden"));
  controller.controls.addEventListener("unlock", () => overlay?.classList.remove("hidden"));

  return controller;
}

function startRenderLoop({
  scene,
  camera,
  renderer,
  controller,
}: ReturnType<typeof setupScene> & { controller: PlayerController }) {
  const clock = new THREE.Clock();

  function tick() {
    const delta = Math.min(clock.getDelta(), 0.1); // clamp to avoid spikes after tab-switch
    controller.update(delta);
    renderer.render(scene, camera);
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function connectToServer() {
  const endpoint = import.meta.env.DEV
    ? "ws://localhost:2567"
    : location.origin.replace(/^http/, "ws");

  const client = new Client(endpoint);
  client
    .joinOrCreate("arena")
    .then((room) => console.log("joined", room.sessionId))
    .catch((err) => console.error("colyseus join failed", err));
}

const sceneSetup = setupScene();
const controller = setupPlayer(sceneSetup);
startRenderLoop({ ...sceneSetup, controller });
connectToServer();
