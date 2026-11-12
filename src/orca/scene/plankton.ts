import * as THREE from 'three'
import type { AquariumTheme } from './themes'

/*
 * Marine snow (海雪), AbyssRium style: ~1000 faint motes, mostly 1-3 px,
 * additive, sinking slowly with lateral sway — one of the strongest cues
 * that the volume is water and not empty space.
 *
 * The point size MUST be clamped and this is not cosmetic: particles pass
 * close to the near plane, and the unclamped perspective term produces
 * sprites hundreds of pixels across which, combined with additive blending,
 * wash the entire lower frame into a flat teal (the old "白斑/糊脸大光点"
 * bug). Near + far fade keep the field readable at every camera standoff —
 * the camera can retreat to ~60 units on portrait phones, so the far fade
 * has to sit well past the subject, not at the old tank-edge 26 units.
 */

const VERT = /* glsl */ `
attribute float aSize;
attribute float aPhase;
attribute float aTier;

uniform float uTime;
uniform float uPixelRatio;

varying float vTier;
varying float vTwinkle;
varying float vFade;

void main() {
  vec3 p = position;

  // Slow settle + lateral sway. Marine snow sinks; it does not rise.
  float drift = mod(uTime * (0.05 + 0.09 * aTier) + aPhase * 12.0, 1.0);
  p.y -= drift * 26.0;
  p.x += sin(uTime * 0.19 + aPhase * 9.0) * 0.55;
  p.z += cos(uTime * 0.14 + aPhase * 7.0) * 0.35;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;

  vTier = aTier;
  // Gentle three-step twinkle.
  float t = fract(uTime * 0.31 + aPhase * 5.0);
  vTwinkle = 0.62 + 0.38 * smoothstep(0.0, 0.28, t) * (1.0 - smoothstep(0.72, 1.0, t));

  float size = mix(1.0, 2.2, aTier) * aSize;
  float perspective = 130.0 / max(0.1, -mv.z);
  gl_PointSize = clamp(size * uPixelRatio * perspective, 1.0, 5.0);

  // Fade motes out near the camera (no face-hugging blobs) and far away
  // (they dissolve into the fog instead of sparkling over the abyss).
  float d = max(0.1, -mv.z);
  vFade = smoothstep(2.0, 6.0, d) * (1.0 - smoothstep(46.0, 68.0, d));
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uFineColor;
uniform vec3 uGlowColor;

varying float vTier;
varying float vTwinkle;
varying float vFade;

void main() {
  vec2 c = gl_PointCoord - 0.5;
  float r2 = dot(c, c);
  if (r2 > 0.25) discard;

  // Soft round mote.
  float falloff = 1.0 - r2 * 4.0;
  falloff *= falloff;

  vec3 col = mix(uFineColor, uGlowColor, vTier);
  float a = falloff * vTwinkle * vFade * 0.6;
  if (a < 0.004) discard;
  gl_FragColor = vec4(col * a, a);
}
`

export interface PlanktonField {
  points: THREE.Points
  update: (t: number, pixelRatio: number) => void
  setTheme: (theme: AquariumTheme) => void
  dispose: () => void
}

const FIELD_HALF_W = 24
const FIELD_HALF_D = 16
const FIELD_MIN_Y = -2
const FIELD_MAX_Y = 14

export function createPlankton(theme: AquariumTheme, count: number): PlanktonField {
  const positions = new Float32Array(count * 3)
  const phases = new Float32Array(count)
  const sizes = new Float32Array(count)
  const tiers = new Float32Array(count)

  for (let i = 0; i < count; i++) {
    positions[i * 3] = (Math.random() - 0.5) * FIELD_HALF_W * 2
    positions[i * 3 + 1] = FIELD_MIN_Y + Math.random() * (FIELD_MAX_Y - FIELD_MIN_Y)
    positions[i * 3 + 2] = (Math.random() - 0.5) * FIELD_HALF_D * 2
    phases[i] = Math.random() * Math.PI * 2
    // ~82% fine dust, ~18% brighter cyan glow tier.
    const tier = Math.random() < 0.82 ? 0 : 1
    tiers[i] = tier
    sizes[i] = tier === 0 ? 0.5 + Math.random() * 0.9 : 0.9 + Math.random() * 1.3
  }

  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1))
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1))
  geometry.setAttribute('aTier', new THREE.BufferAttribute(tiers, 1))

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      // Placeholder only — `environment` overwrites this every frame with the
      // resolved tier's cap. Kept at 1.5 so no frame can ever run above the
      // drawing-buffer budget.
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 1.5) },
      uFineColor: { value: new THREE.Color(theme.planktonColor1) },
      uGlowColor: { value: new THREE.Color(theme.planktonColor2) },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  })

  const points = new THREE.Points(geometry, material)
  points.name = 'marine-snow'
  points.frustumCulled = false

  return {
    points,
    update: (t: number, pixelRatio: number) => {
      material.uniforms.uTime.value = t
      // Points are sized in physical pixels, so the shader has to know the
      // real renderer ratio rather than assuming devicePixelRatio.
      material.uniforms.uPixelRatio.value = pixelRatio
    },
    setTheme: (next: AquariumTheme) => {
      material.uniforms.uFineColor.value.setHex(next.planktonColor1)
      material.uniforms.uGlowColor.value.setHex(next.planktonColor2)
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
