import * as THREE from 'three'
import { bakeCelShading, createOutlineShell } from '../toon'

/*
 * "Clawd" — the blocky companion character, extracted from an early HTML prototype.
 *
 * The original builds him from box primitives (body, two side ears, four legs,
 * two eyes, optional brows) plus a large wardrobe of hats, glasses and neckwear.
 * Only the character himself is ported here: the project already has its own
 * wardrobe concept (the orca's skins), and a hat system would have doubled the
 * import for no gameplay value. The proportions, palette and part names follow
 * the original so the silhouette is recognisably the same creature.
 *
 * Facing: the original drives heading with `Math.atan2(dx, dz)`, i.e. the face
 * looks along local +Z. The orca uses the same convention, so the companion can
 * simply copy its yaw.
 */

/** Identity of the model, for anyone reading the scene graph. */
export const CLAWD_NAME = 'clawd-companion'

/**
 * Height of the original model in its own units (feet at -0.65, ear top at
 * about +0.32). Used to scale him to a chosen in-world size.
 */
const SOURCE_HEIGHT = 0.97

export interface ClawdCompanion {
  readonly group: THREE.Group
  /** Pose him from the orca's past position, plus a little idle motion. */
  update: (t: number, dt: number, follow: { position: THREE.Vector3; yaw: number }) => void
  /** Playful kick, used when he is clicked or a photo is taken. */
  react: () => void
  setColor: (hex: number) => void
  /** Ink-outline toggle (toolbar controls all three characters together). */
  setOutlines: (on: boolean) => void
  dispose: () => void
}

/** Mirror the original's palette. */
const BODY_COLOR = 0xdc7759
const EYE_COLOR = 0x444444

/** Ink hulls (hidden by default; the toolbar outline toggle shows them). */
const OUTLINE_COLOR = 0x14202e
/**
 * Ink width in model units. Proportionally this matches the seal's 0.05 on a
 * 2-unit body. The legs are 0.15 thick, so double this still clears them; the
 * 0.06-wide eyes get no hull at all — the ink would swallow them whole.
 */
const CLAWD_OUTLINE = 0.035

export function createClawdCompanion(targetHeight = 0.9): ClawdCompanion {
  const group = new THREE.Group()
  group.name = CLAWD_NAME

  // Materials are white because the cel-shaded vertex colours carry the actual
  // colour; a non-white material colour would multiply it a second time and
  // darken the whole character.
  const bodyMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true })
  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true })
  const outlineMaterials: THREE.Material[] = []

  /**
   * Attach a part: bake cartoon cel shading into its own geometry (so each face
   * gets one flat tone and the box structure is readable), then wrap it in an
   * inverted-hull outline so the parts separate from each other and from the
   * background. Meshes sharing a geometry share the bake, which is why each part
   * gets its own here.
   *
   * The hull rides as a child of the mesh, which is safe here because every
   * clawd transform is uniform (translations only) — the seal needs the
   * holder-sibling pattern because its parts scale non-uniformly.
   */
  const outlineMeshes: THREE.Mesh[] = []
  const attach = (
    parent: THREE.Object3D,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    baseColor: THREE.ColorRepresentation,
    outline = true,
  ): THREE.Mesh => {
    bakeCelShading(geometry, { baseColor, strength: 0.38, steps: 3 })
    const mesh = new THREE.Mesh(geometry, material)
    parent.add(mesh)
    if (outline) {
      const shell = createOutlineShell(geometry, CLAWD_OUTLINE, OUTLINE_COLOR)
      shell.visible = false
      mesh.add(shell)
      outlineMeshes.push(shell)
      outlineMaterials.push(shell.material as THREE.Material)
    }
    return mesh
  }

  // --- torso (original: BoxGeometry(1.4, 1, 1.2)) ---
  attach(group, new THREE.BoxGeometry(1.4, 1, 1.2), bodyMaterial, BODY_COLOR)

  // --- side ears (original: Box(0.3, 0.3, 1.2) at x = ±0.85) ---
  for (const x of [-0.85, 0.85]) {
    const ear = attach(group, new THREE.BoxGeometry(0.3, 0.3, 1.2), bodyMaterial, BODY_COLOR)
    ear.position.set(x, 0, 0)
  }

  // --- legs: two pairs, each pair in its own group so they can paddle ---
  const frontLegs = new THREE.Group()
  frontLegs.position.set(0, -0.5, 0.45)
  const backLegs = new THREE.Group()
  backLegs.position.set(0, -0.5, -0.45)
  for (const container of [frontLegs, backLegs]) {
    for (const x of [-0.5, 0.5]) {
      const leg = attach(container, new THREE.BoxGeometry(0.15, 0.3, 0.2), bodyMaterial, BODY_COLOR)
      leg.position.set(x, -0.15, 0)
    }
    group.add(container)
  }

  // --- eyes (original: Box(0.06, 0.18, 0.05) at z = 0.6) ---
  for (const x of [-0.4, 0.4]) {
    const eye = attach(group, new THREE.BoxGeometry(0.06, 0.18, 0.05), eyeMaterial, EYE_COLOR)
    eye.position.set(x, 0.1, 0.6)
  }

  // --- soft contact shadow, as in the original ---
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.62, 20),
    new THREE.MeshBasicMaterial({
      color: 0x001018,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.position.y = -0.66
  group.add(shadow)

  group.scale.setScalar(targetHeight / SOURCE_HEIGHT)
  // Sit the feet on the group origin so the caller positions him by his base.
  group.position.y = 0

  let reactTimer = 0
  const baseColor = new THREE.Color(BODY_COLOR)

  const update: ClawdCompanion['update'] = (t, dt, follow) => {
    group.position.copy(follow.position)
    group.rotation.y = follow.yaw

    // Swim wiggle + paddle, scaled up briefly after a reaction.
    if (reactTimer > 0) reactTimer = Math.max(0, reactTimer - dt)
    const excite = 1 + reactTimer * 2.2
    group.rotation.z = Math.sin(t * 2.4) * 0.06 * excite
    group.rotation.x = Math.sin(t * 1.7 + 0.6) * 0.05 * excite
    const paddle = t * 6 * excite
    frontLegs.rotation.x = Math.sin(paddle) * 0.5
    backLegs.rotation.x = Math.sin(paddle + 1.1) * 0.5
    const bob = Math.sin(t * 2.4 + 0.4) * 0.04 * excite
    group.position.y += bob
  }

  return {
    group,
    update,
    react: () => {
      reactTimer = 1
    },
    setColor: (hex: number) => {
      baseColor.setHex(hex)
      // Colour lives in the baked vertex colours, so re-bake rather than tint
      // the material.
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (!mesh.isMesh || mesh.userData.isOutline) return
        bakeCelShading(mesh.geometry, { baseColor: hex, strength: 0.38, steps: 3 })
      })
    },
    setOutlines: (on: boolean) => {
      for (const shell of outlineMeshes) shell.visible = on
    },
    dispose: () => {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      bodyMaterial.dispose()
      eyeMaterial.dispose()
      for (const material of outlineMaterials) material.dispose()
      ;(shadow.material as THREE.Material).dispose()
      group.clear()
    },
  }
}
