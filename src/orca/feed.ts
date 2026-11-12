import * as THREE from 'three'
import { applySoftShade } from './toon'

/*
 * The token the player feeds to a pet.
 *
 * The joke is unchanged — this aquarium is run by a model, so you feed it
 * *tokens* — but the token is a fish jerky with a "T" branded on its back
 * rather than a coin. The fish is what a whale actually wants to eat; the
 * brand is what makes it a token. A coin was readable but it read as money,
 * not as food, and the eating animation had nothing to bite.
 *
 * Everything is built from primitives and flat colours like the rest of the
 * scene: a squashed ellipsoid body with a cream belly and a darker back, a
 * forked tail, two bead eyes, and the brand struck on top.
 *
 * This module owns only the model and its underwater motion; the app owns
 * spawning, targeting, the thank-you and the growth.
 */

/** Dried-fish palette, plus the cream brand struck on the back. */
const BODY_COLOR = 0xe8b063
const BELLY_COLOR = 0xf8e6c2
const BACK_COLOR = 0xc47c33
const EYE_COLOR = 0x33200f
const BRAND_COLOR = 0xfdf1d8

/**
 * Overall size. The fish is ~1.0 long before scaling, so this makes it ~1.15
 * world units — a snack next to a 4.6-unit orca, and still legible from the
 * default camera 16-30 units back.
 */
const FISH_SCALE = 1.15

/**
 * How far the fish rolls its back toward the camera, in radians.
 *
 * This is legibility, not styling. The default camera looks down at only
 * ~11-17°, so a fish swimming flat is seen almost edge-on and the brand on its
 * back collapses into a sliver — the same problem the coin had. Rolling the
 * back ~35° toward the viewer puts most of the brand on screen.
 */
const FISH_LEAN = 0.62

/** Downward acceleration and water drag; together they set the sink speed. */
const GRAVITY = 6.0
const DRAG = 2.6
/** Sideways sway amplitude and frequency, so it does not fall like a stone. */
const SWAY_AMP = 0.42
const SWAY_FREQ = 1.9
/** Turn about the fish's own up axis, in radians per second. */
const SPIN_RATE = 2.2
/** Slow roll wobble, so the fish does not read as a rigid decal. */
const WOBBLE_AMP = 0.16
const WOBBLE_FREQ = 1.35

/**
 * Seconds an uneaten token stays in the water before the app gives up on it.
 * Long enough that the pet always gets there, short enough that the tank
 * never fills up with forgotten food.
 */
export const TOKEN_LIFETIME = 14

/** How close the orca's nose has to get, in world units. */
export const EAT_RADIUS = 1.15

/**
 * How close a companion has to be. Generous on purpose: Clawd and the seal
 * follow the orca rather than chasing food, so the token is dropped straight
 * onto them and eaten on the way past — the radius only has to cover the fall,
 * not a pursuit.
 */
export const COMPANION_EAT_RADIUS = 2.0

/** Which pet a token was dropped for. */
export type FeedTarget = 'orca' | 'clawd' | 'seal' | 'jelly'

export interface TokenDrop {
  readonly group: THREE.Group
  /** Live world-space centre, read by the orca's targeting. */
  readonly position: THREE.Vector3
  /** The pet this token was dropped for; only that pet eats it. */
  readonly owner: FeedTarget
  /**
   * True from the moment the pet bites, while the swallow animation plays.
   * Distinct from `done`: the app must fire the thank-you exactly once, on the
   * transition, not on every frame the token is still shrinking away.
   */
  readonly consumed: boolean
  /** True once eaten or expired; the app removes it on the next frame. */
  readonly done: boolean
  /** Sink, spin and wobble one frame. */
  update: (t: number, dt: number) => void
  /** The pet got it — play the swallow and mark it consumed. */
  consume: () => void
  dispose: () => void
}

/**
 * `faceYaw` aims the fish's roll at the camera (atan2 of the camera offset in
 * XZ). Without it the brand would be edge-on for half of every camera orbit.
 */
