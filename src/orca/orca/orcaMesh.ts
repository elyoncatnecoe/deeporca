import * as THREE from 'three'
import {
  ORCA_CONFIG as C,
  ORCA_BODY_PATH,
  BROW_PATH,
  TAIL_PATH,
  TAIL_NOTCH,
  DORSAL_PATH,
  DORSAL_BL,
  DORSAL_BR,
  PEC_PATH,
  PEC_BL,
  PEC_BR,
  PEC_DROP,
} from './config'
import { sampleBodyPathDense, sampleSvgPath } from './pathSampler'
import { buildSweptGeometry, type SweptData } from './sweptGeometry'
import { applySoftShade, createOutlineShell } from '../toon'

export interface SwimUniforms {
  uTime: { value: number }
  uSwimAmp: { value: number }
  uSwimFreq: { value: number }
  uSwimSpeed: { value: number }
}

export interface OrcaModel {
  group: THREE.Group
  bodyGeo: THREE.BufferGeometry
  bodySwept: SweptData
  bodyScale: number
  bodyTipX: number
  bodyTipY: number
  dentPoint: { x: number; y: number }
  swimUniforms: SwimUniforms
  /** 皮肤切换（照搬 whale-pet：uDark/uWhite 两组材质）。 */
  setSkin: (name: string) => void
  setMood: (mood: OrcaMoodId) => void
  setBoost: (boost: number) => void
  addClick: () => void
  setSleeping: (on: boolean) => void
  /** 墨线描边开关（工具栏统一控制虎鲸/Clawd/Seal-GPT 三个角色）。 */
  setOutlines: (on: boolean) => void
  /**
   * 动作速度倍率（0.4~1.8）。
   *
   * 同时缩放**身体摇摆 / 横滚 / 尾鳍 / 胸鳍**的主频和 shader 的体波速度 ——
   * 这几项本来共用一个频率，只调其中一个会让鲸看起来"关节脱臼"。
   * 呼吸频率不跟着变：那是生命体征，不是动作。
   */
  setMotionSpeed: (scale: number) => void
  /** 每帧动画（尾鳍/胸鳍/眨眼/呼吸），返回呼吸合并后的整体缩放。 */
  update: (t: number, dt: number, opts?: { baseScale?: number; divePitch?: number }) => number
}

const DataUtils = (THREE as unknown as { DataUtils: { toHalfFloat(value: number): number } }).DataUtils

// ------------------------------------------------------- skin system (pet)

export const ORCA_SKINS: Record<string, { dark: number; white: number }> = {
  classic: { dark: 0x4d6bfe, white: 0xffffff },
  night: { dark: 0x271f19, white: 0xfff5e3 },
  pink: { dark: 0xe85a8a, white: 0xffe8f0 },
  green: { dark: 0x2e9e6b, white: 0xe8fff2 },
  gold: { dark: 0xc78b20, white: 0xfff4d6 },
}

export type OrcaMoodId = 'idle' | 'working' | 'needs-input' | 'ready' | 'blocked'

interface MoodParams {
  speed: number
  floatAmp: number
  floatSpeed: number
  breath: number
  bodySway: number
  bodyYaw: number
  bodyPitch: number
  tailYaw: number
  tailPitch: number
  pecFlap: number
}

/** 情绪参数抄 pet.html 的 MOODS（摆动幅度刻意做小以防穿模）。 */
const MOODS: Record<OrcaMoodId, MoodParams> = {
  idle: { speed: 1.6, floatAmp: 0.06, floatSpeed: 1.2, breath: 0.02, bodySway: 0.035, bodyYaw: 0.03, bodyPitch: 0.015, tailYaw: 0.08, tailPitch: 0.045, pecFlap: 0.18 },
  working: { speed: 3.4, floatAmp: 0.1, floatSpeed: 2.4, breath: 0.05, bodySway: 0.06, bodyYaw: 0.055, bodyPitch: 0.028, tailYaw: 0.15, tailPitch: 0.085, pecFlap: 0.28 },
  'needs-input': { speed: 0.8, floatAmp: 0.03, floatSpeed: 0.6, breath: 0.01, bodySway: 0.018, bodyYaw: 0.015, bodyPitch: 0.008, tailYaw: 0.04, tailPitch: 0.022, pecFlap: 0.1 },
  ready: { speed: 2.6, floatAmp: 0.14, floatSpeed: 3.0, breath: 0.06, bodySway: 0.045, bodyYaw: 0.04, bodyPitch: 0.02, tailYaw: 0.12, tailPitch: 0.07, pecFlap: 0.24 },
  blocked: { speed: 0.5, floatAmp: 0.04, floatSpeed: 0.8, breath: 0.015, bodySway: 0.01, bodyYaw: 0.008, bodyPitch: 0.005, tailYaw: 0.02, tailPitch: 0.012, pecFlap: 0.06 },
}

