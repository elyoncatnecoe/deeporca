import * as THREE from 'three'
import { mergeBufferGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { AquariumTheme } from './themes'
import type { QualitySettings } from '../quality'
import { bakeConcavityAO, bakeTopShade } from './lighting'
import { createSeafloorMaterial, type SeafloorMaterial } from './seafloorMaterial'

/*
 * AbyssRium-style seafloor: a near-black navy sand plain (far darker than the
 * water column above it, so the orca stays the brightest saturated object in
 * frame) dotted with a muted reef — blob corals, tube sponges, deep-green
 * seaweed and rounded rock silhouettes that dissolve into the fog with
 * distance.
 *
 * Mobile note — this is the heaviest part of the scene. Props are generated
 * procedurally, which naturally yields hundreds of tiny meshes and therefore
 * hundreds of draw calls. Instead each *kind* of prop is baked into a few
 * merged geometry variants and drawn with one InstancedMesh per variant. Theme
 * changes only rewrite instance colors in place, so switching themes no longer
 * rebuilds a single geometry.
 *
 * NOTE: three r147's InstancedMesh has no bounding-volume helper, so every
 * instanced mesh here sets `frustumCulled = false`.
 */

export interface Terrain {
  group: THREE.Group
  update: (t: number) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

/**
 * Nothing is planted inside this radius.
 *
 * The camera stands off anywhere from ~17 units (desktop) to ~60 (portrait
 * phone) depending on aspect, and it looks along a shallow angle, so props
 * nearer than this end up between the lens and the subject. At the wide phone
 * framing a 16-unit sand mound sat squarely in front of the orca, hence a
 * generous radius rather than a tight one.
 */
const CAMERA_CLEAR_RADIUS = 22
const KELP_VARIANTS = 6
const CORAL_VARIANTS = 4
const HILL_VARIANTS = 4
const SPONGE_VARIANTS = 4
const CHEST_VARIANTS = 3
const SKYLINE_VARIANTS = 3

/** Base prop counts at full quality, scaled down per device tier. */
const BASE_COUNTS = { hill: 10, sponge: 14, chest: 2, coral: 30, kelp: 64, starfish: 20, rock: 26, skyline: 20 }

/*
 * How far the sand reaches.
 *
 * The rim has to be *gone* before the camera can see it, not merely recoloured.
 * Fog here is FogExp2, so coverage is a function of distance: at the old 65-unit
 * rim only ~40% of the fog had been applied, which left the square's edge — and,
 * looking diagonally, its corner — reading as a hard silhouette against the
 * water. At 210 units the rim sits past 97% in all three themes, so the sand
 * simply recedes into the horizon instead of ending.
 */
const GROUND_HALF = 210
/**
 * Vertex density near the middle, in world units per unit of grid space; the
 * rest of the plane grows cubically toward the rim. A uniform grid this large
 * would spend its detail on sand nobody looks at and starve the dunes under the
 * play area. At this setting the play area keeps ~1.5-unit quads — the same as
 * the old 130-unit plane — while the rim ends up at ~7.
 */
const GROUND_NEAR = 90
const GROUND_SEGMENTS = 120

/**
 * Map a normalised grid coordinate (-1..1) onto world space: linear near the
 * middle, cubic toward the rim. `f(1)` is exactly GROUND_HALF, so the outer
 * edge stays where the constant says it is.
 */
function warpGroundAxis(u: number): number {
  const a = Math.abs(u)
  return Math.sign(u) * (GROUND_NEAR * a + (GROUND_HALF - GROUND_NEAR) * a * a * a)
}

function shade(hex: number, scale: number): number {
  const c = new THREE.Color(hex)
  c.r = Math.min(1, c.r * scale)
  c.g = Math.min(1, c.g * scale)
  c.b = Math.min(1, c.b * scale)
  return c.getHex()
}

function flat(color: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
}

function smoothstep(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

/*
 * Organic seafloor height: a gentle central sand bowl lifts the play area
 * (orca cruise / decor zone on its flat top), then the sand rolls down and
 * away into the fog — never a hard edge. Exported so decor placement, the
 * caustic pool centre and the orca's contact shadow can all bed on the sand.
 */
export function heightAt(x: number, z: number): number {
  const d = Math.hypot(x, z)
  const dome = (1 - smoothstep(8, 20, d)) * 0.35
  const ux = smoothstep(22, 34, Math.abs(x))
  const uz = smoothstep(17, 28, Math.abs(z))
  const u = Math.max(ux, uz)
  const n =
    Math.sin(x * 0.35 + Math.sin(z * 0.28) * 1.4) * Math.cos(z * 0.32 + Math.sin(x * 0.31) * 1.3) * 0.55 +
    Math.sin(x * 0.85 + 1.7) * Math.cos(z * 0.9 + 0.3) * 0.28 +
    Math.sin(x * 1.8 + 0.5) * Math.cos(z * 1.9 + 2.1) * 0.14
  return dome - u * 1.6 + n * (0.05 + 0.22 * u)
}

// ------------------------------------------------------- geometry baking

/** `node`'s transform expressed relative to `root`. */
function matrixWithin(root: THREE.Object3D, node: THREE.Object3D): THREE.Matrix4 {
  root.updateMatrixWorld(true)
  return new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(node.matrixWorld)
}

/**
 * Merge every mesh under `node` into one geometry carrying only position and
 * color. UVs and normals are dropped because the whole scene is unlit,
 * texture-free flat color — carrying them would be pure waste.
 *
 * Vertex colors hold *relative* brightness only (1.0 = the raw material
 * color), which lets a single per-instance color drive a whole prop while
 * still preserving per-part shading such as darker rock lobes.
 */
function flatten(node: THREE.Object3D): { geometry: THREE.BufferGeometry; vertexColors: boolean } | null {
  const parts: THREE.BufferGeometry[] = []
  node.updateMatrixWorld(true)

  node.traverse((child) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | THREE.MeshBasicMaterial
      | undefined
    if (!material) return

    const source = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone()
    source.applyMatrix4(matrixWithin(node, mesh))

    const position = source.getAttribute('position') as THREE.BufferAttribute
    const vertexCount = position.count
    const colors = new Float32Array(vertexCount * 3)
    const tint = material.color
    // Materials in this module are authored as white so the instance color
    // shows through unaltered; anything else is baked as a fixed tint.
    const isWhite = tint.r > 0.995 && tint.g > 0.995 && tint.b > 0.995
    for (let i = 0; i < vertexCount; i++) {
      colors[i * 3] = isWhite ? 1 : tint.r
      colors[i * 3 + 1] = isWhite ? 1 : tint.g
      colors[i * 3 + 2] = isWhite ? 1 : tint.b
    }

    const part = new THREE.BufferGeometry()
    part.setAttribute('position', position.clone())
    part.setAttribute('color', new THREE.BufferAttribute(colors, 3))
    const normal = source.getAttribute('normal')
    if (normal) part.setAttribute('normal', normal.clone())

    // Relief. Every prop now gets a lit top and a shadowed underside, baked
    // into the vertex colour — which is why `vertexColors` is unconditionally
    // true below. Baking rather than shading in the shader is deliberate:
    // instances are Y-rotated at random, so a directional light term would
    // point the wrong way on most of them, while N.y survives any Y rotation.
    bakeTopShade(part)
    // The normal has done its job; carrying it into the merged geometry would
    // just be dead weight on an unlit material.
    part.deleteAttribute('normal')
    parts.push(part)

    if (source !== mesh.geometry) source.dispose()
  })

  if (parts.length === 0) return null
  if (parts.length === 1) return { geometry: parts[0], vertexColors: true }
  const merged = mergeBufferGeometries(parts, false)
  parts.forEach(part => part.dispose())
  return merged ? { geometry: merged, vertexColors: true } : null
}

/**
 * One InstancedMesh per baked variant. Instances of the same kind share
 * geometry, so a whole reef costs a handful of draw calls instead of hundreds.
 */
class InstancedGroup {
  readonly group = new THREE.Group()
  private readonly meshes: THREE.InstancedMesh[] = []

  constructor(
    /**
     * A model, or a factory producing one. Factories are called once per
     * variant, so each variant bakes its own random geometry — passing a
     * single prebuilt model made every "variant" identical.
     */
    source: THREE.Object3D | (() => THREE.Object3D),
    variantCount: number,
    totalInstances: number,
  ) {
    // Bake once to learn whether the geometry needs per-vertex colors, then
    // share a single material across every variant. `vertexColors` must be
    // known up front: toggling it later would force a shader recompile.
    const baked: { geometry: THREE.BufferGeometry; vertexColors: boolean }[] = []
    // A variant that will never receive an instance is a wasted draw call, so
    // the pool is capped at the number of props actually being placed.
    const wanted = Math.max(1, Math.min(variantCount, totalInstances))
    for (let i = 0; i < wanted; i++) {
      const model = typeof source === 'function' ? source() : source
      const result = flatten(model)
      if (result) baked.push(result)
    }
    if (baked.length === 0) return

    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      side: THREE.DoubleSide,
      // Always on: every baked geometry now carries a shading term in its
      // vertex colour, including the all-white ones where the instance colour
      // is the only tint. Turning this off per-variant would silently drop
      // the relief from exactly those props.
      vertexColors: true,
    })
    for (const entry of baked) {
      const mesh = new THREE.InstancedMesh(entry.geometry, material, 1)
      mesh.count = 0
      mesh.frustumCulled = false
      this.group.add(mesh)
      this.meshes.push(mesh)
    }
  }

  get size(): number {
    return this.meshes.length
  }

  /** Ensure every variant can hold `capacity` instances. */
  reserve(capacity: number): void {
    // This must stay >= the variant count the constructor settled on, or the
    // variant count would be silently reduced a second time here.
    const room = Math.max(capacity, this.meshes.length)
    for (let i = 0; i < this.meshes.length; i++) {
      const mesh = this.meshes[i]
      if (mesh.instanceMatrix.count >= room) continue
      const grown = new THREE.InstancedMesh(mesh.geometry, mesh.material as THREE.Material, room)
      grown.count = mesh.count
      grown.frustumCulled = false
      const matrix = new THREE.Matrix4()
      const color = new THREE.Color()
      for (let j = 0; j < mesh.count; j++) {
        mesh.getMatrixAt(j, matrix)
        grown.setMatrixAt(j, matrix)
        mesh.getColorAt(j, color)
        grown.setColorAt(j, color)
      }
      this.group.remove(mesh)
      mesh.dispose()
      this.group.add(grown)
      this.meshes[i] = grown
    }
  }

  /**
   * Append one instance and return the slot it landed in. Callers MUST keep
   * that slot to recolour the instance later — deriving it independently is
   * what previously mis-addressed every multi-instance variant.
   */
  add(variant: number, position: THREE.Vector3, scale: THREE.Vector3, rotationY: number, color: THREE.Color): number {
    const mesh = this.meshes[variant % this.meshes.length]
    if (!mesh) return 0
    const index = mesh.count
    if (index >= mesh.instanceMatrix.count) return index
    const dummy = new THREE.Object3D()
    dummy.position.copy(position)
    dummy.scale.copy(scale)
    dummy.rotation.set(0, rotationY, 0)
    dummy.updateMatrix()
    mesh.setMatrixAt(index, dummy.matrix)
    mesh.setColorAt(index, color)
    mesh.count = index + 1
    return index
  }

  /** Re-tint instance `index` of `variant` — used on theme changes. */
  recolor(variant: number, index: number, color: THREE.Color): void {
    const mesh = this.meshes[variant % this.meshes.length]
    if (!mesh || index >= mesh.count) return
    mesh.setColorAt(index, color)
  }

  markDirty(): void {
    for (const mesh of this.meshes) {
      mesh.instanceMatrix.needsUpdate = true
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
    }
  }

  dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    for (const mesh of this.meshes) {
      geometries.add(mesh.geometry)
      materials.add(mesh.material as THREE.Material)
      mesh.dispose()
    }
    geometries.forEach(geometry => geometry.dispose())
    materials.forEach(material => material.dispose())
    this.meshes.length = 0
  }
}

