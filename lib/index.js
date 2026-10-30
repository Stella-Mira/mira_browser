/**
 * mira_browser — DSH 浏览器与协作插件（Host 半边入口）
 *
 * 三件事：
 *   1. **ai_browser 的 MCP 接入**：由 `cordis.patch.yml` 的下一个 insert 行
 *      （`@deepseek-ai/dsh-mcp-client`）负责；本入口只负责在 apply 时**同步建好**
 *      浏览器档案目录与临时目录（MCP 客户端只 spawn，不建目录）。
 *   2. **collab_* 工具**：把另一个 DSH 会话当对端收发消息（浏览器路径，保留 0.1.0 能力），
 *      并新增稳定别名表、两级回执、send_many、队列/在途观测。
 *   3. **本节点监听**：`listen` 手填；对端可 POST 到 `/collab/deliver` 直投本机会话
 *      （走宿主 sessionController 的 steer/followup，不是去点本机 GUI）。
 *
 * 单实例：`claimInstance('mira_browser')`；第二个实例 warn + `plugin/instance`。
 *
 * 缺 listen 时**不阻塞插件加载**：MCP 浏览器工具照常可用；全部 collab_* 返回
 * `config/missing`，hint 指到 config.json（任务书【定】3 + 本轮兼容约束）。
 *
 * 只依赖 node: 内置与相对模块。
 */

import { chmodSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import {
  claimInstance,
  ensureDir,
  fail,
  fileMode,
  makeCounters,
  MiraError,
  nowIso,
  toError,
  writeJsonAtomic,
} from './kit.mjs'
import {
  CONFIG_VERSION,
  aliasesFile,
  configDir,
  configFile,
  listenTokenFile,
  loadConfig,
  requireBrowserRuntime,
  requireListen,
  targetsView,
} from './config.js'
import { AliasStore } from './addressing.js'
import { DeliveryTracker, SendQueue } from './receipt.js'
import { CollabListener } from './listen.js'
import { CollabClient, localSessions, resolveTarget, selfNameOf } from './collab.js'
import { registerTools } from './tools.js'

export const name = 'mira_browser'

/** 工具需要 tools 服务；拿不到就 warn 不注册（不要让整个插件加载失败）。 */
export const inject = ['tools']

const INSTANCE_ID = 'mira_browser'

/** 版本从 package.json 读（不写死两份）。 */
function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export const VERSION = readVersion()

/* ------------------------------------------------------------------ 软取宿主能力 ---- */

/**
 * 软取宿主服务（不写进 inject）：没有 sessionController 时插件仍要能加载、
 * MCP 浏览器工具仍要能用；只有「入站直投本机会话」这一个能力降级。
 */
function softGet(ctx, key) {
  if (ctx === null || ctx === undefined) return null
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    /* 未声明 inject 的服务可能抛；继续试属性 */
  }
  try {
    const value = ctx[key]
    return value === undefined ? null : value
  } catch {
    return null
  }
}

/* ------------------------------------------------------------------ 入站投递 ---- */

function inboundMessage(text, { sessionId, receiptId, from }) {
  return {
    id: 'mira-browser-' + randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: String(text) }],
    // 宿主 RuntimeContextProjection 会读 source.kind；未知 kind 穿透，不能缺。
    source: { kind: 'mira_browser' },
    meta: {
      sessionId,
      receiptId,
      fromPeer: from && typeof from === 'object' ? (from.peer ?? null) : null,
      fromId: from && typeof from === 'object' ? (from.id ?? from.sessionId ?? null) : null,
    },
  }
}

/**
 * 宿主会话投递：steer（插话，默认）/ followup（排队，splice:false）。
 * 返回的 probe 闭包用于二级回执：看到 running → 之后回到 idle 视为「已处理/已读」。
 */
