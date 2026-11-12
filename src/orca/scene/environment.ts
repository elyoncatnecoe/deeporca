import * as THREE from 'three'
import { getTheme, getThemeCounts, type AquariumTheme, type ThemeId } from './themes'
import { createTerrain, type Terrain } from './terrain'
import { createWaterSurface, type WaterSurface } from './surface'
import { createContactShadow, type ContactShadow } from './contactShadow'
import { createGodRays, type GodRays } from './godRays'
import { createPlankton, type PlanktonField } from './plankton'
import { createBubbles, type BubbleField } from './bubbles'
import { createFish, type FishField } from './fish'
import { scaledCount, type QualitySettings } from '../quality'

export interface AquariumEnvironment {
  update: (t: number, dt: number, camera: THREE.PerspectiveCamera, follow: THREE.Vector3) => void
  setTheme: (id: ThemeId) => void
  getTheme: () => AquariumTheme
  dispose: () => void
}

/*
 * Open-sea AbyssRium-style environment: no glass tank, no shadow-mapped
 * lights. The backdrop is a full-screen water-column gradient, with a soft
 * gaussian god-ray fan screen-anchored on top of it, a water surface overhead
 * and marine snow carrying the water volume.
 *
 * The seabed does its own lighting rather than being lit: a near-vertical key
 * light, a hemisphere fill, baked crease occlusion and per-fragment caustics,
 * all resolved inside the sand's material (see seafloorMaterial.ts). The
 * characters stay unlit and cel-shaded on purpose — that contrast is the art
 * direction, and it is also why there is no light rig to hand a shadow map to,
 * hence the single blob shadow tracking the orca.
 */

// ------------------------------------------------------- water column

const MAX_STOPS = 8

const COLUMN_VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  // Full-screen triangle: positions already in clip space.
  gl_Position = vec4(position.xy, 0.9999, 1.0);
}
`

const COLUMN_FRAG = `
precision highp float;

uniform vec3 uStops[${MAX_STOPS}];
uniform float uTimes[${MAX_STOPS}];
uniform vec3 uSunColor;
uniform float uSunGlow;

varying vec2 vUv;

