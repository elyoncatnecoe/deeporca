import * as THREE from 'three'
import type { AquariumTheme } from './themes'

/*
 * Schooling fish: stylized low-poly fish silhouettes (body + notched tail)
 * swimming in loose schools — a few far out in the haze, a couple near the
 * sand island. Each school orbits on its own ellipse with per-fish wiggle,
 * and every fish gets a tiny hue/brightness variation so the school shimmers.
 */

interface School {
  mesh: THREE.InstancedMesh
  cx: number
  cz: number
  orbitA: number
  orbitB: number
  speed: number
  phase: number
  y: number
  fishes: {
    dx: number
    dz: number
    dy: number
    scale: number
    phase: number
    wiggleAmp: number
  }[]
}

const dummy = new THREE.Object3D()

/** Sum of the per-school counts below; referenced directly by `createFish`. */
const SPEC_TOTAL = 76

function makeFishGeometry(): THREE.BufferGeometry {
  const shape = new THREE.Shape()
  shape.moveTo(0.9, 0)
  shape.quadraticCurveTo(0.45, 0.30, -0.20, 0.22)
  shape.lineTo(-0.38, 0.55)
  shape.lineTo(-0.60, 0.55)
  shape.lineTo(-0.30, 0.06)
  shape.lineTo(-0.60, -0.55)
  shape.lineTo(-0.38, -0.55)
  shape.lineTo(-0.20, -0.22)
  shape.quadraticCurveTo(0.45, -0.30, 0.9, 0)
  shape.closePath()
  // The fish stays UPRIGHT in the XY plane (nose +X, dorsal +Y). An earlier
  // build laid the shape flat into XZ, which read as paper shards littering
  // the sand from the shallow camera; upright silhouettes read as fish.
  return new THREE.ShapeGeometry(shape, 10)
}

export interface FishField {
  group: THREE.Group
  update: (t: number) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

export function createFish(theme: AquariumTheme, totalCount: number): FishField {
  const group = new THREE.Group()
  group.name = 'fish'

  const color = new THREE.Color()
  const schools: School[] = []
  const fishGeo = makeFishGeometry()

  const schoolSpecs: { cx: number; cz: number; a: number; b: number; y: number; count: number; speed: number; scale: [number, number] }[] = [
    // Far schools circling in the haze, high enough to silhouette against
    // the water column instead of skimming the sand.
    { cx: 0, cz: 10, a: 24, b: 17, y: 3.4, count: 20, speed: 0.16, scale: [0.4, 0.7] },
    { cx: -12, cz: -8, a: 19, b: 14, y: 4.2, count: 17, speed: 0.13, scale: [0.38, 0.65] },
    { cx: 14, cz: -14, a: 17, b: 12, y: 5.0, count: 15, speed: 0.18, scale: [0.35, 0.6] },
    // Near schools drift mid-water around the sand bowl — raised and
    // shrunk so they read as fish, not floor litter.
    { cx: 0, cz: 0, a: 7.5, b: 5, y: 3.0, count: 13, speed: 0.30, scale: [0.25, 0.45] },
    { cx: 6, cz: 4, a: 6, b: 4.2, y: 3.6, count: 11, speed: 0.34, scale: [0.22, 0.4] },
  ]

  const build = (next: AquariumTheme): void => {
    for (const school of schools) {
      ;(school.mesh.material as THREE.Material).dispose()
      group.remove(school.mesh)
    }
    schools.length = 0

    // `fishGeo` is shared by every school and owned by this closure, so it is
    // only disposed once, in dispose() — never per school.
    const fishScale = totalCount / SPEC_TOTAL
    for (const spec of schoolSpecs) {
      const fishes = []
      const count = Math.max(4, Math.ceil(spec.count * fishScale))
      const material = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })
      const mesh = new THREE.InstancedMesh(fishGeo, material, count)
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
      mesh.frustumCulled = false
      for (let i = 0; i < count; i++) {
        const ang = Math.random() * Math.PI * 2
        const rad = Math.sqrt(Math.random()) * 2.4
        fishes.push({
          dx: Math.cos(ang) * rad,
          dz: Math.sin(ang) * rad,
          dy: (Math.random() - 0.5) * 0.9,
          scale: spec.scale[0] + Math.random() * (spec.scale[1] - spec.scale[0]),
          phase: Math.random() * Math.PI * 2,
          wiggleAmp: 0.15 + Math.random() * 0.28,
        })
        color.setHex(next.fishHues[i % next.fishHues.length])
        color.offsetHSL(0, 0, (Math.random() - 0.5) * 0.07)
        mesh.setColorAt(i, color)
        dummy.position.set(0, -60, 0)
        dummy.scale.setScalar(0.001)
        dummy.updateMatrix()
        mesh.setMatrixAt(i, dummy.matrix)
      }
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
      mesh.instanceMatrix.needsUpdate = true
      group.add(mesh)
      schools.push({
        mesh,
        cx: spec.cx,
        cz: spec.cz,
        orbitA: spec.a,
        orbitB: spec.b,
        speed: spec.speed,
        phase: Math.random() * Math.PI * 2,
        y: spec.y,
        fishes,
      })
    }
  }

  build(theme)

  return {
    group,
    update: (t: number) => {
      for (const school of schools) {
        const cx = school.cx + Math.cos(t * 0.05 + school.phase) * 1.6
        const cz = school.cz + Math.sin(t * 0.043 + school.phase) * 1.2
        const a = school.orbitA
        const b = school.orbitB
        for (let i = 0; i < school.fishes.length; i++) {
          const f = school.fishes[i]
          const ang = t * school.speed + f.phase
          const baseX = cx + Math.cos(ang) * a
          const baseZ = cz + Math.sin(ang) * b
          const wobX = Math.sin(t * 0.7 + f.phase * 2) * f.wiggleAmp
          const wobY = Math.sin(t * 0.9 + f.phase) * 0.14
          dummy.position.set(baseX + f.dx + wobX, school.y + f.dy + wobY, baseZ + f.dz)
          dummy.scale.setScalar(f.scale)
          // Upright geometry (nose +X): yaw = atan2(-vz, vx) with velocity
          // vx = -sin(ang)*a*speed, vz = cos(ang)*b*speed. A gentle yaw
          // wobble stands in for tail sway, visible from the side view.
          dummy.rotation.y =
            Math.atan2(-Math.cos(ang) * b * school.speed, -Math.sin(ang) * a * school.speed) +
            Math.sin(t * 0.8 + f.phase) * 0.12
          dummy.rotation.z = Math.sin(t * 1.4 + f.phase * 3) * 0.1
          dummy.updateMatrix()
          school.mesh.setMatrixAt(i, dummy.matrix)
        }
        school.mesh.instanceMatrix.needsUpdate = true
      }
    },
    setTheme: (next: AquariumTheme) => {
      build(next)
    },
    dispose: () => {
      for (const school of schools) {
        ;(school.mesh.material as THREE.Material).dispose()
      }
      fishGeo.dispose()
    },
  }
}
