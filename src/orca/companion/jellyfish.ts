import * as THREE from 'three'
import { applySoftShade, createOutlineShell } from '../toon'

/*
 * The jellyfish companion, rebuilt from an SVG study.
 *
 * The source is a flat SVG icon: a scalloped dome, two blush patches, a smile
 * and two short comma-shaped tentacles. That is already a companion-shaped
 * creature, so rather than port the goal-less standalone page the icon was
 * first prototyped in, the shapes are rebuilt here from the SVG's own geometry
 * and dropped onto the project's cartoon pipeline.
 *
 * Two things had to change on the way in:
 *
 * 1. Shading. This aquarium is deliberately unlit — every material is
 *    MeshBasicMaterial and form comes from cartoon shading — so the bell is
 *    soft-shaded per fragment (toon.applySoftShade, the same ramp the seal
 *    uses) while its colour lives in vertex colours: white at the crown fading
 *    to pale blue at the rim, which is what the SVG's linearGradient does.
 * 2. The dome is a single open surface, so it is drawn DoubleSide and shaded
 *    with the normal flipped on back faces: from below you see up into the
 *    bell, and it still reads as a bell instead of a dark hat.
 *
 * The tentacles are the interesting part. The SVG draws each one as a closed
 * bezier blob — a curved comma with a round bulb at the tip. Sweeping a tube
 * along a guessed spine always drifted off that silhouette, so instead the
 * outline is taken from the path verbatim, insetted into concentric rings and
 * inflated along z. The head-on view is then the SVG's silhouette exactly,
 * and there is still volume from the side.
 *
 * Facing: the face looks along local +Z, the same convention as Clawd and the
 * seal, so the caller can hand it the exact yaw it hands them.
 */

/**
 * Identity of the model, for anyone reading the scene graph.
 *
 * 显示名是 Userlly：这只水母代表**用户本人**，所以名字和 Clawd / Seal-GPT
 * 一样是英文的，不是「水母」这个物种名。物种词在解释性文案里可以保留，
 * 但只要是在指这个伙伴，就该叫 Userlly。
 */
export const JELLY_NAME = 'userlly-companion'

/**
 * Height of the model in its own units: the top of the bell is at +1.0, the tip
 * of the tentacles at about -0.43. Used to scale it to a chosen in-world size.
 */
const SOURCE_HEIGHT = 1.43

/** Palette, from the SVG (or the closest flat tone that survives soft shading). */
const BELL_TOP = 0xffffff
const BELL_RIM = 0xcfeaf8
const MOUTH_COLOR = 0x8ecae6
const BLUSH_COLOR = 0xffb6c1
const TENTACLE_COLOR = 0xd4e8f1
const TENTACLE_TIP = 0x9fd9f1

/** Ink hulls (hidden by default; the toolbar outline toggle shows them). */
const OUTLINE_COLOR = 0x14202e
/**
 * Ink width for the dome. Wider and it eats the scalloped rim; the whole
 * character is only 1.43 units tall, against the seal's 1.95.
 */
const BELL_OUTLINE = 0.026
/** The tentacles are ~0.19 units thick at the root, so their ink stays thinner. */
const TENTACLE_OUTLINE = 0.015

/**
 * Bell shape. The SVG is a 40-unit radius semicircle inside a 200-unit box, so
 * one bell radius is 1.0 here and every SVG-space coordinate divides by 40.
 */
const BELL_RADIUS = 1.0
const BELL_HEIGHT = 1.0
/** Eight scallops around the rim; head-on that reads as the SVG's four dips. */
const RIM_LOBES = 8
const RIM_WAVE = 0.085
/** Dome tessellation: 96x36 is 6.9k triangles, cheap next to the orca. */
const SEG_U = 96
const SEG_V = 36

export interface JellyCompanion {
  readonly group: THREE.Group
  /** Pose it from the orca's past position, plus a little idle motion. */
  update: (t: number, dt: number, follow: { position: THREE.Vector3; yaw: number }) => void
  /** Playful pump, used when it is clicked or the orca is fussed over. */
  react: () => void
  /** Ink-outline toggle (the toolbar controls every character together). */
  setOutlines: (on: boolean) => void
  dispose: () => void
}

