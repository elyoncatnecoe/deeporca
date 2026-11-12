import * as THREE from 'three'
import { DecalGeometry } from 'three/examples/jsm/geometries/DecalGeometry.js'
import { applySoftShade, createOutlineShell } from '../toon'

/*
 * The "GPT seal" companion, ported from an earlier web prototype.
 *
 * The original is a standalone three.js page: a seal built out of scaled
 * spheres (body, belly, head, snout, nose, eyes with catch-lights, blush,
 * front/rear flippers, whiskers) with the OpenAI knot logo decalled onto its
 * back as a scattering of spots of different sizes.
 *
 * Two things changed on the way in:
 *
 * 1. Shading. The original is a lit scene (MeshStandardMaterial + three
 *    lights). This aquarium is deliberately unlit — every material is
 *    MeshBasicMaterial and the form comes from cartoon shading — so the parts
 *    carry their flat colour in vertex colours and a soft per-fragment cel
 *    ramp (see toon.applySoftShade) gives them their roundness. The orca uses
 *    the same trick, so the two characters read as one art style.
 * 2. Outlines are optional. The ink hulls are built for the big masses and
 *    flippers but ship hidden; the toolbar's outline toggle shows/hides them
 *    for the orca, Clawd and the seal together (default off — the flat look
 *    is the baseline). Thin parts (whiskers, blush, eyes) never get one: a
 *    hull wide enough to read on the body would swallow a whisker whole — the
 *    same trap the orca's fins hit.
 *
 * The eyes are the one place we deliberately diverge from the source page.
 * The page models a white ball with a dark pupil in front of it; the white is
 * buried inside the head sphere, so what actually shows is a dark bead — but
 * it is still modelled, and the seal is not supposed to have eye whites at
 * all. The white is therefore dropped: the eye is a plain black bead plus its
 * catch-light, matching how the source reads in practice.
 *
 * Facing: the snout points along local +Z, the same convention as Clawd, so
 * the caller can hand it the exact yaw it hands him.
 */

/** Identity of the model, for anyone reading the scene graph. */
export const SEAL_NAME = 'gpt-seal-companion'

/**
 * Height of the source model in its own units (body bottom ≈ -0.85, crown of
 * the head ≈ +1.10). Used to scale the seal to a chosen in-world size.
 */
const SOURCE_HEIGHT = 1.95

/** Palette, straight from the original. */
const BODY_COLOR = 0x8cb4d4
const BELLY_COLOR = 0xe8f0f8
const NOSE_COLOR = 0x3a2a2a
const EYE_PUPIL_COLOR = 0x111122
const CHEEK_COLOR = 0xffaacc
const WHISKER_COLOR = 0xdddddd
/** The OpenAI knot is etched on in grey, as in the source page. */
const SPOT_FILL = '#666666'

/** Ink hulls (hidden by default; the toolbar outline toggle shows them). */
const OUTLINE_COLOR = 0x14202e
/** Ink width for the big round masses, in model units. */
const BODY_OUTLINE = 0.05
/**
 * Ink width for the flippers. A rear flipper is only 0.12 units thick, so
 * anything wider than this eats the fin and reads as a black twig.
 */
const FIN_OUTLINE = 0.025

/** The body ellipsoid, reused for the spot projection maths. */
const BODY_SCALE = new THREE.Vector3(1.0, 0.85, 1.3)

/**
 * Spot placement on the body ellipsoid, copied verbatim from the original so
 * the markings land in the same places (back, flanks, shoulders) at the same
 * relative sizes: (theta from +Y, phi around Y, decal box size).
 */
const SPOTS: { theta: number; phi: number; size: number }[] = [
  { theta: 35, phi: 270, size: 0.55 }, // crown of the back — the big one
  { theta: 55, phi: 210, size: 0.3 }, // left rear shoulder — small
  { theta: 55, phi: 330, size: 0.42 }, // right rear shoulder — medium
  { theta: 75, phi: 180, size: 0.25 }, // left flank — small
  { theta: 75, phi: 0, size: 0.5 }, // right flank — large
  { theta: 85, phi: 240, size: 0.35 }, // left rear low — medium
  { theta: 85, phi: 300, size: 0.22 }, // right rear low — the smallest
]

/** The OpenAI knot, as an SVG path on a 24x24 grid. */
const GPT_PATH =
  'M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z'

export interface SealCompanion {
  readonly group: THREE.Group
  /** Pose it from the orca's past position, plus a little idle motion. */
  update: (t: number, dt: number, follow: { position: THREE.Vector3; yaw: number }) => void
  /** Playful kick, used when it is clicked or the orca is fussed over. */
  react: () => void
  /** Ink-outline toggle (toolbar controls all three characters together). */
  setOutlines: (on: boolean) => void
  dispose: () => void
}

