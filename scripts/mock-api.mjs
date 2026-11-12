import { createServer } from 'node:http'

const PORT = Number(process.env.MOCK_PORT ?? 8787)

/**
 * 媒体探针用的假数据：
 * - 1×1 透明 PNG（生图接口返回 b64_json）
 * - 0.1 秒 8kHz 单声道 WAV（TTS 接口返回二进制 / OpenRouter audio 返回 base64）
 */
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lQn4WQAAAABJRU5ErkJggg=='

function tinyWavBase64() {
  const sampleRate = 8000
  const samples = 800
  const dataSize = samples * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)
  return buffer.toString('base64')
}

const TINY_WAV = tinyWavBase64()

function cors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Credentials', 'true')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS')
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    req.on('data', (chunk) => { raw += chunk })
    req.on('end', () => {
      try { resolve(JSON.parse(raw)) } catch { resolve({}) }
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 模拟「输出上限截断」的次数。
 *
 * MOCK_TRUNCATE=1 时，前 N 次（默认 1 次）带思考的请求会回 finish_reason:'length'
 * 且正文为空；之后恢复正常。用来验证客户端的两条路径：
 *   - 撞顶自动翻倍重试（第 2 次请求上限变大）
 *   - 重试仍截断时的自动续写（需要 MOCK_TRUNCATE_TIMES=2）
 */
let truncateArmed = Number(process.env.MOCK_TRUNCATE_TIMES ?? '1')

const HTML = `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><title>深海小游戏</title><link rel="stylesheet" href="style.css"></head>
<body>
  <h1>接住星星</h1>
  <p>用方向键移动小鲸鱼。</p>
  <canvas id="game" width="480" height="320"></canvas>
  <script src="script.js"></script>
</body>
</html>
`

const CSS = `body{margin:0;background:#04141d;color:#e8f7f9;font-family:system-ui;display:grid;place-items:center;min-height:100vh}
canvas{border-radius:18px;background:#082530;box-shadow:0 20px 50px rgba(0,0,0,.4)}`

const JS = `const c=document.getElementById('game'),x=c.getContext('2d');
let px=240,py=280,score=0,star={x:240,y:40};
addEventListener('keydown',e=>{if(e.key==='ArrowLeft')px-=24;if(e.key==='ArrowRight')px+=24;px=Math.max(20,Math.min(460,px))});
setInterval(()=>{star.y+=4;if(star.y>300){if(Math.abs(star.x-px)<28)score++;star={x:40+Math.random()*400,y:20}}},30);
(function loop(){x.fillStyle='#082530';x.fillRect(0,0,480,320);x.fillStyle='#ffd166';x.beginPath();x.arc(star.x,star.y,8,0,7);x.fill();x.fillStyle='#7fe3d4';x.beginPath();x.ellipse(px,py,26,12,0,0,7);x.fill();x.fillStyle='#e8f7f9';x.font='16px system-ui';x.fillText('分数 '+score,16,26);requestAnimationFrame(loop)})();`

function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => (part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image_url' ? '[图片]' : ''))
    .filter(Boolean)
    .join('\n')
}

const server = createServer(async (req, res) => {
  cors(req, res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  if (req.url?.includes('/models')) {
    // 带上各家真实字段形态，好让「获取可用模型 → 看图能力」这条链能被探测：
    // OpenRouter 用 architecture.input_modalities，别的网关用 capabilities.vision。
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      data: [
        { id: 'deepseek-flash', architecture: { input_modalities: ['text', 'image'] } },
        { id: 'deepseek-v4-pro', architecture: { input_modalities: ['text'] } },
        { id: 'gpt-4o', capabilities: { vision: true } },
        { id: 'glm-4v-plus', supports_vision: true },
      ],
    }))
    return
  }
  if (req.url?.includes('/images')) {
    const body = await readBody(req)
    console.log('IMAGE_REQ', {
      model: body.model,
      prompt: String(body.prompt ?? '').slice(0, 40),
      count: body.n,
      size: body.size,
      references: Array.isArray(body.input_references) ? body.input_references.length : 0,
    })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG, media_type: 'image/png' }] }))
    return
  }
  if (req.url?.includes('/audio/speech')) {
    const body = await readBody(req)
    console.log('SPEECH_REQ', {
      model: body.model,
      input: String(body.input ?? '').slice(0, 40),
      voice: body.voice,
      format: body.response_format,
    })
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': Buffer.from(TINY_WAV, 'base64').length })
    res.end(Buffer.from(TINY_WAV, 'base64'))
    return
  }
  if (!req.url?.includes('/chat/completions')) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  const body = await readBody(req)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = String(messages[0]?.content ?? '')
  const lastUser = [...messages].reverse().find((message) => message.role === 'user')
  const lastTool = [...messages].reverse().find((message) => message.role === 'tool')
  const userText = contentText(lastUser?.content)
  const hasImage = Array.isArray(lastUser?.content)
    && lastUser.content.some((part) => part?.type === 'image_url')
  const thinkingOn = body.thinking?.type === 'enabled' || body.model === 'deepseek-reasoner'
  let truncateTurn = false
  console.log('REQ', {
    stream: body.stream,
    model: body.model,
    messages: messages.length,
    user: userText.slice(0, 40),
    thinking: body.thinking,
    effort: body.reasoning_effort,
    image: hasImage,
    // 探测用：输出预算（B1/B2 改的就是它）与工具是否真的进了请求体。
    maxTokens: body.max_tokens ?? null,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    // 人设第一行：用来确认助手配置真的进了 system prompt。
    systemHead: system.split('\n')[0].slice(0, 60),
  })

  // OpenRouter 的语音输出：同一个 /chat/completions，带 modalities:['text','audio']。
  // 真接口按 SSE 的 delta.audio.data 分片返回 base64 音频，这里照同一形状模拟。
  if (Array.isArray(body.modalities) && body.modalities.includes('audio')) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    sse(res, { id: 'mock-audio', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    await sleep(60)
    sse(res, { id: 'mock-audio', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { audio: { data: TINY_WAV, transcript: '' } }, finish_reason: null }] })
    await sleep(40)
    sse(res, { id: 'mock-audio', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  const toolNames = Array.isArray(body.tools) ? body.tools.map((tool) => tool?.function?.name).filter(Boolean) : []
  const lastUserIndex = lastUser === undefined ? -1 : messages.lastIndexOf(lastUser)
  const lastToolIndex = lastTool === undefined ? -1 : messages.lastIndexOf(lastTool)
  const newTurn = lastTool === undefined || lastToolIndex < lastUserIndex
  const wantsImage = newTurn && toolNames.includes('generate_image') && /画|生图|生成.*图|改.*图/.test(userText)
  const wantsSpeech = newTurn && toolNames.includes('speak') && /语音|朗读|读出来|念一下/.test(userText)
  if (wantsImage || wantsSpeech) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
    await sleep(70)
    const call = wantsImage
      ? { name: 'generate_image', arguments: JSON.stringify({ prompt: userText, size: '1024x1024', count: 1 }) }
      : { name: 'speak', arguments: JSON.stringify({ text: '你好，我是深鲸。', speed: 1 }) }
    sse(res, {
      id: 'mock', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: wantsImage ? 'call_mock_image' : 'call_mock_speech', type: 'function', function: { name: call.name, arguments: '' } }] }, finish_reason: null }],
    })
    await sleep(60)
    sse(res, {
      id: 'mock', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: call.arguments } }] }, finish_reason: null }],
    })
    await sleep(40)
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // 探测用（默认关）：MOCK_TRUNCATE=1 时模拟「思考吃满 max_tokens 被截断」，
  // 即线上那个撞顶的场景，用来验证客户端会不会自动放大预算重发、以及续写。
  if (process.env.MOCK_TRUNCATE === '1' && lastTool === undefined && thinkingOn && truncateArmed > 0) {
    truncateTurn = true
    truncateArmed -= 1
  }

  if (!body.stream) {
    const isMemory = system.includes('记忆抽取器')
    const isCompress = system.includes('滚动摘要')
    console.log('JSON_REQ', { isMemory, isCompress, systemHead: system.slice(0, 24) })
    if (isCompress && process.env.MOCK_COMPRESS_FAIL === '1') {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'mock network down' } }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    const content = isMemory
      ? JSON.stringify({ facts: [{ text: '用户叫小林，喜欢简洁的回答', type: 'profile', tags: ['名字', '沟通'], importance: 4 }] })
      : isCompress
        ? JSON.stringify({
          summary: `（第 ${Math.floor(Math.random() * 1e6)} 次压缩）前面聊到用户在测试压缩功能，助手确认会保留最近原文。`,
          lost: ['具体测试序号已丢失'],
        })
        : JSON.stringify({ facts: [] })
    res.end(JSON.stringify({ id: 'mock', choices: [{ index: 0, message: { role: 'assistant', content } }] }))
    return
  }

  if (lastTool !== undefined && thinkingOn) {
    const toolAssistant = [...messages].reverse().find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))
    if (!toolAssistant?.reasoning_content) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'reasoning_content must be echoed after a thinking tool call' } }))
      return
    }
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  })

  const wantsTool = lastTool === undefined && (userText.includes('网页') || userText.includes('工坊') || userText.includes('小游戏'))

  sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })

  if (thinkingOn) {
    const thoughts = hasImage
      ? ['先看看用户给的图。', '图里似乎是一个深色的界面，我该描述重点。']
      : ['先理解一下用户真正想要什么。', userText.length > 24 ? '这句话有点长，拆成几个部分来看。' : '很短，直接回答就好。']
    for (const thought of thoughts) {
      await sleep(90)
      sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: thought }, finish_reason: null }] })
    }
  }

  // 截断分支：只发思考、不发正文、不发工具，finish_reason:'length'。
  if (truncateTurn) {
    const long = '先列场景：便利店在街角、雨夜、霓虹反光、湿地面。'
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: long.repeat(6) }, finish_reason: null }] })
    await sleep(60)
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })
    if (body.stream_options?.include_usage) {
      sse(res, {
        id: 'mock', object: 'chat.completion.chunk', choices: [],
        usage: { prompt_tokens: 200, completion_tokens: body.max_tokens ?? 4096, total_tokens: 200 + (body.max_tokens ?? 4096) },
      })
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  if (wantsTool) {
    sse(res, {
      id: 'mock', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function', function: { name: 'write_file', arguments: '' } }] }, finish_reason: null }],
    })
    await sleep(80)
    const args = JSON.stringify({ path: 'index.html', content: HTML })
    sse(res, {
      id: 'mock', object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args } }] }, finish_reason: null }],
    })
    await sleep(60)
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    if (body.stream_options?.include_usage) {
      sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 120, completion_tokens: 40, total_tokens: 160 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  const lastToolName = lastTool !== undefined
    ? [...messages].reverse().find((message) => message.role === 'assistant' && Array.isArray(message.tool_calls))?.tool_calls?.[0]?.function?.name
    : undefined
  const pieces = hasImage
    ? ['我看到了这张图。', '如果你想，我可以把它改成网页里的界面。']
    : userText.includes('转个圈') || userText.includes('身体')
      ? ['<body act="sp', 'in" mood="playful" say="看我的！" />', '好，', '我转一圈。']
      : lastToolName === 'generate_image'
        ? ['图片生成好了，', '直接看上面的图片。']
        : lastToolName === 'speak'
          ? ['语音生成好了，', '点播放器就能听。']
          : lastTool !== undefined
            ? ['写好了：', '`index.html` 已经在工坊里。', '点「运行预览」就能玩。']
            : userText.includes('我叫')
              ? ['你好，小林。', '我是深鲸，', '住在你设备的深海里。']
              : userText.includes('简洁')
                ? ['好，', '我尽量短。']
                : ['收到。', '我们慢慢来。']

  for (const piece of pieces) {
    await sleep(90)
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
  }
  await sleep(60)
  sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
  if (body.stream_options?.include_usage) {
    sse(res, { id: 'mock', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 90, completion_tokens: 18, total_tokens: 108 } })
  }
  res.write('data: [DONE]\n\n')
  res.end()
})

function sse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MOCK_API http://127.0.0.1:${PORT}`)
})