// ------------------------------------------------------- prop builders

/**
 * One reef piece: tube / branch / fan / brain coral, picked at random. Built
 * from white materials whose brightness steps ARE the shading (body 1.0, lip
 * or tip brighter), so the single per-instance hue from the theme palette
 * still reads as a multi-tone piece. A small sand mound grounds it.
 */
function buildReefPiece(): THREE.Group {
  const piece = new THREE.Group()
  const mound = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 6), flat(shade(0xffffff, 0.62)))
  mound.scale.set(1, 0.3, 1)
  piece.add(mound)

  const kind = Math.random()
  if (kind < 0.32) {
    // Tube coral: upright cylinders with a brighter lip ring at each mouth.
    const tubes = 3 + Math.floor(Math.random() * 3)
    for (let i = 0; i < tubes; i++) {
      const height = 0.4 + Math.random() * 0.75
      const radius = 0.09 + Math.random() * 0.07
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.82, radius, height, 8), flat(0xffffff))
      tube.position.set((Math.random() - 0.5) * 0.42, height / 2 + 0.04, (Math.random() - 0.5) * 0.42)
      tube.rotation.z = (Math.random() - 0.5) * 0.26
      tube.rotation.x = (Math.random() - 0.5) * 0.26
      const lip = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius * 0.82, 0.08, 8), flat(shade(0xffffff, 1.3)))
      lip.position.set(tube.position.x + tube.rotation.z * height * 0.5, height + 0.06, tube.position.z)
      piece.add(tube, lip)
    }
  } else if (kind < 0.62) {
    // Branch coral: a fractal tree — every arm forks into 2-3 children
    // (length ×0.72, radius ×0.6) with an upward bias, tip segments brighter.
    // The recursion gives the distinctive branching silhouette; brightness
    // stepping (instance hue × shade) keeps the multi-tone read.
    const UP = new THREE.Vector3(0, 1, 0)
    const grow = (
      root: THREE.Vector3,
      dir: THREE.Vector3,
      length: number,
      radius: number,
      depth: number,
    ): void => {
      const seg = new THREE.Mesh(
        new THREE.CylinderGeometry(radius * 0.62, radius, length, 7),
        flat(shade(0xffffff, depth <= 0 ? 1.3 : 0.88 + depth * 0.06)),
      )
      seg.position.copy(root).addScaledVector(dir, length / 2)
      seg.quaternion.setFromUnitVectors(UP, dir)
      piece.add(seg)
      const tip = root.clone().addScaledVector(dir, length)
      if (depth <= 0) {
        const bead = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.95, 8, 8), flat(shade(0xffffff, 1.35)))
        bead.position.copy(tip)
        piece.add(bead)
        return
      }
      let side = new THREE.Vector3().crossVectors(dir, UP)
      if (side.lengthSq() < 1e-6) side.set(1, 0, 0)
      side.normalize()
      const children = depth >= 3 ? 2 : Math.random() < 0.4 ? 3 : 2
      for (let i = 0; i < children; i++) {
        const spread = (i / Math.max(1, children - 1) - 0.5) * 1.5
        const childDir = dir
          .clone()
          .applyAxisAngle(side, spread)
          .applyAxisAngle(dir, Math.random() * Math.PI * 2)
        childDir.lerp(UP, 0.18).normalize()
        grow(tip, childDir, length * 0.72, radius * 0.6, depth - 1)
      }
    }
    grow(new THREE.Vector3(0, 0.16, 0), new THREE.Vector3(0, 1, 0), 0.42, 0.08, 3)
  } else if (kind < 0.84) {
    // Fan coral: a thin upright half-disc on a stem, brighter rim.
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.07, 0.3, 7), flat(shade(0xffffff, 0.85)))
    stem.position.y = 0.15
    piece.add(stem)
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.5, 10, 0, Math.PI), flat(shade(0xffffff, 1.05)))
    fan.position.y = 0.62
    fan.rotation.y = Math.random() * Math.PI
    fan.rotation.x = -0.25 - Math.random() * 0.3
    piece.add(fan)
    const rim = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.035, 6, 12, Math.PI), flat(shade(0xffffff, 1.3)))
    rim.position.copy(fan.position)
    rim.rotation.copy(fan.rotation)
    piece.add(rim)
  } else {
    // Brain coral: a squat dome with a few fused lobes.
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.34, 10, 8), flat(shade(0xffffff, 0.9)))
    dome.scale.y = 0.72
    dome.position.y = 0.2
    piece.add(dome)
    for (let i = 0; i < 3; i++) {
      const ang = Math.random() * Math.PI * 2
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.14 + Math.random() * 0.08, 8, 6), flat(shade(0xffffff, 1.12)))
      lobe.position.set(Math.cos(ang) * 0.16, 0.3 + Math.random() * 0.06, Math.sin(ang) * 0.16)
      piece.add(lobe)
    }
  }
  return piece
}