const BASE_SWIM_HZ = 0.9

function blinkCurve(p: number): number {
  const c = 0.1
  const o = 0.42
  if (p < c) return 1 - p / c
  if (p < c + o) {
    const u = (p - c) / o
    return u * u
  }
  return 1
}

/** Map a 2D SVG point (from brow/eye contours) onto the body surface. */
function mapToSurface(
  p: { x: number; y: number },
  cx: number,
  cy: number,
  swept: SweptData,
): { x: number; y: number; z: number } {
  const { xs, mid, rad } = swept
  const px = (p.x - cx) * C.BROW_SCALE + C.BROW_OFFSET_X
  const py = -(p.y - cy) * C.BROW_SCALE + C.BROW_OFFSET_Y
  const n = xs.length
  let s: number
  if (px <= xs[0]) s = 0
  else if (px >= xs[n - 1]) s = n - 1
  else {
    let i = 0
    while (i < n - 1 && xs[i + 1] < px) i++
    s = i + (px - xs[i]) / Math.max(1e-9, xs[i + 1] - xs[i])
  }
  const i0 = Math.min(Math.floor(s), n - 1)
  const i1 = Math.min(i0 + 1, n - 1)
  const t = s - i0
  const m = mid[i0] * (1 - t) + mid[i1] * t
  const r = Math.max(0, rad[i0] * (1 - t) + rad[i1] * t)
  const cosTh = r > 1e-6 ? Math.max(-1, Math.min(1, (py - m) / r)) : 1
  const sinTh = Math.sqrt(Math.max(0, 1 - cosTh * cosTh))
  const dx = Math.max(1e-9, xs[i1] - xs[i0])
  const dr = (rad[i1] - rad[i0]) / dx
  const dm = (mid[i1] - mid[i0]) / dx
  const nx = -(dr + dm * cosTh)
  const ny = cosTh
  const nz = sinTh
  const len = Math.hypot(nx, ny, nz) || 1
  return {
    x: px + nx / len * C.BROW_LIFT,
    y: m + r * cosTh + ny / len * C.BROW_LIFT,
    z: r * sinTh + nz / len * C.BROW_LIFT,
  }
}

function backSurfaceAt(
  frac: number,
  bodySwept: SweptData,
  bodyScale: number,
): { x: number; top: number; mid: number; rad: number } {
  const { xs, mid, rad } = bodySwept
  const totalX = xs[xs.length - 1] - xs[0]
  const x = xs[0] + totalX * frac
  let idx = 0
  while (idx < xs.length - 1 && xs[idx + 1] < x) idx++
  const t = (x - xs[idx]) / (xs[idx + 1] - xs[idx] || 1)
  const m = mid[idx] * (1 - t) + mid[idx + 1] * t
  const r = rad[idx] * (1 - t) + rad[idx + 1] * t
  return { x: x * bodyScale, top: (m + r) * bodyScale, mid: m * bodyScale, rad: r * bodyScale }
}

function extrudePolygon3D(
  points2D: { x: number; y: number }[],
  thickness: number,
  origin: THREE.Vector3,
  axisX: THREE.Vector3,
  axisY: THREE.Vector3,
): THREE.BufferGeometry {
  const N = points2D.length
  const h = thickness / 2
  const axisZ = new THREE.Vector3().crossVectors(axisX, axisY).normalize()
  const tri = THREE.ShapeUtils.triangulateShape(points2D.map(p => new THREE.Vector2(p.x, p.y)), [])
  const pos: number[] = []
  for (const p of points2D) {
    const v = new THREE.Vector3().copy(origin).addScaledVector(axisX, p.x).addScaledVector(axisY, p.y).addScaledVector(axisZ, h)
    pos.push(v.x, v.y, v.z)
  }
  for (const p of points2D) {
    const v = new THREE.Vector3().copy(origin).addScaledVector(axisX, p.x).addScaledVector(axisY, p.y).addScaledVector(axisZ, -h)
    pos.push(v.x, v.y, v.z)
  }
  const idx: number[] = []
  for (const t of tri) idx.push(t[0], t[1], t[2])
  for (const t of tri) idx.push(N + t[0], N + t[2], N + t[1])
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N
    idx.push(i, j, N + j, i, N + j, N + i)
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geom.setIndex(idx)
  geom.computeVertexNormals()
  return geom
}