function buildHostDelivery(ctx, logger, counters) {
  const sessionController = softGet(ctx, 'sessionController')
  const sessions = softGet(ctx, 'sessions')
  const available = Boolean(sessionController && typeof sessionController.resolveAgent === 'function')

  async function resolveAgent(sessionId) {
    if (!available) {
      throw new MiraError('delivery/failed',
        '宿主没有 sessionController.resolveAgent，无法向本机会话直投',
        '这是宿主能力缺失：改用浏览器路径（collab_send），或升级宿主；入站 API 需要它')
    }
    let result
    try {
      result = await sessionController.resolveAgent(sessionId)
    } catch (error) {
      throw new MiraError('delivery/failed',
        '解析会话失败：' + sessionId + '（' + (error?.message ?? String(error)) + '）',
        '用 GET /collab/sessions 核对 sessionId；会话可能未加载、已被删或归属别的 owner')
    }
    // 宿主的 resolveAgent 有两种返回形态：live Agent 或 { agent } / { error }
    if (result !== null && result !== undefined) {
      if (typeof result.steer === 'function' || typeof result.followup === 'function') return result
      if (result.agent !== undefined && result.agent !== null) return result.agent
      if (result.error !== undefined) {
        throw new MiraError('delivery/failed',
          '会话不可用：' + sessionId + '（' + (result.error.code ?? result.error.message ?? 'unknown') + '）',
          '会话可能不存在或归属别的 owner；用 GET /collab/sessions 核对')
      }
    }
    throw new MiraError('delivery/failed', 'resolveAgent 返回了无法识别的结果：' + sessionId, '宿主接口变化；看宿主日志')
  }

  async function deliver({ sessionId, text, splice = true, receiptId, from = null }) {
    const agent = await resolveAgent(sessionId)
    const message = inboundMessage(text, { sessionId, receiptId, from })
    if (splice === false) {
      if (typeof agent.followup !== 'function') {
        throw new MiraError('delivery/failed', 'agent.followup 不可用，无法排队投递', '改用 splice:true（steer，插话）')
      }
      agent.followup(message)
      counters.bump('inbound/followup')
    } else {
      if (typeof agent.steer !== 'function') {
        throw new MiraError('delivery/failed', 'agent.steer 不可用（会话 ' + sessionId + '）', '宿主版本不支持插话投递')
      }
      agent.steer(message)
      counters.bump('inbound/steer')
    }
    try {
      if (sessions && typeof sessions.flush === 'function' && agent.session) await sessions.flush(agent.session)
    } catch {
      /* flush 失败不影响「已投递」，宿主自己会记日志 */
    }
    return agent
  }

  function probe(sessionId) {
    let sawRunning = false
    return async () => {
      const agent = await resolveAgent(sessionId)
      const running = agent?.status === 'running'
      if (running) sawRunning = true
      const read = sawRunning && !running
      return {
        running,
        read,
        evidence: running ? 'agent-running' : read ? 'agent-returned-idle' : 'agent-idle',
      }
    }
  }

  if (!available) {
    logger?.info?.('[mira_browser] 宿主没有 sessionController：入站 /collab/deliver 不可用（出站与 MCP 浏览器工具不受影响）')
  }
  return { available, deliver, probe, resolveAgent, sessions }
}

/* ------------------------------------------------------------------ 入站参数 ---- */

const SESSION_ID_RE = /^session-[A-Za-z0-9._-]{1,128}$/u

