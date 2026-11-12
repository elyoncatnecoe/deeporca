import * as THREE from 'three'
import type { AquariumTheme } from './themes'

/**
 * Volumetric god rays, AbyssRium style.
 *
 * Measured from the reference frame: 11-19 bands across the top third, fanned
 * from an apex above the frame with a ±13 deg spread. Crucially they are SOFT:
 * peak brightness is only ~20-25% above the local background, and the strongest
 * band has a FWHM of ~1.3% of frame width. Sharp bright cones look immediately
 * wrong.
 *
 * Implementation: additive quads, NOT screen-space raymarching — one texture
 * tap per pixel, viable on mobile. Each quad is a generous container and the
 * soft shaft is carved out inside the fragment shader by a gaussian. Sizing
 * the quad itself to the beam width produces hard-edged triangles, because a
 * quad's edges are not a gaussian.
 *
 * The fan is parented to the CAMERA so it stays screen-anchored while the
 * player orbits: the water column behind it is screen-space too, so the pair
 * always read as one backdrop. depthTest stays ON so the orca and the seafloor
 * occlude the beams naturally.
 */

const VERT = /* glsl */ `
varying vec3 vView;
void main() {
  vView = (modelViewMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uIntensity;
uniform float uTime;
uniform float uSeed;
uniform float uApexY;
uniform float uLength;
uniform float uHalfWidth;
uniform float uTilt;

varying vec3 vView;

void main() {
  // v goes 0 at the surface apex to 1 at the far end of the shaft.
  float v = clamp((uApexY - vView.y) / uLength, 0.0, 1.0);

  // Shear the beam axis with depth: the centreline is apexX + tan(tilt)*drop.
  // Doing it here rather than rotating the quad keeps the beam width uniform
  // along the shaft instead of fanning out.
  float drop = uApexY - vView.y;
  float centre = uTilt * drop;

  // Soft gaussian across the beam. exp(-ln2 * (d/hw)^2) gives a true FWHM of
  // 2*uHalfWidth, so beam width is expressed in real view units.
  float d = (vView.x - centre) / uHalfWidth;
  float core = exp(-0.6931 * d * d);

  // Bright just under the surface, then dissolving long before the seafloor.
  float along = smoothstep(0.0, 0.05, v) * (1.0 - smoothstep(0.30, 0.95, v));

  // Very gentle brightness breathing; no geometric sway, so the shafts stay
  // straight and only their intensity moves — which is what the reference
  // frames show.
  float pulse = 0.9 + 0.1 * sin(uTime * 0.31 + uSeed * 9.0);

  float a = core * along * uIntensity * pulse;
  if (a < 0.0025) discard;
  gl_FragColor = vec4(uColor * a, a);
}
`

export interface GodRays {
  group: THREE.Group
  /** Re-fit the fan to the current frustum. Call every frame. */
  layout: (camera: THREE.PerspectiveCamera) => void
  update: (t: number) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

export function createGodRays(theme: AquariumTheme): GodRays {
  const count: number = 15
  const spreadDeg = 26
  const apexX = 0.16
  const apexY = 1.3
  const distance = 34
  const lengthFactor = 1.4

  const group = new THREE.Group()
  group.name = 'god-rays'
  group.renderOrder = -5

  // Quad is a container: unit square with local y running 0 (top) .. 1 (bottom).
  const geometry = new THREE.PlaneGeometry(1, 1, 1, 1)
  geometry.translate(0, -0.5, 0)

  let seed = 20260815
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 4294967296
  }

  const materials: THREE.ShaderMaterial[] = []
  const meshes: THREE.Mesh[] = []
  const beamWidths: number[] = []

  for (let i = 0; i < count; i++) {
    const t = count === 1 ? 0.5 : i / (count - 1)
    const tiltDeg = (t - 1) * spreadDeg + (rand() - 0.5) * (spreadDeg * 0.4)
    const s = rand()

    const material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uColor: { value: new THREE.Color(theme.shaftColor) },
        // Widths and brightnesses vary per ray, as they do in the reference.
        uIntensity: {
          value: theme.shaftIntensity * (0.35 + 0.8 * s) * (1.05 - 0.5 * Math.abs(t - 0.62)),
        },
        uTime: { value: 0 },
        uSeed: { value: s },
        uApexY: { value: 0 },
        uLength: { value: 1 },
        uHalfWidth: { value: 0.1 },
        uTilt: { value: 0 },
      },
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      side: THREE.DoubleSide,
    })

    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = false
    mesh.userData.tilt = (tiltDeg * Math.PI) / 180
    mesh.userData.intensityK = (0.35 + 0.8 * s) * (1.05 - 0.5 * Math.abs(t - 0.62))
    // Beam half-width as a fraction of the visible half-width. The measured
    // FWHM is ~1.3% of frame width, so half-width ~1% of frame width.
    mesh.userData.widthFactor = 0.012 + 0.024 * rand()
    mesh.userData.lengthFactor = 0.85 + 0.95 * s
    mesh.userData.containerFactor = 1.6 + 0.9 * s

    beamWidths.push(mesh.userData.widthFactor)
    materials.push(material)
    meshes.push(mesh)
    group.add(mesh)
  }

  const layout = (camera: THREE.PerspectiveCamera): void => {
    const halfH = Math.tan((camera.fov * Math.PI) / 360) * distance
    const halfW = halfH * camera.aspect
    const apexXWorld = apexX * halfW
    const apexYWorld = apexY * halfH
    const length = halfH * lengthFactor

    meshes.forEach((mesh, i) => {
      const container = mesh.userData.containerFactor as number
      const lf = mesh.userData.lengthFactor as number
      const shaftLength = length * lf

      // The sheared centreline drifts by tan(tilt)*shaftLength over the whole
      // shaft, so the container must be wide enough for that drift plus the
      // beam half-width — otherwise the gaussian clips at the quad edge and
      // you get a hard triangular shard artefact.
      const tilt = mesh.userData.tilt as number
      const drift = Math.abs(Math.tan(tilt)) * shaftLength
      const beamHalf = (beamWidths[i] as number) * halfW
      const needed = Math.max(halfW * 0.35, (drift + beamHalf * 4) * 2)
      const containerWidth = needed * container * 0.5

      mesh.scale.set(containerWidth, shaftLength, 1)
      mesh.position.set(apexXWorld, apexYWorld, -distance)

      const mat = materials[i]
      mat.uniforms.uApexY.value = apexYWorld
      mat.uniforms.uLength.value = shaftLength
      mat.uniforms.uHalfWidth.value = beamHalf
      mat.uniforms.uTilt.value = Math.tan(tilt)
    })
  }

  return {
    group,
    layout,
    update: (t: number) => {
      for (const material of materials) material.uniforms.uTime.value = t
    },
    setTheme: (next: AquariumTheme) => {
      meshes.forEach((mesh, i) => {
        const material = materials[i]
        ;(material.uniforms.uColor.value as THREE.Color).setHex(next.shaftColor)
        material.uniforms.uIntensity.value = next.shaftIntensity * (mesh.userData.intensityK as number)
      })
    },
    dispose: () => {
      geometry.dispose()
      for (const material of materials) material.dispose()
    },
  }
}
