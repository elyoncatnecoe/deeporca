import * as THREE from 'three'

/*
 * The seabed's light rig, in one place.
 *
 * This scene is deliberately unlit: every character is a cel-shaded cartoon and
 * real PBR shading would grind that into something muddier and less graphic.
 * But "unlit" had gone too far — the sand carried one flat vertex colour, so a
 * dune had no lit side and no shadowed side and the floor read as a painted
 * plane rather than ground.
 *
 * So the seabed gets a small, honest light model instead of a real light:
 *
 *  - a key light from almost straight overhead. That is not a stylistic
 *    choice — underwater, refraction squeezes the whole sky into a cone
 *    ~48.6 degrees wide around the vertical, so sunlight genuinely does arrive
 *    from above and almost nowhere else.
 *  - a hemisphere fill standing in for scattered light coming back off the
 *    water column.
 *  - baked curvature occlusion, so creases sit back and crests come forward.
 *  - caustics resolved per fragment, scaled by how much headroom a pixel has
 *    left, which is what stops bright sand clipping to white.
 *
 * Everything here is a handful of ALU ops per vertex/fragment, so the low tier
 * pays essentially nothing for it.
 */

/**
 * Key light direction, world space, pointing *toward* the sun.
 *
 * Tilted ~22 degrees off vertical: straight up would light every dune face
 * identically and lose the relief we are trying to show, while a low sun would
 * contradict the caustics arriving from overhead.
 */
export const SUN_DIR = new THREE.Vector3(0.34, 0.9, 0.22).normalize()

/**
 * Shading baked into static props.
 *
 * Only the vertical component of the normal is used, and that is deliberate:
 * every prop is placed with a random Y rotation, so a baked directional term
 * would point the wrong way on most instances. N.y survives any Y rotation, so
 * tops stay lit and undersides stay dark no matter how the instance is spun.
 */
const PROP_AMBIENT = 0.6
const PROP_DIFFUSE = 0.52

/**
 * Multiply a geometry's `color` attribute by a baked top-light term.
 *
 * The attribute holds *relative* brightness (1.0 = the raw tint), so scaling it
 * here keeps the per-instance colour contract intact while adding relief.
 */
export function bakeTopShade(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position')
  const color = geometry.getAttribute('color')
  if (!position || !color) return

  // Some props are hand-built and never got normals; the primitives all have
  // them. Either way we need them before shading.
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals()
  const normal = geometry.getAttribute('normal')

  for (let i = 0; i < position.count; i++) {
    const up = Math.max(0, normal.getY(i))
    const shade = PROP_AMBIENT + PROP_DIFFUSE * up
    color.setXYZ(i, color.getX(i) * shade, color.getY(i) * shade, color.getZ(i) * shade)
  }
  color.needsUpdate = true
}

/**
 * Baked ambient occlusion from surface curvature.
 *
 * For each vertex, compare its height with the average of four neighbours: if
 * the neighbours sit higher, the vertex is in a dip and should be darker. That
 * is enough to make dune troughs read as troughs without a second render pass.
 *
 * Returns one value per vertex in [floor, 1].
 */
export function bakeConcavityAO(
  geometry: THREE.BufferGeometry,
  heightFn: (x: number, z: number) => number,
  radius = 2.4,
  strength = 2.6,
  floor = 0.55,
): Float32Array {
  const position = geometry.getAttribute('position')
  const ao = new Float32Array(position.count)

  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i)
    const y = position.getY(i)
    const z = position.getZ(i)
    const around =
      (heightFn(x + radius, z) +
        heightFn(x - radius, z) +
        heightFn(x, z + radius) +
        heightFn(x, z - radius)) /
      4
    // Positive when the neighbours are higher than this vertex, i.e. a dip.
    const dip = (around - y) / radius
    ao[i] = Math.min(1, Math.max(floor, 1 - Math.max(0, dip) * strength))
  }
  return ao
}

/**
 * Floor caustics: broad slow light pools with a fine glitter network riding on
 * top.
 *
 * Deliberately not the hard cellular caustic most water shaders use. At this
 * camera distance a cellular pattern reads as scratches on the sand, whereas
 * broad swells with a thin shimmer read as sunlight arriving through a moving
 * surface. `p` is in pattern units (world XZ times the theme's caustic scale).
 */
export const CAUSTIC_GLSL = /* glsl */ `
float causticField(vec2 p, float t) {
  // The whole field drifts, so the pools never look pinned to the floor.
  p += vec2(t * 0.08, t * 0.055);

  // Three slow phase-shifted swells. Each one's phase is warped by the other
  // axis, which is what makes the crests wander instead of sliding like
  // venetian blinds.
  float a = sin(p.x * 1.6 + sin(p.y * 1.25 + t * 0.5) * 1.25 + t * 0.42)
          + sin(p.y * 1.4 + sin(p.x * 1.05 - t * 0.38) * 1.15 - t * 0.31)
          + sin((p.x + p.y) * 1.05 + t * 0.55);
  a /= 3.0;

  // Soft plateau-free bands: an S-curve, then a mild power so crests stay
  // billowy while troughs fall to zero.
  float c = smoothstep(0.08, 0.92, a);
  c = pow(c, 1.7);

  // Fine glitter on its own phase, cubed so only thin filaments survive. This
  // is the shimmer the broad layer alone lacks.
  vec2 q = p * 3.1;
  float fine = sin(q.x + sin(q.y + t * 0.9) * 1.4) * sin(q.y - sin(q.x - t * 0.7) * 1.4);
  c = c * 0.85 + pow(max(0.0, fine), 3.0) * 0.55;
  return c;
}
`

/**
 * Fine sand ripples.
 *
 * Only the shading normal is perturbed — the floor mesh stays coarse — so the
 * texture costs no vertices and can never alias into jagged geometry at the
 * horizon the way real displacement would.
 *
 * Three trains at different angles rather than two perpendicular ones: a
 * checkerboard of sines reads as a woven lattice under a directional light,
 * whereas raked trains at odd angles read as sand combed by a current.
 *
 * The amplitude that reaches this function is deliberately small (see
 * `rippleStrength` in themes.ts). The gradient here is order 1, so a strength
 * of 0.1 tilts the normal by roughly 7 degrees — visible as texture, nowhere
 * near enough to look like corrugated plastic.
 */
export const RIPPLE_GLSL = /* glsl */ `
float rippleHeight(vec2 p) {
  // Rotate a copy so the second train crosses at ~25 degrees, not 90.
  vec2 q = vec2(p.x * 0.91 + p.y * 0.41, -p.x * 0.41 + p.y * 0.91);
  float a = sin(p.x * 1.35 + sin(p.y * 0.55) * 1.1);
  float b = sin(q.x * 1.9 + 1.7);
  float c = sin(q.y * 0.75 - 0.6);
  return a * 0.55 + b * 0.28 + c * 0.17;
}
`
