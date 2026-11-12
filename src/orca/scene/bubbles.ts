import * as THREE from 'three'
import type { AquariumTheme } from './themes'

/*
 * Ambient rising bubbles: soft paper-cut rings with a tiny inner disc that
 * billboard to the camera. Each bubble wobbles on its way up and wraps around
 * the open sea, spread over a wide circular area (no tank box).
 *
 * Two InstancedMeshes — one for the rings, one for the discs — rather than a
 * group of two meshes per bubble. That was 120 draw calls on the high tier for
 * pure decoration, which on its own put the scene over the minitool WebGL
 * budget (references/performance-budget.md: <=100 calls per frame). Now it is
 * two, and the per-bubble variation that used to live in per-bubble materials
 * lives in the instance matrices and the instance colour buffer:
 *
 *   - size      -> the matrix scale (one unit geometry, scaled per instance)
 *   - opacity   -> the instance colour's brightness
 *
 * The brightness trick is exact here, not an approximation: the material is
 * additive (`SrcAlpha, One`), so `dst + src * alpha` and `dst + (src * alpha)`
 * are the same thing. The material keeps `opacity: 1` and every bubble's
 * `baseOpacity * shimmer` is folded into its instance colour.
 */

export interface BubbleField {
  group: THREE.Group
  update: (t: number, dt: number, camera: THREE.PerspectiveCamera) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

const BUBBLE_RADIUS = 24
const BUBBLE_MIN_Y = 0.2
const BUBBLE_MAX_Y = 11
const BUBBLE_CLUSTER = 0.45

/** The inner disc is dimmer than the ring, as a fraction of its brightness. */
const DISC_BRIGHTNESS = 0.32

interface Bubble {
  baseX: number
  baseZ: number
  y: number
  speed: number
  phase: number
  baseOpacity: number
  size: number
}

function randomBubbleSpot(): [number, number] {
  // Scattered but clumpy: most bubbles drift in loose clusters, some
  // float far out on their own — never a tidy box or even ring.
  if (Math.random() < BUBBLE_CLUSTER) {
    const cx = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS
    const cz = (Math.random() - 0.5) * 2 * BUBBLE_RADIUS
    return [
      cx + (Math.random() - 0.5) * 6,
      cz + (Math.random() - 0.5) * 6,
    ]
  }
  const ang = Math.random() * Math.PI * 2
  const r = Math.pow(Math.random(), 1.3) * BUBBLE_RADIUS
  return [Math.cos(ang) * r, Math.sin(ang) * r]
}

export function createBubbles(theme: AquariumTheme, count: number): BubbleField {
  const group = new THREE.Group()
  group.name = 'bubbles'

  // Unit geometry: the ring is 0.62..1 and the disc 0..0.62 in its own units,
  // so a per-instance scale of `size` reproduces the old per-bubble geometry
  // exactly, at any size, with no rebuild.
  const ringGeo = new THREE.RingGeometry(0.62, 1, 20)
  const discGeo = new THREE.CircleGeometry(0.62, 20)
  const makeMaterial = (): THREE.MeshBasicMaterial =>
    new THREE.MeshBasicMaterial({
      // White: the instance colour carries both the theme hue and the
      // per-bubble brightness, so it must not be multiplied by anything else.
      color: 0xffffff,
      transparent: true,
      opacity: 1,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    })
  const ringMat = makeMaterial()
  const discMat = makeMaterial()

  const rings = new THREE.InstancedMesh(ringGeo, ringMat, Math.max(1, count))
  const discs = new THREE.InstancedMesh(discGeo, discMat, Math.max(1, count))
  rings.name = 'bubble-rings'
  discs.name = 'bubble-discs'
  for (const mesh of [rings, discs]) {
    mesh.count = count
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
    // The instances are spread over a 48-unit disc, so the geometry's own
    // bounding sphere is meaningless here and would cull the whole field as
    // soon as the camera looked away from the origin.
    mesh.frustumCulled = false
    group.add(mesh)
  }

  const bubbles: Bubble[] = []
  for (let i = 0; i < count; i++) {
    const [baseX, baseZ] = randomBubbleSpot()
    bubbles.push({
      baseX,
      baseZ,
      size: 0.035 + Math.random() * 0.1,
      y: BUBBLE_MIN_Y + Math.random() * (BUBBLE_MAX_Y - BUBBLE_MIN_Y),
      speed: 0.28 + Math.random() * 0.55,
      phase: Math.random() * Math.PI * 2,
      baseOpacity: theme.bubbleOpacity * (0.4 + Math.random() * 0.6),
    })
  }

  const themeColor = new THREE.Color(theme.bubbleColor)
  const tint = new THREE.Color()
  const position = new THREE.Vector3()
  const scale = new THREE.Vector3()
  const matrix = new THREE.Matrix4()

  const setTheme = (next: AquariumTheme): void => {
    themeColor.setHex(next.bubbleColor)
    for (const bubble of bubbles) {
      bubble.baseOpacity = next.bubbleOpacity * (0.4 + Math.random() * 0.6)
    }
    // The colours are rewritten on the next frame; forcing the buffers here
    // keeps a theme switch from showing one frame of the old palette.
    rings.instanceColor && (rings.instanceColor.needsUpdate = true)
    discs.instanceColor && (discs.instanceColor.needsUpdate = true)
  }

  return {
    group,
    update: (t: number, dt: number, camera: THREE.PerspectiveCamera) => {
      // Every bubble faces the camera, so the rotation is composed once.
      for (let i = 0; i < count; i++) {
        const bubble = bubbles[i]
        bubble.y += bubble.speed * dt
        if (bubble.y > BUBBLE_MAX_Y) {
          bubble.y = BUBBLE_MIN_Y
          const spot = randomBubbleSpot()
          bubble.baseX = spot[0]
          bubble.baseZ = spot[1]
        }
        const shimmer = 0.82 + 0.18 * Math.sin(t * 2.2 + bubble.phase * 3.0)
        position.set(
          bubble.baseX + Math.sin(t * 0.9 + bubble.phase) * 0.16,
          bubble.y,
          bubble.baseZ + Math.cos(t * 0.7 + bubble.phase) * 0.16,
        )
        matrix.compose(position, camera.quaternion, scale.setScalar(bubble.size))
        rings.setMatrixAt(i, matrix)
        discs.setMatrixAt(i, matrix)

        tint.copy(themeColor).multiplyScalar(bubble.baseOpacity * shimmer)
        rings.setColorAt(i, tint)
        tint.copy(themeColor).multiplyScalar(bubble.baseOpacity * DISC_BRIGHTNESS * shimmer)
        discs.setColorAt(i, tint)
      }
      rings.instanceMatrix.needsUpdate = true
      discs.instanceMatrix.needsUpdate = true
      if (rings.instanceColor) rings.instanceColor.needsUpdate = true
      if (discs.instanceColor) discs.instanceColor.needsUpdate = true
    },
    setTheme,
    dispose: () => {
      ringGeo.dispose()
      discGeo.dispose()
      ringMat.dispose()
      discMat.dispose()
      rings.dispose()
      discs.dispose()
    },
  }
}