function buildLeafGeometry(contour2D: { x: number; z: number }[], thickness: number): THREE.BufferGeometry {
  const N = contour2D.length
  const h = thickness / 2
  const tri = THREE.ShapeUtils.triangulateShape(contour2D.map(p => new THREE.Vector2(p.x, p.z)), [])
  const pos: number[] = []
  for (const p of contour2D) pos.push(p.x, h, p.z)
  for (const p of contour2D) pos.push(p.x, -h, p.z)
  const idx: number[] = []
  for (const t of tri) idx.push(t[0], t[1], t[2])
  for (const t of tri) idx.push(N + t[0], N + t[2], N + t[1])
  for (let i = 0; i < N; i++) {
    const a = i
    const b = (i + 1) % N
    idx.push(a, b, N + b, a, N + b, N + a)
  }
  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geom.setIndex(idx)
  geom.computeVertexNormals()
  return geom
}

function extractLeftHalf(pts: { x: number; z: number }[]): { x: number; z: number }[] | null {
  const n = pts.length
  const crossings: { index: number; point: { x: number; z: number } }[] = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    if ((a.z < 0 && b.z >= 0) || (a.z >= 0 && b.z < 0)) {
      const t = a.z / (a.z - b.z)
      const x = a.x + t * (b.x - a.x)
      crossings.push({ index: i, point: { x, z: 0 } })
    }
  }
  if (crossings.length < 2) return null
  const c1 = crossings[0]
  const c2 = crossings[1]
  const startIdx = c1.index
  const endIdx = c2.index
  const half: { x: number; z: number }[] = [c1.point]
  if (endIdx >= startIdx) {
    for (let i = startIdx + 1; i <= endIdx; i++) half.push(pts[i % n])
  } else {
    for (let i = startIdx + 1; i < n; i++) half.push(pts[i])
    for (let i = 0; i <= endIdx; i++) half.push(pts[i])
  }
  half.push(c2.point)
  let avgZ = 0
  for (const p of half) avgZ += p.z
  avgZ /= half.length
  if (avgZ > 0) {
    half.length = 0
    half.push(c2.point)
    if (endIdx + 1 < startIdx) {
      for (let i = endIdx + 1; i <= startIdx; i++) half.push(pts[i % n])
    } else {
      for (let i = endIdx + 1; i < n; i++) half.push(pts[i])
      for (let i = 0; i <= startIdx; i++) half.push(pts[i])
    }
    half.push(c1.point)
  }
  return half
}

/**
 * Build the complete orca model from orca.html: body + white markings + eyes
 * + tail/dorsal/pectoral fins. Visual parameters stay 1:1 with the original.
 */