/**
 * Tube sponges — the warm accent of the reef. Tapered tubes with a brighter
 * lip ring at each mouth, brightness baked per part.
 */
function buildSpongeCluster(): THREE.Group {
  const cluster = new THREE.Group()
  const tubeCount = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < tubeCount; i++) {
    const height = 0.5 + Math.random() * 1.0
    const radius = 0.1 + Math.random() * 0.05
    const x = (Math.random() - 0.5) * 0.5
    const z = (Math.random() - 0.5) * 0.5
    const leanZ = (Math.random() - 0.5) * 0.3
    const leanX = (Math.random() - 0.5) * 0.3
    const tube = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.8, radius * 1.35, height, 8),
      flat(shade(0xffffff, 0.88 + Math.random() * 0.2)),
    )
    tube.position.set(x, height / 2, z)
    tube.rotation.z = leanZ
    tube.rotation.x = leanX
    const lip = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 1.05, radius * 0.8, 0.09, 8),
      flat(shade(0xffffff, 1.28)),
    )
    lip.position.set(x + leanZ * height * 0.5, height + 0.05, z)
    cluster.add(tube, lip)
  }
  return cluster
}

/**
 * Rounded rock cluster (low-poly boulders). Sharp cones read as paper
 * triangles against the soft water column; dodecahedra read as stone.
 */
