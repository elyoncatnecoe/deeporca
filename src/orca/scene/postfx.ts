import * as THREE from 'three'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import type { QualitySettings } from '../quality'

/*
 * AbyssRium-style post chain: soft pastel bloom + a gentle color grade
 * (brightness / contrast / saturation / teal tint / vignette). The grade
 * pass keeps bright macaron elements dreamy while the background and sand
 * stay crisp paper-cut color.
 *
 * The chain is also the game's camera: a photo is the exact frame the player
 * sees, bloom and grade included, read back out of the composer's own buffer.
 * That is why the main renderer never enables `preserveDrawingBuffer` — it
 * would cost a full-resolution copy on every single frame just to make the
 * canvas readable, and the canvas does not even contain the post-processed
 * image anyway.
 */

const ColorGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uBrightness: { value: 1.02 },
    uContrast: { value: 1.05 },
    uSaturation: { value: 1.22 },
    // The water column already bakes a vignette into the backdrop, so this
    // one stays faint — just enough to sink the far corners of the reef.
    uVignette: { value: 0.14 },
    // A violet-blue unify pass nudges every prop toward the measured column
    // hue, the way the reference frame's reef always sits inside its water.
    uTint: { value: new THREE.Color(0x2a3a6a) },
    uTintAmount: { value: 0.04 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float uBrightness;
    uniform float uContrast;
    uniform float uSaturation;
    uniform float uVignette;
    uniform vec3 uTint;
    uniform float uTintAmount;
    varying vec2 vUv;

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 c = texel.rgb * uBrightness;
      c = (c - 0.5) * uContrast + 0.5;

      float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = mix(vec3(luma), c, uSaturation);
      c = mix(c, uTint, uTintAmount);

      // Gentle AbyssRium vignette: darken the far corners slightly.
      vec2 d = vUv - 0.5;
      float vig = smoothstep(0.92, 0.42, length(d));
      c *= 1.0 - uVignette * (1.0 - vig);

      gl_FragColor = vec4(c, texel.a);
    }
  `,
}

/**
 * Turn raw GL pixels into an upright canvas.
 *
 * WebGL reads bottom-up, so `pixels` is stored mirrored; drawing it through a
 * scratch canvas and flipping on the way out undoes that. Going via drawImage
 * rather than putImageData also avoids the premultiplied-alpha pitfalls that
 * make readRenderTargetPixels output look washed out when written directly.
 *
 * Kept separate from `createPostFX` so the flip can be unit tested without a
 * GL context.
 */
export function pixelsToCanvas(
  pixels: Uint8Array,
  sourceWidth: number,
  sourceHeight: number,
  outWidth: number,
  outHeight: number,
): HTMLCanvasElement {
  const scratch = document.createElement('canvas')
  scratch.width = sourceWidth
  scratch.height = sourceHeight
  const scratchCtx = scratch.getContext('2d')!
  const image = scratchCtx.createImageData(sourceWidth, sourceHeight)
  /*
   * 长度理论上必然相等（同一个 sourceWidth/height 算出来的），但真机上出现过
   * 回读缓冲比 ImageData 短的情况：直接 set 会抛 RangeError，而这个异常会一路
   * 冒到 takePhoto 的 catch 里，表现成「拍照失败，请重试」—— 照片功能整个不可用，
   * 日志里却什么都没有。所以这里按较短的截断：丢几行像素，但照片能出来。
   */
  const count = Math.min(image.data.length, pixels.length)
  if (count !== pixels.length) {
    console.warn('[orca] pixel buffer mismatch', {
      sourceWidth,
      sourceHeight,
      imageData: image.data.length,
      readback: pixels.length,
    })
  }
  image.data.set(count === pixels.length ? pixels : pixels.subarray(0, count))
  scratchCtx.putImageData(image, 0, 0)

  const canvas = document.createElement('canvas')
  canvas.width = outWidth
  canvas.height = outHeight
  const ctx = canvas.getContext('2d')!
  ctx.translate(0, outHeight)
  ctx.scale(1, -1)
  ctx.drawImage(scratch, 0, 0, outWidth, outHeight)
  return canvas
}

export interface PostFX {
  composer: EffectComposer
  /** Undefined on the low tier, where the bloom pass is never created. */
  bloom: UnrealBloomPass | undefined
  grade: ShaderPass | undefined
  render: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => void
  setSize: (width: number, height: number) => void
  /**
   * Change the composer's render scale at runtime. The runtime quality
   * downgrade uses this to drop from the tier's ratio to 1x without rebuilding
   * the chain — the bloom pass has to follow, or its blur pyramid keeps running
   * at the old resolution.
   */
  setPixelRatio: (ratio: number) => void
  setStrength: (strength: number) => void
  /**
   * Render one frame through the full chain into an offscreen target and
   * return it as a fresh canvas. The target is always upright and no wider
   * than the tier's capture cap, so a 4K display cannot force a 4K readback.
   */
  capture: (scene: THREE.Scene, camera: THREE.PerspectiveCamera) => HTMLCanvasElement
  dispose: () => void
}

export function createPostFX(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  quality: QualitySettings,
): PostFX {
  const composer = new EffectComposer(renderer)
  // Must match the renderer's own ratio, not the tier ceiling: the renderer
  // uses min(devicePixelRatio, cap), so on a 1x display a composer running at
  // the raw cap would allocate 2.25x the pixels for no visible gain.
  // Mutable: `setPixelRatio` below lowers it when the runtime detects a device
  // that cannot hold its frame budget.
  let pixelRatio = Math.min(window.devicePixelRatio || 1, quality.maxPixelRatio)
  composer.setPixelRatio(pixelRatio)

  const size = renderer.getSize(new THREE.Vector2())
  composer.setSize(size.x, size.y)

  composer.addPass(new RenderPass(scene, camera))

  // UnrealBloomPass runs a five-level blur pyramid; on the low tier it is the
  // difference between playable and not, so it is skipped entirely.
  let bloom: UnrealBloomPass | undefined
  if (quality.bloom) {
    bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x * pixelRatio, size.y * pixelRatio),
      0, // default strength (off; the slider in the decor panel turns it up)
      0.6, // radius — wide soft halo, deepsea.html-style dreamy glow
      // Threshold 0.9: bright-theme caustic pools alpha-blend and top out
      // below it (no bloom halo at all); the night theme's additive pool cores
      // clamp past 1.0 and keep their glow.
      // below it so the frame stays matte while caustic pools bloom.
      // Threshold 0.7, not deepsea's 0.2: deepsea's numbers ride on an ACES
      // tone-mapping pipeline that compresses highlights first; our flat
      // unlit pipeline feeds raw luminance to the bloom, so 0.2 blew the
      // whole water column and the orca's belly out to white.
      0.9,
    )
    composer.addPass(bloom)
  }

  let grade: ShaderPass | undefined
  if (quality.colorGrade) {
    grade = new ShaderPass(ColorGradeShader)
    composer.addPass(grade)
  }

  return {
    composer,
    bloom,
    grade,
    render: () => composer.render(),
    setSize: (width, height) => {
      composer.setSize(width, height)
      bloom?.setSize(width * pixelRatio, height * pixelRatio)
    },
    setPixelRatio: (ratio) => {
      pixelRatio = ratio
      composer.setPixelRatio(ratio)
      const next = renderer.getSize(new THREE.Vector2())
      composer.setSize(next.x, next.y)
      bloom?.setSize(next.x * ratio, next.y * ratio)
    },
    setStrength: (strength) => {
      if (bloom) bloom.strength = strength
    },
    capture: (captureScene, captureCamera) => {
      // Route the whole chain into the composer's own buffer instead of the
      // swap chain, so nothing is lost when the canvas is cleared next frame.
      const previousTarget = renderer.getRenderTarget()
      composer.renderToScreen = false
      composer.render()

      /*
       * 取缓冲区的引用必须在 render() **之后**。
       * EffectComposer 用一对 ping-pong target，Pass 跑完会 swapBuffers()：
       * colorGrade 那个 ShaderPass 的 needsSwap 是 true（RenderPass / UnrealBloomPass
       * 是 false），所以渲染完一次，最终画面躺在**换过之后**的 readBuffer 里。
       * 以前在 render() 之前取引用，回读到的永远是调色 / 暗角**之前**那一帧 ——
       * 三档画质都开着 colorGrade，于是每张成品照片都比玩家屏幕上看到的淡。
       */
      const renderTarget = composer.readBuffer

      /*
       * 必须取整。`renderTarget.width/height` 在 devicePixelRatio 非整数时是小数
       * （150% 缩放最常见的 1.5 倍：835 × 1.5 = 1252.5），于是
       * `new Uint8Array(w * h * 4)` 按浮点乘积分配、`createImageData(w, h)` 按
       * 截断后的整数分配 —— 前者比后者多出整整一行，`image.data.set(pixels)`
       * 直接抛 RangeError，拍照功能在 125%/150%/175% 缩放的机器上全废。
       * 回读也按取整后的尺寸读，两者才对得上。
       */
      const sourceWidth = Math.max(1, Math.floor(renderTarget.width))
      const sourceHeight = Math.max(1, Math.floor(renderTarget.height))
      // Fit inside the tier box on both axes: a tall phone screen is the case
      // that would otherwise read back an enormous portrait buffer.
      const scale = Math.min(1, quality.captureMaxWidth / sourceWidth, quality.captureMaxHeight / sourceHeight)
      const outWidth = Math.max(1, Math.round(sourceWidth * scale))
      const outHeight = Math.max(1, Math.round(sourceHeight * scale))

      const pixels = new Uint8Array(sourceWidth * sourceHeight * 4)
      renderer.readRenderTargetPixels(renderTarget, 0, 0, sourceWidth, sourceHeight, pixels)

      composer.renderToScreen = true
      renderer.setRenderTarget(previousTarget)

      return pixelsToCanvas(pixels, sourceWidth, sourceHeight, outWidth, outHeight)
    },
    dispose: () => {
      composer.dispose()
    },
  }
}