/* ------------------------------------------------------------------ *
 * Bell surface
 * ------------------------------------------------------------------ */

/** Radius of the bell at v (0 = crown, 1 = rim). */
function bellRadius(v: number): number {
  const a = v * Math.PI * 0.5
  return BELL_RADIUS * Math.pow(Math.sin(a), 0.92) * (1 + 0.13 * Math.pow(v, 3.4))
}

/** Height of the bell at v. */
function bellHeight(v: number): number {
  return BELL_HEIGHT * Math.cos(v * Math.PI * 0.5)
}

/** A point on the bell, with the scalloped rim folded in near v = 1. */
function surfacePoint(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const theta = u * Math.PI * 2
  const rimWeight = Math.pow(THREE.MathUtils.clamp(v, 0, 1), 4.5)
  const lobe = 0.5 + 0.5 * Math.cos(theta * RIM_LOBES)
  const r = bellRadius(v) * (1 + 0.02 * lobe * rimWeight)
  const y = bellHeight(v) - RIM_WAVE * lobe * rimWeight
  return out.set(Math.cos(theta) * r, y, Math.sin(theta) * r)
}

/** Surface normal, by differencing the parameterisation. */
function surfaceNormal(u: number, v: number, out = new THREE.Vector3()): THREE.Vector3 {
  const e = 0.0008
  const du = surfacePoint(u + e, v).sub(surfacePoint(u - e, v))
  const dv = surfacePoint(u, v + e).sub(surfacePoint(u, v - e))
  out.crossVectors(du, dv)
  if (out.lengthSq() < 1e-12) return out.set(0, 1, 0)
  return out.normalize()
}

/**
 * Project an SVG-space coordinate onto the bell, facing +Z.
 *
 * The SVG puts the rim at y = 110 and the crown at y = 70 on a 40-unit radius,
 * and the face sits on the front of the dome.
 *
 * `FACE_X_COMPRESS` pulls the face inboard. On the flat icon the cheeks sit at
 * 75% of the radius, which on a sphere is almost the silhouette: projected
 * there an oval becomes a foreshortened flag wrapping round the side and the
 * face stops reading at all. Squeezing the azimuth keeps the flat layout —
 * cheeks outside the smile — while putting them on the front of the dome.
 */
const FACE_X_COMPRESS = 0.72

function svgToFaceUV(sx: number, sy: number): { u: number; v: number } {
  const yw = (110 - sy) / 40
  const xw = ((sx - 100) / 40) * FACE_X_COMPRESS
  const v = (2 / Math.PI) * Math.acos(THREE.MathUtils.clamp(yw / BELL_HEIGHT, -1, 1))
  const r = bellRadius(v)
  const theta = Math.PI * 0.5 - Math.asin(THREE.MathUtils.clamp(xw / r, -1, 1))
  return { u: theta / (Math.PI * 2), v }
}

function svgToSurface(sx: number, sy: number, lift: number): THREE.Vector3 {
  const { u, v } = svgToFaceUV(sx, sy)
  const point = surfacePoint(u, v)
  if (lift !== 0) point.addScaledVector(surfaceNormal(u, v), lift)
  return point
}

/* ------------------------------------------------------------------ *
 * Vertex-colour painting
 *
 * Everything below writes the palette into the `color` attribute, because the
 * materials are white MeshBasicMaterial and the soft-shade ramp multiplies the
 * vertex colour. Colours are written in the same sRGB terms `setHex` produces —
 * NOT converted to linear — for the same reason toon.bakeCelShading does not:
 * converting both sides squares the value and darkens the character.
 * ------------------------------------------------------------------ */

