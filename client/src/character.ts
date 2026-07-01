import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import { CAPSULE_HEIGHT } from "./playerController";

/**
 * M4 asset swap: loads the KayKit "Adventurer" character glTF once and hands
 * out correctly-scaled/oriented/animatable clones for network.ts's remote
 * players. See CREDITS.md for source/license; PLAN.md "Asset contract" for
 * the path/units/animation-vocabulary conventions this file implements.
 *
 * All measurements below (heights, facing axis) were taken offline against
 * the actual shipped `adventurer.glb` using three.js's own GLTFLoader +
 * Box3(precise) in a throwaway Node script — not guessed from the file name
 * or asset-pack docs — since the model's bind pose (T-pose, used for skin
 * weights) and its default *posed* geometry (Idle clip at t=0) differ
 * substantially and only the latter matches what actually renders.
 */

const CHARACTER_MODEL_URL = "/models/characters/adventurer.glb";

// Feet (y=0) to helmet-top, measured via THREE.Box3().setFromObject(scene,
// true) after playing the "Idle" clip at t=0 (precise = true walks the
// skin's bone matrices, not just the static/T-pose bind geometry — the raw
// bind pose measures ~2.47m tall but ~1.94m *wide* because the arms are
// spread out T-pose-style, which would be the wrong number to scale a
// standing/idle character against).
const RAW_MODEL_HEIGHT_METERS = 2.453;

/** Uniform scale so the loaded model's standing height matches the existing capsule collider's height, rather than the source pack's arbitrary export scale. */
export const CHARACTER_SCALE = CAPSULE_HEIGHT / RAW_MODEL_HEIGHT_METERS;

// Measured offline: the rig's toe bones sit at a more positive local Z than
// their own ankle bones (toesl.z ≈ +0.04 vs footl.z ≈ -0.07m, same for the
// right foot) — i.e. this model's own "forward" is local +Z. PLAN.md's
// convention (and the capsule placeholder this replaces, see network.ts)
// is rotY=0 -> forward=(0,0,-1). A fixed 180° yaw baked into a pivot
// *inside* the rotY-driven wrapper reconciles the two without touching any
// rotY math shared with playerController.ts/server physics.
const MODEL_FACING_OFFSET_Y = Math.PI;

// KayKit's single combined rig embeds every melee weapon/shield variant
// pre-parented to the hand bones (see the M4 fetch report / CREDITS.md) —
// left visible, the character would render simultaneously wielding a sword
// in one hand and four different shields stacked in the other. This game's
// players use the ranged blaster (attached separately as a camera
// view-model, see weapon.ts), so none of these belong on the body.
const HIDDEN_NODE_NAMES = new Set([
  "1H_Sword_Offhand",
  "Badge_Shield",
  "Rectangle_Shield",
  "Round_Shield",
  "Spike_Shield",
  "1H_Sword",
  "2H_Sword",
]);

/** Fixed animation-state vocabulary the rest of the client drives — see PLAN.md "Asset contract". */
export type AnimName = "idle" | "run" | "jump" | "shoot" | "death";

// Real clip names as shipped in adventurer.glb (KayKit Adventurers 1.0, 76
// clips total, see the M4 fetch report for the full list) mapped to the
// fixed vocabulary above. Kept in one place so network.ts's animation-state
// logic never has to know the source pack's naming.
const CLIP_NAMES: Record<AnimName, string> = {
  idle: "Idle",
  run: "Running_A",
  jump: "Jump_Full_Short",
  shoot: "1H_Ranged_Shoot",
  death: "Death_A",
};

interface CharacterTemplate {
  scene: THREE.Object3D;
  clips: THREE.AnimationClip[];
}

let templatePromise: Promise<CharacterTemplate> | null = null;

/** Loads+parses the character glTF exactly once; every remote player clones the cached result. */
function loadCharacterTemplate(): Promise<CharacterTemplate> {
  if (!templatePromise) {
    const loader = new GLTFLoader();
    templatePromise = loader.loadAsync(CHARACTER_MODEL_URL).then((gltf) => ({
      scene: gltf.scene,
      clips: gltf.animations,
    }));
  }
  return templatePromise;
}

export interface RemoteCharacter {
  /** Parent this under the remote player's position/rotY wrapper (see network.ts's `RemotePlayer.mesh`). */
  root: THREE.Object3D;
  mixer: THREE.AnimationMixer;
  /** Only the vocabulary entries whose real clip actually resolved — see CLIP_NAMES. */
  actions: Partial<Record<AnimName, THREE.AnimationAction>>;
}

/**
 * Builds one independent, correctly-scaled/oriented, animatable character
 * instance. Uses SkeletonUtils.clone (not Object3D.clone) since a naive
 * clone doesn't rebind a SkinnedMesh's skeleton/bone references — every
 * remote player needs its own bone hierarchy to animate independently.
 */
export async function createRemoteCharacter(): Promise<RemoteCharacter> {
  const template = await loadCharacterTemplate();
  const clone = cloneSkeleton(template.scene) as THREE.Object3D;

  clone.traverse((obj) => {
    if (HIDDEN_NODE_NAMES.has(obj.name)) obj.visible = false;
  });

  // Pivot carries the fixed scale + facing correction; the outer wrapper
  // (network.ts) stays exclusively responsible for the network-driven
  // position/rotY, so the two transforms never fight each other.
  const pivot = new THREE.Group();
  pivot.rotation.y = MODEL_FACING_OFFSET_Y;
  pivot.scale.setScalar(CHARACTER_SCALE);
  pivot.add(clone);

  const mixer = new THREE.AnimationMixer(clone);
  const actions: Partial<Record<AnimName, THREE.AnimationAction>> = {};
  for (const key of Object.keys(CLIP_NAMES) as AnimName[]) {
    const clip = template.clips.find((c) => c.name === CLIP_NAMES[key]);
    if (!clip) continue; // best-effort — a missing clip just leaves that state unanimated
    actions[key] = mixer.clipAction(clip);
  }

  return { root: pivot, mixer, actions };
}