export function buildOrcaModel(): OrcaModel {
  const group = new THREE.Group()
  group.name = 'orca'

  const rawContour = sampleBodyPathDense(ORCA_BODY_PATH, 50, 800)
  let cx = 0
  let cy = 0
  for (const p of rawContour) {
    cx += p.x
    cy += p.y
  }
  cx /= rawContour.length
  cy /= rawContour.length
  const pts = rawContour.map(p => ({ x: (p.x - cx) * 1.1, y: -(p.y - cy) }))
  if (THREE.ShapeUtils.isClockWise(pts.map(p => new THREE.Vector2(p.x, p.y)))) pts.reverse()

  const { geometry: geo, swept: bodySwept } = buildSweptGeometry(pts, C)
  geo.computeVertexNormals()
  geo.computeBoundingBox()
  const b = geo.boundingBox
  const size = b!.getSize(new THREE.Vector3())
  const bodyScale = C.BODY_TARGET_HEIGHT / size.y
  geo.scale(bodyScale, bodyScale, bodyScale)

  // ---- body shader (black/white orca pattern) -----------------------------
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  const nSw = bodySwept.mid.length
  const mrData = new Uint16Array(nSw * 2)
  for (let i = 0; i < nSw; i++) {
    mrData[i * 2] = DataUtils.toHalfFloat(bodySwept.mid[i] * bodyScale)
    mrData[i * 2 + 1] = DataUtils.toHalfFloat(bodySwept.rad[i] * bodyScale)
  }
  const mrTex = new THREE.DataTexture(mrData, nSw, 1, THREE.RGFormat, THREE.HalfFloatType)
  mrTex.minFilter = mrTex.magFilter = THREE.LinearFilter
  mrTex.needsUpdate = true

  const swimUniforms: SwimUniforms = {
    uTime: { value: 0 },
    uSwimAmp: { value: 0.13 },
    uSwimFreq: { value: 2.6 },
    uSwimSpeed: { value: 2.8 },
  }

const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
  ;(material as unknown as { extensions: Record<string, boolean> }).extensions = { derivatives: true }
  let bodyUniformsRef: Record<string, THREE.IUniform> | null = null
  material.onBeforeCompile = (shader) => {
    const uniforms = (shader as unknown as { uniforms: Record<string, THREE.IUniform> }).uniforms
    uniforms.uMR = { value: mrTex }
    uniforms.uMin = { value: bb.min.x }
    uniforms.uMax = { value: bb.max.x }
    uniforms.uTime = swimUniforms.uTime
    uniforms.uSwimAmp = swimUniforms.uSwimAmp
    uniforms.uSwimFreq = swimUniforms.uSwimFreq
    uniforms.uSwimSpeed = swimUniforms.uSwimSpeed
    uniforms.uDark = { value: new THREE.Color(ORCA_SKINS.classic.dark) }
    uniforms.uWhite = { value: new THREE.Color(ORCA_SKINS.classic.white) }
    uniforms.uCelLight = { value: new THREE.Vector3(0.45, 0.78, 0.44).normalize() }
    uniforms.uCelStrength = { value: 0.3 }
    uniforms.uCelSoft = { value: 0.85 }
    bodyUniformsRef = uniforms
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPos;\nvarying vec3 vNrm;\nuniform float uTime;\nuniform float uSwimAmp;\nuniform float uSwimFreq;\nuniform float uSwimSpeed;\nuniform float uMin;\nuniform float uMax;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPos = position;\nvNrm = normal;\n{\n  float along = (position.x - uMin) / max(uMax - uMin, 1e-4);\n  float envelope = smoothstep(0.0, 0.55, along) * (1.0 - smoothstep(0.72, 1.0, along));\n  float wave = sin(position.x * uSwimFreq - uTime * uSwimSpeed) * uSwimAmp;\n  transformed.z += wave * envelope;\n  transformed.y += wave * 0.28 * envelope;\n}')
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vPos;\nvarying vec3 vNrm;\nuniform sampler2D uMR;\nuniform float uMin, uMax;\nuniform vec3 uDark;\nuniform vec3 uWhite;\nuniform vec3 uCelLight;\nuniform float uCelStrength;\nuniform float uCelSoft;')
      .replace('#include <color_fragment>', `#include <color_fragment>
      {
          float u = clamp((vPos.x - uMin) / (uMax - uMin), 0.0, 1.0);
          float midY = texture2D(uMR, vec2(u, 0.5)).r;
          float ang = 3.14159265 - abs(atan(vPos.z, vPos.y - midY));
          float baseScale = 0.77 * 1.1;
          float uCenter = 0.28, uHalf = 0.245 * baseScale, angMax = 0.84 * baseScale;
          float headFactor = 1.0 - smoothstep(0.18, 0.52, u);
          float angMaxAdjusted = angMax * (1.0 + 0.7 * headFactor);
          float uu = (0.16 + 0.49 * u - uCenter) / uHalf;
          float nn = ang / angMaxAdjusted;
          float rr = uu * uu + nn * nn;
          float tailZone = smoothstep(0.40, 0.58, u) * (1.0 - smoothstep(0.80, 0.86, u));
          float peak = 0.78, bumpWidth = 0.11, bumpStrength = 1.0;
          float d = nn - peak;
          float bump = tailZone * bumpStrength * exp(-d*d / (bumpWidth*bumpWidth));
          float threshold = 1.0 + bump;
          float aa = fwidth(rr) * 1.2 + 2e-4;
          float a = 1.0 - smoothstep(threshold - aa, threshold + aa, rr);
          diffuseColor.rgb = mix(uDark, uWhite, a);

          // Soft volumetric shade on top of the skin mask. An earlier build
          // rebuilt the normal from screen-space derivatives and quantised it
          // into hard bands — the flat per-triangle normal made the shading
          // follow the mesh facets, reading as blocky mosaic patches. The
          // geometry's SMOOTH vertex normal plus a wide smoothstep ramp gives
          // a gentle watercolour volume instead; the ink outline carries the
          // cartoon read on its own.
          vec3 n = normalize(vNrm);
          if (!gl_FrontFacing) n = -n;
          float lambert = dot(n, normalize(uCelLight)) * 0.5 + 0.5;
          float ramp = smoothstep(0.5 - uCelSoft * 0.5, 0.5 + uCelSoft * 0.5, lambert);
          float shade = 1.0 - uCelStrength * (1.0 - ramp);
          diffuseColor.rgb *= shade;
      }`)
  }

  const model = new THREE.Mesh(geo, material)
  group.add(model)

  // ---- optional ink outlines (off by default; toolbar toggle) --------------
  // The body rides the swim wave, so its hull must replay the same wave in the
  // vertex shader — a static hull would visibly detach from the swinging tail.
  // Fins are rigid meshes animated by pivot rotation, so plain hulls track them.
  // 0.025 is the widest ink that survives a 0.05-0.06 fin thickness; anything
  // more eats the fin and reads as a black twig.
  const OUTLINE_COLOR = 0x14202e
  const BODY_OUTLINE = 0.065
  const FIN_OUTLINE = 0.025
  const outlineMeshes: THREE.Mesh[] = []
  const addOutline = (parent: THREE.Object3D, geometry: THREE.BufferGeometry, width: number, flipZ = false): void => {
    const shell = createOutlineShell(geometry, width, OUTLINE_COLOR)
    if (flipZ) shell.scale.z = -1
    shell.visible = false
    parent.add(shell)
    outlineMeshes.push(shell)
  }
  addOutline(model, geo, BODY_OUTLINE)

  // ---- white brow patches + eyes ------------------------------------------
  const browSvg = sampleSvgPath(BROW_PATH, 40)
  function buildBrowMesh(flip: boolean): THREE.BufferGeometry {
    const contour = browSvg.map(p => new THREE.Vector2((p.x - cx) * C.BROW_SCALE + C.BROW_OFFSET_X, -(p.y - cy) * C.BROW_SCALE + C.BROW_OFFSET_Y))
    const tri = THREE.ShapeUtils.triangulateShape(contour, [])
    const pos: number[] = []
    const idx: number[] = []
    for (const p of browSvg) {
      const sp = mapToSurface(p, cx, cy, bodySwept)
      pos.push(sp.x, sp.y, sp.z)
    }
    for (const t of tri) idx.push(t[0], t[1], t[2])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    if (flip) {
      const arr = g.attributes.position.array as Float32Array
      for (let i = 2; i < arr.length; i += 3) arr[i] = -arr[i]
    }
g.scale(bodyScale, bodyScale, bodyScale)
    return g
  }

  const dentPoint = browSvg.reduce((prev, curr) => (curr.y < prev.y ? curr : prev), browSvg[0])
  const eyeCenterX = dentPoint.x - 2

  // Surface-attached parts (brow patches / eyes) must ride the same body
  // undulation wave, otherwise the wavy blue body surface sinks through
  // them and covers the eyes.
  const waveAttachMaterial = (color: number, offsetFactor: number, offsetUnits: number): THREE.MeshBasicMaterial => {
    const mat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: offsetFactor, polygonOffsetUnits: offsetUnits })
    mat.onBeforeCompile = (shader) => {
      const uniforms = (shader as unknown as { uniforms: Record<string, THREE.IUniform> }).uniforms
      uniforms.uTime = swimUniforms.uTime
      uniforms.uSwimAmp = swimUniforms.uSwimAmp
      uniforms.uSwimFreq = swimUniforms.uSwimFreq
      uniforms.uSwimSpeed = swimUniforms.uSwimSpeed
      uniforms.uMin = { value: bb.min.x }
      uniforms.uMax = { value: bb.max.x }
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uSwimAmp;\nuniform float uSwimFreq;\nuniform float uSwimSpeed;\nuniform float uMin;\nuniform float uMax;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n{\n  float along = (position.x - uMin) / max(uMax - uMin, 1e-4);\n  float envelope = smoothstep(0.0, 0.55, along) * (1.0 - smoothstep(0.72, 1.0, along));\n  float wave = sin(position.x * uSwimFreq - uTime * uSwimSpeed) * uSwimAmp;\n  transformed.z += wave * envelope;\n  transformed.y += wave * 0.28 * envelope;\n}')
    }
    return mat
  }