void main() {
  // UV convention: v=1 is the TOP of the quad, so the surface end (t=0) is
  // t = 1 - vUv.y. Straight 1:1 mapping of the measured stops.
  float t = clamp(1.0 - vUv.y, 0.0, 1.0);

  // Find the containing segment and interpolate within it exactly once; the
  // final matching segment must win, so every match also overwrites.
  vec3 col = uStops[${MAX_STOPS - 1}];
  for (int i = 0; i < ${MAX_STOPS - 1}; i++) {
    float t0 = uTimes[i];
    float t1 = uTimes[i + 1];
    if (t >= t0 && t <= t1) {
      float f = clamp((t - t0) / max(t1 - t0, 1e-5), 0.0, 1.0);
      col = mix(uStops[i], uStops[i + 1], f);
    }
  }
  if (t < uTimes[0]) col = uStops[0];

  // Surface glint where the god rays converge, baked into the column so
  // photos carry it too.
  vec2 d = vUv - vec2(0.5, 1.0);
  col += uSunColor * exp(-dot(d, d) * 7.0) * uSunGlow;

  // A gentle vignette baked into the backdrop (the reference frame's corners
  // sit visibly darker).
  vec2 vd = vUv - vec2(0.5, 0.54);
  col *= 1.0 - 0.18 * smoothstep(0.6, 1.2, length(vd));

  gl_FragColor = vec4(col, 1.0);
}
`

export function createAquariumEnvironment(
  scene: THREE.Scene,
  initialTheme: ThemeId,
  quality: QualitySettings,
): AquariumEnvironment {
  let theme = getTheme(initialTheme)

  const group = new THREE.Group()
  group.name = 'open-sea'
  scene.add(group)

  // Full-screen water column. Opaque queue with depthTest/depthWrite off and
  // renderOrder -100: drawn first, never interferes with scene geometry.
  const columnGeo = new THREE.BufferGeometry()
  columnGeo.setAttribute(
    'position',
    new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
  )
  columnGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 2, 0, 0, 2]), 2))
  const columnMat = new THREE.ShaderMaterial({
    vertexShader: COLUMN_VERT,
    fragmentShader: COLUMN_FRAG,
    uniforms: {
      uStops: { value: theme.column.map(([, hex]) => new THREE.Color(hex)) },
      uTimes: { value: theme.column.map(([t]) => t) },
      uSunColor: { value: new THREE.Color(theme.sunColor) },
      uSunGlow: { value: theme.sunGlow },
    },
    depthTest: false,
    depthWrite: false,
  })
  const column = new THREE.Mesh(columnGeo, columnMat)
  column.name = 'water-column'
  column.frustumCulled = false
  column.renderOrder = -100
  scene.add(column)

  const godRays = createGodRays(theme)
  godRays.group.renderOrder = -5
  // The fan is parented to the CAMERA on the first update() so it stays
  // screen-anchored while the player orbits; see attachGodRays below.
  let raysAttached = false

  let terrain = createTerrain(theme, quality)
  group.add(terrain.group)

  // The ceiling. Parented to the group, not the camera: it is real geometry
  // the player orbits under, so it has to hold still in world space.
  const surface: WaterSurface = createWaterSurface(theme)
  group.add(surface.mesh)

  const shadow: ContactShadow = createContactShadow(theme)
  group.add(shadow.mesh)

  // Population counts come from the theme's palette entry but are then scaled
  // by the device tier — a mid-range phone should not try to draw every fish.
  let fish = createFish(theme, scaledCount(getThemeCounts(theme.id).fish, quality.fish, 6))
  group.add(fish.group)

  let plankton = createPlankton(theme, scaledCount(getThemeCounts(theme.id).plankton, quality.plankton, 120))
  group.add(plankton.points)

  let bubbles = createBubbles(theme, scaledCount(60, quality.bubble, 10))
  group.add(bubbles.group)

  const applyTheme = (next: AquariumTheme): void => {
    theme = next
    scene.background = new THREE.Color(next.background)

    const stops = columnMat.uniforms.uStops.value as THREE.Color[]
    const times = columnMat.uniforms.uTimes.value as number[]
    next.column.forEach(([t, hex], i) => {
      if (i < MAX_STOPS) {
        stops[i].setHex(hex)
        times[i] = t
      }
    })
    columnMat.uniforms.uSunColor.value.setHex(next.sunColor)
    columnMat.uniforms.uSunGlow.value = next.sunGlow

    godRays.setTheme(next)
    terrain.setTheme(next)
    surface.setTheme(next)
    surface.setFog(next.fogColor, next.fogDensity)
    shadow.setTheme(next)
    plankton.setTheme(next)
    bubbles.setTheme(next)
    fish.setTheme(next)
  }

  // initial colors
  scene.fog = new THREE.FogExp2(theme.fogColor, theme.fogDensity)
  applyTheme(theme)

  const setTheme = (id: ThemeId): void => {
    const next = getTheme(id)
    scene.fog = new THREE.FogExp2(next.fogColor, next.fogDensity)
    applyTheme(next)
  }

  return {
    update: (t: number, dt: number, camera: THREE.PerspectiveCamera, follow: THREE.Vector3) => {
      if (!raysAttached) {
        raysAttached = true
        // A camera must be part of the scene graph for its children to render.
        scene.add(camera)
        camera.add(godRays.group)
      }
      godRays.layout(camera)
      godRays.update(t)
      surface.update(t, camera)
      shadow.update(follow)
      plankton.update(t, Math.min(window.devicePixelRatio, quality.maxPixelRatio))
      terrain.update(t)
      bubbles.update(t, dt, camera)
      fish.update(t)
    },
    setTheme,
    getTheme: () => theme,
    dispose: () => {
      terrain.dispose()
      surface.dispose()
      shadow.dispose()
      godRays.dispose()
      plankton.dispose()
      bubbles.dispose()
      fish.dispose()
      columnGeo.dispose()
      columnMat.dispose()
      scene.remove(column)
      scene.remove(group)
    },
  }
}
