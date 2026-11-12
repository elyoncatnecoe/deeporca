import * as THREE from 'three'

/*
 * 2D-cartoon shading for an otherwise unlit, flat-colour scene.
 *
 * The project deliberately uses MeshBasicMaterial everywhere (no lights), which
 * keeps the flat paper-cut palette but makes a box-built character read as one
 * solid silhouette — you cannot tell which faces point where.
 *
 * Rather than introduce real lights (which would flatten the whole aquarium's
 * look), the shading is *baked into vertex colours*: each triangle gets a single
 * tone derived from its facing direction, quantised into a few steps. That is
 * exactly what a 2D cartoon does — flat fill per facet, no gradients — and it
 * costs nothing per frame.
 *
 * The tone multiplies the material colour, so this composes with existing
 * colours: the orca's skinned SDF shader and the companion's palette both keep
 * working, they just gain readable form.
 */

export interface CelShadingOptions {
  /** The light comes from up, in front and slightly to one side. */
  lightDir?: THREE.Vector3
  /** How much the darkest faces are darkened (0 = no shading, 1 = black). */
  strength?: number
  /** Number of discrete tones. 2-3 reads as cartoon; more looks like CG. */
  steps?: number
  /**
   * Base colour baked into the vertex colours. Leave white when the material
   * already carries the colour; set it when the material is white but the part
   * should be a specific hue (the companion's dark eyes, for instance).
   */
  baseColor?: THREE.ColorRepresentation
}

const DEFAULT_LIGHT = new THREE.Vector3(0.45, 0.78, 0.44).normalize()

/**
 * Compute a per-vertex "shade" factor in [1 - strength, 1] from the geometry's
 * face normals and bake it into a `color` attribute.
 *
 * Geometry is de-indexed first so every triangle owns its three vertices. That
 * is what makes the result read as faceted cartoon shading instead of a smooth
 * gradient across a shared vertex.
 */
export function bakeCelShading(geometry: THREE.BufferGeometry, options: CelShadingOptions = {}): THREE.BufferGeometry {
  const light = (options.lightDir ?? DEFAULT_LIGHT).clone().normalize()
  const strength = options.strength ?? 0.42
  const steps = Math.max(2, options.steps ?? 3)
  const base = new THREE.Color(options.baseColor ?? 0xffffff)
  // NOTE: deliberately NOT converted to linear space. Vertex colours multiply
  // the material colour, and `setHex` already leaves the material colour in
  // sRGB terms here (legacy mode). Converting this side would square the value
  // and darken the whole character — the companion turned dark red when it did.

  const source = geometry.index ? geometry.toNonIndexed() : geometry
  const position = source.getAttribute('position') as THREE.BufferAttribute
  const count = position.count
  const colors = new Float32Array(count * 3)

  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const edge1 = new THREE.Vector3()
  const edge2 = new THREE.Vector3()
  const normal = new THREE.Vector3()

  for (let i = 0; i < count; i += 3) {
    a.fromBufferAttribute(position, i)
    b.fromBufferAttribute(position, i + 1)
    c.fromBufferAttribute(position, i + 2)
    edge1.subVectors(b, a)
    edge2.subVectors(c, a)
    normal.crossVectors(edge1, edge2)
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0)
    else normal.normalize()

    // Facing term in [-1, 1] -> [0, 1], then quantise into bands.
    const lambert = (normal.dot(light) + 1) * 0.5
    const band = Math.min(steps - 1, Math.floor(lambert * steps)) / (steps - 1)
    const shade = 1 - strength * (1 - band)

    for (let k = 0; k < 3; k++) {
      const v = (i + k) * 3
      colors[v] = base.r * shade
      colors[v + 1] = base.g * shade
      colors[v + 2] = base.b * shade
    }
  }

  source.setAttribute('color', new THREE.BufferAttribute(colors, 3))
  if (source !== geometry) {
    // Adopt the de-indexed attributes on the original object so callers keep
    // using the same geometry reference.
    geometry.setIndex(null)
    for (const name of Object.keys(source.attributes)) {
      geometry.setAttribute(name, source.attributes[name])
    }
    return geometry
  }
  return source
}

/** Turn on vertex colours on a material (no shader recompile hazard if set once). */
export function enableVertexColors(material: THREE.Material): THREE.Material {
  ;(material as THREE.MeshBasicMaterial).vertexColors = true
  return material
}

/*
 * Inverted-hull outline built as a ShaderMaterial.
 *
 * Why not reuse MeshBasicMaterial + the `createOutline` hull above? Two reasons:
 *  1. `createOutline` inflates by a uniform *scale*, which only looks right when
 *     the geometry is centred on its local origin (true for Clawd's boxes, not
 *     for the orca's fins and body, which sit far from the origin).
 *  2. `MeshBasicMaterial` only includes the normal chunks under
 *     USE_ENVMAP/USE_SKINNING, so a normal-push expansion injected via
 *     onBeforeCompile has no `objectNormal` to read. A standalone ShaderMaterial
 *     declares the `normal` attribute itself, so the expansion is always valid.
 *
 * The shell is pushed along the vertex normal by a fixed width, drawn with
 * front faces culled, so only a thin rim shows — the classic 2D-cartoon ink
 * line. Pass `swim` for the orca body so the rim replays the same per-frame
 * wave as the body and stays attached (a static hull would detach as it swims).
 */
export interface OutlineSwim {
  uMin: number
  uMax: number
  uniforms: {
    uTime: THREE.IUniform
    uSwimAmp: THREE.IUniform
    uSwimFreq: THREE.IUniform
    uSwimSpeed: THREE.IUniform
  }
}

