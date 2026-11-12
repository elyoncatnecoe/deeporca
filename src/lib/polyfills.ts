/**
 * 老 Android WebView 的运行时补丁。
 *
 * 为什么需要它：构建工具的 target 只降语法（?.、??、class 等），
 * 不 polyfill 内置方法。而依赖库普遍在用 ES2022+ 的方法：
 *   - marked 用了 Object.hasOwn 与 Array.prototype.at
 *   - react-dom 用了 Object.hasOwn
 * 这些在 Chromium < 92 的 WebView 上会抛 "xxx is not a function"，
 * 而调用点往往在渲染路径里（markdown 解析、状态更新），结果就是整页白屏。
 *
 * 这个文件必须在任何业务模块之前执行（见 main.tsx 的第一行 import）。
 *
 * 只补真正用到的几个，不引 core-js：那个包体积大、还会改一堆用不到的东西，
 * 对已经很大的 bundle 不划算。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Array.prototype.at：ES2022。老内核没有。 */
if (typeof (Array.prototype as any).at !== 'function') {
  Object.defineProperty(Array.prototype, 'at', {
    value: function at(this: any[], index: number): unknown {
      const length = this.length
      const relative = Math.trunc(index) || 0
      const absolute = relative < 0 ? length + relative : relative
      if (absolute < 0 || absolute >= length) return undefined
      return this[absolute]
    },
    writable: true,
    configurable: true,
  })
}

/** String.prototype.at：同上，字符串版本。 */
if (typeof (String.prototype as any).at !== 'function') {
  Object.defineProperty(String.prototype, 'at', {
    value: function at(this: string, index: number): string | undefined {
      const length = this.length
      const relative = Math.trunc(index) || 0
      const absolute = relative < 0 ? length + relative : relative
      if (absolute < 0 || absolute >= length) return undefined
      return this[absolute]
    },
    writable: true,
    configurable: true,
  })
}

/** Object.hasOwn：ES2022。等价于 hasOwnProperty.call。 */
if (typeof (Object as any).hasOwn !== 'function') {
  Object.defineProperty(Object, 'hasOwn', {
    value: function hasOwn(target: object, key: PropertyKey): boolean {
      if (target === null || target === undefined) return false
      return Object.prototype.hasOwnProperty.call(target, key)
    },
    writable: true,
    configurable: true,
  })
}

/** Array.prototype.findLast / findLastIndex：ES2023。 */
if (typeof (Array.prototype as any).findLast !== 'function') {
  Object.defineProperty(Array.prototype, 'findLast', {
    value: function findLast<T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
      thisArg?: unknown,
    ): T | undefined {
      for (let i = this.length - 1; i >= 0; i -= 1) {
        if (predicate.call(thisArg, this[i] as T, i, this)) return this[i]
      }
      return undefined
    },
    writable: true,
    configurable: true,
  })
}

if (typeof (Array.prototype as any).findLastIndex !== 'function') {
  Object.defineProperty(Array.prototype, 'findLastIndex', {
    value: function findLastIndex<T>(
      this: T[],
      predicate: (value: T, index: number, array: T[]) => boolean,
      thisArg?: unknown,
    ): number {
      for (let i = this.length - 1; i >= 0; i -= 1) {
        if (predicate.call(thisArg, this[i] as T, i, this)) return i
      }
      return -1
    },
    writable: true,
    configurable: true,
  })
}

/** structuredClone：Chromium 98+。 */
if (typeof (globalThis as any).structuredClone !== 'function') {
  ;(globalThis as any).structuredClone = function structuredCloneFallback<T>(value: T): T {
    if (value === undefined || value === null) return value
    try {
      return JSON.parse(JSON.stringify(value)) as T
    } catch {
      return value
    }
  }
}

export {}