const browMat = waveAttachMaterial(C.COLOR_WHITE, -2, -2)
  const browGroup = new THREE.Group()
  browGroup.add(new THREE.Mesh(buildBrowMesh(false), browMat))
  browGroup.add(new THREE.Mesh(buildBrowMesh(true), browMat))
  model.add(browGroup)
  const eyeCenterY = dentPoint.y + C.EYE_OFFSET_Y
  const circlePoints: { x: number; y: number }[] = []
  for (let i = 0; i < C.EYE_CIRCLE_SEGMENTS; i++) {
    const angle = (i / C.EYE_CIRCLE_SEGMENTS) * Math.PI * 2
    circlePoints.push({ x: eyeCenterX + C.EYE_RADIUS * Math.cos(angle), y: eyeCenterY + C.EYE_RADIUS * Math.sin(angle) })
  }
  function buildEyeMesh(flip: boolean): THREE.BufferGeometry {
    const contour = circlePoints.map(p => new THREE.Vector2((p.x - cx) * C.BROW_SCALE + C.BROW_OFFSET_X, -(p.y - cy) * C.BROW_SCALE + C.BROW_OFFSET_Y))
    const tri = THREE.ShapeUtils.triangulateShape(contour, [])
    const pos: number[] = []
    const idx: number[] = []
    for (const p of circlePoints) {
      const sp = mapToSurface(p, cx, cy, bodySwept)
      pos.push(sp.x, sp.y, sp.z)
    }
    for (const t of tri) idx.push(t[0], t[1], t[2])
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    g.setIndex(idx)
    if (flip) {
      const arr = g.attributes.position.array as Float32Array
      for (let i = 2; i < arr.length; i += 3) arr[i] = -arr[i]
    }
    g.scale(bodyScale, bodyScale, bodyScale)
    return g
  }
