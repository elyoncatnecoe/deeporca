const { app } = require("electron")
const { Worker } = require("node:worker_threads")
const path = require("node:path")
const fs = require("node:fs")

app.whenReady().then(() => {
  const base = path.join(process.resourcesPath, "app.asar.unpacked", "electron-dist", "pow-worker.cjs")
  const alt = path.join(process.resourcesPath, "app.asar", "electron-dist", "pow-worker.cjs")
  console.log("PROBE unpacked exists:", fs.existsSync(base))
  console.log("PROBE unpacked path:", base)
  try {
    const w = new Worker(base)
    w.on("message", (m) => { console.log("PROBE worker 回复:", JSON.stringify(m)); w.terminate(); app.quit() })
    w.on("error", (e) => { console.log("PROBE worker 错误:", e.message); app.quit() })
    // 造一道低难度挑战让它解
    w.postMessage({ id: 1, challenge: {
      algorithm: "DeepSeekHashV1",
      challenge: "0".repeat(64),
      salt: "probe",
      difficulty: 500,
      expireAt: 1700000000,
      signature: "s",
      targetPath: "/api/v0/chat/completion"
    }})
    setTimeout(() => { console.log("PROBE 超时"); app.quit() }, 10000)
  } catch (e) {
    console.log("PROBE 加载失败:", e.message)
    app.quit()
  }
})