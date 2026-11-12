export interface Point2 {
  x: number
  y: number
}

const PATH_TOKEN_RE = /[MLCZ]|[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi

function bezier(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const mt = 1 - t
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3
}

/** Parse an SVG path string (only M/L/C commands) into sampled points. */
export function sampleSvgPath(d: string, stepsPerSegment = 40, close = true): Point2[] {
  const toks = d.match(PATH_TOKEN_RE)
  if (!toks) return []
  let i = 0
  let x = 0
  let y = 0
  const pts: Point2[] = []
  const num = () => parseFloat(toks[i++])
  while (i < toks.length) {
    const c = toks[i++].toUpperCase()
    if (c === 'M' || c === 'L') {
      x = num()
      y = num()
      pts.push({ x, y })
    } else if (c === 'C') {
      const c1x = num()
      const c1y = num()
      const c2x = num()
      const c2y = num()
      const ex = num()
      const ey = num()
      for (let s = 1; s <= stepsPerSegment; s++) {
        const t = s / stepsPerSegment
        pts.push({ x: bezier(t, x, c1x, c2x, ex), y: bezier(t, y, c1y, c2y, ey) })
      }
      x = ex
      y = ey
    }
  }
  if (close && pts.length > 0) {
    const first = pts[0]
    const last = pts[pts.length - 1]
    if (first.x !== last.x || first.y !== last.y) pts.push({ x: first.x, y: first.y })
  }
  return pts
}

/** Dense arc-length resampling of the body outline (closed Catmull-Rom). */
export function sampleBodyPathDense(d: string, stepsPerSegment = 50, totalResample = 800): Point2[] {
  return catmullRomResample(sampleSvgPath(d, stepsPerSegment, false), totalResample, true)
}

export function catmullRomResample(points: Point2[], targetCount: number, closed = true): Point2[] {
  if (points.length < 2) return points
  const n = points.length
  const src = closed ? [...points, points[0], points[1], points[2]] : points
  const len = closed ? n : n - 1
  const arcLen = [0]
  for (let i = 1; i < src.length; i++) {
    const dx = src[i].x - src[i - 1].x
    const dy = src[i].y - src[i - 1].y
    arcLen.push(arcLen[i - 1] + Math.sqrt(dx * dx + dy * dy))
  }
  const totalLen = arcLen[arcLen.length - 1]
  const result: Point2[] = []
  for (let k = 0; k < targetCount; k++) {
    const t = (k / targetCount) * totalLen
    let seg = 0
    while (seg < arcLen.length - 2 && arcLen[seg + 1] < t) seg++
    const segStart = arcLen[seg]
    const segEnd = arcLen[seg + 1]
    const localT = segEnd - segStart > 0 ? (t - segStart) / (segEnd - segStart) : 0
    const p0 = src[Math.max(0, seg - 1)]
    const p1 = src[seg]
    const p2 = src[seg + 1]
    const p3 = src[Math.min(src.length - 1, seg + 2)]
    const tt = localT
    const tt2 = tt * tt
    const tt3 = tt2 * tt
    const x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * tt + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * tt2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * tt3)
    const y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * tt + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * tt2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * tt3)
    result.push({ x, y })
  }
  return result
}
