import * as THREE from 'three'
import type { AquariumTheme } from './themes'

/*
 * The underside of the water surface.
 *
 * This is the cue the scene was missing: without a ceiling overhead the water
 * column is just a gradient, and the eye reads the whole thing as fog rather
 * than as being underwater. Looking up from below, the surface does two very
 * specific things, and both are worth keeping because they are what makes a
 * shot read as "submerged" rather than "blue room":
 *
 *  - Snell's window. Refraction squeezes the entire sky into a cone about 48.6
 *    degrees wide around the vertical, so overhead there is a bright, slightly
 *    soft-edged disc of sky.
 *  - Total internal reflection everywhere else. Outside that cone the surface
 *    stops transmitting and becomes a mirror of the dark water below, so the
 *    ceiling darkens sharply away from the vertical.
 *
 * Both are theme-tinted, and the whole sheet fades out with distance so it
 * dissolves into the column near the horizon instead of ending on a line.
 *
 * The reference page drives a similar plane from a plain Fresnel mix. This one
 * separates the window from the reflection and adds the ripple shading, which
 * is what gives the ceiling its slow movement.
 */

/** Height of the surface above the basin. Well clear of the orca's swim band. */
const SURFACE_Y = 15

const VERT = /* glsl */ `
varying vec3 vWorld;
varying float vFogDepth;

void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform float uTime;
uniform vec3 uCamPos;
uniform float uSurfaceY;
uniform vec3 uTransmit;
uniform vec3 uReflect;
uniform float uAlpha;
uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vWorld;
varying float vFogDepth;

// Crossing swells at deliberately incommensurate frequencies. A handful of
// tidy ratios (1:2, 1:1.5) sum into visible strata near the horizon, where
// perspective compresses a whole wavelength into a few pixels; frequencies
// that share no common period instead read as shimmer.
float waveHeight(vec2 p, float t) {
  float h = 0.0;
  h += sin(p.x * 0.72 + t * 0.85) * 0.50;
  h += sin(p.y * 0.94 - t * 0.72) * 0.50;
  h += sin((p.x + p.y) * 0.51 + t * 1.05) * 0.34;
  h += sin((p.x - p.y) * 1.12 - t * 1.40) * 0.14;
  h += sin(p.x * 2.30 + p.y * 1.70 + t * 1.90) * 0.09;
  h += sin(p.y * 3.10 - p.x * 1.30 - t * 2.30) * 0.05;
  return h;
}

void main() {
  vec2 p = vWorld.xz;
  float e = 0.35;
  float h0 = waveHeight(p, uTime);
  float hx = waveHeight(p + vec2(e, 0.0), uTime);
  float hz = waveHeight(p + vec2(0.0, e), uTime);

  // Normal pointing DOWN, into the water, because we are underneath it.
  // The tilt is kept deliberately shallow: at a grazing view a strong normal
  // swings the facing term across its whole range over a few pixels, which
  // turns the ceiling into hard stripes. Water seen from below is a soft
  // sheet, so the shading has to stay soft too.
  vec3 N = normalize(vec3((hx - h0) / e * 0.08, -1.0, (hz - h0) / e * 0.08));
  vec3 V = normalize(uCamPos - vWorld);
  // 1.0 when the camera sits directly below this patch, 0.0 at grazing.
  float facing = clamp(dot(N, V), 0.0, 1.0);

  // Total internal reflection: the steeper the view, the more the surface
  // mirrors the deep instead of letting the sky through.
  float reflectivity = pow(1.0 - facing, 3.0);
  vec3 col = mix(uTransmit, uReflect, reflectivity);

  // Snell's window: the bright disc, with a soft rim rather than a hard circle.
  float window = smoothstep(0.56, 0.74, facing);
  col = mix(col, uTransmit, window * 0.5);
  col += uTransmit * pow(facing, 10.0) * 0.4;

  // Ripple shading, so the ceiling breathes instead of sitting still.
  float ripple = sin(p.x * 2.1 + uTime * 1.1) * sin(p.y * 1.9 - uTime * 0.9);
  col += vec3(0.02) * ripple * facing;

  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // Dissolve toward the horizon.
  float dist = length(vWorld.xz - uCamPos.xz);
  float fade = 1.0 - smoothstep(45.0, 190.0, dist);

  // The orbit range lets the player climb above the waterline. From up there
  // this plane would sit between the lens and the whole scene and wash it out,
  // so it retires as the camera approaches the surface. Cheap, and it means the
  // ceiling never has to be reconciled with an above-water view.
  fade *= 1.0 - smoothstep(0.0, 6.0, uCamPos.y - uSurfaceY);

  gl_FragColor = vec4(col, uAlpha * fade);
}
`

export interface WaterSurface {
  mesh: THREE.Mesh
  update: (t: number, camera: THREE.Camera) => void
  setTheme: (theme: AquariumTheme) => void
  setFog: (color: number, density: number) => void
  dispose: () => void
}

export function createWaterSurface(theme: AquariumTheme): WaterSurface {
  const geometry = new THREE.PlaneGeometry(420, 420, 1, 1)
  geometry.rotateX(Math.PI / 2)

  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uTime: { value: 0 },
      uCamPos: { value: new THREE.Vector3() },
      uSurfaceY: { value: SURFACE_Y },
      uTransmit: { value: new THREE.Color(theme.surfaceTransmit) },
      uReflect: { value: new THREE.Color(theme.surfaceReflect) },
      uAlpha: { value: theme.surfaceAlpha },
      uFogColor: { value: new THREE.Color(theme.fogColor) },
      uFogDensity: { value: theme.fogDensity },
    },
    transparent: true,
    depthWrite: false,
    // Depth-tested so the orca and the reef occlude the ceiling when they
    // rise in front of it.
    depthTest: true,
    side: THREE.DoubleSide,
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.name = 'water-surface'
  mesh.position.y = SURFACE_Y
  mesh.frustumCulled = false
  // After the water column (-100), before the god-ray fan (-5): the fan is
  // closer to the lens and should read as being in front of the ceiling.
  mesh.renderOrder = -10

  return {
    mesh,
    update: (t: number, camera: THREE.Camera) => {
      material.uniforms.uTime.value = t
      ;(material.uniforms.uCamPos.value as THREE.Vector3).copy(camera.position)
    },
    setTheme: (next: AquariumTheme) => {
      const u = material.uniforms
      ;(u.uTransmit.value as THREE.Color).setHex(next.surfaceTransmit)
      ;(u.uReflect.value as THREE.Color).setHex(next.surfaceReflect)
      u.uAlpha.value = next.surfaceAlpha
    },
    setFog: (color: number, density: number) => {
      ;(material.uniforms.uFogColor.value as THREE.Color).setHex(color)
      material.uniforms.uFogDensity.value = density
    },
    dispose: () => {
      geometry.dispose()
      material.dispose()
    },
  }
}