function buildRockCluster(): THREE.Group {
  const cluster = new THREE.Group()
  const count = 2 + Math.floor(Math.random() * 3)
  for (let i = 0; i < count; i++) {
    const s = 0.45 + Math.random() * 0.75
    const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), flat(shade(0xffffff, 0.75 + Math.random() * 0.3)))
    rock.position.set((Math.random() - 0.5) * 1.4, s * 0.35, (Math.random() - 0.5) * 1.4)
    rock.scale.y = 0.55 + Math.random() * 0.35
    rock.rotation.set(Math.random() * 0.5, Math.random() * Math.PI, Math.random() * 0.5)
    cluster.add(rock)
  }
  return cluster
}

/** Tapered kelp blade, pivoted at its base so an instance matrix can sway it. */
function buildKelpBlade(): THREE.PlaneGeometry {
  const height = 0.9 + Math.random() * 2.6
  const geometry = new THREE.PlaneGeometry(0.3, height, 1, 12)
  const pos = geometry.attributes.position.array as Float32Array
  for (let i = 0; i < pos.length; i += 3) {
    const y = pos[i + 1]
    const t = (y + height / 2) / height
    // Ribbon profile: narrow at the root and the tip, widest through the
    // middle — a blade that widens all the way up reads as a flag.
    pos[i] *= 0.3 + 0.7 * Math.sin(t * Math.PI)
    pos[i] += Math.sin(t * 2.2) * 0.05
  }
  geometry.computeVertexNormals()
  geometry.translate(0, height / 2, 0)
  return geometry
}

function buildStarfishGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  const points = 5
  const outer = 0.26
  const inner = 0.11
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner
    const angle = (i / (points * 2)) * Math.PI * 2 - Math.PI / 2
    const x = Math.cos(angle) * r
    const y = Math.sin(angle) * r
    if (i === 0) shape.moveTo(x, y)
    else shape.lineTo(x, y)
  }
  shape.closePath()
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: 0.06,
    bevelEnabled: true,
    bevelThickness: 0.018,
    bevelSize: 0.018,
    bevelSegments: 2,
  })
  geometry.rotateX(-Math.PI / 2)
  return geometry
}

/**
 * Distant silhouette boulder. Rounded, never a cone — the skyline has to
 * read as eroded rock dissolving into fog, not as a paper triangle.
 */