/** Bake one flat base colour into a geometry's vertex colours. */
function tintGeometry(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const c = new THREE.Color(color)
  const colors = new Float32Array(position.count * 3)
  for (let i = 0; i < position.count; i++) {
    colors[i * 3] = c.r
    colors[i * 3 + 1] = c.g
    colors[i * 3 + 2] = c.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/** A point on the unit sphere: theta from +Y, phi around Y. */
function spherePoint(thetaDeg: number, phiDeg: number): THREE.Vector3 {
  const theta = THREE.MathUtils.degToRad(thetaDeg)
  const phi = THREE.MathUtils.degToRad(phiDeg)
  return new THREE.Vector3(Math.sin(theta) * Math.cos(phi), Math.cos(theta), Math.sin(theta) * Math.sin(phi))
}

/** Aim a decal projector's local +Z along a surface normal. */
function orientationFromNormal(normal: THREE.Vector3): THREE.Euler {
  const zAxis = normal.clone().normalize()
  const up = new THREE.Vector3(0, 1, 0)
  if (Math.abs(zAxis.dot(up)) > 0.99) up.set(0, 0, -1)
  const xAxis = new THREE.Vector3().crossVectors(up, zAxis).normalize()
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize()
  const m = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis)
  return new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromRotationMatrix(m))
}

/**
 * Rasterise the OpenAI knot into a canvas so it can be used as a decal map.
 * Left in the renderer's default (linear) colour space on purpose: this whole
 * project runs unmanaged, so the canvas colour lands on screen verbatim.
 */
function buildSpotTexture(): THREE.CanvasTexture {
  const size = 1024
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  ctx.scale(size / 24, size / 24)
  ctx.fillStyle = SPOT_FILL
  ctx.fill(new Path2D(GPT_PATH))
  const texture = new THREE.CanvasTexture(canvas)
  texture.anisotropy = 4
  return texture
}