export function createOutlineShell(
  geometry: THREE.BufferGeometry,
  width = 0.05,
  color: THREE.ColorRepresentation = 0x16202e,
  swim?: OutlineSwim,
): THREE.Mesh {
  const uniforms: Record<string, THREE.IUniform> = {
    uOutlineWidth: { value: width },
    uColor: { value: new THREE.Color(color) },
  }

  let vertexShader = `
    uniform float uOutlineWidth;
    void main() {
      vec3 expanded = position + normal * uOutlineWidth;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(expanded, 1.0);
    }`

  if (swim) {
    uniforms.uTime = swim.uniforms.uTime
    uniforms.uSwimAmp = swim.uniforms.uSwimAmp
    uniforms.uSwimFreq = swim.uniforms.uSwimFreq
    uniforms.uSwimSpeed = swim.uniforms.uSwimSpeed
    uniforms.uMin = { value: swim.uMin }
    uniforms.uMax = { value: swim.uMax }
    vertexShader = `
    uniform float uOutlineWidth, uTime, uSwimAmp, uSwimFreq, uSwimSpeed, uMin, uMax;
    void main() {
      vec3 expanded = position;
      float along = (position.x - uMin) / max(uMax - uMin, 1e-4);
      float env = smoothstep(0.0, 0.55, along) * (1.0 - smoothstep(0.72, 1.0, along));
      float wave = sin(position.x * uSwimFreq - uTime * uSwimSpeed) * uSwimAmp;
      expanded.z += wave * env;
      expanded.y += wave * 0.28 * env;
      expanded += normal * uOutlineWidth;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(expanded, 1.0);
    }`
  }

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader: `
      uniform vec3 uColor;
      void main() { gl_FragColor = vec4(uColor, 1.0); }`,
    side: THREE.BackSide,
  })

  const outline = new THREE.Mesh(geometry, material)
  outline.renderOrder = -1
  outline.userData.isOutline = true
  return outline
}

/*
 * Per-fragment soft shading for a flat-colour (MeshBasicMaterial) mesh.
 *
 * Earlier builds rebuilt the normal from screen-space derivatives of the model
 * position, which yields the FLAT normal of every triangle; quantising that
 * into bands made the shading follow the mesh's triangle facets — visible as
 * blocky mosaic patches on the orca. The fix is two-fold:
 *   1. Read the geometry's SMOOTH vertex normal instead (three.js always
 *      declares `attribute vec3 normal;` in the vertex prefix, even for
 *      MeshBasicMaterial that never uses it), so the shading interpolates
 *      across faces.
 *   2. Replace the hard band quantisation with a smoothstep ramp, so light
 *      wraps softly instead of stepping.
 * `gl_FrontFacing` flips the normal on back faces so a DoubleSide mesh shades
 * consistently from the same model-space light. Outlines are untouched.
 */
export interface CelShadeOptions {
  /** Light direction in model space (matches bakeCelShading default). */
  lightDir?: [number, number, number]
  /** How much the darkest areas are darkened (0 = none, 1 = black). */
  strength?: number
  /**
   * Width of the soft transition in lambert space. Higher = softer, 0 = the
   * old hard-band look. Kept as an option so the character can be tuned
   * without relearning the shader.
   */
  softness?: number
}

export function applySoftShade(
  material: THREE.MeshBasicMaterial,
  options: CelShadeOptions = {},
): THREE.MeshBasicMaterial {
  const [lx, ly, lz] = options.lightDir ?? [0.45, 0.78, 0.44]
  const strength = options.strength ?? 0.42
  const softness = options.softness ?? 0.5

  material.onBeforeCompile = (shader) => {
    const uniforms = (shader as unknown as { uniforms: Record<string, THREE.IUniform> }).uniforms
    uniforms.uCelLight = { value: new THREE.Vector3(lx, ly, lz).normalize() }
    uniforms.uCelStrength = { value: strength }
    uniforms.uCelSoft = { value: softness }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vCelNrm;')
      // `normal` is declared by the program prefix even for MeshBasicMaterial;
      // it is the SMOOTH vertex normal, which is exactly what kills the mosaic.
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCelNrm = normal;')

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec3 vCelNrm;\nuniform vec3 uCelLight;\nuniform float uCelStrength;\nuniform float uCelSoft;',
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
      {
        vec3 n = normalize(vCelNrm);
        if (!gl_FrontFacing) n = -n;
        float lambert = dot(n, normalize(uCelLight)) * 0.5 + 0.5;
        float ramp = smoothstep(0.5 - uCelSoft * 0.5, 0.5 + uCelSoft * 0.5, lambert);
        float shade = 1.0 - uCelStrength * (1.0 - ramp);
        diffuseColor.rgb *= shade;
      }`,
      )
  }
  return material
}

/**
 * Inverted-hull outline: a slightly inflated copy of the mesh rendered with
 * front faces culled, so only a rim shows. This is the classic cartoon outline
 * and it is what makes separate parts read as separate shapes.
 *
 * Deliberately not applied to the orca: its body is deformed every frame by a
 * swim shader, so a static inflated shell would visibly detach from it.
 */
export function createOutline(
  geometry: THREE.BufferGeometry,
  scale = 1.06,
  color: THREE.ColorRepresentation = 0x1a2230,
): THREE.Mesh {
  const material = new THREE.MeshBasicMaterial({
    color,
    side: THREE.BackSide,
  })
  const outline = new THREE.Mesh(geometry, material)
  outline.scale.setScalar(scale)
  outline.renderOrder = -1
  // Flagged so re-baking a colour skips the rim; it has no shaded geometry.
  outline.userData.isOutline = true
  return outline
}