export function createTokenDrop(
  spawn: THREE.Vector3,
  floorY: number,
  faceYaw: number,
  owner: FeedTarget,
): TokenDrop {
  const group = new THREE.Group()
  group.name = 'token-drop'
  group.userData.isFood = true
  group.userData.owner = owner

  /*
   * Three nested groups, and the nesting is the whole trick:
   *
   *   group — position and the swallow scale
   *   face  — yaw, so the roll points at the camera
   *   lean  — the fixed ~35° roll that presents the back to the viewer
   *   fish  — the turn, about the fish's own up axis
   *
   * Turning about the fish's up axis is what keeps the brand readable: the
   * brand is on the back, so it stays presented to the camera while only the
   * fish's heading sweeps round. Tumbling on all three axes — what the fish
   * did before it carried a brand — flashes the back away from the viewer for
   * most of the fall.
   */
  const face = new THREE.Group()
  face.rotation.y = faceYaw
  group.add(face)
  const lean = new THREE.Group()
  lean.rotation.x = FISH_LEAN
  face.add(lean)
  const fish = new THREE.Group()
  lean.add(fish)

  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []

  /** A flat-colour part with a little soft volume, matching the characters. */
  const part = (
    geometry: THREE.BufferGeometry,
    color: number,
    position?: [number, number, number],
    scale?: [number, number, number],
    rotation?: [number, number, number],
  ): THREE.Mesh => {
    geometries.push(geometry)
    const material = applySoftShade(new THREE.MeshBasicMaterial({ color }), {
      strength: 0.3,
      softness: 0.7,
    })
    materials.push(material)
    const mesh = new THREE.Mesh(geometry, material)
    if (position) mesh.position.fromArray(position)
    if (scale) mesh.scale.fromArray(scale)
    if (rotation) mesh.rotation.fromArray(rotation)
    fish.add(mesh)
    return mesh
  }

  // --- body: long on X, flattened on Y, narrow on Z ------------------------
  part(new THREE.SphereGeometry(0.5, 18, 12), BODY_COLOR, undefined, [1.0, 0.3, 0.46])
  // Belly and back sit proud of the body so the two tones stay readable.
  part(new THREE.SphereGeometry(0.44, 16, 10), BELLY_COLOR, [0, -0.055, 0], [0.94, 0.17, 0.4])
  part(new THREE.SphereGeometry(0.46, 16, 10), BACK_COLOR, [0, 0.085, 0], [0.9, 0.12, 0.33])

  // --- forked tail: two flattened cones splayed off the rear ---------------
  for (const side of [-1, 1]) {
    part(
      new THREE.ConeGeometry(0.17, 0.36, 4),
      BODY_COLOR,
      [-0.54, 0, side * 0.13],
      [1, 1, 0.55],
      [0, side * 0.42, Math.PI / 2],
    )
  }

  // --- eyes: two dark beads near the nose ----------------------------------
  for (const side of [-1, 1]) {
    part(new THREE.SphereGeometry(0.055, 10, 8), EYE_COLOR, [0.3, 0.05, side * 0.15])
  }

  /*
   * --- the brand: a "T" struck on the back ---------------------------------
   *
   * Two boxes, raised just clear of the curved back so they read as a stamp
   * rather than a decal. Laid out in the XZ plane (which is the plane the
   * camera sees once the fish is rolled toward it): the crossbar runs along
   * the body and sits on the far side, so from the viewer's side of the tank
   * the bar is at the top and the stem descends toward them.
   */
  part(new THREE.BoxGeometry(0.4, 0.035, 0.075), BRAND_COLOR, [0.04, 0.148, -0.058])
  part(new THREE.BoxGeometry(0.085, 0.035, 0.24), BRAND_COLOR, [0.04, 0.148, 0.062])

  group.scale.setScalar(FISH_SCALE)

  // --- motion --------------------------------------------------------------
  const velocity = new THREE.Vector3(
    (Math.random() - 0.5) * 0.7,
    -0.4,
    (Math.random() - 0.5) * 0.7,
  )
  const swayPhase = Math.random() * Math.PI * 2
  const spinRate = SPIN_RATE * (0.85 + Math.random() * 0.3)

  group.position.copy(spawn)

  let age = 0
  let done = false
  let consumed = false
  let swallow = 0
  /** True once it has settled on the sand and stopped sinking. */
  let settled = false

  const position = new THREE.Vector3()

  const update = (t: number, dt: number): void => {
    age += dt
    if (!consumed && age > TOKEN_LIFETIME) done = true

    if (swallow > 0) {
      // Being swallowed: shrink away rather than popping out of existence.
      swallow = Math.max(0, swallow - dt * 5)
      group.scale.setScalar(FISH_SCALE * swallow)
      group.rotation.y += dt * 12
      if (swallow === 0) done = true
      position.copy(group.position)
      return
    }

    // The heading turns; the brand stays presented.
    fish.rotation.y += spinRate * dt
    fish.rotation.z = Math.sin(t * WOBBLE_FREQ + swayPhase) * WOBBLE_AMP

    if (!settled) {
      velocity.y -= GRAVITY * dt
      // Water drag, applied as a per-frame fraction so it is frame-rate safe.
      const drag = Math.max(0, 1 - DRAG * dt)
      velocity.multiplyScalar(drag)
      group.position.addScaledVector(velocity, dt)
      // A slow side-to-side drift reads as "sinking through water" instead of
      // "dropped in a vacuum".
      group.position.x += Math.sin(t * SWAY_FREQ + swayPhase) * SWAY_AMP * dt
      group.position.z += Math.cos(t * SWAY_FREQ * 0.8 + swayPhase) * SWAY_AMP * 0.6 * dt

      if (group.position.y <= floorY) {
        group.position.y = floorY
        settled = true
      }
    } else {
      // Hovering just above the sand, still turning: uncollected food in this
      // scene drifts rather than lying in the dirt.
      group.position.y = floorY + Math.sin(t * 1.6 + swayPhase) * 0.07
    }

    position.copy(group.position)
  }

  position.copy(group.position)

  return {
    group,
    position,
    owner,
    get consumed() {
      return consumed
    },
    get done() {
      return done
    },
    update,
    consume: () => {
      if (consumed) return
      consumed = true
      swallow = 1
      // Freeze the fall so the shrink reads as being swallowed.
      velocity.set(0, 0, 0)
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      group.clear()
    },
  }
}