/** 入站寻址：sessionId 优先；标题必须在本机会话存储里**完全一致且唯一**（不猜）。 */
function resolveInboundSession(body) {
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (sessionId !== '') {
    if (!SESSION_ID_RE.test(sessionId)) {
      throw new MiraError('addressing/invalid', 'sessionId 不合法：' + JSON.stringify(sessionId), '形如 session-<uuid>；用 GET /collab/sessions 取')
    }
    const stored = localSessions().get(sessionId)
    return { sessionId, title: stored ?? (title === '' ? null : title) }
  }
  if (title !== '') {
    const local = localSessions()
    const hits = [...local.entries()].filter(([, stored]) => stored === title)
    if (hits.length === 0) {
      throw new MiraError('addressing/not-found', '本机会话存储里没有标题完全等于「' + title + '」的会话',
        '用 GET /collab/sessions 取 sessionId（稳定 id）；标题必须完全一致，不用前缀猜')
    }
    if (hits.length > 1) {
      throw new MiraError('addressing/ambiguous', '标题「' + title + '」对应 ' + hits.length + ' 个会话',
        '改用 sessionId（GET /collab/sessions）')
    }
    return { sessionId: hits[0][0], title }
  }
  throw new MiraError('addressing/missing', '入站投递需要 sessionId 或 title',
    'body 形如 { "sessionId": "session-…", "text": "…", "splice": true }；sessionId 从 GET /collab/sessions 取')
}

async function deliverInbound(app, body) {
  if (!app.host.available) {
    throw new MiraError('delivery/failed', '本机没有可用的会话投递服务（sessionController 不可用）',
      '宿主能力缺失；请让对端改用「在它正看着的会话里回复」，或升级宿主')
  }
  const text = String(body.text ?? '')
  if (text.trim() === '') {
    throw new MiraError('addressing/invalid', 'text 不能为空', 'body 里给要投递的正文')
  }
  const { sessionId, title } = resolveInboundSession(body)
  const splice = body.splice !== false
  const receiptId = app.tracker.begin({
    target: 'self',
    alias: null,
    sessionId,
    title,
    text,
    transport: 'host',
    meta: { splice, from: body.from ?? null },
  })
  try {
    await app.host.deliver({ sessionId, text, splice, receiptId, from: body.from ?? null })
    app.tracker.markWritten(receiptId)
    app.tracker.setProbe(receiptId, app.host.probe(sessionId))
    const view = await app.client.refreshReceipt(receiptId)
    app.counters.bump('inbound/delivered')
    app.logger?.info?.('[mira_browser] 入站投递已写入本机会话 ' + sessionId + '（' + (splice ? 'steer' : 'followup') + '，receipt=' + receiptId + '）')
    return { ok: true, ...view, session: { sessionId, title } }
  } catch (error) {
    app.tracker.markFailed(receiptId, error)
    app.counters.bump('inbound/failed')
    app.logger?.warn?.('[mira_browser] 入站投递失败 session=' + sessionId + '：' + (error?.message ?? String(error)))
    throw error
  }
}

/* ------------------------------------------------------------------ 运行期目录 ---- */

function ensureRuntimeDirs(config, logger, counters) {
  const report = []
  for (const [key, dir] of [['profiles', config.profilesDir], ['tmp', config.tmpDir]]) {
    const existed = existsSync(dir)
    try {
      ensureDir(dir)
      // 新建的目录按 700 落地：档案目录里有 cookie（约定8），别给同组/其他人读。
      // 已存在的目录不擅自改权限（可能是用户/其它工具共用的），只 warn。
      if (!existed) {
        try { chmodSync(dir, 0o700) } catch { /* 平台不支持就交给 umask */ }
      }
      report.push(key + '=' + dir)
    } catch (error) {
      counters.bump('config/dir-failed')
      logger?.warn?.('[mira_browser] 运行期目录创建失败 ' + key + '=' + dir + '：' + (error?.message ?? String(error)))
    }
  }
  try {
    const mode = fileMode(config.profilesDir)
    if (mode !== -1 && (mode & 0o007) !== 0) {
      counters.bump('config/profiles-world-readable')
      logger?.warn?.('[mira_browser] 浏览器档案目录对其他用户可读（0' + mode.toString(8) + '），里面可能有 cookie；建议 chmod 700 ' + config.profilesDir)
    }
  } catch {
    /* 尽力而为 */
  }
  return report
}

/* ------------------------------------------------------------------ 入口 ---- */

