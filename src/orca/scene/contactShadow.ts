import * as THREE from 'three'
import type { AquariumTheme } from './themes'
import { heightAt } from './terrain'

/*
 * A soft contact shadow on the sand under the orca.
 *
 * Nothing grounded the subject before: the orca floated over a lit floor with
 * no relationship to it, which is the single strongest reason a 3D character
 * reads as a sticker. A real shadow map would be the textbook answer, but this
 * scene has no lights to cast from and a depth pass would cost the low tier
 * real frames for one blob.
 *
 * So: a small radial-gradient disc that tracks the orca's XZ, re-beds itself on
 * the sand every frame, and softens as the orca rises. That is the entire
 * shadow model, and at this camera distance it is indistinguishable from a
 * correctly filtered soft shadow.
 */

const SEGMENTS = 10

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uColor;
uniform float uOpacity;

varying vec2 vUv;

void main() {
  vec2 d = (vUv - 0.5) * 2.0;
  float r = length(d);
  // Wide soft shoulder, no hard rim.
  float a = 1.0 - smoothstep(0.25, 1.0, r);
  a = pow(a, 1.7);
  gl_FragColor = vec4(uColor, a * uOpacity);
}
`

export interface ContactShadow {
  mesh: THREE.Mesh
  /** Track the subject's world position; the disc re-beds on the sand. */
  update: (target: THREE.Vector3) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

export function createContactShadow(theme: AquariumTheme): ContactShadow {
  const geometry = new THREE.PlaneGeometry(1, 1, SEGMENTS, SEGMENTS)
  geometry.rotateX(-Math.PI / 2)

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(theme.sandColor).multiplyScalar(0.42) },
      uOpacity: { value: 0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'contact-shadow'
  mesh.frustumCulled = false
  // Sand first, shadow on top of it.
  mesh.renderOrder = 1

  const position = geometry.getAttribute('position') as THREE.BufferAttribute
  let currentSize = 0

  return {
    mesh,
    update: (target: THREE.Vector3) => {
      const floorY = heightAt(target.x, target.z)
      const lift = Math.max(0, target.y - floorY)

      // A shadow thrown from higher up is bigger, softer and fainter. The
      // radius has to clear the orca's own silhouette or the body simply hides
      // the shadow from the default camera, which sits above the subject.
      const size = 4.6 + lift * 0.7
      const opacity = 0.44 * (1 - smoothstep(2.0, 12.0, lift))

      mesh.position.set(target.x, 0, target.z)
      mesh.scale.set(size, 1, size)
      material.uniforms.uOpacity.value = opacity

      // Re-bed on the sand. Only re-walk the vertices when the footprint
      // actually changed, which is most frames while swimming but not when the
      // orca is holding station.
      if (Math.abs(size - currentSize) > 0.01 || opacity > 0) {
        currentSize = size
        for (let i = 0; i < position.count; i++) {
          const wx = target.x + position.getX(i) * size
          const wz = target.z + position.getZ(i) * size
          position.setY(i, heightAt(wx, wz) + 0.05)
        }
        position.needsUpdate = true
      }
    },
    setTheme: (next: AquariumTheme) => {
      // Shadow colour follows the sand it falls on, pushed a little toward the
      // water so it never reads as a grey hole punched in a pastel floor.
      const color = new THREE.Color(next.sandColor).multiplyScalar(0.42)
      color.lerp(new THREE.Color(next.fogColor), 0.3)
      ;(material.uniforms.uColor.value as THREE.Color).copy(color)
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
