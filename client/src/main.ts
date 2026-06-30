import * as THREE from "three";
import { Client } from "@colyseus/sdk";

function setupScene() {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x202030);

  const camera = new THREE.PerspectiveCamera(
    75,
    window.innerWidth / window.innerHeight,
    0.1,
    1000,
  );
  camera.position.set(0, 3, 6);
  camera.lookAt(0, 0.5, 0);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);
  document.body.appendChild(renderer.domElement);

  window.addEventListener("resize", () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
  });

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(50, 50),
    new THREE.MeshStandardMaterial({ color: 0x445544 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);

  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardMaterial({ color: 0x2266ff }),
  );
  cube.position.set(0, 0.5, 0);
  scene.add(cube);

  const hemiLight = new THREE.HemisphereLight(0xffffff, 0x444444, 1.5);
  scene.add(hemiLight);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1);
  dirLight.position.set(5, 10, 5);
  scene.add(dirLight);

  return { scene, camera, renderer, cube };
}

function startRenderLoop({
  scene,
  camera,
  renderer,
  cube,
}: ReturnType<typeof setupScene>) {
  function tick() {
    cube.rotation.y += 0.01;
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

startRenderLoop(setupScene());
connectToServer();