const eyeMat = waveAttachMaterial(C.COLOR_WHITE, -3, -3)
  const eyeL = new THREE.Mesh(buildEyeMesh(false), eyeMat)
  const eyeR = new THREE.Mesh(buildEyeMesh(true), eyeMat)
  model.add(eyeL)
  model.add(eyeR)
  const eyeMeshes: THREE.Mesh[] = [eyeL, eyeR]

  // ---- tail fin -------------------------------------------------------------
  const tailSvgPts = sampleSvgPath(TAIL_PATH, 60)
  const bodyTipX = bodySwept.xs[bodySwept.xs.length - 1] * bodyScale
  const bodyTipY = bodySwept.mid[bodySwept.mid.length - 1] * bodyScale
  const openAng = C.TAIL_OPEN_ANGLE_DEG * Math.PI / 180
  const oc = Math.cos(openAng)
  const os = Math.sin(openAng)
  const finPts = tailSvgPts.map(p => {
    const lx = (p.x - TAIL_NOTCH.x) * C.TAIL_FORK_SCALE
    const ly = -(p.y - TAIL_NOTCH.y) * C.TAIL_FORK_SCALE
    return { x: lx * oc + ly * os, z: -lx * os + ly * oc }
  })

  const tailMat = new THREE.MeshBasicMaterial({ color: C.COLOR_BODY_BLUE, side: THREE.DoubleSide })
  applySoftShade(tailMat, { strength: 0.32, softness: 0.7 })
  const tailGroup = new THREE.Group()
  const leftHalf = extractLeftHalf(finPts)
  if (leftHalf && leftHalf.length > 2) {
    const closedLeft = [...leftHalf, { x: leftHalf[0].x, z: leftHalf[0].z }]
    const leftGeom = buildLeafGeometry(closedLeft, C.TAIL_THICKNESS)
    tailGroup.add(new THREE.Mesh(leftGeom, tailMat))
    const rightMesh = new THREE.Mesh(leftGeom.clone(), tailMat)
    rightMesh.scale.z = -1
    tailGroup.add(rightMesh)
    addOutline(tailGroup, leftGeom, FIN_OUTLINE)
    addOutline(tailGroup, leftGeom, FIN_OUTLINE, true)
  } else {
    const N = finPts.length
    const tri = THREE.ShapeUtils.triangulateShape(finPts.map(p => new THREE.Vector2(p.x, p.z)), [])
    const h = C.TAIL_THICKNESS / 2
    const pos: number[] = []
    for (const p of finPts) pos.push(p.x, h, p.z)
    for (const p of finPts) pos.push(p.x, -h, p.z)
    const idx: number[] = []
    for (const t of tri) idx.push(t[0], t[1], t[2])
    for (const t of tri) idx.push(N + t[0], N + t[2], N + t[1])
    for (let i = 0; i < N; i++) {
      const a = i
      const b2 = (i + 1) % N
      idx.push(a, b2, N + b2, a, N + b2, N + a)
    }
    const fallbackGeom = new THREE.BufferGeometry()
    fallbackGeom.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    fallbackGeom.setIndex(idx)
    fallbackGeom.computeVertexNormals()
    tailGroup.add(new THREE.Mesh(fallbackGeom, tailMat))
    addOutline(tailGroup, fallbackGeom, FIN_OUTLINE)
  }
  group.add(tailGroup)
  tailGroup.position.set(bodyTipX + C.TAIL_NOTCH_DX, bodyTipY + C.TAIL_NOTCH_DY, 0)
  tailGroup.rotation.z = C.TAIL_TILT_DEG * Math.PI / 180

  // ---- dorsal fin -----------------------------------------------------------
  const dorsalSvg = sampleSvgPath(DORSAL_PATH, C.DORSAL_SAMPLES)
  const by0 = backSurfaceAt(C.DORSAL_START_FRAC, bodySwept, bodyScale).top
  const by1 = backSurfaceAt(C.DORSAL_END_FRAC, bodySwept, bodyScale).top
  const dorsalPts = dorsalSvg.map(p => {
    const u = (p.x - DORSAL_BL) / (DORSAL_BR - DORSAL_BL)
    const baseY = 2.993 + u * (4.746 - 2.993)
    const h = Math.max(0, (baseY - p.y) * C.DORSAL_HEIGHT_SCALE)
    const frac = C.DORSAL_START_FRAC + u * (C.DORSAL_END_FRAC - C.DORSAL_START_FRAC)
    const px = (bodySwept.xs[0] + (bodySwept.xs[bodySwept.xs.length - 1] - bodySwept.xs[0]) * frac) * bodyScale
    const py = by0 + u * (by1 - by0) - C.DORSAL_SINK + h
    return { x: px, y: py }
  })
  const dorsalMat = new THREE.MeshBasicMaterial({ color: C.COLOR_BODY_BLUE, side: THREE.DoubleSide })
  applySoftShade(dorsalMat, { strength: 0.32, softness: 0.7 })
  const dorsalGeom = extrudePolygon3D(dorsalPts, C.DORSAL_THICKNESS, new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0))
  const dorsalFin = new THREE.Mesh(dorsalGeom, dorsalMat)
  group.add(dorsalFin)
  addOutline(group, dorsalGeom, FIN_OUTLINE)

  // ---- pectoral fins --------------------------------------------------------