export function createSealCompanion(targetHeight = 1.25): SealCompanion {
  const group = new THREE.Group()
  group.name = SEAL_NAME

  const geometries: THREE.BufferGeometry[] = []
  const materials: THREE.Material[] = []
  const textures: THREE.Texture[] = []

  // One shared surface material: the flat colour rides in the vertex colours,
  // and the soft cel ramp gives the spheres their form.
  const surfaceMaterial = applySoftShade(
    new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true }),
    { strength: 0.42, softness: 0.62 },
  )
  const highlightMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff })
  const cheekMaterial = new THREE.MeshBasicMaterial({
    color: CHEEK_COLOR,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  })
  const whiskerMaterial = new THREE.MeshBasicMaterial({ color: WHISKER_COLOR })
  materials.push(surfaceMaterial, highlightMaterial, cheekMaterial, whiskerMaterial)

  const sphere = (radius: number, widthSegments: number, heightSegments: number, color: THREE.ColorRepresentation): THREE.BufferGeometry => {
    const geometry = new THREE.SphereGeometry(radius, widthSegments, heightSegments)
    tintGeometry(geometry, color)
    geometries.push(geometry)
    return geometry
  }

  interface PartOptions {
    parent?: THREE.Object3D
    geometry: THREE.BufferGeometry
    position?: [number, number, number]
    rotation?: [number, number, number]
    scale?: [number, number, number]
    /** Inverted-hull ink width in model units. Omit for no outline. */
    outline?: number
    material?: THREE.Material
  }

  /**
   * Add a part and (optionally) its ink hull *as siblings inside a holder*,
   * never as a parent/child pair: a hull parented to the mesh would inherit
   * the mesh's non-uniform scale a second time and drift off the silhouette.
   * The holder is what gets animated (see the flippers below).
   *
   * The part's own `scale` goes on the **mesh**, not the holder. A holder is
   * also the parent of any nested parts — the eye's pupil and catch-light — and
   * scaling the holder would scale their offsets too. That is not hypothetical:
   * it multiplied the pupil's forward offset by the eyeball's 0.62 z-scale and
   * buried it inside the white, leaving a blank-eyed seal.
   */
  const outlineMeshes: THREE.Mesh[] = []
  const addPart = (options: PartOptions): { holder: THREE.Group; mesh: THREE.Mesh } => {
    const holder = new THREE.Group()
    if (options.position) holder.position.fromArray(options.position)
    if (options.rotation) holder.rotation.fromArray(options.rotation)
    ;(options.parent ?? group).add(holder)

    const mesh = new THREE.Mesh(options.geometry, options.material ?? surfaceMaterial)
    if (options.scale) mesh.scale.fromArray(options.scale)
    holder.add(mesh)

    if (options.outline !== undefined) {
      const outline = createOutlineShell(options.geometry, options.outline, OUTLINE_COLOR)
      if (options.scale) outline.scale.fromArray(options.scale)
      outline.visible = false
      holder.add(outline)
      outlineMeshes.push(outline)
    }
    return { holder, mesh }
  }

  // --- body (built first: the spots are projected onto it) -----------------
  const bodyGeometry = sphere(1, 48, 36, BODY_COLOR)
  const body = addPart({
    geometry: bodyGeometry,
    scale: [BODY_SCALE.x, BODY_SCALE.y, BODY_SCALE.z],
    outline: BODY_OUTLINE,
  })

  // --- belly ---------------------------------------------------------------
  addPart({
    geometry: sphere(0.82, 24, 18, BELLY_COLOR),
    position: [0, -0.12, 0.1],
    scale: [0.95, 0.75, 1.15],
  })

  // --- head ----------------------------------------------------------------
  addPart({
    geometry: sphere(0.68, 32, 24, BODY_COLOR),
    position: [0, 0.45, 0.85],
    scale: [0.95, 0.9, 0.95],
    outline: BODY_OUTLINE,
  })

  // --- snout ---------------------------------------------------------------
  addPart({
    geometry: sphere(0.38, 24, 18, BELLY_COLOR),
    position: [0, 0.3, 1.25],
    scale: [0.9, 0.7, 1.0],
    outline: BODY_OUTLINE,
  })

  // --- nose ----------------------------------------------------------------
  addPart({
    geometry: sphere(0.1, 16, 12, NOSE_COLOR),
    position: [0, 0.38, 1.58],
    scale: [1.1, 0.8, 0.9],
  })

  // --- eyes (a plain black bead + catch-light), angled outward a little ----
  // The source page builds each eye as a white ball with a dark pupil riding
  // in front of it. That white ball is *inside* the head sphere there, so the
  // page only ever shows the dark bead — but the ball is still modelled, and
  // the brief here is explicit: the seal has no eye whites. So the white is
  // dropped outright and the eye is just the black bead the page actually
  // reads as. Eye centres stay at the source's (±0.32, 0.55, 1.25) with the
  // 0.35 rad outward yaw.
  for (const x of [-0.32, 0.32]) {
    const yaw = x > 0 ? 0.35 : -0.35
    // The bead is pushed out along its own (yawed) axis so it clears the
    // head's curved surface and reads as a round eye rather than a flat dot.
    // On the page that job was done by the white ball the pupil sat on; with
    // the white gone the offset has to grow (0.12 -> 0.145) to compensate.
    const forward = 0.145
    const eye = addPart({
      geometry: sphere(0.1, 20, 16, EYE_PUPIL_COLOR),
      position: [x + Math.sin(yaw) * forward, 0.57, 1.25 + Math.cos(yaw) * forward],
      rotation: [0, yaw, 0],
      scale: [1, 1.12, 0.85],
    })
    addPart({
      parent: eye.holder,
      geometry: sphere(0.03, 16, 16, 0xffffff),
      position: [-0.03, 0.045, 0.07],
      scale: [1, 1, 0.55],
      material: highlightMaterial,
    })
  }

  // --- blush ---------------------------------------------------------------
  // Flat and wide, with enough segments that the intersection with the head
  // reads as a soft oval instead of a hard-edged patch.
  for (const x of [-0.52, 0.52]) {
    addPart({
      geometry: sphere(0.19, 28, 20, CHEEK_COLOR),
      position: [x, 0.43, 1.19],
      scale: [1, 0.66, 0.28],
      material: cheekMaterial,
    })
  }

  // --- front flippers ------------------------------------------------------
  // The source parks them at x = ±0.95, which is *flush* with the body
  // surface: only a paper-thin sliver of each paddle clears the ellipsoid.
  // Pushed out to ±1.04 and given a little more thickness they read as
  // actual flippers.
  const frontFlippers: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const flipper = addPart({
      geometry: sphere(0.35, 20, 14, BODY_COLOR),
      position: [side * 1.04, -0.16, 0.6],
      scale: [0.3, 0.72, 1.0],
      rotation: [-0.3, 0, side * 0.62],
      outline: FIN_OUTLINE,
    })
    frontFlippers.push(flipper.holder)
  }

  // --- rear flippers -------------------------------------------------------
  const rearFlippers: THREE.Group[] = []
  for (const side of [-1, 1]) {
    const flipper = addPart({
      geometry: sphere(0.4, 20, 14, BODY_COLOR),
      position: [side * 0.35, -0.15, -1.25],
      scale: [0.7, 0.15, 0.9],
      rotation: [0.4, 0, side * 0.7],
      outline: FIN_OUTLINE,
    })
    rearFlippers.push(flipper.holder)
  }

  // --- whiskers (never outlined; a hull would eat them) --------------------
  const whiskerGeometry = () => {
    const geometry = new THREE.CylinderGeometry(0.008, 0.012, 0.6, 6)
    tintGeometry(geometry, WHISKER_COLOR)
    geometries.push(geometry)
    return geometry
  }
  for (const [x, y, z, rotY] of [
    [-0.36, 0.32, 1.4, 0.2],
    [-0.3, 0.22, 1.45, 0.15],
    [0.36, 0.32, 1.4, -0.2],
    [0.3, 0.22, 1.45, -0.15],
  ] as const) {
    addPart({
      geometry: whiskerGeometry(),
      position: [x, y, z],
      rotation: [0, rotY, Math.PI / 2 + (x > 0 ? -0.3 : 0.3)],
      material: whiskerMaterial,
    })
  }

  // --- the GPT markings ----------------------------------------------------
  // The projector works in world space, so the spots are computed while the
  // whole group still sits at the identity transform; afterwards the group's
  // own scale/rotation carries body and spots together.
  group.updateMatrixWorld(true)
  const spotTexture = buildSpotTexture()
  textures.push(spotTexture)
  const spotMaterial = new THREE.MeshBasicMaterial({
    map: spotTexture,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
  })
  materials.push(spotMaterial)

  for (const spot of SPOTS) {
    const dir = spherePoint(spot.theta, spot.phi)
    const position = new THREE.Vector3(dir.x * BODY_SCALE.x, dir.y * BODY_SCALE.y, dir.z * BODY_SCALE.z)
    // Surface normal of an ellipsoid at that point: the direction divided by
    // the squared semi-axes — with unit semi-axes that is just dir / scale.
    const normal = new THREE.Vector3(
      dir.x / BODY_SCALE.x,
      dir.y / BODY_SCALE.y,
      dir.z / BODY_SCALE.z,
    ).normalize()
    const geometry = new DecalGeometry(
      body.mesh,
      position,
      orientationFromNormal(normal),
      new THREE.Vector3(spot.size, spot.size, 0.6),
    )
    geometries.push(geometry)
    group.add(new THREE.Mesh(geometry, spotMaterial))
  }

  group.scale.setScalar(targetHeight / SOURCE_HEIGHT)

  let reactTimer = 0

  const update: SealCompanion['update'] = (t, dt, follow) => {
    if (reactTimer > 0) reactTimer = Math.max(0, reactTimer - dt)
    // Swim a little harder for a moment after being poked.
    const excite = 1 + reactTimer * 2.0

    // Idle drift layered on top of the trail position, so it reads as a
    // living animal rather than a model glued to the orca's old path.
    group.position.set(
      follow.position.x + Math.sin(t * 0.62) * 0.16,
      follow.position.y + Math.sin(t * 1.3) * 0.11 * excite,
      follow.position.z + Math.cos(t * 0.5) * 0.12,
    )
    group.rotation.set(
      Math.sin(t * 1.6) * 0.07 * excite,
      follow.yaw + Math.sin(t * 0.7) * 0.2 * excite,
      Math.sin(t * 0.9) * 0.1 * excite,
    )

    const [frontLeft, frontRight] = frontFlippers
    frontLeft.rotation.z = -0.62 + Math.sin(t * 2.4) * 0.4 * excite
    frontRight.rotation.z = 0.62 + Math.sin(t * 2.4 + 0.6) * 0.4 * excite
    frontLeft.rotation.x = -0.3 + Math.sin(t * 2.4 + 0.4) * 0.25 * excite
    frontRight.rotation.x = -0.3 + Math.sin(t * 2.4 + 1.0) * 0.25 * excite

    const [rearLeft, rearRight] = rearFlippers
    rearLeft.rotation.x = 0.4 + Math.sin(t * 2.0) * 0.4 * excite
    rearRight.rotation.x = 0.4 + Math.sin(t * 2.0 + 0.4) * 0.4 * excite
    rearLeft.rotation.z = -0.7 + Math.sin(t * 2.0 + 0.2) * 0.2 * excite
    rearRight.rotation.z = 0.7 + Math.sin(t * 2.0 + 0.5) * 0.2 * excite
  }

  return {
    group,
    update,
    react: () => {
      reactTimer = 1
    },
    setOutlines: (on: boolean) => {
      for (const outline of outlineMeshes) outline.visible = on
    },
    dispose: () => {
      for (const geometry of geometries) geometry.dispose()
      for (const material of materials) material.dispose()
      for (const texture of textures) texture.dispose()
      group.clear()
    },
  }
}
