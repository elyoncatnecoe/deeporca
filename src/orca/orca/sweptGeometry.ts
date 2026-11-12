import * as THREE from 'three'
import type { Point2 } from './pathSampler'

export interface SweptData {
  xs: number[]
  mid: number[]
  rad: number[]
}

function smoothGaussian(arr: number[], sigma: number, iterations: number): number[] {
  const len = arr.length
  const half = Math.ceil(sigma * 3)
  const kernel: number[] = []
  let sumK = 0
  for (let j = -half; j <= half; j++) {
    const val = Math.exp(-0.5 * (j / sigma) * (j / sigma))
    kernel.push(val)
    sumK += val
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sumK

  const work = [...arr]
  for (let iter = 0; iter < iterations; iter++) {
    const temp = [...work]
    for (let i = 0; i < len; i++) {
      let sum = 0
      for (let j = -half; j <= half; j++) {
        const idx = Math.min(len - 1, Math.max(0, i + j))
        sum += temp[idx] * kernel[j + half]
      }
      work[i] = sum
    }
  }
  return work
}

function removeDents(arr: number[], window = 10): number[] {
  const res = [...arr]
  for (let i = 1; i < res.length - 1; i++) {
    const left = Math.max(0, i - window)
    const right = Math.min(res.length - 1, i + window)
    let minNeighbor = Infinity
    for (let j = left; j <= right; j++) {
      if (j === i) continue
      if (res[j] < minNeighbor) minNeighbor = res[j]
    }
    if (res[i] < minNeighbor) res[i] = minNeighbor
  }
  return res
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)))
  return t * t * (3 - 2 * t)
}

/**
 * 1:1 port of orca.html's buildSwept(): revolve the body outline into a closed
 * swept BufferGeometry and keep the (unscaled) profile in userData.swept.
 */
export function buildSweptGeometry(poly: Point2[], config: {
  SWEPT_SLICES: number
  SWEPT_RINGS: number
}): { geometry: THREE.BufferGeometry; swept: SweptData } {
  const nSlices = config.SWEPT_SLICES
  const nRings = config.SWEPT_RINGS

  let minX = 1e9
  let maxX = -1e9
  let polyMinY = Infinity
  let polyMaxY = -Infinity
  for (const p of poly) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x)
    polyMinY = Math.min(polyMinY, p.y)
    polyMaxY = Math.max(polyMaxY, p.y)
  }
  const totalX = maxX - minX
  const step = totalX / nSlices
  const polyHeight = polyMaxY - polyMinY
  const tailLiftAmount = 0.1 * polyHeight
  const xs: number[] = []
  const midRaw: number[] = []
  const radRaw: number[] = []
  let lastM = 0

  for (let s = 0; s <= nSlices; s++) {
    const x = minX + s * step
    let top = -Infinity
    let bot = Infinity
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i]
      const b = poly[(i + 1) % poly.length]
      if (Math.abs(a.x - b.x) < 1e-9) continue
      if ((a.x - x) * (b.x - x) > 0) continue
      const y = a.y + (x - a.x) / (b.x - a.x) * (b.y - a.y)
      if (y > top) top = y
      if (y < bot) bot = y
    }
    let m: number
    let r: number
    if (Number.isFinite(top) && Number.isFinite(bot)) {
      m = (top + bot) / 2
      r = (top - bot) / 2
      if (r < 0) r = 0
      lastM = m
    } else {
      m = lastM
      r = 0
    }
    xs.push(x)
    midRaw.push(m)
    radRaw.push(Math.max(0, r))
  }

  let radSmooth = smoothGaussian(radRaw, 3.0, 2)
  let midSmooth = smoothGaussian(midRaw, 2.0, 1)
  radSmooth = removeDents(radSmooth, 8)
  radSmooth = smoothGaussian(radSmooth, 1.5, 1)

  let maxIdx = 0
  let maxVal = 0
  for (let i = 0; i < radSmooth.length; i++) {
    if (radSmooth[i] > maxVal) {
      maxVal = radSmooth[i]
      maxIdx = i
    }
  }
  for (let i = maxIdx - 1; i >= 0; i--) {
    if (radSmooth[i] > radSmooth[i + 1]) radSmooth[i] = radSmooth[i + 1]
  }
  for (let i = maxIdx + 1; i < radSmooth.length; i++) {
    if (radSmooth[i] > radSmooth[i - 1]) radSmooth[i] = radSmooth[i - 1]
  }

  const tailRatio = 0.14
  const headRatio = 0.11
  const tailLen = totalX * tailRatio
  const headLen = totalX * headRatio
  const tailEnd = xs.findIndex(x => x >= minX + tailLen)
  if (tailEnd > 2) {
    const rBody = radSmooth[tailEnd]
    for (let i = 0; i <= tailEnd; i++) {
      const t = (xs[i] - minX) / tailLen
      const ease = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
      radSmooth[i] = Math.min(radSmooth[i], rBody * ease)
    }
  }
  const headStart = xs.findIndex(x => x >= maxX - headLen)
  if (headStart < nSlices - 2) {
    const rBody = radSmooth[headStart]
    for (let i = headStart; i <= nSlices; i++) {
      const t = (maxX - xs[i]) / headLen
      const ease = 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3)
      radSmooth[i] = Math.min(radSmooth[i], rBody * ease)
    }
  }
  radSmooth[0] = 0
  radSmooth[nSlices] = 0
  radSmooth = smoothGaussian(radSmooth, 1.2, 1)
  radSmooth[0] = 0
  radSmooth[nSlices] = 0

  const tailLiftStartFrac = 0.75
  for (let i = 0; i <= nSlices; i++) {
    const t = (xs[i] - minX) / totalX
    if (t > tailLiftStartFrac) {
      const liftT = smoothstep(tailLiftStartFrac, 1.0, t)
      midSmooth[i] += tailLiftAmount * liftT
    }
  }

  const pos: number[] = []
  for (let s = 0; s <= nSlices; s++) {
    for (let k = 0; k < nRings; k++) {
      const th = (k / nRings) * Math.PI * 2
      const c = Math.cos(th)
      const sn = Math.sin(th)
      pos.push(xs[s], midSmooth[s] + radSmooth[s] * c, radSmooth[s] * sn)
    }
  }
  const idx: number[] = []
  for (let s = 0; s < nSlices; s++) {
    for (let k = 0; k < nRings; k++) {
      const k2 = (k + 1) % nRings
      const a = s * nRings + k
      const b = s * nRings + k2
      const c2 = (s + 1) * nRings + k
      const d = (s + 1) * nRings + k2
      idx.push(a, d, c2, a, b, d)
    }
  }
  const geometry = new THREE.BufferGeometry()
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  geometry.setIndex(idx)

  const swept: SweptData = { xs, mid: midSmooth, rad: radSmooth }
  geometry.userData.swept = swept
  return { geometry, swept }
}
