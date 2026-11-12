import * as THREE from 'three'

export interface DecorKind {
  id: string
  name: string
  /** Rough half-width on the sand plane, used for placement collision. */
  radius: number
  makeMesh: () => THREE.Group
}

function mat(color: number, transparent = false, opacity = 1): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    transparent,
    opacity,
    side: THREE.DoubleSide,
  })
}

function makeGlowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.25, 'rgba(255,255,255,0.55)')
  grad.addColorStop(0.55, 'rgba(255,255,255,0.14)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = grad
  ctx.fillRect(0, 0, 128, 128)
  const tex = new THREE.CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
  return tex
}

const glowTexture = makeGlowTexture()

function glowSprite(color: number, size: number, opacity = 0.85): THREE.Sprite {
  const material = new THREE.SpriteMaterial({
    map: glowTexture,
    color,
    transparent: true,
    opacity,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  })
  const sprite = new THREE.Sprite(material)
  sprite.scale.set(size, size, 1)
  return sprite
}

function taperedBranch(
  height: number,
  radiusBottom: number,
  radiusTop: number,
  color: number,
  segments = 7,
): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(radiusTop, radiusBottom, height, segments), mat(color))
}

/**
 * A small settled-sand mound under a decor piece. Props used to meet the
 * seafloor at a hard, floating-looking edge; a low mound grounds them the way
 * AbyssRium's props are settled into the sand.
 */
function sandMound(radius: number): THREE.Mesh {
  const mound = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), mat(0x3c4480))
  mound.scale.set(1, 0.32, 1)
  mound.position.y = radius * 0.06
  return mound
}

/*
 * Palette notes: the scene is unlit, so these hex values ARE the final screen
 * colours. Each piece reads best with one saturated body hue + a lighter accent
 * on its tips + a grounded sand base — three tones, never more.
 */
const SAND_MOUND = 0x3c4480
const CORAL_BODY = 0xf06a92
const CORAL_TIP = 0xffb0c8
const CORAL_ALT = 0x7fd4c8
const KELP_A = 0x40916c
const KELP_B = 0x52b788
const WOOD = 0x8a5a3c
const WOOD_DARK = 0x6e4429
const BRASS = 0xf2c14e
const ANEMONE_BODY = 0xb06ad0
const ANEMONE_TIP = 0xf0c0ff

