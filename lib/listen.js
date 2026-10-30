/**
 * mira_browser / listen.js —— 本节点监听（入站协作的唯一入口）
 *
 * 为什么要有它（任务书功能点3【定】）：
 *   「自身监听地址手填」——地址来自 config.json 的 `listen`，**不探测网卡、不猜主机名**。
 *   配 `"loopback"` 时只绑 127.0.0.1（同机协作够用），端口由系统分配（在信封 reply_to 里公布）；
 *   配 `{ip,port}` 时绑指定网卡（跨机对端要能回连到它就填它）。
 *
 * 入站 API（对方按消息信封里的 reply_to 调）：
 *   GET  /healthz            机器可读的存活信息（唯一不需要令牌的路由）
 *   GET  /collab/status      本节点协作状态（不含正文/口令）
 *   GET  /collab/sessions    本机会话 {sessionId,title}（稳定 id 的发现入口）
 *   POST /collab/deliver     投递一条消息到本机会话（宿主 agent.steer；splice:false 走 followup）
 *   GET  /collab/receipts?id= 查一条入站投递的二级回执
 *
 * 安全（约定8）：
 *   · 回环监听 = 本机进程可达，不再要求令牌；
 *   · 非回环监听 = 必须配 `<configDir>/listen-token`（600）。没有令牌 → 除 /healthz 外一律 403。
 *   · 令牌只从文件读、只做哈希比较，**永不写日志/永不回显**；消息正文也不进日志。
 *
 * 本文件不驱动浏览器、不解析业务错误码语义 —— 业务回调由入口注入，便于自检用假实现。
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

import { MiraError, toError } from './kit.mjs'
import { readListenToken } from './config.js'

const MAX_BODY_BYTES = 64 * 1024

function hashOf(text) {
  return createHash('sha256').update(String(text)).digest()
}

function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost'
}

function describeBindError(error, host, port) {
  const code = error && typeof error === 'object' ? error.code : ''
  if (code === 'EADDRINUSE') {
    return new MiraError('listen/failed', '监听端口已被占用：' + host + ':' + port,
      '换一个 listen.port，或先找出占用者（Linux：ss -ltnp | grep ' + port + '）；本插件不自动换端口')
  }
  if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') {
    return new MiraError('listen/failed', '监听地址在本机不存在：' + host,
      '把 listen.ip 改成本机网卡上的 IPv4（ip -4 addr）；本插件不探测地址')
  }
  if (code === 'EACCES') {
    return new MiraError('listen/failed', '没有权限绑定 ' + host + ':' + port,
      '换 ≥1024 的端口；<1024 需要特权')
  }
  return new MiraError('listen/failed', '监听启动失败：' + host + ':' + port + '（' + (error?.message ?? String(error)) + '）',
    '检查 config.json 的 listen.ip / listen.port 与端口占用情况')
}

export class CollabListener {
  /**
   * @param {{
   *   listen: {mode: 'loopback'|'manual', ip: string, port: number},
   *   tokenFile: string,
   *   version?: string,
   *   logger?: object,
   *   counters?: object,
   *   name?: string,
   *   onStatus: () => object|Promise<object>,
   *   onSessions: () => object|Promise<object>,
   *   onDeliver: (body: object) => object|Promise<object>,
   *   onReceipt: (id: string) => object|Promise<object>,
   * }} options
   */
  constructor(options) {
    this.listen = options.listen
    this.host = options.listen.ip
    this.port = options.listen.port
    this.tokenFile = options.tokenFile
    this.version = options.version ?? ''
    this.logger = options.logger ?? null
    this.counters = options.counters ?? null
    this.name = options.name ?? 'mira_browser'
    this.onStatus = options.onStatus
    this.onSessions = options.onSessions
    this.onDeliver = options.onDeliver
    this.onReceipt = options.onReceipt
    this.loopback = isLoopbackHost(this.host)
    this.server = null
    this.state = 'idle' // idle | starting | listening | error | closed
    this.error = null
    this.actual = null
    this.token = null
    this.tokenMode = null
    this.tokenState = this.loopback ? 'not-needed' : 'missing'
    this.readyPromise = null
    this.#loadToken()
  }

  #loadToken() {
    if (this.loopback) {
      this.tokenState = 'not-needed'
      return
    }
    const loaded = readListenToken(this.tokenFile)
    if (loaded === null) {
      this.tokenState = 'missing'
      this.logger?.warn?.('[mira_browser] 非回环监听 ' + this.host + ' 缺少入站令牌文件：' + this.tokenFile
        + '（入站写入将全部 403；出站投递不受影响）')
      return
    }
    this.token = hashOf(loaded.token)
    this.tokenMode = loaded.mode
    this.tokenState = 'ok'
    if (loaded.mode !== -1 && (loaded.mode & 0o077) !== 0) {
      this.counters?.bump('listen/token-insecure-mode')
      this.logger?.warn?.('[mira_browser] 入站令牌文件权限为 0' + loaded.mode.toString(8) + '，组/其他人可读；建议 chmod 600 ' + this.tokenFile)
    }
  }

  /** 启动监听；返回 this。绑定结果用 ready() 等（apply 保持同步，工具调用时再等）。 */
  start() {
    if (this.server !== null) return this
    this.state = 'starting'
    this.server = createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        this.#json(res, 500, toError(error, 'http/internal', '这是本插件内部错误；看宿主日志'))
      })
    })
    this.server.on('clientError', (error, socket) => {
      try {
        socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      } catch {
        /* socket 已经没了 */
      }
      this.counters?.bump('listen/client-error')
      this.logger?.warn?.('[mira_browser] 入站请求格式错误：' + (error?.message ?? String(error)))
    })
    this.server.on('error', (error) => {
      // 监听成功之后的运行时错误（少见）：记状态，不让它变成未捕获异常
      if (this.state === 'listening') {
        this.state = 'error'
        this.error = describeBindError(error, this.host, this.port)
        this.counters?.bump('listen/runtime-error')
        this.logger?.warn?.('[mira_browser] ' + this.error.message)
      }
    })
    this.readyPromise = new Promise((resolve, reject) => {
      const onError = (error) => {
        this.server?.off('listening', onListening)
        this.state = 'error'
        this.error = describeBindError(error, this.host, this.port)
        this.counters?.bump('listen/failed')
        this.logger?.warn?.('[mira_browser] ' + this.error.message + '（' + (this.error.hint ?? '') + '）')
        reject(this.error)
      }
      const onListening = () => {
        this.server?.off('error', onError)
        const address = this.server?.address()
        this.actual = address && typeof address === 'object' ? { address: address.address, port: address.port, family: address.family } : null
        this.state = 'listening'
        this.error = null
        this.logger?.info?.('[mira_browser] 协作监听已就绪：' + this.describe().url
          + '（' + (this.loopback ? '仅本机回环；入站免令牌' : '非回环；入站需 Bearer 令牌') + '）')
        resolve(this)
      }
      this.server.once('listening', onListening)
      this.server.once('error', onError)
      try {
        this.server.listen({ host: this.host, port: this.port, exclusive: true })
      } catch (error) {
        onError(error)
      }
    })
    this.readyPromise.catch(() => { /* 由调用方决定怎么报；这里避免 unhandled rejection */ })
    return this
  }

  async ready() {
    if (this.state === 'listening') return this.describe()
    if (this.state === 'error') throw this.error ?? new MiraError('listen/failed', '监听不可用', '检查 config.json 的 listen')
    if (this.readyPromise === null) throw new MiraError('listen/failed', '监听没有启动（listen 未配置？）', '先在 config.json 里填 listen.ip/listen.port 或写 "loopback"')
    await this.readyPromise
    return this.describe()
  }

  /** 对外描述（端口是**实际绑定**的端口；loopback 形态下与配置值 0 不同）。 */
  describe() {
    const port = this.actual?.port ?? this.port
    const host = this.actual?.address ?? this.host
    const listening = this.state === 'listening'
    return {
      mode: this.listen.mode,
      host,
      port,
      url: listening ? 'http://' + host + ':' + port + '/' : null,
      state: this.state,
      loopback: this.loopback,
      auth: this.loopback ? 'loopback' : (this.tokenState === 'ok' ? 'token' : 'disabled'),
      tokenFile: this.loopback ? null : this.tokenFile,
      ...(this.error ? { error: { code: this.error.code, message: this.error.message, hint: this.error.hint } } : {}),
    }
  }

  #authorized(req) {
    if (this.loopback) return true
    if (this.tokenState !== 'ok' || this.token === null) return false
    const header = req.headers.authorization
    if (typeof header !== 'string' || !/^Bearer\s+/iu.test(header)) return false
    const presented = header.replace(/^Bearer\s+/iu, '').trim()
    if (presented === '') return false
    try {
      return timingSafeEqual(hashOf(presented), this.token)
    } catch {
      return false
    }
  }

  async #readJson(req) {
    const chunks = []
    let total = 0
    for await (const chunk of req) {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        throw new MiraError('http/too-large', '请求体超过 ' + MAX_BODY_BYTES + ' 字节', '把消息截短后重发')
      }
      chunks.push(chunk)
    }
    if (total === 0) return {}
    const text = Buffer.concat(chunks).toString('utf8')
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not-object')
      }
      return parsed
    } catch {
      throw new MiraError('http/invalid-json', '请求体不是 JSON 对象', 'Content-Type: application/json；正文形如 {"sessionId":"session-…","text":"…"}')
    }
  }

  async #handle(req, res) {
    let path = '/'
    let query = new URLSearchParams()
    try {
      const url = new URL(req.url ?? '/', 'http://' + (req.headers.host ?? 'localhost'))
      path = url.pathname
      query = url.searchParams
    } catch {
      return this.#json(res, 400, { ok: false, error: { code: 'http/invalid-url', message: '请求 URL 无法解析' } })
    }

    if (path === '/healthz' && req.method === 'GET') {
      return this.#json(res, 200, {
        ok: true,
        name: this.name,
        version: this.version,
        pid: process.pid,
        listen: this.describe(),
      })
    }

    if (!this.#authorized(req)) {
      this.counters?.bump('listen/auth-denied')
      return this.#json(res, 403, {
        ok: false,
        error: {
          code: 'auth/denied',
          message: '非回环监听需要 Authorization: Bearer <token>',
          hint: '令牌文件：' + this.tokenFile + (this.tokenState === 'missing' ? '（尚未创建；先写入随机串并 chmod 600）' : ''),
        },
      })
    }

    if (path === '/collab/status') {
      if (req.method !== 'GET') return this.#methodNotAllowed(res, 'GET')
      return this.#json(res, 200, await this.onStatus())
    }
    if (path === '/collab/sessions') {
      if (req.method !== 'GET') return this.#methodNotAllowed(res, 'GET')
      return this.#json(res, 200, await this.onSessions())
    }
    if (path === '/collab/receipts') {
      if (req.method !== 'GET') return this.#methodNotAllowed(res, 'GET')
      const id = String(query.get('id') ?? '').trim()
      if (id === '') {
        return this.#json(res, 400, { ok: false, error: { code: 'receipt/not-found', message: '缺少 ?id=<receiptId>', hint: '用 POST /collab/deliver 返回的 receiptId' } })
      }
      return this.#json(res, 200, await this.onReceipt(id))
    }
    if (path === '/collab/deliver') {
      if (req.method !== 'POST') return this.#methodNotAllowed(res, 'POST')
      let body
      try {
        body = await this.#readJson(req)
      } catch (error) {
        const normalized = toError(error, 'http/invalid-json')
        return this.#json(res, normalized.error.code === 'http/too-large' ? 413 : 400, normalized)
      }
      return this.#json(res, 200, await this.onDeliver(body))
    }
    return this.#json(res, 404, {
      ok: false,
      error: { code: 'http/not-found', message: '没有这个路由：' + path, hint: '可用：GET /healthz|/collab/status|/collab/sessions|/collab/receipts、POST /collab/deliver' },
    })
  }

  #methodNotAllowed(res, allowed) {
    res.setHeader('Allow', allowed)
    return this.#json(res, 405, { ok: false, error: { code: 'http/method', message: '只支持 ' + allowed } })
  }

  #json(res, status, value) {
    if (res.writableEnded || res.destroyed) return
    let text
    try {
      text = JSON.stringify(value ?? { ok: true })
    } catch {
      text = JSON.stringify({ ok: false, error: { code: 'http/serialize', message: '响应无法序列化' } })
    }
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(text),
    })
    res.end(text)
  }

  /** 关监听。先掐掉 keep-alive 连接，避免 close 一直等（自检里尤其明显）。 */
  async close() {
    const server = this.server
    this.server = null
    this.state = 'closed'
    if (server === null) return
    try { server.closeAllConnections?.() } catch { /* 旧 node */ }
    await new Promise((resolve) => {
      try {
        server.close(() => resolve())
        // 兜底：某些 keep-alive 组合下 close 回调会拖；最多等 1s
        const timer = setTimeout(resolve, 1000)
        if (typeof timer.unref === 'function') timer.unref()
      } catch {
        resolve()
      }
    })
  }
}

export { isLoopbackHost }