function buildSkylineGeometry(kind: number): THREE.BufferGeometry {
  if (kind === 0) return new THREE.DodecahedronGeometry(1, 0)
  if (kind === 1) return new THREE.IcosahedronGeometry(1, 0)
  return new THREE.OctahedronGeometry(1, 0)
}

/** Sunken treasure chest. Its colours are baked (wood + brass), not themed. */
function buildChest(): THREE.Group {
  const chest = new THREE.Group()
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.4, 0.5), flat(0x5f4432))
  body.position.y = 0.24
  chest.add(body)
  const lid = new THREE.Mesh(
    new THREE.CylinderGeometry(0.26, 0.26, 0.5, 10, 1, false, 0, Math.PI),
    flat(0x4a3325),
  )
  lid.rotation.z = Math.PI / 2
  lid.position.y = 0.47
  chest.add(lid)
  const band = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.06, 0.54), flat(0xc8a24a))
  band.position.y = 0.24
  chest.add(band)
  const coins: [number, number, number, number][] = [
    [0.16, 0.2, 0, 0.1],
    [-0.2, 0.14, 0.4, 0.07],
  ]
  for (const [x, z, rotY, r] of coins) {
    const coin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 12), flat(0xd8b050))
    coin.rotation.x = Math.PI / 2
    coin.rotation.y = rotY
    coin.position.set(x, 0.08, z)
    chest.add(coin)
  }
  return chest
}

// ------------------------------------------------------- assembly

/** Per-instance metadata so a theme change can re-tint without a rebuild. */
interface InstanceRecord {
  variant: number
  index: number
  colorSlot: number
  brightness: number
}

interface KelpRecord {
  variant: number
  index: number
  x: number
  y: number
  z: number
  yaw: number
  phase: number
}

/** Deterministic per-vertex noise for the sand, so it never shimmer-loops. */
function sandNoise(x: number, z: number): number {
  const s = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453
  return s - Math.floor(s)
}