export const DECOR_CATALOG: DecorKind[] = [
  {
    id: 'rock-small',
    name: '小岩石',
    radius: 0.7,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.62))
      // Three boulders of clearly different size + two pebbles, each with its
      // own tilt so the cluster reads as settled rubble, not a spawned clump.
      const a = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 0), mat(0x9aa8c0))
      a.position.set(0, 0.3, 0)
      a.rotation.set(0.4, 0.2, 0)
      a.scale.y = 0.82
      const b = new THREE.Mesh(new THREE.IcosahedronGeometry(0.32, 0), mat(0x8a98b4))
      b.position.set(0.46, 0.16, 0.2)
      b.rotation.set(0.1, 0.9, 0.15)
      const c = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 0), mat(0xaab8d0))
      c.position.set(-0.4, 0.1, -0.18)
      c.rotation.set(0.7, 0.3, 0.45)
      const d = new THREE.Mesh(new THREE.IcosahedronGeometry(0.12, 0), mat(0x7e8ca8))
      d.position.set(0.18, 0.06, 0.5)
      const e = new THREE.Mesh(new THREE.IcosahedronGeometry(0.09, 0), mat(0x7e8ca8))
      e.position.set(-0.14, 0.05, 0.38)
      // A moss cap gives the biggest stone a colour anchor.
      const moss = new THREE.Mesh(new THREE.SphereGeometry(0.26, 10, 6), mat(0x74c69d))
      moss.scale.set(1, 0.4, 1)
      moss.position.set(0, 0.42, 0)
      g.add(a, b, c, d, e, moss)
      return g
    },
  },
  {
    id: 'coral',
    name: '珊瑚',
    radius: 0.8,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.55))
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.34, 0.28, 9), mat(0xc4587e))
      base.position.y = 0.32
      g.add(base)
      // Fractal-tree coral (分形树): every arm recursively forks into 2-3
      // smaller arms (length ×0.72, radius ×0.62) with a gentle upward bias,
      // ending in light beads. Depth 4 gives the classic branching-silhouette
      // that reads as "coral" at a glance — and nothing like the anemone's
      // short radial tentacles.
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
          mat(CORAL_BODY),
        )
        seg.position.copy(root).addScaledVector(dir, length / 2)
        seg.quaternion.setFromUnitVectors(UP, dir)
        g.add(seg)
        const tip = root.clone().addScaledVector(dir, length)
        if (depth <= 0) {
          const bead = new THREE.Mesh(new THREE.SphereGeometry(radius * 0.95, 8, 8), mat(CORAL_TIP))
          bead.position.copy(tip)
          g.add(bead)
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
          grow(tip, childDir, length * 0.72, radius * 0.62, depth - 1)
        }
      }
      // 3-5 trunks fanning out from the base, each its own fractal tree.
      const trunks = 3 + Math.floor(Math.random() * 2)
      for (let i = 0; i < trunks; i++) {
        const ang = (i / trunks) * Math.PI * 2 + Math.random() * 0.6
        const dir = new THREE.Vector3(Math.cos(ang) * 0.32, 1, Math.sin(ang) * 0.32).normalize()
        grow(new THREE.Vector3(Math.cos(ang) * 0.08, 0.42, Math.sin(ang) * 0.08), dir, 0.46, 0.085, 4)
      }
      return g
    },
  },
  {
    id: 'kelp',
    name: '海草',
    radius: 0.6,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.42))
      // Tuft of ribbon blades in two greens: tall centre, shorter skirt, each
      // with its own lean so the cluster reads as a plant, not a fence.
      const blades = 7
      for (let i = 0; i < blades; i++) {
        const ang = (i / blades) * Math.PI * 2
        const tall = i < 3
        const h = tall ? 1.5 + (i % 2) * 0.5 : 0.7 + (i % 3) * 0.22
        const geometry = new THREE.PlaneGeometry(0.16, h, 1, 10)
        const pos = geometry.attributes.position.array as Float32Array
        for (let j = 0; j < pos.length; j += 3) {
          const t = (pos[j + 1] + h / 2) / h
          pos[j] *= 0.3 + 0.7 * Math.sin(t * Math.PI)
          pos[j] += Math.sin(t * 2.4 + i) * 0.035
        }
        geometry.computeVertexNormals()
        const blade = new THREE.Mesh(geometry, mat(i % 2 === 0 ? KELP_A : KELP_B))
        blade.position.set(Math.cos(ang) * 0.14, h / 2 + 0.05, Math.sin(ang) * 0.14)
        blade.rotation.y = ang
        blade.rotation.z = (Math.random() - 0.5) * 0.24
        g.add(blade)
      }
      return g
    },
  },
  {
    id: 'treasure',
    name: '宝箱',
    radius: 0.7,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.52))
      const chest = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.5), mat(WOOD))
      chest.position.y = 0.29
      g.add(chest)
      const lid = new THREE.Mesh(
        new THREE.CylinderGeometry(0.26, 0.26, 0.5, 12, 1, false, 0, Math.PI),
        mat(WOOD_DARK),
      )
      lid.rotation.z = Math.PI / 2
      lid.position.y = 0.5
      g.add(lid)
      // Brass work: two horizontal bands, a vertical strap and a lock plate.
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.06, 0.54), mat(BRASS))
      band.position.y = 0.24
      const band2 = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.05, 0.54), mat(BRASS))
      band2.position.y = 0.47
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.44, 0.56), mat(BRASS))
      strap.position.set(0.18, 0.29, 0)
      const lock = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.06), mat(0xffe08a))
      lock.position.set(0, 0.4, 0.27)
      g.add(band, band2, strap, lock)
      const coins: [number, number, number, number][] = [
        [0.16, 0.2, 0, 0.1],
        [-0.2, 0.14, 0.4, 0.07],
        [0.02, -0.22, 0.9, 0.08],
      ]
      for (const [x, z, rotY, r] of coins) {
        const coin = new THREE.Mesh(new THREE.CylinderGeometry(r, r, 0.04, 12), mat(BRASS))
        coin.rotation.x = Math.PI / 2
        coin.rotation.y = rotY
        coin.position.set(x, 0.09, z)
        g.add(coin)
      }
      const glow = glowSprite(BRASS, 1.3, 0.4)
      glow.position.y = 0.62
      g.add(glow)
      return g
    },
  },
  {
    id: 'anemone',
    name: '海葵',
    radius: 0.6,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.48))
      // Bulbous body with a visible rim, then two-tone tentacles: purple
      // columns ending in pale beads that catch the bloom.
      const body = new THREE.Mesh(new THREE.SphereGeometry(0.3, 12, 10), mat(ANEMONE_BODY))
      body.scale.set(1, 0.72, 1)
      body.position.y = 0.26
      g.add(body)
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.26, 0.1, 12), mat(0x9a58c0))
      rim.position.y = 0.42
      g.add(rim)
      const tentacles = 16
      for (let i = 0; i < tentacles; i++) {
        const ang = (i / tentacles) * Math.PI * 2
        const rad = 0.16 + (i % 3) * 0.05
        const h = 0.42 + (i % 4) * 0.09
        const tilt = 0.35 + (i % 3) * 0.12
        const dir = new THREE.Vector3(Math.cos(ang) * Math.sin(tilt), Math.cos(tilt), Math.sin(ang) * Math.sin(tilt))
        const root = new THREE.Vector3(Math.cos(ang) * rad, 0.44, Math.sin(ang) * rad)
        const tip = root.clone().addScaledVector(dir, h)
        const tentacle = taperedBranch(h, 0.045, 0.02, ANEMONE_BODY, 6)
        tentacle.position.copy(root).add(tip).multiplyScalar(0.5)
        tentacle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir)
        const bead = new THREE.Mesh(new THREE.SphereGeometry(0.042, 8, 8), mat(ANEMONE_TIP))
        bead.position.copy(tip)
        g.add(tentacle, bead)
      }
      return g
    },
  },
  {
    id: 'lamp',
    name: '小灯',
    radius: 0.5,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.4))
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.24, 0.14, 10), mat(0x5a648e))
      base.position.y = 0.12
      g.add(base)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.8, 8), mat(0x525c86))
      pole.position.y = 0.56
      g.add(pole)
      // Brass collar under the glass so the join reads deliberately.
      const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.07, 10), mat(BRASS))
      collar.position.y = 0.97
      g.add(collar)
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 14, 14),
        mat(0xfff4d0, true, 0.82),
      )
      bulb.position.y = 1.12
      g.add(bulb)
      const core = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 10), mat(0xffffff))
      core.position.y = 1.1
      g.add(core)
      const glow = glowSprite(0xffe9a0, 1.7, 0.65)
      glow.position.y = 1.12
      g.add(glow)
      return g
    },
  },
  {
    id: 'shell',
    name: '贝壳',
    radius: 0.45,
    makeMesh: () => {
      const g = new THREE.Group()
      g.add(sandMound(0.34))
      // Scalloped fan: petals around a hinge, cream body with rose tips.
      const hinge = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), mat(0xe8c8b0))
      hinge.position.set(0, 0.1, 0.12)
      g.add(hinge)
      const petals = 8
      for (let i = 0; i < petals; i++) {
        const spread = (i / (petals - 1) - 0.5) * Math.PI * 0.8
        const petal = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.42, 6), mat(0xf3d9c0))
        petal.position.set(Math.sin(spread) * 0.16, 0.16 + Math.cos(spread) * 0.14, 0)
        petal.rotation.z = -spread
        g.add(petal)
        const ridge = new THREE.Mesh(new THREE.SphereGeometry(0.03, 6, 6), mat(0xffe8d4))
        ridge.position.set(Math.sin(spread) * 0.3, 0.2 + Math.cos(spread) * 0.28, 0.02)
        g.add(ridge)
      }
      const pearl = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 12), mat(0xfff6ea))
      pearl.position.set(0.22, 0.07, 0.16)
      g.add(pearl)
      return g
    },
  },
]

export interface DecorPlacement {
  kindId: string
  x: number
  z: number
  rotationY: number
}

export function createDecorMesh(kindId: string): THREE.Group {
  const kind = DECOR_CATALOG.find(k => k.id === kindId)
  if (!kind) {
    const fallback = new THREE.Group()
    fallback.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), mat(0xff00ff)))
    return fallback
  }
  return kind.makeMesh()
}

export function findDecorKind(kindId: string): DecorKind | undefined {
  return DECOR_CATALOG.find(k => k.id === kindId)
}
