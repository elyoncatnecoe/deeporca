import * as THREE from 'three'
import type { AquariumTheme } from './themes'
import { SUN_DIR, CAUSTIC_GLSL, RIPPLE_GLSL } from './lighting'

/*
 * The sand's material.
 *
 * It was a MeshBasicMaterial fed baked vertex colours, which meant the floor
 * had no relationship to any light in the scene: dunes were flat, and the
 * caustics were a separate transparent plane floating 0.08 above the sand
 * (which z-fought on steep faces and could not be occluded by a dune).
 *
 * This replaces both. The ground now resolves its own key light, ambient fill,
 * baked curvature occlusion, sand ripples and caustics in one pass, so the
 * light pool genuinely wraps the dunes instead of sitting on top of them, and
 * one whole draw call disappears.
 *
 * Everything is hand-written GLSL rather than an onBeforeCompile patch on
 * MeshBasicMaterial: patching three's chunk soup for this much custom shading
 * is more fragile than owning the shader outright, and this material has no
 * maps, no skinning and no instancing to inherit.
 *
 * It is also the one *transparent* surface in the scene, for a reason that has
 * nothing to do with glass: the far sand has to disappear into the water rather
 * than stop at it. See the fade at the end of FRAG.
 */

const VERT = /* glsl */ `
attribute float aAO;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vAO;
varying float vFogDepth;

void main() {
  vColor = color;
  vNormalW = normalize(mat3(modelMatrix) * normal);

  vec4 world = modelMatrix * vec4(position, 1.0);
  vWorld = world.xyz;
  vAO = aAO;

  vec4 mv = viewMatrix * world;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
precision highp float;

uniform vec3 uLightDir;
uniform vec3 uLightColor;
uniform float uAmbient;
uniform float uDiffuse;

uniform vec3 uCausticColor;
uniform float uCausticIntensity;
uniform float uCausticScale;
uniform float uCausticRadius;
uniform vec2 uCausticCenter;
uniform float uTime;

uniform float uRipple;
uniform float uAOStrength;

uniform vec3 uFogColor;
uniform float uFogDensity;

varying vec3 vColor;
varying vec3 vNormalW;
varying vec3 vWorld;
varying float vAO;
varying float vFogDepth;

${CAUSTIC_GLSL}
${RIPPLE_GLSL}

void main() {
  vec3 N = normalize(vNormalW);

  // Sand ripples. Finite-difference the analytic ripple height and fold the
  // result into the shading normal, so the floor picks up fine texture that
  // the 90x90 mesh could never carry as real geometry.
  vec2 rp = vWorld.xz * 1.35;
  float e = 0.14;
  float h0 = rippleHeight(rp);
  float hx = rippleHeight(rp + vec2(e, 0.0));
  float hz = rippleHeight(rp + vec2(0.0, e));
  vec3 rippleN = normalize(vec3((h0 - hx) / e * uRipple, 1.0, (h0 - hz) / e * uRipple));
  N = normalize(N + rippleN - vec3(0.0, 1.0, 0.0));

  float ndl = max(dot(N, uLightDir), 0.0);
  float ao = mix(1.0, vAO, uAOStrength);

  // Key light + hemisphere fill, then the baked crease occlusion.
  vec3 base = vColor * (uAmbient + uDiffuse * ndl) * ao;

  // Caustics, scaled by how much headroom the pixel has left. Bright sand gets
  // a shimmer, dark sand gets the full pool, and nothing can clip to white.
  // This is what the old build faked by switching the overlay between additive
  // and normal blending per theme; now there is one blend and it cannot blow
  // out, which also means the theme switch no longer recompiles a shader.
  vec2 d = vWorld.xz - uCausticCenter;
  float pool = 1.0 - smoothstep(uCausticRadius * 0.5, uCausticRadius, length(d));
  float ca = causticField(d * uCausticScale, uTime) * pool;
  float lum = dot(base, vec3(0.299, 0.587, 0.114));
  float headroom = clamp(1.0 - lum, 0.0, 1.0);
  base += uCausticColor * ca * uCausticIntensity * headroom;

  // Crests catch a little direct light too, otherwise the pattern reads as a
  // decal pasted over the shading rather than light lying on the ground.
  base += uLightColor * ca * 0.06 * ndl;

  // FogExp2 by hand: a raw ShaderMaterial does not inherit scene.fog, and
  // without it the sand's far edge would pop instead of dissolving.
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  base = mix(base, uFogColor, clamp(fogFactor, 0.0, 1.0));

  // ...but tinting toward the fog colour is not enough to make the sand meet
  // the water. The water column behind it is a *different* colour — brighter
  // than uFogColor, and lifted again by the grade/bloom pass, which a
  // hand-written fog term never receives. So a fully fogged sand pixel lands
  // noticeably darker than the water right above it, and the horizon reads as
  // a ruled line across the frame. No fog colour or density fixes that: the
  // two are drawn by different pipelines.
  //
  // Fading the alpha out instead lets the real water show through, so the sand
  // genuinely dissolves rather than ending. Keyed to fogFactor rather than to
  // raw distance so the band moves with each theme's density: the sand stays
  // solid until the fog has mostly swallowed it, then hands over.
  //
  // 0.98 rather than 1.0 because the plane's rim (210 units) is reached while
  // the fog is at ~0.97 — ending the ramp at 0.98 leaves the rim at 0.2% alpha,
  // i.e. a step far below one 8-bit level, so the square can never reappear
  // even if a future theme fog gets thinner.
  float fade = 1.0 - smoothstep(0.70, 0.98, clamp(fogFactor, 0.0, 1.0));

  gl_FragColor = vec4(base, fade);
}
`