export function createTerrain(theme: AquariumTheme, quality: QualitySettings): Terrain {
  const group = new THREE.Group()
  group.name = 'open-sea-terrain'

  // --- the sand itself ---
  //
  // A real seafloor mesh, displaced by heightAt: the previous build had no
  // ground at all (the "floor" was the dome gradient showing through), which
  // is why props looked like they floated. Vertex shading lifts a subtly
  // brighter platform under the play area and lets the sand sink toward the
  // skyline colour with distance, so terrain and silhouette merge in the fog.
  const groundGeo = new THREE.PlaneGeometry(GROUND_HALF * 2, GROUND_HALF * 2, GROUND_SEGMENTS, GROUND_SEGMENTS)
  groundGeo.rotateX(-Math.PI / 2)
  {
    // Warp the grid before anything reads positions, so the height field, the
    // distance-based tint and the baked occlusion are all evaluated on the
    // final vertex layout.
    const pos = groundGeo.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      pos.setX(i, warpGroundAxis(pos.getX(i) / GROUND_HALF))
      pos.setZ(i, warpGroundAxis(pos.getZ(i) / GROUND_HALF))
    }
  }
  {
    const pos = groundGeo.attributes.position as THREE.BufferAttribute
    const colors = new Float32Array(pos.count * 3)
    const sand = new THREE.Color(theme.sandColor)
    const edge = new THREE.Color(theme.skylineColor)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      pos.setY(i, heightAt(x, z))
      const d = Math.hypot(x, z)
      const platform = 1 + 0.18 * (1 - smoothstep(4, 14, d))
      const fade = 1 - smoothstep(20, 48, d)
      c.copy(sand).multiplyScalar(platform).lerp(edge, 1 - fade)
      const n = 0.94 + sandNoise(x, z) * 0.12
      colors[i * 3] = c.r * n
      colors[i * 3 + 1] = c.g * n
      colors[i * 3 + 2] = c.b * n
    }
    groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  }
  // The floor needs real normals now: they drive the key light in the shader.
  // Smooth (the plane is indexed, so shared vertices average) because sand has
  // no facets — the relief comes from the shading, not from the topology.
  groundGeo.computeVertexNormals()
  // Curvature occlusion, baked once: dune troughs sit back, crests come
  // forward. Theme-independent, so a theme switch only rescales its strength.
  groundGeo.setAttribute(
    'aAO',
    new THREE.BufferAttribute(bakeConcavityAO(groundGeo, heightAt), 1),
  )

  const seafloor = createSeafloorMaterial(theme)
  const groundMaterial = seafloor.material
  const ground = new THREE.Mesh(groundGeo, groundMaterial)
  ground.name = 'seafloor'
  ground.frustumCulled = false
  // The ground is transparent (its far field fades into the water), so it now
  // renders in the transparent queue — which three orders *after* the god rays
  // and the surface. Without an explicit order the sand would paint over both.
  // -15 puts it behind everything else that is transparent: surface (-10),
  // god rays (-5), particles and bubbles (0), contact shadow (1).
  ground.renderOrder = -15
  group.add(ground)

  // Counts are resolved once: the device tier never changes mid-session.
  const counts = {
    hill: Math.round(BASE_COUNTS.hill * quality.prop),
    sponge: Math.round(BASE_COUNTS.sponge * quality.prop),
    chest: Math.round(BASE_COUNTS.chest * quality.prop),
    coral: Math.round(BASE_COUNTS.coral * quality.coral),
    kelp: Math.round(BASE_COUNTS.kelp * quality.kelp),
    starfish: Math.round(BASE_COUNTS.starfish * quality.starfish),
    rock: Math.round(BASE_COUNTS.rock * quality.rock),
    skyline: Math.round(BASE_COUNTS.skyline * quality.skyline),
  }

  const coral = new InstancedGroup(buildReefPiece, CORAL_VARIANTS, counts.coral)
  const starfish = new InstancedGroup(new THREE.Mesh(buildStarfishGeometry(), flat(0xffffff)), 1, counts.starfish)
  const sponges = new InstancedGroup(buildSpongeCluster(), SPONGE_VARIANTS, counts.sponge)
  const chests = new InstancedGroup(buildChest(), CHEST_VARIANTS, counts.chest)
  const hills = new InstancedGroup(buildRockCluster(), HILL_VARIANTS, counts.hill)
  const rocks = new InstancedGroup(new THREE.Mesh(new THREE.IcosahedronGeometry(1, 0), flat(0xffffff)), 1, counts.rock)
  const skyline = new InstancedGroup(
    new THREE.Mesh(buildSkylineGeometry(0), flat(0xffffff)),
    SKYLINE_VARIANTS,
    counts.skyline,
  )
  const structures = [coral, starfish, sponges, chests, hills, rocks, skyline]
  structures.forEach(entry => group.add(entry.group))

  // Worst-case capacity per variant, so no prop is ever silently dropped.
  const perVariant = (total: number, variants: number): number => Math.ceil(total / variants) + 2
  coral.reserve(counts.coral + 1)
  starfish.reserve(counts.starfish + 1)
  sponges.reserve(perVariant(counts.sponge, sponges.size))
  chests.reserve(perVariant(counts.chest, chests.size))
  hills.reserve(perVariant(counts.hill, hills.size))
  rocks.reserve(counts.rock + 1)
  skyline.reserve(perVariant(counts.skyline, skyline.size))

  // Kelp is hand-rolled instancing because it sways every frame: one dynamic
  // matrix write per blade instead of forty separate draw calls. Each variant
  // carries its own material so the seaweed reads as mixed greens, not a
  // single flat colour.
  const kelpMaterials: THREE.MeshBasicMaterial[] = []
  const kelpMeshes: THREE.InstancedMesh[] = []
  for (let i = 0; i < KELP_VARIANTS; i++) {
    const material = flat(theme.kelpHues[i % theme.kelpHues.length])
    const mesh = new THREE.InstancedMesh(buildKelpBlade(), material, perVariant(counts.kelp, KELP_VARIANTS))
    mesh.count = 0
    mesh.frustumCulled = false
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    group.add(mesh)
    kelpMaterials.push(material)
    kelpMeshes.push(mesh)
  }
  const kelpRecords: KelpRecord[] = []

  // --- one-time placement ---
  const records = new Map<InstancedGroup, InstanceRecord[]>()
  const recordFor = (entry: InstancedGroup): InstanceRecord[] => {
    let list = records.get(entry)
    if (!list) {
      list = []
      records.set(entry, list)
    }
    return list
  }
  /**
   * The slot a prop lands in is the index *within its variant's mesh*, NOT the
   * running total of props. `add` returns it so the record and the instance can
   * never drift apart: deriving the index independently used to mis-address
   * every recolour for variants holding more than one instance, which left
   * whole swathes of the seafloor untinted white.
   */
  const white = new THREE.Color(0xffffff)

  const place = (
    entry: InstancedGroup,
    variant: number,
    position: THREE.Vector3,
    scale: THREE.Vector3,
    rotationY: number,
    colorSlot: number,
    color: THREE.Color,
    brightness = 1,
  ): void => {
    const index = entry.add(variant, position, scale, rotationY, color)
    recordFor(entry).push({ variant, index, colorSlot, brightness })
  }

  // Rock clusters: background boulders that frame the basin.
  //
  // Size is tied to distance on purpose. The camera stands off anywhere from
  // ~17 to ~60 units depending on aspect, so a boulder at 24 units is only ~33
  // units from the lens on a phone — at full size it filled the lower third of
  // the screen and hid the orca. Small when near, large when far reads as depth
  // instead of as an obstacle.
  const hillColor = new THREE.Color(theme.hillColor)
  for (let i = 0; i < counts.hill; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = CAMERA_CLEAR_RADIUS + Math.random() * 14
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist
    // Ramps from small at the corridor edge to full size further out.
    const sizeRamp = Math.min(1, Math.max(0.28, (dist - CAMERA_CLEAR_RADIUS) / 14))
    const sx = (1.2 + Math.random() * 1.6) * sizeRamp
    place(
      hills,
      i % HILL_VARIANTS,
      new THREE.Vector3(x, heightAt(x, z) - 0.05, z),
      new THREE.Vector3(sx, (0.55 + Math.random() * 0.7) * sizeRamp, sx),
      Math.random() * Math.PI,
      0,
      hillColor,
    )
  }

  // Tube sponges: the warm accent ring, hugging the outer edge of the reef.
  const spongePalette = theme.spongeHues.map(hue => new THREE.Color(hue))
  for (let i = 0; i < counts.sponge; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = CAMERA_CLEAR_RADIUS - 2 + Math.random() * 10
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist
    const s = 0.8 + Math.random() * 0.6
    const slot = i % spongePalette.length
    place(
      sponges,
      i % SPONGE_VARIANTS,
      new THREE.Vector3(x, heightAt(x, z), z),
      new THREE.Vector3(s, s, s),
      Math.random() * Math.PI,
      slot,
      spongePalette[slot],
    )
  }

  // Sunken treasure chests. Rare — one or two glints in the murk.
  for (let i = 0; i < counts.chest; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = CAMERA_CLEAR_RADIUS + Math.random() * 8
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist
    const s = 0.9 + Math.random() * 0.4
    place(
      chests,
      i % CHEST_VARIANTS,
      new THREE.Vector3(x, heightAt(x, z), z),
      new THREE.Vector3(s, s, s),
      Math.random() * Math.PI,
      0,
      white,
    )
  }

  // Coral blobs: hugged to the outer ring so the centre stays DIY space.
  const coralPalette = theme.coralHues.map(hue => new THREE.Color(hue))
  for (let i = 0; i < counts.coral; i++) {
    const ang = (i / Math.max(1, counts.coral)) * Math.PI * 2 + Math.random() * 0.5
    const dist = CAMERA_CLEAR_RADIUS + 1.5 + Math.random() * 8
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist * 0.8
    const s = 1.15 + Math.random() * 0.85
    const slot = i % coralPalette.length
    place(
      coral,
      i % CORAL_VARIANTS,
      new THREE.Vector3(x, heightAt(x, z), z),
      new THREE.Vector3(s, s, s),
      Math.random() * Math.PI,
      slot,
      coralPalette[slot],
    )
  }

  // Starfish. Kept off the camera corridor so they read as seafloor detail
  // rather than something pressed against the lens.
  const starfishColor = new THREE.Color(theme.starfishColor)
  for (let i = 0; i < counts.starfish; i++) {
    const ang = Math.random() * Math.PI * 2
    const dist = CAMERA_CLEAR_RADIUS + Math.random() * 8
    const x = Math.cos(ang) * dist
    const z = Math.sin(ang) * dist * 0.72
    place(
      starfish,
      0,
      new THREE.Vector3(x, heightAt(x, z) + 0.03, z),
      new THREE.Vector3(1, 1, 1),
      Math.random() * Math.PI,
      0,
      starfishColor,
    )
  }

  // Scattered pebbles, bedded on the sand.
  const rockColor = new THREE.Color(shade(theme.hillColor, 1.35))
  let placed = 0
  let guard = 0
  while (placed < counts.rock && guard < counts.rock * 40) {
    guard++
    const x = (Math.random() - 0.5) * 34
    const z = (Math.random() - 0.5) * 24
    const h = heightAt(x, z)
    if (Math.hypot(x, z) <= CAMERA_CLEAR_RADIUS || h <= -1.1 || h >= 0.3) continue
    const s = 0.28 + Math.random() * 0.28
    place(
      rocks,
      0,
      new THREE.Vector3(x, h + 0.05, z),
      new THREE.Vector3(s, s * (0.55 + Math.random() * 0.35), s),
      Math.random() * Math.PI,
      0,
      rockColor,
    )
    placed++
  }

  // Distant silhouette boulders (fog-shrouded seafloor rim). Heights stay
  // moderate: towers taller than this read as monoliths against the bright
  // part of the water column instead of as eroded rock.
  const skylinePalette = [
    new THREE.Color(shade(theme.skylineColor, 0.85)),
    new THREE.Color(theme.skylineColor),
  ]
  for (let i = 0; i < counts.skyline; i++) {
    const ang = (i / Math.max(1, counts.skyline)) * Math.PI * 2 + Math.random() * 0.22
    const radius = 24 + Math.random() * 16
    const tall = Math.random() < 0.35
    const h = tall ? 3.6 + Math.random() * 3 : 2 + Math.random() * 2.6
    const w = tall ? 1.8 + Math.random() * 2 : 2.6 + Math.random() * 3.2
    const slot = i % 2
    place(
      skyline,
      i % SKYLINE_VARIANTS,
      new THREE.Vector3(Math.cos(ang) * radius, heightAt(Math.cos(ang) * radius, Math.sin(ang) * radius) + h * 0.28, Math.sin(ang) * radius),
      new THREE.Vector3(w, h, w),
      Math.random() * Math.PI,
      slot,
      skylinePalette[slot],
    )
  }

  // Kelp blades. Planted just outside the camera corridor: a blade landing a
  // few units in front of the lens filled a third of the screen with green.
  // Blades go down in TUFTS of three sharing a base — lone blades read as
  // scattered sticks, tufts read as plants.
  {
    let blade = 0
    let tuft = 0
    const tufts = Math.ceil(counts.kelp / 3)
    while (blade < counts.kelp && tuft < tufts) {
      tuft++
      const ang = Math.random() * Math.PI * 2
      const dist = CAMERA_CLEAR_RADIUS + Math.random() * 6
      const bx = Math.cos(ang) * dist
      const bz = Math.sin(ang) * dist * 0.75
      for (let k = 0; k < 3 && blade < counts.kelp; k++, blade++) {
        const x = bx + (Math.random() - 0.5) * 0.5
        const z = bz + (Math.random() - 0.5) * 0.5
        const variant = blade % KELP_VARIANTS
        const mesh = kelpMeshes[variant]
        const index = mesh.count
        if (index >= mesh.instanceMatrix.count) break
        kelpRecords.push({
          variant,
          index,
          x,
          y: heightAt(x, z),
          z,
          yaw: Math.random() * Math.PI,
          phase: Math.random() * Math.PI * 2,
        })
        mesh.count = index + 1
      }
    }
  }

  /** Re-tint every instance for `theme`. No geometry is touched. */
  const applyColors = (next: AquariumTheme): void => {
    for (let i = 0; i < kelpMaterials.length; i++) {
      kelpMaterials[i].color.setHex(next.kelpHues[i % next.kelpHues.length])
    }

    const retint = (entry: InstancedGroup, palette: THREE.Color[], fallback: THREE.Color): void => {
      const list = recordFor(entry)
      const color = new THREE.Color()
      for (const record of list) {
        color.copy(palette.length > 1 ? (palette[record.colorSlot % palette.length] ?? fallback) : fallback)
        if (record.brightness !== 1) color.multiplyScalar(record.brightness)
        entry.recolor(record.variant, record.index, color)
      }
      entry.markDirty()
    }

    const nextHill = new THREE.Color(next.hillColor)
    retint(hills, [nextHill], nextHill)

    const nextSponge = next.spongeHues.map(hue => new THREE.Color(hue))
    retint(sponges, nextSponge, nextSponge[0] ?? white)

    const nextCoral = next.coralHues.map(hue => new THREE.Color(hue))
    retint(coral, nextCoral, nextCoral[0] ?? white)

    const nextStarfish = new THREE.Color(next.starfishColor)
    retint(starfish, [nextStarfish], nextStarfish)

    const nextRock = new THREE.Color(shade(next.hillColor, 1.35))
    retint(rocks, [nextRock], nextRock)

    const nextSkyline = [
      new THREE.Color(shade(next.skylineColor, 0.85)),
      new THREE.Color(next.skylineColor),
    ]
    retint(skyline, nextSkyline, nextSkyline[0])

    // The sand: rewrite vertex colors in place (a few thousand verts, cheap
    // enough for a theme switch that also rebuilds nothing else).
    const pos = groundGeo.attributes.position as THREE.BufferAttribute
    const colors = groundGeo.attributes.color as THREE.BufferAttribute
    const sand = new THREE.Color(next.sandColor)
    const edge = new THREE.Color(next.skylineColor)
    const c = new THREE.Color()
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i)
      const z = pos.getZ(i)
      const d = Math.hypot(x, z)
      const platform = 1 + 0.18 * (1 - smoothstep(4, 14, d))
      const fade = 1 - smoothstep(20, 48, d)
      c.copy(sand).multiplyScalar(platform).lerp(edge, 1 - fade)
      const n = 0.94 + sandNoise(x, z) * 0.12
      colors.setXYZ(i, c.r * n, c.g * n, c.b * n)
    }
    colors.needsUpdate = true
  }

  // Bake the base pose once; `update` rewrites the sway matrices from here.
  const dummy = new THREE.Object3D()
  const writeKelpMatrices = (t: number | null): void => {
    for (const record of kelpRecords) {
      dummy.position.set(record.x, record.y, record.z)
      dummy.scale.setScalar(1)
      if (t === null) {
        dummy.rotation.set(0, record.yaw, 0)
      } else {
        dummy.rotation.set(
          Math.cos(t * 0.7 + record.phase) * 0.09,
          record.yaw,
          Math.sin(t * 0.9 + record.phase) * 0.14,
        )
      }
      dummy.updateMatrix()
      kelpMeshes[record.variant].setMatrixAt(record.index, dummy.matrix)
    }
    for (const mesh of kelpMeshes) mesh.instanceMatrix.needsUpdate = true
  }

  // Paint the first theme. Props are placed with a white placeholder colour
  // (the only value known before the palette is applied), so skipping this
  // leaves the entire seafloor — hills, sponges, rocks — pure white
  // until the player happens to switch themes.
  applyColors(theme)

  writeKelpMatrices(null)
  structures.forEach(entry => entry.markDirty())

  return {
    group,
    update: (t: number) => {
      writeKelpMatrices(t)
      seafloor.update(t)
    },
    setTheme: (next: AquariumTheme) => {
      applyColors(next)
      seafloor.setTheme(next)
      seafloor.setFog(next.fogColor, next.fogDensity)
    },
    dispose: () => {
      groundGeo.dispose()
      seafloor.dispose()
      structures.forEach(entry => entry.dispose())
      kelpMeshes.forEach(mesh => {
        mesh.geometry.dispose()
        mesh.dispose()
      })
      kelpMaterials.forEach(material => material.dispose())
      group.clear()
    },
  }
}