/** 自检用的假 bridge 工厂 / 假时钟（生产为空）。放在模块级是为了不把测试缝塞进配置模型。 */
let createBridgeFactory = null
let clientOverrides = {}
let lastApp = null

export function apply(ctx, rawConfig) {
  const logger = ctx?.logger ?? null
  const counters = makeCounters()
  counters.pluginName = 'mira_browser'

  const loaded = loadConfig({ raw: rawConfig ?? {}, logger, counters })
  const config = loaded.config
  const dirs = ensureRuntimeDirs(config, logger, counters)
  try {
    writeJsonAtomic(join(configDir(), 'loaded.json'), {
      at: nowIso(),
      pid: process.pid,
      version: VERSION,
      tools: true,
      listen: config.listen?.mode ?? 'unset',
    })
  } catch {
    /* 标记写不出来不影响功能 */
  }

  if (!loaded.ok) {
    logger?.warn?.('[mira_browser] 配置不可用（' + loaded.error.code + '）：' + loaded.error.message + '；' + (loaded.error.hint ?? ''))
    counters.bump('start/' + loaded.error.code)
  }
  for (const line of loaded.warnings ?? []) logger?.info?.('[mira_browser] ' + line)
  logger?.info?.('[mira_browser] 运行期目录已就绪：' + dirs.join('，'))

  if (config.enabled === false) {
    logger?.info?.('[mira_browser] 已在配置里禁用（enabled: false）')
    return fail('plugin/disabled', 'mira_browser 被 config.enabled=false 禁用', '把配置里的 enabled 改回 true 再重载')
  }

  // 约定6 单实例：两个实例 = 两套浏览器桥 + 两个监听 = 回执/队列翻倍
  const claim = claimInstance(INSTANCE_ID)
  if (!claim.ok) {
    logger?.warn?.('[mira_browser] 已经有一个实例在跑（pid=' + (claim.holder?.pid ?? '?') + '），本次加载被拒绝：'
      + '两个实例会各开一套浏览器桥与监听端口，同一条消息可能被投两次。检查 profile 是不是把 mira_browser 挂了两遍')
    counters.bump('plugin/instance')
    return fail('plugin/instance', 'mira_browser 已有实例在跑，重复加载被拒绝',
      '检查 profile 的 cordis patch 是否把 mira_browser 挂了两遍；一个进程只允许一个实例')
  }

  let listener = null
  let client = null
  let toolsHandle = null
  let app = null
  let host = null // 在 try 里赋值；inboundStatus 闭包在 try 外，必须先声明

  const inboundStatus = () => {
    const described = listener?.describe?.() ?? {
      mode: config.listen?.mode ?? 'unset',
      host: null,
      port: null,
      url: null,
      state: 'unset',
      loopback: false,
      auth: 'unset',
    }
    const listening = described.state === 'listening'
    return {
      ready: Boolean(listening && host.available),
      listener: described,
      sessionController: host.available,
      reason: !listening
        ? (described.error ? 'listen/failed' : 'listen 未就绪/未配置')
        : !host.available ? '宿主没有 sessionController（只影响入站直投）' : null,
    }
  }

  const wrapCallback = (fn, fallbackCode) => async (arg) => {
    try {
      return await fn(arg)
    } catch (error) {
      const normalized = toError(error, fallbackCode, '看本插件 status/log')
      counters.bump('inbound/' + normalized.error.code)
      return normalized
    }
  }

  try {
    const aliases = new AliasStore({ file: aliasesFile(), logger, counters })
    const tracker = new DeliveryTracker({
      keep: 200,
      inflightTtlMs: 15 * 60 * 1000,
    })
    const queue = new SendQueue()
    host = buildHostDelivery(ctx, logger, counters)

    if (loaded.ok && config.listen.mode !== 'unset' && config.listen.mode !== 'invalid') {
      try {
        listener = new CollabListener({
          listen: config.listen,
          tokenFile: listenTokenFile(),
          version: VERSION,
          logger,
          counters,
          onStatus: wrapCallback(() => app.status(), 'status/failed'),
          onSessions: wrapCallback(() => ({
            ok: true,
            sessions: [...localSessions()].map(([sessionId, title]) => ({ sessionId, title })),
          }), 'sessions/failed'),
          onDeliver: wrapCallback((body) => deliverInbound(app, body), 'delivery/failed'),
          onReceipt: wrapCallback((id) => app.client.refreshReceipt(id), 'receipt/failed'),
        }).start()
      } catch (error) {
        listener = null
        counters.bump('listen/failed')
        logger?.warn?.('[mira_browser] 监听启动失败：' + (error?.message ?? String(error)) + '；collab_* 会报 listen/failed')
      }
    } else if (loaded.ok) {
      logger?.warn?.('[mira_browser] listen 未配置：所有 collab_* 工具会返回 config/missing；'
        + 'MCP 浏览器工具（mcp__aibrowser__*）不受影响。在 ' + configFile()
        + ' 里手填 listen.ip/listen.port，或只监听本机回环时写 "listen": "loopback"')
      counters.bump('start/listen-unset')
    }

    client = new CollabClient({
      config,
      configFile: loaded.file,
      logger,
      counters,
      aliases,
      tracker,
      queue,
      listener,
      version: VERSION,
      createBridge: createBridgeFactory ?? undefined,
      now: clientOverrides.now,
      sleep: clientOverrides.sleep,
      pollMs: clientOverrides.pollMs,
      inboundStatus,
    })

    app = {
      name,
      version: VERSION,
      logger,
      counters,
      pid: process.pid,
      config,
      configFile: loaded.file,
      configError: loaded.error ?? null,
      loadedWarnings: loaded.warnings ?? [],
      self: selfNameOf(config),
      aliases,
      tracker,
      queue,
      listener,
      client,
      host,
      toolNames: [],
      requireConfig() {
        if (app.configError !== null) {
          throw new MiraError(app.configError.code, app.configError.message, app.configError.hint)
        }
        return app.config
      },
      /** 发送需要的两件事：配置可用 + 监听真的起来了（拿到可公布的回信地址）。 */
      async requireAdvertised() {
        app.requireConfig()
        requireListen(app.config, app.configFile)
        requireBrowserRuntime(app.config, app.configFile)
        if (app.listener === null) {
          throw new MiraError('listen/failed', '监听没有启动（listen 配置缺失或绑定失败）',
            '检查 ' + app.configFile + ' 的 listen；改完重载插件')
        }
        const described = await app.listener.ready()
        const replyTo = (typeof app.config.replyUrl === 'string' && app.config.replyUrl.trim() !== '')
          ? app.config.replyUrl.trim()
          : described.url
        return { replyTo, described }
      },
      /** status 用：等监听结果，但**不**把绑定失败抛出去（status 要能回来看状态）。 */
      async waitListen() {
        if (app.listener === null) return null
        try {
          return await app.listener.ready()
        } catch (error) {
          counters.bump('listen/status-error')
          return null
        }
      },
      inboundStatus,
      status() {
        const listen = app.listener?.describe?.() ?? {
          mode: app.config.listen?.mode ?? 'unset',
          host: null,
          port: null,
          url: null,
          state: app.configError ? 'unavailable' : 'unset',
          loopback: false,
          auth: 'unset',
          ...(app.configError ? { error: app.configError } : {}),
        }
        const configView = {
          file: app.configFile,
          schemaVersion: CONFIG_VERSION,
          configError: app.configError,
          listen: {
            mode: app.config.listen?.mode ?? 'unset',
            host: app.config.listen?.ip ?? null,
            port: app.config.listen?.port ?? null,
          },
          replyTo: app.client ? app.client.advertisedReplyTo() : null,
          self: app.self,
          localGuiUrl: app.config.localGuiUrl,
          proxyPort: app.config.proxyPort,
          profilesDir: app.config.profilesDir,
          tmpDir: app.config.tmpDir,
          python: app.config.python,
          aiBrowserHome: app.config.aiBrowserHome,
          playwrightBrowsersPath: app.config.playwrightBrowsersPath,
          targets: targetsView(app.config, logger),
        }
        return app.client.statusSnapshot({ configView, inbound: inboundStatus() })
      },
    }

    if (ctx && ctx.tools && typeof ctx.tools.register === 'function') {
      toolsHandle = registerTools(ctx, app)
    } else {
      logger?.warn?.('[mira_browser] tools 服务不可用，未注册 collab_* 工具（MCP 浏览器工具是另一行，不受影响）')
    }

    lastApp = app

    const described = app.listener?.describe?.() ?? null
    logger?.info?.('[mira_browser] 已加载 v' + VERSION + '：配置 ' + loaded.file
      + (loaded.created ? '（已生成模板，需要手填 listen）' : '')
      + '；目标 ' + config.targets.length + ' 个；别名 ' + aliases.summary().count + ' 条；'
      + 'collab 工具 ' + app.toolNames.length + ' 个'
      + (described === null ? '；listen 未配置' : '；listen ' + (described.url ?? described.state)))

    if (ctx && typeof ctx.effect === 'function') {
      ctx.effect(() => async () => {
        // 顺序：先摘工具 → 停桥 → 关监听 → 放认领。
        // 队列/tracker 都是进程内状态，不需要落盘（也就不会出现「旧实例用旧状态覆写新文件」）。
        try { toolsHandle?.dispose() } catch { /* 退场不抛 */ }
        try { await client?.closeBrowsers() } catch { /* noop */ }
        try { await listener?.close() } catch { /* noop */ }
        try { app.tracker.clear() } catch { /* noop */ }
        try { app.queue.clear() } catch { /* noop */ }
        try { claim.release() } catch { /* noop */ }
        if (lastApp === app) lastApp = null
      })
    }

    return {
      ok: true,
      version: VERSION,
      configFile: loaded.file,
      configCreated: loaded.created,
      listen: described,
      aliasesFile: aliasesFile(),
      tools: app.toolNames,
    }
  } catch (error) {
    // 装配期意外：释放认领，别把「半初始化」的实例留在注册表里
    try { claim.release() } catch { /* noop */ }
    try { if (toolsHandle) toolsHandle.dispose() } catch { /* noop */ }
    try { if (listener) await0(listener.close()) } catch { /* noop */ }
    counters.bump('start/failed')
    const normalized = toError(error, 'plugin/start-failed', '看宿主日志')
    logger?.warn?.('[mira_browser] 加载失败：' + normalized.error.message)
    return normalized
  }
}

/** 同步上下文里触发一个 promise 并吞掉结果（只用于退场兜底，不阻塞返回）。 */
function await0(promise) {
  if (promise && typeof promise.then === 'function') promise.then(() => undefined, () => undefined)
  return undefined
}

/* --------------------------------------------------------------- 自检钩子 ---- */

/**
 * 不是运行时 API，只给 `test/smoke.mjs` 用：
 *   setCreateBridge(fn)  注入假浏览器桥（生产不注入，默认 new BrowserBridge）
 *   get lastApp          最近一次装配的 app（拿 listener.ready / tracker 等做白盒断言）
 */
export const __testing = {
  version: VERSION,
  setCreateBridge(factory) {
    createBridgeFactory = factory
  },
  resetCreateBridge() {
    createBridgeFactory = null
  },
  /** 假时钟：只影响 collab_wait 的轮询/截止（不影响回执 waitedMs 的真实时间）。 */
  setClientOptions(options) {
    clientOverrides = options && typeof options === 'object' ? options : {}
  },
  resetClientOptions() {
    clientOverrides = {}
  },
  get lastApp() {
    return lastApp
  },
  resolveTarget,
  resolveInboundSession,
  requireListen,
}