const pecSvg = sampleSvgPath(PEC_PATH, 30)
  const pecMat = new THREE.MeshBasicMaterial({ color: C.COLOR_BODY_BLUE, side: THREE.DoubleSide })
  applySoftShade(pecMat, { strength: 0.32, softness: 0.7 })
  const pecAngle = C.PEC_RADIAN * Math.PI / 180
  const pecPivots: THREE.Group[] = []
  for (const side of [1, -1]) {
    const s0 = backSurfaceAt(C.PEC_START_FRAC, bodySwept, bodyScale)
    const s1 = backSurfaceAt(C.PEC_END_FRAC, bodySwept, bodyScale)
    const r0 = s0.rad - C.PEC_SINK
    const r1 = s1.rad - C.PEC_SINK
    const Rh = new THREE.Vector3(
      s0.x + C.PEC_BACKWARD_OFFSET,
      s0.mid + r0 * Math.cos(pecAngle),
      side * (r0 * Math.sin(pecAngle) + C.PEC_OUTWARD_OFFSET),
    )
    const Rt = new THREE.Vector3(
      s1.x + C.PEC_BACKWARD_OFFSET,
      s1.mid + r1 * Math.cos(pecAngle),
      side * (r1 * Math.sin(pecAngle) + C.PEC_OUTWARD_OFFSET),
    )
    const rootLen = Rh.distanceTo(Rt)
    const axisX = new THREE.Vector3().subVectors(Rt, Rh).normalize()
    const outRaw = new THREE.Vector3(0, -Math.sin(C.PEC_ANGLE_DEG * Math.PI / 180), side * Math.cos(C.PEC_ANGLE_DEG * Math.PI / 180))
    const axisY = outRaw.clone().addScaledVector(axisX, -outRaw.dot(axisX)).normalize()
    const pec2D = pecSvg.map(p => {
      const u = (p.x - PEC_BL) / (PEC_BR - PEC_BL)
      const baseY = 19.267 + u * (19.565 - 19.267)
      const w = Math.max(0, (p.y - baseY) / PEC_DROP)
      return { x: u * rootLen + w * C.PEC_SWEEP, y: w * C.PEC_SPAN }
    })
    const pecGeom = extrudePolygon3D(pec2D, C.PEC_THICKNESS, new THREE.Vector3(0, 0, 0), axisX, axisY)
    const finMesh = new THREE.Mesh(pecGeom, pecMat)
    const pivot = new THREE.Group()
    pivot.position.copy(Rh)
    pivot.add(finMesh)
    addOutline(pivot, pecGeom, FIN_OUTLINE)
    group.add(pivot)
    pecPivots.push(pivot)
  }