function paintSolid(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation): void {
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

/** Paint a top-to-bottom gradient, like the SVG's linearGradient on the bell. */
function paintGradient(
  geometry: THREE.BufferGeometry,
  top: THREE.ColorRepresentation,
  bottom: THREE.ColorRepresentation,
  yTop: number,
  yBottom: number,
): void {
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  const topColor = new THREE.Color(top)
  const bottomColor = new THREE.Color(bottom)
  const mixed = new THREE.Color()
  const colors = new Float32Array(position.count * 3)
  const span = yTop - yBottom || 1
  for (let i = 0; i < position.count; i++) {
    const f = THREE.MathUtils.clamp((position.getY(i) - yBottom) / span, 0, 1)
    mixed.copy(bottomColor).lerp(topColor, f)
    colors[i * 3] = mixed.r
    colors[i * 3 + 1] = mixed.g
    colors[i * 3 + 2] = mixed.b
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3))
}

/**
 * Recolour the lower end of a geometry toward `tip`, leaving everything above
 * `yBlend` alone. Used for the tentacle bulbs, which are blue-tipped in the SVG.
 */
function paintTip(
  geometry: THREE.BufferGeometry,
  tip: THREE.ColorRepresentation,
  yTip: number,
  yBlend: number,
): void {
  const colors = geometry.getAttribute('color') as THREE.BufferAttribute | undefined
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  if (!colors) return
  const tipColor = new THREE.Color(tip)
  const span = Math.abs(yBlend - yTip) || 1
  for (let i = 0; i < position.count; i++) {
    const t = THREE.MathUtils.clamp((yBlend - position.getY(i)) / span, 0, 1)
    const f = THREE.MathUtils.smoothstep(t, 0.15, 1)
    colors.setXYZ(
      i,
      THREE.MathUtils.lerp(colors.getX(i), tipColor.r, f),
      THREE.MathUtils.lerp(colors.getY(i), tipColor.g, f),
      THREE.MathUtils.lerp(colors.getZ(i), tipColor.b, f),
    )
  }
  colors.needsUpdate = true
}

/* ------------------------------------------------------------------ *
 * Bell + face
 * ------------------------------------------------------------------ */

function buildBellGeometry(): THREE.BufferGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const uvs: number[] = []
  const indices: number[] = []
  const point = new THREE.Vector3()
  const normal = new THREE.Vector3()

  for (let iv = 0; iv <= SEG_V; iv++) {
    const v = iv / SEG_V
    for (let iu = 0; iu <= SEG_U; iu++) {
      const u = iu / SEG_U
      surfacePoint(u, v, point)
      surfaceNormal(u, v, normal)
      positions.push(point.x, point.y, point.z)
      normals.push(normal.x, normal.y, normal.z)
      uvs.push(u, v)
    }
  }
  for (let jv = 0; jv < SEG_V; jv++) {
    for (let ju = 0; ju < SEG_U; ju++) {
      const a = jv * (SEG_U + 1) + ju
      const b = a + SEG_U + 1
      // Counter-clockwise, so the outside is the front face.
      indices.push(a, a + 1, b + 1, a, b + 1, b)
    }
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geometry.setIndex(indices)
  return geometry
}

/**
 * One blush cheek, built as an ellipse in SURFACE coordinates rather than in
 * SVG coordinates: sampling a rectangle of the flat icon and projecting it
 * gives a distorted flag, while an ellipse in (u, v) stays an oval on the dome
 * wherever it is placed. `halfArc` is a world-space arc length along the
 * latitude, matching the SVG's own 7x4-unit ellipse.
 */