export interface SeafloorMaterial {
  material: THREE.ShaderMaterial
  setTheme: (theme: AquariumTheme) => void
  setFog: (color: number, density: number) => void
  update: (t: number) => void
  dispose: () => void
}

export function createSeafloorMaterial(theme: AquariumTheme): SeafloorMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    // `color` only exists as an attribute when this is set; the ground's whole
    // base tint lives in it.
    vertexColors: true,
    // The far field fades to alpha 0 (see FRAG) so the sand can hand over to
    // the water column, which is drawn behind it. depthWrite stays ON: the
    // ground is the backmost surface in the scene and the god rays rely on its
    // depth to stay off the sand.
    transparent: true,
    depthWrite: true,
    uniforms: {
      uLightDir: { value: SUN_DIR.clone() },
      uLightColor: { value: new THREE.Color(theme.sunColor) },
      uAmbient: { value: theme.ambient },
      uDiffuse: { value: theme.diffuse },

      uCausticColor: { value: new THREE.Color(theme.causticColor) },
      uCausticIntensity: { value: theme.causticIntensity },
      uCausticScale: { value: theme.causticScale },
      uCausticRadius: { value: theme.causticRadius },
      // The basin the camera frames sits on the origin; the pool is centred
      // there so it lights the play area rather than the empty outer sand.
      uCausticCenter: { value: new THREE.Vector2(0, 0) },
      uTime: { value: 0 },

      uRipple: { value: theme.rippleStrength },
      uAOStrength: { value: theme.aoStrength },

      uFogColor: { value: new THREE.Color(theme.fogColor) },
      uFogDensity: { value: theme.fogDensity },
    },
  })

  return {
    material,
    setTheme: (next: AquariumTheme) => {
      const u = material.uniforms
      ;(u.uLightColor.value as THREE.Color).setHex(next.sunColor)
      u.uAmbient.value = next.ambient
      u.uDiffuse.value = next.diffuse
      ;(u.uCausticColor.value as THREE.Color).setHex(next.causticColor)
      u.uCausticIntensity.value = next.causticIntensity
      u.uCausticScale.value = next.causticScale
      u.uCausticRadius.value = next.causticRadius
      u.uRipple.value = next.rippleStrength
      u.uAOStrength.value = next.aoStrength
    },
    setFog: (color: number, density: number) => {
      ;(material.uniforms.uFogColor.value as THREE.Color).setHex(color)
      material.uniforms.uFogDensity.value = density
    },
    update: (t: number) => {
      material.uniforms.uTime.value = t
    },
    dispose: () => material.dispose(),
  }
}