// ---- skin: collect fin/eye materials into dark / white groups ----
  const darkMats: THREE.Material[] = []
  const whiteMats: THREE.Material[] = []
  group.traverse((m) => {
    const mesh = m as THREE.Mesh
    if (!mesh.isMesh || !mesh.material || mesh.material === material) return
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const c = (mat as THREE.MeshBasicMaterial).color
    if (!c) return
    if (c.getHex() === 0xffffff) whiteMats.push(mat)
    else darkMats.push(mat)
  })

  function applySkin(dark: number, white: number): void {
    if (bodyUniformsRef) {
      bodyUniformsRef.uDark.value.set(dark)
      bodyUniformsRef.uWhite.value.set(white)
    }
    darkMats.forEach(m => (m as THREE.MeshBasicMaterial).color.set(dark))
    whiteMats.forEach(m => (m as THREE.MeshBasicMaterial).color.set(white))
  }

  const setSkin = (name: string): void => {
    const skin = ORCA_SKINS[name] ?? ORCA_SKINS.classic
    applySkin(skin.dark, skin.white)
  }

  const setOutlines = (on: boolean): void => {
    for (const shell of outlineMeshes) shell.visible = on
  }

  // ---- mood animation (照搬 pet.html 情绪系统) ----
  let moodTarget = MOODS.idle
  let currentMood: OrcaMoodId = 'idle'
  const moodState: MoodParams = { ...MOODS.idle }
  let hoverBoost = 0
  let clickBoost = 0
  let isSleeping = false
  /** 动作速度倍率；1 = 原始节奏。见 OrcaModel.setMotionSpeed 的说明。 */
  let motionScale = 1
  let blinkPhase = Math.random()

  const setMood = (mood: OrcaMoodId): void => {
    if (MOODS[mood]) {
      currentMood = mood
      moodTarget = MOODS[mood]
    }
  }

  const update = (t: number, dt: number, opts: { baseScale?: number; divePitch?: number } = {}): number => {
    const rate = 0.04
    moodState.speed += (moodTarget.speed - moodState.speed) * rate
    moodState.floatAmp += (moodTarget.floatAmp - moodState.floatAmp) * rate
    moodState.floatSpeed += (moodTarget.floatSpeed - moodState.floatSpeed) * rate
    moodState.breath += (moodTarget.breath - moodState.breath) * rate
    moodState.bodySway += (moodTarget.bodySway - moodState.bodySway) * rate
    moodState.bodyYaw += (moodTarget.bodyYaw - moodState.bodyYaw) * rate
    moodState.bodyPitch += (moodTarget.bodyPitch - moodState.bodyPitch) * rate
    moodState.tailYaw += (moodTarget.tailYaw - moodState.tailYaw) * rate
    moodState.tailPitch += (moodTarget.tailPitch - moodState.tailPitch) * rate
    moodState.pecFlap += (moodTarget.pecFlap - moodState.pecFlap) * rate

    clickBoost += (0 - clickBoost) * 0.02
    const boost = Math.max(hoverBoost, clickBoost)
    const sleepF = isSleeping ? 0.2 : 1
    const fMul = 1 + 0.4 * boost
    const aMul = 1 + 0.45 * boost
    const w = BASE_SWIM_HZ * fMul * Math.PI * 2 * motionScale

    // 身体姿态。模型鼻子朝局部 -X：绕 Z 的旋转是俯仰（divePitch，下潜低头
    // /上浮抬头，由巡游逻辑传入），绕 X 的旋转是横滚（mood 摇摆）。之前把
    // orbitPitch 加在 rotation.x 上——那是横滚轴，俯仰被当成了侧滚。
    const dive = opts.divePitch ?? 0
    const sway = moodState.bodySway * aMul * sleepF
    group.rotation.z = dive + sway * (Math.sin(t * w) + 0.4 * Math.sin(t * w * 2 + 1.3))
    const roll = moodState.bodyPitch * aMul * sleepF
    group.rotation.x = roll * (Math.sin(t * w + 0.8) + 0.4 * Math.sin(t * w * 2 + 0.3))

    // 呼吸（整体缩放）
    const s = 1 + Math.sin(t * moodState.floatSpeed * 1.6) * moodState.breath

    // 尾鳍：基准倾角固定 Z + 左右/上下摆
    tailGroup.rotation.z = C.TAIL_TILT_DEG * Math.PI / 180
    const ty = moodState.tailYaw * aMul * sleepF
    tailGroup.rotation.y = ty * (Math.sin(t * w + 0.7) + 0.5 * Math.sin(t * w * 2 + 1.9))
    const tp = moodState.tailPitch * aMul * sleepF
    tailGroup.rotation.x = tp * (Math.sin(t * w + 1.2) + 0.5 * Math.sin(t * w * 2 + 0.5))

    // 胸鳍：划水
    const pf = moodState.pecFlap * aMul * sleepF
    const pecVal = pf * (Math.sin(t * w + 0.6) + 0.5 * Math.sin(t * w * 2 + 1.8))
    for (const piv of pecPivots) piv.rotation.x = pecVal

    // 眨眼
    if (isSleeping) {
      for (const m of eyeMeshes) m.scale.y = 0.1
    } else {
      const blinkPeriod = 4.3 / (1 + 0.25 * boost)
      const bp = ((t + blinkPhase) % blinkPeriod) / blinkPeriod
      const eyeOpen = 0.06 + 0.94 * blinkCurve(bp)
      for (const m of eyeMeshes) m.scale.y = eyeOpen
    }

    return (opts.baseScale ?? 1) * s
  }

  return {
    group,
    bodyGeo: geo,
    bodySwept,
    bodyScale,
    bodyTipX,
    bodyTipY,
    dentPoint,
    swimUniforms,
    setSkin,
    setMood,
    setOutlines,
    setBoost: (boost: number) => { hoverBoost = boost },
    addClick: () => { clickBoost = 1 },
    setSleeping: (on: boolean) => { isSleeping = on },
    setMotionSpeed: (scale: number) => {
      // 夹在 0.4~1.8：再慢会读成"卡帧"，再快就回到用户抱怨的那种抽搐。
      motionScale = Math.min(1.8, Math.max(0.4, scale))
      // shader 里的体波是另一套时间轴，必须一起缩放，否则身体在抖而尾巴不抖。
      swimUniforms.uSwimSpeed.value = 2.8 * motionScale
    },
    update,
  }
}