function buildBlushPatch(
  sx: number,
  sy: number,
  halfArc: number,
  halfHeight: number,
  lift: number,
  segments = 28,
): THREE.BufferGeometry {
  const { u: u0, v: v0 } = svgToFaceUV(sx, sy)
  const r = Math.max(bellRadius(v0), 0.05)
  const du = halfArc / (2 * Math.PI * r)
  // Vertical world distance per unit of v, from the dome's own slope.
  const slope = Math.max(Math.abs((-Math.PI / 2) * Math.sin(v0 * Math.PI / 2) * BELL_HEIGHT), 0.25)
  const dv = halfHeight / slope

  const positions: number[] = []
  const indices: number[] = []
  const normal = surfaceNormal(u0, v0)
  const centre = surfacePoint(u0, v0).addScaledVector(normal, lift)
  positions.push(centre.x, centre.y, centre.z)

  for (let i = 0; i < segments; i++) {
    const angle = (i / segments) * Math.PI * 2
    const u = u0 + du * Math.cos(angle)
    const v = v0 + dv * Math.sin(angle)
    const point = surfacePoint(u, v).addScaledVector(surfaceNormal(u, v), lift)
    positions.push(point.x, point.y, point.z)
  }
  for (let i = 0; i < segments; i++) {
    indices.push(0, 1 + i, 1 + ((i + 1) % segments))
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()
  return geometry
}

/**
 * The smile, swept as a tube along the SVG's own path
 * (M94,93 C94,98 95,100 100,100 C105,100 106,98 106,93), projected onto the dome.
 */
function buildSmileGeometry(): THREE.BufferGeometry {
  type Pt = [number, number]
  const cubic = (p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt => {
    const mt = 1 - t
    const a = mt * mt * mt
    const b = 3 * mt * mt * t
    const c = 3 * mt * t * t
    const d = t * t * t
    return [a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]]
  }
  const left: Pt[] = [
    [94, 93],
    [94, 98],
    [95, 100],
    [100, 100],
  ]
  const right: Pt[] = [
    [100, 100],
    [105, 100],
    [106, 98],
    [106, 93],
  ]
  const flat: Pt[] = []
  for (let i = 0; i <= 14; i++) flat.push(cubic(left[0], left[1], left[2], left[3], i / 14))
  for (let i = 1; i <= 14; i++) flat.push(cubic(right[0], right[1], right[2], right[3], i / 14))

  // Lift a little more than the blush: the tube has volume and would otherwise
  // sink into the bell wherever the surface curves away from it.
  const points = flat.map(([sx, sy]) => svgToSurface(sx, sy, 0.03))
  const curve = new THREE.CatmullRomCurve3(points)
  return new THREE.TubeGeometry(curve, 48, 0.034, 8, false)
}

/* ------------------------------------------------------------------ *
 * Tentacles
 * ------------------------------------------------------------------ */

/** The SVG path each tentacle is built from, in its own 0..419 x 0..470 space. */
function tentacleOutline(): THREE.Vector2[] {
  const path = new THREE.Path()
  path.moveTo(317.1, 0)
  path.bezierCurveTo(317.1, 0, 245.104, 271.5, 68.0, 264.1)
  path.bezierCurveTo(-2.516, 262.412, -28.175, 361.685, 40.0, 405.0)
  path.bezierCurveTo(143.048, 470.473, 385.836, 444.355, 419.1, 33.0)
  path.lineTo(317.1, 0)

  const raw = path.getPoints(34)
  const out: THREE.Vector2[] = []
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i]
    if (i === 0 || p.distanceTo(raw[i - 1]) > 1e-4) out.push(new THREE.Vector2(p.x, p.y))
  }
  if (out.length > 2 && out[0].distanceTo(out[out.length - 1]) < 1e-4) out.pop()
  return out
}

function polygonArea(points: THREE.Vector2[]): number {
  let area = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    area += p.x * q.y - q.x * p.y
  }
  return area * 0.5
}

/**
 * Inset a closed polygon by `distance`: capped mitres so sharp corners cannot
 * fire off to infinity, then two smoothing passes so the bezier's sampling
 * noise does not show up as a jagged band.
 */
function insetPolygon(points: THREE.Vector2[], distance: number, inward: number): THREE.Vector2[] {
  const n = points.length
  let ring: THREE.Vector2[] = []
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n]
    const cur = points[i]
    const next = points[(i + 1) % n]
    let e0x = cur.x - prev.x
    let e0y = cur.y - prev.y
    let e1x = next.x - cur.x
    let e1y = next.y - cur.y
    const l0 = Math.hypot(e0x, e0y) || 1
    const l1 = Math.hypot(e1x, e1y) || 1
    e0x /= l0
    e0y /= l0
    e1x /= l1
    e1y /= l1
    const n0x = -e0y * inward
    const n0y = e0x * inward
    const n1x = -e1y * inward
    const n1y = e1x * inward
    let bx = n0x + n1x
    let by = n0y + n1y
    const bl = Math.hypot(bx, by)
    if (bl < 1e-6) {
      ring.push(cur.clone())
      continue
    }
    bx /= bl
    by /= bl
    const cosHalf = Math.max(bx * n1x + by * n1y, 0.35)
    const m = distance / cosHalf
    ring.push(new THREE.Vector2(cur.x + bx * m, cur.y + by * m))
  }
  for (let pass = 0; pass < 2; pass++) {
    const smoothed = ring.map((p) => p.clone())
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n]
      const b = ring[i]
      const c = ring[(i + 1) % n]
      smoothed[i].set((a.x + b.x * 2 + c.x) * 0.25, (a.y + b.y * 2 + c.y) * 0.25)
    }
    ring = smoothed
  }
  return ring
}

/** 1 unit of the SVG path's own space, in bell radii. */
const TENTACLE_UNITS = 0.001
/**
 * Where the tentacles hang: the SVG attaches them at (+-0.225, -0.05). They are
 * lifted a little here so their flat top edge sits under the bell's rim instead
 * of cutting across the silhouette, and the tint fades them out there.
 */
const TENTACLE_ANCHOR_X = 0.225
const TENTACLE_ANCHOR_Y = 0.038
const TENTACLE_LENGTH = 0.47
const TENTACLE_RINGS = 5
const TENTACLE_THICKNESS = 0.052
/**
 * Each tentacle is rotated slightly out of the face plane, so the pair reads as
 * two separate hanging limbs from the side rather than one flat decal.
 */
const TENTACLE_SPLAY = 0.22

/**
 * Build one tentacle: the SVG outline inset into concentric rings and inflated
 * along z into a lens, with front and back shells sharing the silhouette.
 */
function buildTentacleGeometry(mirror: boolean): THREE.BufferGeometry {
  const outline = tentacleOutline()
  const inward = polygonArea(outline) > 0 ? 1 : -1

  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of outline) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    minY = Math.min(minY, p.y)
    maxY = Math.max(maxY, p.y)
  }
  const spanX = maxX - minX
  const spanY = maxY - minY
  const totalInset = Math.min(spanX, spanY) * 0.115

  const rings: THREE.Vector2[][] = [outline]
  for (let r = 1; r <= TENTACLE_RINGS; r++) {
    rings.push(insetPolygon(rings[r - 1], totalInset / TENTACLE_RINGS, inward))
  }

  // Rounded profile: thin at the silhouette edge, thickest in the middle.
  const profile = (t: number): number => Math.sqrt(Math.max(0, 1 - (1 - t) * (1 - t)))

  const count = outline.length
  const positions: number[] = []
  const indices: number[] = []

  const toModel = (p: THREE.Vector2, depth: number): THREE.Vector3 => {
    const lx = p.x * TENTACLE_UNITS * (mirror ? -1 : 1)
    const ly = -p.y * TENTACLE_UNITS
    const rot = TENTACLE_SPLAY * (lx / Math.max(spanX * TENTACLE_UNITS, 1e-6))
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    return new THREE.Vector3(lx * cos + depth * sin, ly, -lx * sin + depth * cos)
  }

  let cx = 0
  let cy = 0
  for (const p of rings[TENTACLE_RINGS]) {
    cx += p.x
    cy += p.y
  }
  const centre = new THREE.Vector2(cx / count, cy / count)

  // --- front shell (z >= 0) ---
  for (let k = 0; k <= TENTACLE_RINGS; k++) {
    const depth = TENTACLE_THICKNESS * profile(k / TENTACLE_RINGS)
    for (const p of rings[k]) {
      const v = toModel(p, depth)
      positions.push(v.x, v.y, v.z)
    }
  }
  const frontCentre = toModel(centre, TENTACLE_THICKNESS)
  const frontCentreIndex = positions.length / 3
  positions.push(frontCentre.x, frontCentre.y, frontCentre.z)

  for (let k = 0; k < TENTACLE_RINGS; k++) {
    for (let i = 0; i < count; i++) {
      const a = k * count + i
      const b = k * count + ((i + 1) % count)
      const c = (k + 1) * count + ((i + 1) % count)
      const d = (k + 1) * count + i
      indices.push(a, b, c, a, c, d)
    }
  }
  for (let i = 0; i < count; i++) {
    indices.push(TENTACLE_RINGS * count + i, TENTACLE_RINGS * count + ((i + 1) % count), frontCentreIndex)
  }

  // --- back shell (z <= 0), wound the other way ---
  const backStart = positions.length / 3
  for (let k = 0; k <= TENTACLE_RINGS; k++) {
    const depth = -TENTACLE_THICKNESS * profile(k / TENTACLE_RINGS)
    for (const p of rings[k]) {
      const v = toModel(p, depth)
      positions.push(v.x, v.y, v.z)
    }
  }
  const backCentre = toModel(centre, -TENTACLE_THICKNESS)
  const backCentreIndex = positions.length / 3
  positions.push(backCentre.x, backCentre.y, backCentre.z)

  for (let k = 0; k < TENTACLE_RINGS; k++) {
    for (let i = 0; i < count; i++) {
      const a = backStart + k * count + i
      const b = backStart + k * count + ((i + 1) % count)
      const c = backStart + (k + 1) * count + ((i + 1) % count)
      const d = backStart + (k + 1) * count + i
      indices.push(a, c, b, a, d, c)
    }
  }
  for (let i = 0; i < count; i++) {
    indices.push(
      backStart + TENTACLE_RINGS * count + i,
      backCentreIndex,
      backStart + TENTACLE_RINGS * count + ((i + 1) % count),
    )
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geometry.setIndex(indices)
  geometry.computeVertexNormals()

  // Guard against a winding mistake: most normals should point away from the
  // tentacle's own centre. If they do not, flip every triangle once.
  const normals = geometry.getAttribute('normal') as THREE.BufferAttribute
  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  let outward = 0
  let inwardCount = 0
  for (let i = 0; i < position.count; i += 7) {
    const dirX = position.getX(i)
    const dirY = position.getY(i) + 0.24
    const dirZ = position.getZ(i)
    const dot = normals.getX(i) * dirX + normals.getY(i) * dirY + normals.getZ(i) * dirZ
    if (dot >= 0) outward++
    else inwardCount++
  }
  if (inwardCount > outward) {
    const index = geometry.getIndex() as THREE.BufferAttribute
    const array = index.array as unknown as number[]
    for (let i = 0; i < array.length; i += 3) {
      const swap = array[i + 1]
      array[i + 1] = array[i + 2]
      array[i + 2] = swap
    }
    index.needsUpdate = true
    geometry.computeVertexNormals()
  }

  return geometry
}

/* ------------------------------------------------------------------ *
 * Companion
 * ------------------------------------------------------------------ */

export function createJellyCompanion(targetHeight = 1.2): JellyCompanion {
  const group = new THREE.Group()
  group.name = JELLY_NAME

  // White materials: the palette lives in the vertex colours, so a tinted
  // material would multiply it a second time and darken the whole character.
  const bellMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    // One open surface: from below you look up into the bell.
    side: THREE.DoubleSide,
  })
  const faceMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, vertexColors: true, side: THREE.DoubleSide })
  const tentacleMaterial = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    vertexColors: true,
    side: THREE.DoubleSide,
  })
  // `applySoftShade` reads the smooth vertex normal and flips it on back faces,
  // so the inside of the dome shades correctly instead of going black.
  applySoftShade(bellMaterial, { strength: 0.26, softness: 0.6 })
  applySoftShade(faceMaterial, { strength: 0.16, softness: 0.5 })
  applySoftShade(tentacleMaterial, { strength: 0.2, softness: 0.55 })

  const outlineMaterials: THREE.Material[] = []
  const outlineShells: THREE.Mesh[] = []
  /** Attach an ink hull to a mesh; it rides as a child so it follows the pose. */
  const addShell = (mesh: THREE.Mesh, width: number): void => {
    const shell = createOutlineShell(mesh.geometry as THREE.BufferGeometry, width, OUTLINE_COLOR)
    shell.visible = false
    mesh.add(shell)
    outlineShells.push(shell)
    outlineMaterials.push(shell.material as THREE.Material)
  }

  /** The part of the body that pumps: bell, face and tentacles together. */
  const body = new THREE.Group()
  group.add(body)

  // --- bell ---
  const bellGeometry = buildBellGeometry()
  paintGradient(bellGeometry, BELL_TOP, BELL_RIM, 1.0, -0.06)
  const bell = new THREE.Mesh(bellGeometry, bellMaterial)
  body.add(bell)
  addShell(bell, BELL_OUTLINE)

  // --- face: two blush cheeks and the smile, lifted clear of the dome ---
  for (const cx of [70, 130]) {
    // The SVG's own blush is an ellipse of rx 7, ry 4 on a 40-unit radius.
    const patch = buildBlushPatch(cx, 96, 7 / 40, 4 / 40, 0.022)
    paintSolid(patch, BLUSH_COLOR)
    const mesh = new THREE.Mesh(patch, faceMaterial)
    mesh.renderOrder = 1
    body.add(mesh)
  }
  const smileGeometry = buildSmileGeometry()
  paintSolid(smileGeometry, MOUTH_COLOR)
  const smile = new THREE.Mesh(smileGeometry, faceMaterial)
  smile.renderOrder = 1
  body.add(smile)

  // --- tentacles ---
  const tentacles: THREE.Mesh[] = []
  for (const mirror of [false, true]) {
    const geometry = buildTentacleGeometry(mirror)
    paintSolid(geometry, TENTACLE_COLOR)
    // Blue bulbs, as in the SVG: fade the colour in over the lower third.
    paintTip(geometry, TENTACLE_TIP, -TENTACLE_LENGTH, -TENTACLE_LENGTH * 0.35)
    const mesh = new THREE.Mesh(geometry, tentacleMaterial)
    mesh.position.set(TENTACLE_ANCHOR_X * (mirror ? -1 : 1), TENTACLE_ANCHOR_Y, 0)
    body.add(mesh)
    tentacles.push(mesh)
    addShell(mesh, TENTACLE_OUTLINE)
  }

  group.scale.setScalar(targetHeight / SOURCE_HEIGHT)

  let reactTimer = 0

  const update: JellyCompanion['update'] = (t, dt, follow) => {
    group.position.copy(follow.position)
    group.rotation.y = follow.yaw

    if (reactTimer > 0) reactTimer = Math.max(0, reactTimer - dt)
    const excite = 1 + reactTimer * 1.8

    // The bell pumps and the tentacles trail a quarter cycle behind, so the
    // silhouette never freezes: a jellyfish that stops pumping is a jelly.
    const pump = Math.sin(t * 1.9) * (0.5 + 0.5 * excite)
    const squash = pump * 0.055 * (0.6 + 0.4 * excite)
    body.scale.set(1 - squash * 0.5, 1 + squash, 1 - squash * 0.5)

    for (let i = 0; i < tentacles.length; i++) {
      const mesh = tentacles[i]
      const phase = i * 1.4
      const trail = Math.sin(t * 1.9 - 0.9 + phase) * 0.09 * (0.7 + 0.5 * excite)
      mesh.rotation.x = trail * 0.6
      mesh.rotation.z = Math.sin(t * 1.3 + phase) * 0.05 * (1 + reactTimer)
    }

    // Drift: a slow rise and fall plus a gentle roll, on top of the follow slot.
    group.position.y += Math.sin(t * 1.1 + 0.4) * 0.06 * excite
    group.rotation.z = Math.sin(t * 0.9) * 0.05
    group.rotation.x = Math.sin(t * 1.3 + 1.2) * 0.04
  }

  return {
    group,
    update,
    react: () => {
      reactTimer = 1
    },
    setOutlines: (on: boolean) => {
      for (const shell of outlineShells) shell.visible = on
    },
    dispose: () => {
      group.traverse((object) => {
        const mesh = object as THREE.Mesh
        if (mesh.isMesh) mesh.geometry.dispose()
      })
      bellMaterial.dispose()
      faceMaterial.dispose()
      tentacleMaterial.dispose()
      for (const material of outlineMaterials) material.dispose()
      group.clear()
    },
  }
}