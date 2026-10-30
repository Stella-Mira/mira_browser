/**
 * mira_browser 自检：node test/smoke.mjs
 *
 * 全过 → 退出码 0，末行 `==== ALL PASS（N 项断言）====`；失败逐行 `[FAIL] 编号 说明`，退出码 1。
 *
 * 覆盖 tool_shared/PLAN.md §1.5 的 E1–E7，以及本轮明确加的兼容约束：
 *   E2  缺 listen（且不是 loopback）→ collab_* 报 config/missing，hint 含 listen 与配置文件路径；
 *       插件本身照常加载、运行期目录照建（MCP 浏览器工具不受影响）
 *   E3  listen:"loopback" → 实际监听 127.0.0.1（用 GET /healthz 反向证明），send ok
 *   E4  用别名发送 → 一级回执 level:1、aliases.json 落盘 / lastUsedAt 回写；默认插话
 *   E5  对端开跑后 → 二级回执 pending → running → read（只前进）
 *   E6  send_many 3 个目标其中 1 个投递失败 → 3 条回执，失败的只有那一条
 *   E7  collab_status 含 bridges/sessions/queue/inflight[{target,waitedMs}]
 *   另测：单实例、schemaVersion 不匹配、别名表坏、旧 profile 键兼容、凭据不回显、
 *         入站 API（/collab/sessions、/collab/deliver、/collab/receipts）、非回环令牌。
 *
 * 全程假 bridge / 假宿主，不 spawn Python、不驱动浏览器、不连对端。
 */

import {
  chmodSync,
  existsSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'

/* ── 断言框架（与 mira_active/test/smoke.mjs 同风格） ───── */

let passed = 0
const failures = []
let current = '(未命名)'

function check(ok, message) {
  if (ok) {
    passed += 1
    return true
  }
  failures.push('[' + current + '] ' + message)
  return false
}

function eq(actual, expected, message) {
  return check(
    JSON.stringify(actual) === JSON.stringify(expected),
    message + '（期望 ' + JSON.stringify(expected) + '，实得 ' + JSON.stringify(actual) + '）',
  )
}

/** 每个用例结束（无论成败）都释放它建的 ctx，避免一个失败把单实例认领留给下个用例。 */
const activeCtxs = []

async function test(id, name, fn) {
  current = id + ' ' + name
  try {
    await fn()
  } catch (error) {
    failures.push('[' + current + '] 抛异常：' + (error && error.stack ? error.stack.split('\n').slice(0, 4).join(' | ') : String(error)))
  } finally {
    for (const ctx of activeCtxs.splice(0).reverse()) {
      try { await ctx.dispose() } catch { /* 退场不抛 */ }
    }
    try { __testing.resetCreateBridge() } catch { /* noop */ }
    try { __testing.resetClientOptions() } catch { /* noop */ }
  }
}

/* ── 隔离环境：每个用例一个 DSH_HOME ───────────────────── */

const TMP = mkdtempSync(join(tmpdir(), 'mira-browser-smoke-'))
process.env.DSH_HOME = TMP
process.env.DSH_SESSION_ID = 'session-test-self'

const logLines = []
const logger = {
  info: (message) => logLines.push('I ' + message),
  warn: (message) => logLines.push('W ' + message),
  error: (message) => logLines.push('E ' + message),
  debug: () => {},
}

const { apply, __testing } = await import('../lib/index.js')
const { __testing: collabTest, resolveTarget, isExpiredSessionError } = await import('../lib/collab.js')
const { CollabListener } = await import('../lib/listen.js')
const { BrowserBridge } = await import('../lib/bridge.js')
const lockTest = await import('../lib/profile-lock.js')

const IDS = { a: 'session-aaaa1111', b: 'session-bbbb2222' }
const FAKE_SESSIONS = {
  [IDS.a]: '兄弟聊天',
  [IDS.b]: '工作区会话',
}

let caseSeq = 0

function writeSessionStore(home) {
  mkdirSync(join(home, 'storages'), { recursive: true })
  const sessions = {}
  for (const [sessionId, title] of Object.entries(FAKE_SESSIONS)) {
    sessions[sessionId] = { rows: { title: { val: title } } }
  }
  writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({ tables: { sessions } }))
}

function freshHome() {
  caseSeq += 1
  const home = join(TMP, 'case-' + caseSeq)
  process.env.DSH_HOME = home
  writeSessionStore(home)
  const configDir = join(home, 'mira_config', 'mira_browser')
  return {
    home,
    configDir,
    configFile: join(configDir, 'config.json'),
    aliasesFile: join(configDir, 'aliases.json'),
  }
}

function writeConfig(homeInfo, value) {
  mkdirSync(homeInfo.configDir, { recursive: true })
  writeFileSync(homeInfo.configFile, JSON.stringify(value, null, 2))
}

function loopbackConfig(extra = {}) {
  return { schemaVersion: 1, listen: 'loopback', localGuiUrl: 'http://127.0.0.1:3080/', proxyPort: 8543, targets: [], ...extra }
}

/** 取一个当前空闲的 127.0.0.1 端口（只为手填对象形态的 listen 用；不是插件在探测）。 */
async function freePort(host = '127.0.0.1') {
  const server = createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port: 0 }, resolve)
  })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

/* ── 假 ctx（宿主能力） ─────────────────────────────────── */

function makeCtx() {
  const tools = new Map()
  const disposers = []
  const steers = []
  const followups = []
  const agent = {
    id: IDS.a,
    session: { id: IDS.a },
    status: 'idle',
    steer(message) { steers.push(message) },
    followup(message) { followups.push(message) },
  }
  const sessions = {
    flushed: 0,
    async flush() { this.flushed += 1 },
  }
  const ctx = {
    logger,
    tools: {
      register(def) {
        tools.set(def.name, def)
        return () => { tools.delete(def.name) }
      },
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return () => {}
    },
    sessionController: {
      async resolveAgent(sessionId) {
        if (sessionId !== IDS.a && sessionId !== IDS.b) throw new Error('session not found: ' + sessionId)
        return agent
      },
    },
    sessions,
    toolsMap: tools,
    steers,
    followups,
    agent,
    sessionsSvc: sessions,
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          const result = typeof dispose === 'function' ? dispose() : null
          if (result && typeof result.then === 'function') await result
        } catch { /* 退场不抛 */ }
      }
      disposers.length = 0
    },
  }
  activeCtxs.push(ctx)
  return ctx
}

async function call(ctx, name, args = {}, exec = {}) {
  const def = ctx.toolsMap.get(name)
  if (def === undefined) throw new Error('工具不存在：' + name)
  const raw = await def.execute(args, exec)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('工具返回不是 JSON：' + String(raw).slice(0, 200))
  }
}

/* ── 假浏览器桥（不 spawn 任何进程） ────────────────────── */

function makeFakeBridge(options = {}) {
  const state = {
    rows: [
      { title: FAKE_SESSIONS[IDS.a], selected: false, raw: FAKE_SESSIONS[IDS.a] },
      { title: FAKE_SESSIONS[IDS.b], selected: false, raw: FAKE_SESSIONS[IDS.b] },
    ],
    groups: [],
    // 折叠工作区分组里挂着的会话：{ 分组名: [sessionId, ...] }（缺省空，不影响既有用例）。
    // 只有「点击这个 expanded:false 的 projectRow」时才把这些行加进 state.rows —— 与真实 GUI
    // 一致，也是 select() 那段「找不到就展开折叠分组再重读」逻辑的可观测副作用。
    groupSessions: {},
    // sessionId → 标题（给折叠分组里的会话造标题用；缺省空）
    sessionTitles: {},
    texts: [],
    composerState: { placeholder: '给智能体发消息', value: '', queue: 0, busy: false },
    lastFilled: '',
    echoOnPress: false,
    failWhenFilledIncludes: null,
    hold: null, // { promise, onEnter }
    opened: 0,
    // 注入「桥报会话过期/其它错误」的钩子（可选）：(op, args) => void，抛异常即失败。
    // 用来验证「过期自愈」与「别的错误不误重开」，不需要真的杀掉浏览器。
    beforeRequest: null,
  }
  const bridge = {
    running: true,
    state,
    options,
    requests: [],
    async request(op, args = {}) {
      bridge.requests.push({ op, args })
      if (typeof state.beforeRequest === 'function') state.beforeRequest(op, args)
      if (op === 'open') {
        state.opened += 1
        return { session_id: 'sid-' + state.opened, url: args.url }
      }
      if (op === 'wait') return {}
      if (op === 'texts') {
        return { texts: state.texts.map((text) => ({ text })), page_url: 'http://fake.invalid/' }
      }
      if (op === 'press') {
        state.hold?.onEnter?.()
        if (state.hold) await state.hold.promise
        if (state.failWhenFilledIncludes && state.lastFilled.includes(state.failWhenFilledIncludes)) {
          throw new Error('fake bridge: press 失败（脚本注入）')
        }
        if (state.echoOnPress && state.lastFilled !== '') state.texts.push(state.lastFilled)
        return { receipt: {} }
      }
      if (op === 'cdp_click') return { receipt: {} }
      if (op === 'act') {
        const action = args.action ?? {}
        if (action.action === 'click_text') {
          const row = state.rows.find((item) => item.title === action.text)
          if (row) {
            for (const item of state.rows) item.selected = false
            row.selected = true
            return { receipt: { clicked: action.text } }
          }
          // 折叠的工作区分组（projectRow）：点一下就展开，把它名下的会话行露出来。
          const group = state.groups.find((item) => item.name === action.text)
          if (group !== undefined && group.expanded === false) {
            group.expanded = true
            for (const sessionId of state.groupSessions[group.name] ?? []) {
              const title = state.sessionTitles[sessionId] ?? FAKE_SESSIONS[sessionId] ?? sessionId
              if (!state.rows.some((item) => item.title === title)) {
                state.rows.push({ title, selected: false, raw: title })
              }
            }
            return { receipt: { clicked: action.text, expanded: true } }
          }
          return { receipt: { clicked: action.text } }
        }
        if (action.action === 'dom_eval') {
          const js = action.js
          if (js === collabTest.jsSidebar()) {
            return {
              dom_eval: {
                result: {
                  rows: state.rows.map((row) => ({ ...row })),
                  groups: state.groups.map((group) => ({ ...group })),
                  url: null,
                  title: null,
                },
              },
            }
          }
          if (js === collabTest.jsComposer()) {
            return {
              dom_eval: {
                result: {
                  aiId: 'a1',
                  tag: 'TEXTAREA',
                  placeholder: state.composerState.placeholder,
                  value: state.composerState.value,
                },
              },
            }
          }
          if (js === collabTest.jsComposerState()) {
            return { dom_eval: { result: { ...state.composerState } } }
          }
          return { dom_eval: { result: null } }
        }
        if (typeof action.id === 'string') {
          state.composerState.value = action.text
          state.lastFilled = action.text
          return { receipt: {} }
        }
      }
      throw new Error('fake bridge: 未支持的 op ' + op)
    },
    async stop() {
      bridge.running = false
    },
  }
  return bridge
}

function makeBridgeFactory(configure = null) {
  const bridges = []
  const factory = (options) => {
    const bridge = makeFakeBridge(options)
    if (typeof configure === 'function') configure(bridge)
    bridges.push(bridge)
    return bridge
  }
  factory.bridges = bridges
  factory.last = () => bridges[bridges.length - 1]
  return factory
}

/** 每个用例都换一个假工厂，避免上一个用例的 bridge 状态串味。 */
function useFakeBridge(configure = null) {
  __testing.setClientOptions({})
  const factory = makeBridgeFactory(configure)
  __testing.setCreateBridge(factory)
  return factory
}

/* ==================================================================== E2 ==== */

await test('E2', '缺 listen：插件照常加载、collab_* 报 config/missing（hint 含 listen 与配置文件路径）', async () => {
  const home = freshHome()
  const factory = useFakeBridge()
  const ctx = makeCtx()

  // 模拟本机 profile 现在传的那一层：键名一个不改（整体替换，不是深合并）
  const profileConfig = {
    enabled: true,
    python: join(home.home, 'fake-python', 'bin', 'python'),
    aiBrowserHome: join(home.home, 'fake-ai-browser'),
    playwrightBrowsersPath: join(home.home, 'fake-pw'),
    root: join(home.home, 'legacy-root'),
    profilesDir: join(home.home, 'profiles'),
    tmpDir: join(home.home, 'tmp'),
    localGuiUrl: 'http://127.0.0.1:3080/',
    proxyPort: 8543,
    targets: [],
  }

  const applied = apply(ctx, profileConfig)
  eq(applied.ok, true, '缺 listen 不应让插件加载失败（MCP 浏览器工具要继续可用）')
  eq(ctx.toolsMap.size, 10, '应注册 10 个 collab 工具（实得 ' + [...ctx.toolsMap.keys()].join(',') + '）')

  const app = __testing.lastApp
  eq(app.config.listen.mode, 'unset', 'listen 应为未配置')
  eq(app.config.python, profileConfig.python, 'profile 的 python 键必须继续生效')
  eq(app.config.aiBrowserHome, profileConfig.aiBrowserHome, 'profile 的 aiBrowserHome 键必须继续生效')
  eq(app.config.playwrightBrowsersPath, profileConfig.playwrightBrowsersPath, 'profile 的 playwrightBrowsersPath 键必须继续生效')
  eq(app.config.profilesDir, profileConfig.profilesDir, 'profile 的 profilesDir 键必须继续生效')
  eq(app.config.tmpDir, profileConfig.tmpDir, 'profile 的 tmpDir 键必须继续生效')
  eq(app.config.localGuiUrl, 'http://127.0.0.1:3080/', 'profile 的 localGuiUrl 键必须继续生效')
  eq(app.config.proxyPort, 8543, 'profile 的 proxyPort 键必须继续生效')
  eq(app.config.root, join(home.home, 'legacy-root'), 'profile 的 root 键必须继续生效')

  check(existsSync(home.configFile), '应在 config.json 不存在时生成模板，给用户手填 listen')
  const template = JSON.parse(readFileSync(home.configFile, 'utf8'))
  eq(template.schemaVersion, 1, '配置模板必须带 schemaVersion')
  eq(template.listen, { ip: '', port: 0 }, '模板里的 listen 必须是空的（不猜地址）')

  // MCP 那一行依赖的运行期目录：即使 collab 缺 listen，也必须先建好
  check(existsSync(profileConfig.profilesDir), '浏览器档案目录应先建好（MCP 行依赖它）')
  check(existsSync(profileConfig.tmpDir), '临时目录应先建好（Playwright 依赖它）')
  eq(statSync(profileConfig.profilesDir).mode & 0o777, 0o700, '新建的浏览器档案目录应 700（里面有 cookie）')

  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'hi' })
  eq(sent.ok, false, '缺 listen 时 collab_send 应失败')
  eq(sent.error.code, 'config/missing', '错误码应是 config/missing')
  check(String(sent.error.hint).includes('listen'), 'hint 必须含 listen：' + sent.error.hint)
  check(String(sent.error.hint).includes('loopback'), 'hint 必须告诉用户「可以写 loopback」：' + sent.error.hint)
  check(String(sent.error.hint).includes(home.configFile), 'hint 必须指出配置文件路径：' + sent.error.hint)
  eq(statSync(home.configFile).mode & 0o777, 0o600, '自动生成的配置模板应 600（可能含口令）')
  check(String(sent.error.message).includes('listen'), 'message 也要点出缺的项：' + sent.error.message)

  // 本轮兼容约束：投递类 collab_* 走同一门槛
  for (const name of ['collab_list', 'collab_alias_list']) {
    const result = await call(ctx, name, {})
    eq(result.ok, false, name + ' 也应报 config/missing')
    eq(result.error?.code, 'config/missing', name + ' 的错误码')
  }

  // 但 status 必须仍然可读：配置不全时最需要看状态（否则「为什么发不出去」无处可查）
  const status = await call(ctx, 'collab_status', {})
  eq(status.ok, true, '缺 listen 时 collab_status 仍应可读')
  eq(status.listen?.state, 'unset', 'status 应如实报告 listen 未配置')
  eq(status.listen?.error?.code, 'config/missing', 'status 应带 config/missing 的 listen.error')
  check(Array.isArray(status.warnings) && status.warnings.some((w) => String(w).includes('listen')),
    'status.warnings 里要说明 listen 未配置：' + JSON.stringify(status.warnings))
  eq(factory.bridges.length, 0, '缺 listen 时不应创建任何浏览器桥')

  eq(resolveTarget(app.config, 'proxy').url, 'https://127.0.0.1:8543/', 'proxy 目标应回落到 proxyPort（旧行为）')
  await ctx.dispose()
})

/* ==================================================================== E3 ==== */

await test('E3', 'listen:"loopback" → 实际监听 127.0.0.1、send ok；二级回执默认 pending', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const ctx = makeCtx()

  const applied = apply(ctx, {})
  eq(applied.ok, true, 'apply 应成功')
  const app = __testing.lastApp
  eq(app.config.listen.mode, 'loopback', 'listen 模式应是 loopback')

  const desc = await app.listener.ready()
  eq(desc.state, 'listening', '监听应就绪')
  eq(desc.host, '127.0.0.1', '实际绑定地址必须是 127.0.0.1')
  check(desc.port > 0, '实际端口应大于 0（loopback 形态由系统分配）')
  eq(desc.auth, 'loopback', '回环监听不需要令牌')

  const status = await call(ctx, 'collab_status', {})
  eq(status.ok, true, 'collab_status 应成功')
  eq(status.listen.host, '127.0.0.1', 'status 里的实际监听地址')
  eq(status.listen.port, desc.port, 'status 端口 = 实际端口')
  eq(status.config.replyTo, desc.url, 'replyTo 应由实际监听地址推导（不探测）')
  eq(typeof status.bridges, 'number', 'status 含 bridges 数字')
  eq(typeof status.sessions, 'number', 'status 含 sessions 数字')

  // 真发一次 HTTP 请求：证明「实际监听」不是配置里写着好看
  const healthRes = await fetch(desc.url + 'healthz', { signal: AbortSignal.timeout(3000) })
  eq(healthRes.status, 200, 'GET /healthz 应 200')
  const health = await healthRes.json()
  eq(health.ok, true, 'healthz ok')
  eq(health.listen.host, '127.0.0.1', 'healthz 报告实际监听地址')
  eq(health.listen.port, desc.port, 'healthz 报告实际端口')

  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'loopback 测试' })
  eq(sent.ok, true, 'loopback 下 collab_send 应成功：' + JSON.stringify(sent))
  eq(sent.receipt.level, 1, '一级回执 level 应为 1')
  eq(sent.mode, 'splice', '默认投递方式是插话')
  const fake = factory.last()
  eqStringIncludes(fake.state.lastFilled, 'loopback 测试', '正文应写进对端输入框')
  eqStringIncludes(fake.state.lastFilled, 'reply_to=' + desc.url, '信封里应带手填监听地址推导出的 reply_to')

  await ctx.dispose()
})

/* ================================================================ E3b ===== */

await test('E3b', 'listen:{ip,port} 手填对象形态 → 绑指定端口，不走自动探测', async () => {
  const home = freshHome()
  const port = await freePort()
  writeConfig(home, { schemaVersion: 1, listen: { ip: '127.0.0.1', port }, targets: [] })
  useFakeBridge()
  const ctx = makeCtx()
  const applied = apply(ctx, {})
  eq(applied.ok, true, 'apply 应成功')
  const app = __testing.lastApp
  eq(app.config.listen.mode, 'manual', '对象形态应是 manual')
  const desc = await app.listener.ready()
  eq(desc.port, port, '必须绑手填的端口')
  eq(desc.host, '127.0.0.1', '必须绑手填的地址')
  eq(desc.mode, 'manual', 'describe 里 mode 为 manual')
  await ctx.dispose()
})

/* ==================================================================== E4 ==== */

await test('E4', '别名发送：一级回执 level:1、别名表落盘/lastUsedAt、默认插话、不依赖标题前缀', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  const set = await call(ctx, 'collab_alias_set', { alias: 'brother', target: 'local', sessionId: IDS.a })
  eq(set.ok, true, '别名应登记成功：' + JSON.stringify(set))
  check(existsSync(home.aliasesFile), 'aliases.json 应落盘')
  const table = JSON.parse(readFileSync(home.aliasesFile, 'utf8'))
  eq(table.schemaVersion, 1, '别名表带 schemaVersion')
  eq(table.aliases.brother.target, 'local', '别名记录 target')
  eq(table.aliases.brother.sessionId, IDS.a, '别名记录本机稳定 id')
  check(typeof table.aliases.brother.updatedAt === 'string', '别名记录 updatedAt')

  const sent = await call(ctx, 'collab_send', { alias: 'brother', text: '你好，哥哥' })
  eq(sent.ok, true, '按别名发送应成功：' + JSON.stringify(sent))
  eq(sent.receipt.level, 1, '一级回执 level 必须是 1')
  eq(sent.to.alias, 'brother', '回执里带别名')
  eq(sent.to.title, FAKE_SESSIONS[IDS.a], '别名经 sessionId 解析到会话标题（不是猜前缀）')
  eq(sent.to.sessionId, IDS.a, '回执里带稳定 id')
  eq(sent.mode, 'splice', '默认必须是插话')
  check(typeof sent.receiptId === 'string' && sent.receiptId.startsWith('r-'), '应返回 receiptId')

  const afterSend = JSON.parse(readFileSync(home.aliasesFile, 'utf8'))
  check(typeof afterSend.aliases.brother.lastUsedAt === 'string', '发送后应回写 lastUsedAt（别名表原子落盘）')
  check(!existsSync(home.aliasesFile + '.tmp'), '原子写不应留下 .tmp')
  const pressOps = factory.last().requests.filter((item) => item.op === 'press')
  eq(pressOps[pressOps.length - 1].args.modifiers, ['Control'], '插话必须按 Ctrl+Enter')

  const queued = await call(ctx, 'collab_send', { alias: 'brother', text: '排队', splice: false })
  eq(queued.ok, true, 'splice:false 也应成功')
  eq(queued.mode, 'queue', 'splice:false 的模式是排队')
  const pressOps2 = factory.last().requests.filter((item) => item.op === 'press')
  eq(pressOps2[pressOps2.length - 1].args.modifiers, [], '排队用不带修饰键的 Enter')

  // 功能点7：不依赖标题前缀。别名 title 是「兄弟」，侧边栏里只有「兄弟聊天」→ 必须找不到，不能前缀命中
  const prefixAlias = await call(ctx, 'collab_alias_set', { alias: 'brother-prefix', target: 'local', title: '兄弟' })
  eq(prefixAlias.ok, true, '登记一个前缀标题的别名（登记本身不探测）')
  const bad = await call(ctx, 'collab_send', { alias: 'brother-prefix', text: '不该命中' })
  eq(bad.ok, false, '前缀标题不应命中「兄弟聊天」')
  eq(bad.error.code, 'addressing/not-found', '应报 addressing/not-found（不是前缀猜测成功）')

  const conflict = await call(ctx, 'collab_alias_set', { alias: 'brother', target: 'local', title: FAKE_SESSIONS[IDS.b] })
  eq(conflict.ok, false, '已存在别名默认不允许改指向')
  eq(conflict.error.code, 'addressing/conflict', '应报 addressing/conflict')
  const overwritten = await call(ctx, 'collab_alias_set', {
    alias: 'brother',
    target: 'local',
    title: FAKE_SESSIONS[IDS.b],
    overwrite: true,
  })
  eq(overwritten.ok, true, 'overwrite:true 才允许改指向')

  const listed = await call(ctx, 'collab_alias_list', {})
  eq(listed.ok, true, '别名列表应成功')
  eq(listed.count, 2, '应有 2 个别名')
  const removed = await call(ctx, 'collab_alias_remove', { alias: 'brother-prefix' })
  eq(removed.ok, true, '删除别名应成功')
  eq(removed.removed, true, '应真的删掉')

  await ctx.dispose()
})

/* ==================================================================== E5 ==== */

await test('E5', '二级回执：pending → running → read（只前进），collab_wait 也带回', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const clock = { t: 1_000_000 }
  __testing.setClientOptions({ now: () => clock.t, sleep: async (ms) => { clock.t += ms }, pollMs: 5000 })
  const ctx = makeCtx()
  apply(ctx, {})

  await call(ctx, 'collab_alias_set', { alias: 'brother', target: 'local', sessionId: IDS.a })
  const sent = await call(ctx, 'collab_send', { alias: 'brother', text: '等你开跑' })
  eq(sent.ok, true, '发送应成功')
  eq(sent.receiptLevel2.state, 'pending', '刚写入、页面还没动静时应是 pending')

  const fake = factory.last()
  fake.state.composerState.busy = true
  const running = await call(ctx, 'collab_receipt', { id: sent.receiptId })
  eq(running.ok, true, '查回执应成功')
  eq(running.receiptLevel2.state, 'running', '对端开跑后应变成 running')
  check(typeof running.receiptLevel2.evidence === 'string', 'running 应带证据：' + JSON.stringify(running.receiptLevel2))

  fake.state.texts = [fake.state.lastFilled]
  const read = await call(ctx, 'collab_receipt', { id: sent.receiptId })
  eq(read.receiptLevel2.state, 'read', '看到文本后应变成 read')

  fake.state.composerState.busy = false
  fake.state.texts = []
  const still = await call(ctx, 'collab_receipt', { id: sent.receiptId })
  eq(still.receiptLevel2.state, 'read', '状态只前进不后退')

  const waited = await call(ctx, 'collab_wait', { alias: 'brother', seconds: 5 })
  eq(waited.ok, true, 'collab_wait 应成功')
  eq(waited.timeout, true, '没有新文本应 timeout=true（不是错误）')
  eq(waited.receiptId, sent.receiptId, 'wait 应挂上最近一条回执')
  eq(waited.receiptLevel2.state, 'read', 'wait 也应带回二级回执')

  __testing.resetClientOptions()
  await ctx.dispose()
})

/* ==================================================================== E6 ==== */

await test('E6', 'send_many：3 个目标其中 1 个投递失败 → 3 条回执，失败的只有那一条', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge((bridge) => { bridge.state.failWhenFilledIncludes = 'FAIL' })
  const ctx = makeCtx()
  apply(ctx, {})

  await call(ctx, 'collab_alias_set', { alias: 'a1', target: 'local', sessionId: IDS.a })
  await call(ctx, 'collab_alias_set', { alias: 'a2', target: 'local', sessionId: IDS.b })
  await call(ctx, 'collab_alias_set', { alias: 'a3', target: 'local', sessionId: IDS.a })

  const batch = await call(ctx, 'collab_send_many', {
    items: [
      { alias: 'a1', text: '第一条' },
      { alias: 'a2', text: 'FAIL 这一条会失败' },
      { alias: 'a3', text: '第三条' },
    ],
  })
  eq(batch.requested, 3, '应请求 3 条')
  eq(batch.results.length, 3, '必须有 3 条回执')
  eq(batch.sent, 2, '成功 2 条')
  eq(batch.failed, 1, '失败 1 条')
  eq(batch.ok, true, '至少一条成功 → 顶层 ok=true')
  eq(batch.partial, true, '部分失败应标 partial=true')
  eq(batch.results[0].ok, true, '第 1 条成功')
  eq(batch.results[0].receipt.level, 1, '第 1 条有一级回执')
  eq(batch.results[1].ok, false, '第 2 条失败')
  eq(batch.results[1].error.code, 'delivery/failed', '第 2 条错误码')
  eq(batch.results[2].ok, true, '第 3 条成功（不被第 2 条阻断）')
  eq(batch.results[2].receipt.level, 1, '第 3 条有一级回执')
  eq(factory.last().requests.filter((item) => item.op === 'press').length, 3, '三条都真的尝试过 press')

  const status = await call(ctx, 'collab_status', {})
  eq(status.queue.length, 0, '完成后 queue 应为空（失败的那条也已出队）')
  eq(status.inflight.length, 2, 'in-flight 只应有两条成功的（失败的一级未成立，不进 inflight）')

  const allBad = await call(ctx, 'collab_send_many', {
    items: [{ alias: 'nope-1', text: 'x' }, { alias: 'nope-2', text: 'y' }],
  })
  eq(allBad.ok, false, '全部失败时顶层 ok=false')
  eq(allBad.results.length, 2, '仍要逐条回执')
  eq(allBad.results.every((item) => item.ok === false), true, '每条都带自己的错误')
  eq(allBad.error.code, 'delivery/failed', '顶层错误码')

  await ctx.dispose()
})

/* ==================================================================== E7 ==== */

await test('E7', 'collab_status 含 bridges/sessions/queue/inflight[{target,waitedMs}]', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  await call(ctx, 'collab_alias_set', { alias: 'brother', target: 'local', sessionId: IDS.a })
  const first = await call(ctx, 'collab_send', { alias: 'brother', text: '第一条（页面无回显）' })
  eq(first.ok, true, '第一条应成功')
  eq(first.receiptLevel2.state, 'pending', '第一条留在 in-flight')

  // 第二条卡在 press：制造一个真实在等的 queue 条目
  const fake = factory.last()
  let enterResolve
  const entered = new Promise((resolve) => { enterResolve = resolve })
  let release
  const gate = new Promise((resolve) => { release = resolve })
  fake.state.hold = { promise: gate, onEnter: enterResolve }
  const pendingSend = call(ctx, 'collab_send', { alias: 'brother', text: '第二条（卡住）' })
  await entered

  const status = await call(ctx, 'collab_status', {})
  eq(status.ok, true, 'status 应成功')
  eq(typeof status.bridges, 'number', 'bridges 应是数字')
  eq(typeof status.sessions, 'number', 'sessions 应是数字')
  check(Array.isArray(status.queue), 'queue 应是数组')
  eq(status.queue.length >= 1, true, '卡住的发送应出现在 queue 里')
  eq(status.queue[0].target, 'local', 'queue 的 target')
  eq(typeof status.queue[0].waitedMs, 'number', 'queue 的 waitedMs')
  check(status.queue[0].waitedMs >= 0, 'waitedMs 非负')
  check(Array.isArray(status.inflight), 'inflight 应是数组')
  eq(status.inflight.length >= 1, true, '第一条应在 inflight')
  eq(status.inflight[0].target, 'local', 'inflight 的 target')
  eq(typeof status.inflight[0].waitedMs, 'number', 'inflight 的 waitedMs')
  eq(status.inflight[0].receiptLevel2.state, 'pending', 'inflight 的二级状态')
  eq(status.receipts.pending >= 1, true, 'receipts 计数里应有 pending')

  release()
  fake.state.hold = null
  const second = await pendingSend
  eq(second.ok, true, '放行后第二条应成功')
  const status2 = await call(ctx, 'collab_status', {})
  eq(status2.queue.length, 0, '完成后 queue 为空')
  check(status2.inflight.length >= 2, '两条在途都应可见（pending）')

  await ctx.dispose()
})

/* ================================================================ 单实例 ==== */

await test('X1', '单实例：第二次 apply → plugin/instance；释放后可以再加载', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  useFakeBridge()

  const ctx1 = makeCtx()
  const first = apply(ctx1, {})
  eq(first.ok, true, '第一次 apply 应成功')
  eq(ctx1.toolsMap.size, 10, '第一次应注册工具')

  const ctx2 = makeCtx()
  const second = apply(ctx2, {})
  eq(second.ok, false, '第二次 apply 应失败')
  eq(second.error.code, 'plugin/instance', '错误码应是 plugin/instance')
  eq(ctx2.toolsMap.size, 0, '被拒绝的实例不应注册工具')
  check(logLines.some((line) => line.includes('已经有一个实例在跑')), '应写一行 warn')

  await ctx1.dispose()
  const ctx3 = makeCtx()
  const third = apply(ctx3, {})
  eq(third.ok, true, '释放后应可再次加载')
  await ctx3.dispose()
})

/* ========================================================= schemaVersion ==== */

await test('X2', 'schemaVersion 不匹配：拒绝使用配置、工具报 config/schema、文件原样保留', async () => {
  const home = freshHome()
  writeConfig(home, { schemaVersion: 99, listen: 'loopback' })
  useFakeBridge()
  const ctx = makeCtx()
  const applied = apply(ctx, {})
  eq(applied.ok, true, '插件本身仍加载（MCP 浏览器工具不受影响）')
  const app = __testing.lastApp
  eq(app.configError.code, 'config/schema', '应记录 config/schema')
  eq(app.listener, null, 'schema 不匹配不应起监听')
  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'x' })
  eq(sent.ok, false, '工具应拒绝使用配置')
  eq(sent.error.code, 'config/schema', '错误码 config/schema')
  check(String(sent.error.hint).includes('迁移') || String(sent.error.hint).includes('schemaVersion'), '应给迁移提示：' + sent.error.hint)
  eq(JSON.parse(readFileSync(home.configFile, 'utf8')).schemaVersion, 99, '不得覆盖用户文件')
  await ctx.dispose()
})

await test('X3', '别名表 schemaVersion 不匹配：别名不可用，但按标题投递照常、文件保留', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  mkdirSync(home.configDir, { recursive: true })
  writeFileSync(home.aliasesFile, JSON.stringify({ schemaVersion: 99, aliases: {} }))
  useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  const list = await call(ctx, 'collab_alias_list', {})
  eq(list.ok, false, '别名列表应失败')
  eq(list.error.code, 'config/schema', '错误码 config/schema')
  const byAlias = await call(ctx, 'collab_send', { alias: 'brother', text: 'x' })
  eq(byAlias.ok, false, '别名寻址应失败')
  eq(byAlias.error.code, 'config/schema', '别名表 schema 错误应透出')
  const byTitle = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'x' })
  eq(byTitle.ok, true, '不依赖别名表的标题投递仍可用')
  eq(JSON.parse(readFileSync(home.aliasesFile, 'utf8')).schemaVersion, 99, '别名表原样保留')
  const status = await call(ctx, 'collab_status', {})
  eq(status.ok, true, 'status 仍可用')
  eq(status.aliases.error.code, 'config/schema', 'status 里报告别名表错误')
  await ctx.dispose()
})

/* ============================================== 旧 profile 键 / 凭据不外泄 ==== */

await test('X4', '远程目标：creds 文件覆盖 config 口令、600 不变、status/日志不回显', async () => {
  const home = freshHome()
  writeConfig(home, {
    schemaVersion: 1,
    listen: 'loopback',
    targets: [{ name: 'pc', baseUrl: 'https://192.0.2.99:8543/', user: 'inline-user', pass: 'INLINE-SECRET' }],
  })
  mkdirSync(join(home.configDir, 'creds'), { recursive: true })
  const credsFile = join(home.configDir, 'creds', 'pc.json')
  writeFileSync(credsFile, JSON.stringify({ schemaVersion: 1, user: 'file-user', pass: 'FILE-SECRET' }))
  chmodSync(credsFile, 0o600)

  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  const remoteWithId = await call(ctx, 'collab_alias_set', {
    alias: 'bad-remote',
    target: 'pc',
    sessionId: IDS.a,
  })
  eq(remoteWithId.ok, false, '跨机别名不接受 sessionId（不可寻址）')
  eq(remoteWithId.error.code, 'addressing/invalid', '错误码 addressing/invalid')

  const set = await call(ctx, 'collab_alias_set', { alias: 'pc-session', target: 'pc', title: FAKE_SESSIONS[IDS.a] })
  eq(set.ok, true, '跨机别名（title）应登记成功')
  const sent = await call(ctx, 'collab_send', { alias: 'pc-session', text: '跨机消息' })
  eq(sent.ok, true, '发往远程目标应成功（假 bridge）')
  const options = factory.last().options
  eq(options.httpUser, 'file-user', 'creds 文件的 user 应覆盖 config 里的 user')
  eq(options.httpPass, 'FILE-SECRET', 'creds 文件的 pass 应覆盖 config 里的 pass')

  const status = await call(ctx, 'collab_status', {})
  const statusText = JSON.stringify(status)
  check(!statusText.includes('FILE-SECRET'), 'status 不得回显口令')
  check(!statusText.includes('INLINE-SECRET'), 'status 不得回显旧口令')
  check(!logLines.join('\n').includes('FILE-SECRET'), '日志不得含口令')
  check(!logLines.join('\n').includes('INLINE-SECRET'), '日志不得含旧口令')
  eq(statSync(credsFile).mode & 0o777, 0o600, '凭据文件权限应保持 600')
  eq(status.config.targets.length, 1, 'status 列出目标')
  eq(status.config.targets[0].hasCreds, true, 'status 只报 hasCreds，不报口令')
  await ctx.dispose()
})

/* ================================================== 入站监听（宿主 steer） ==== */

await test('X5', '入站：/collab/sessions、/collab/deliver 走宿主 steer，二级回执 running→read', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})
  const app = __testing.lastApp
  const desc = await app.listener.ready()

  const sessionsRes = await fetch(desc.url + 'collab/sessions', { signal: AbortSignal.timeout(3000) })
  const sessions = await sessionsRes.json()
  eq(sessions.ok, true, '/collab/sessions 应成功')
  eq(sessions.sessions.some((item) => item.sessionId === IDS.a && item.title === FAKE_SESSIONS[IDS.a]), true,
    '应列出本机稳定 id（跨机对端用它寻址）')

  const delivered = await postJson(desc.url + 'collab/deliver', { sessionId: IDS.a, text: '来自对端的消息' })
  eq(delivered.ok, true, '入站投递应成功：' + JSON.stringify(delivered))
  eq(delivered.receipt.level, 1, '入站一级回执')
  check(typeof delivered.receiptId === 'string', '入站应返回 receiptId')
  eq(ctx.steers.length, 1, '宿主 agent.steer 应收到 1 条')
  eq(ctx.steers[0].source.kind, 'mira_browser', '消息 source.kind 必须是 mira_browser')
  eqStringIncludes(ctx.steers[0].content[0].text, '来自对端的消息', '正文应原样投递')
  eq(ctx.sessionsSvc.flushed >= 1, true, '投递后应 flush 一次会话')

  ctx.agent.status = 'running'
  const running = await getJson(desc.url + 'collab/receipts?id=' + encodeURIComponent(delivered.receiptId))
  eq(running.receiptLevel2.state, 'running', '观察到 agent running → running')
  ctx.agent.status = 'idle'
  const read = await getJson(desc.url + 'collab/receipts?id=' + encodeURIComponent(delivered.receiptId))
  eq(read.receiptLevel2.state, 'read', 'running 之后回到 idle → read（已处理）')

  const byTitle = await postJson(desc.url + 'collab/deliver', { title: FAKE_SESSIONS[IDS.b], text: '按标题投递' })
  eq(byTitle.ok, true, '入站按完整标题也应成功')
  eq(byTitle.session.sessionId, IDS.b, '标题解析到正确的本机 id')

  const queued = await postJson(desc.url + 'collab/deliver', { sessionId: IDS.a, text: '排队一条', splice: false })
  eq(queued.ok, true, 'splice:false 入站应成功')
  eq(ctx.followups.length, 1, 'splice:false 应走 followup（排队）而不是 steer')

  const badSession = await postJson(desc.url + 'collab/deliver', { sessionId: 'session-nope', text: 'x' })
  eq(badSession.ok, false, '不存在的会话应失败')
  eq(badSession.error.code, 'delivery/failed', '错误码 delivery/failed')
  const missing = await postJson(desc.url + 'collab/deliver', { text: 'x' })
  eq(missing.ok, false, '缺寻址应失败')
  eq(missing.error.code, 'addressing/missing', '错误码 addressing/missing')

  await ctx.dispose()
})

/* ============================================================ 非回环令牌 ==== */

await test('X6', '非回环监听：无令牌 403、Bearer 令牌 200，令牌不回显', async () => {
  const home = freshHome()
  mkdirSync(home.configDir, { recursive: true })
  const tokenFile = join(home.configDir, 'listen-token')
  writeFileSync(tokenFile, 'TOKEN-123456\n')
  chmodSync(tokenFile, 0o600)

  // 本机有没有 127.0.0.2 取决于内核/发行版：Linux 有整个 127/8，macOS 的 lo0 默认只有 127.0.0.1
  // （要用得先 `ifconfig lo0 alias 127.0.0.2`）。没有就**跳过**这条用例并说清楚，
  // 而不是让它变成「换台机器就红」的假失败 —— 产品侧对绑不上的地址报
  // 「监听地址在本机不存在」本来就是正确行为（下面单独断言）。
  const setup = new CollabListener({
    listen: { mode: 'manual', ip: '127.0.0.2', port: 0 },
    tokenFile,
    logger,
    version: 'probe',
    onStatus: () => ({ ok: true }),
    onSessions: () => ({ ok: true, sessions: [] }),
    onDeliver: () => ({ ok: true }),
    onReceipt: () => ({ ok: true }),
  }).start()
  let bindable = true
  try {
    await setup.ready()
  } catch (error) {
    bindable = false
    check(String(error.message).includes('不存在'), '绑不上时应明确说「监听地址在本机不存在」：' + error.message)
    await setup.close().catch(() => {})
  }
  if (!bindable) {
    console.log('[SKIP] X6 非回环令牌用例：本机没有绑 127.0.0.2（macOS lo0 默认只有 127.0.0.1）')
    return
  }
  await setup.close().catch(() => {})

  const makeListener = (file) => new CollabListener({
    listen: { mode: 'manual', ip: '127.0.0.2', port: 0 },
    tokenFile: file,
    logger,
    version: 'test',
    onStatus: () => ({ ok: true, via: 'status' }),
    onSessions: () => ({ ok: true, sessions: [] }),
    onDeliver: () => ({ ok: true }),
    onReceipt: () => ({ ok: true }),
  }).start()

  const listener = makeListener(tokenFile)
  const desc = await listener.ready()
  eq(desc.loopback, false, '127.0.0.2 应被视为非回环（需要令牌）')
  eq(desc.auth, 'token', '令牌已加载')

  eq(statSync(tokenFile).mode & 0o777, 0o600, '令牌文件权限应保持 600')
  const health = await getJson(desc.url + 'healthz')
  eq(health.ok, true, '/healthz 是唯一免令牌路由')

  const deniedRes = await fetch(desc.url + 'collab/status', { signal: AbortSignal.timeout(3000) })
  eq(deniedRes.status, 403, '无令牌应 403')
  const denied = await deniedRes.json()
  eq(denied.error.code, 'auth/denied', '错误码 auth/denied')
  check(!JSON.stringify(denied).includes('TOKEN-123456'), '响应不得回显令牌')

  const okRes = await fetch(desc.url + 'collab/status', {
    headers: { authorization: 'Bearer TOKEN-123456' },
    signal: AbortSignal.timeout(3000),
  })
  eq(okRes.status, 200, '带令牌应 200')
  eq((await okRes.json()).via, 'status', '应真的走到业务回调')
  check(!logLines.join('\n').includes('TOKEN-123456'), '日志不得含令牌')
  await listener.close()

  // 没配令牌文件：入站写入全拒（出站不受影响）；错误提示指到文件
  const noTokenFile = join(home.configDir, 'missing-token')
  const listener2 = makeListener(noTokenFile)
  const desc2 = await listener2.ready()
  eq(desc2.auth, 'disabled', '没有令牌 → auth=disabled')
  const res2 = await fetch(desc2.url + 'collab/status', { signal: AbortSignal.timeout(3000) })
  eq(res2.status, 403, '没有令牌时也应 403')
  const body2 = await res2.json()
  eqStringIncludes(body2.error.hint, noTokenFile, 'hint 应指出令牌文件路径')
  await listener2.close()
})

/* ================================================== listen 非法（不换地址） ==== */

await test('X7', 'listen 非法（0.0.0.0）→ config/invalid，不静默换地址也不起监听', async () => {
  const home = freshHome()
  writeConfig(home, { schemaVersion: 1, listen: { ip: '0.0.0.0', port: 9000 } })
  useFakeBridge()
  const ctx = makeCtx()
  const applied = apply(ctx, {})
  eq(applied.ok, true, '插件仍加载')
  const app = __testing.lastApp
  eq(app.configError.code, 'config/invalid', '应记录 config/invalid')
  eq(app.listener, null, '不应起监听（更不该自动换地址）')
  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'x' })
  eq(sent.ok, false, '工具应拒绝')
  eq(sent.error.code, 'config/invalid', '错误码 config/invalid')
  check(String(sent.error.hint).includes('具体 IPv4') || String(sent.error.hint).includes('0.0.0.0'), 'hint 要说明怎么改：' + sent.error.hint)
  await ctx.dispose()
})

/* ================================================= 本机 list/read（补充） ==== */

await test('X8', 'collab_list 给本机 id 映射；collab_read 按标题切会话并 tail', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  useFakeBridge((bridge) => { bridge.state.texts = ['第一行', '第二行', '第三行'] })
  const ctx = makeCtx()
  apply(ctx, {})

  const listed = await call(ctx, 'collab_list', {})
  eq(listed.ok, true, 'list 应成功')
  eq(listed.target.kind, 'local', 'target 是 local')
  const row = listed.rows.find((item) => item.title === FAKE_SESSIONS[IDS.a])
  check(row !== undefined, '应列出「兄弟聊天」')
  eq(row.sessionId, IDS.a, '本机目标应给出 sessionId 映射')
  eq(listed.localSessions.length, 2, '应附本机会话映射表')

  const read = await call(ctx, 'collab_read', { session: FAKE_SESSIONS[IDS.a], tail: 2 })
  eq(read.ok, true, 'read 应成功')
  eq(read.count, 3, 'count 是过滤后的总行数')
  eq(read.lines, ['第二行', '第三行'], 'tail 应只回最后 2 行')
  await ctx.dispose()
})

/* ==================================================================== X9 ==== */

// 回归：别名名撞 Object.prototype（valueOf / toString / hasOwnProperty …）时，
// set() 曾用 `aliases[name]` 裸取，读到继承成员 → 空表里也误报「别名已存在」。
await test('X9', '别名名撞 Object.prototype：空表可登记、第二次才冲突（不再拿继承成员当已存在）', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  const proto = await call(ctx, 'collab_alias_set', { alias: 'valueOf', target: 'local', title: FAKE_SESSIONS[IDS.a] })
  eq(proto.ok, true, '空表里 valueOf 应登记成功（不是 addressing/conflict）：' + JSON.stringify(proto))
  eq(proto.alias, 'valueOf', '别名原样保存')
  const table = JSON.parse(readFileSync(home.aliasesFile, 'utf8'))
  eq(table.aliases.valueOf.target, 'local', 'aliases.json 里应有真实的 valueOf 记录')
  check(Object.prototype.hasOwnProperty.call(table.aliases, 'valueOf'), 'valueOf 必须是自有的键（不是原型链上的）')
  const listed = await call(ctx, 'collab_alias_list', {})
  eq(listed.count, 1, '别名表只应有这 1 条')

  const again = await call(ctx, 'collab_alias_set', { alias: 'valueOf', target: 'local', title: FAKE_SESSIONS[IDS.b] })
  eq(again.ok, false, '真的已存在时才允许报冲突')
  eq(again.error.code, 'addressing/conflict', '冲突码仍是 addressing/conflict')

  const send = await call(ctx, 'collab_send', { alias: 'valueOf', text: '沿 valueOf 发送' })
  eq(send.ok, true, '登记后的 valueOf 别名应可直接投递：' + JSON.stringify(send))
  eq(send.to.title, FAKE_SESSIONS[IDS.a], '别名解析到登记时的标题')
  await ctx.dispose()
})

/* ==================================================================== X10 === */

// 回归：reply_to 是**基地址**（对端做 reply_to + 路由）。replyUrl 少写结尾斜杠时，
// 旧代码把它原样塞进信封 → 对端读到 `http://h:8544collab/deliver`，直投必失败。
await test('X10', 'replyUrl 不带结尾斜杠 → 归一化成基地址，信封里拼出的路由可点', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig({ replyUrl: 'http://127.0.0.1:8544' }))
  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: '回信地址测试' })
  eq(sent.ok, true, 'send 应成功：' + JSON.stringify(sent))
  const filled = String(factory.last().state.lastFilled)
  eqStringIncludes(filled, 'reply_to=http://127.0.0.1:8544/\n', '信封里的 reply_to 必须带结尾 /（基地址）')
  eqStringIncludes(filled, 'http://127.0.0.1:8544/collab/deliver', '按 reply_to + 路由 拼出来的投递地址必须可点')
  check(!filled.includes('8544collab/deliver'), '不能出现 8544collab/deliver 这种粘连地址')

  const status = await call(ctx, 'collab_status', {})
  eq(status.config.replyTo, 'http://127.0.0.1:8544/', 'status 里的 replyTo 与信封一致')
  // 单实例：先退场，才能在同一进程里再 apply 一次
  await ctx.dispose()

  // 已带斜杠的写法不能被改成双斜杠
  const home2 = freshHome()
  writeConfig(home2, loopbackConfig({ replyUrl: 'http://127.0.0.1:8545/' }))
  const factory2 = useFakeBridge()
  const ctx2 = makeCtx()
  apply(ctx2, {})
  const sent2 = await call(ctx2, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: '已带斜杠' })
  eq(sent2.ok, true, '已带斜杠的 replyUrl 照常可发')
  eqStringIncludes(String(factory2.last().state.lastFilled), 'reply_to=http://127.0.0.1:8545/\n', '已带斜杠时不重复补 /')
  await ctx2.dispose()
})

/* ================================================== L1/L2 档案锁 ============ */

/* 现场 bug：桥/浏览器被 kill 后 profiles/<profile>/SingletonLock 留了下来，
   下一次启动 Chromium 报 Failed to create ProcessSingleton ... File exists。
   Chromium(POSIX) 的锁是**悬空符号链接** -> "<hostname>-<pid>"。*/

function makeLockProfile(label) {
  const profilesDir = join(TMP, 'profiles-' + label)
  const profile = 'dsh-collab'
  const profileDir = join(profilesDir, profile)
  mkdirSync(profileDir, { recursive: true })
  return { profilesDir, profile, profileDir, lockPath: join(profileDir, 'SingletonLock') }
}

/** 用不存在的 pid：本机不可能有，判活必须是死的。 */
const DEAD_PID = 999999

function writeStaleLock(info, raw = hostname() + '-' + DEAD_PID) {
  symlinkSync(raw, info.lockPath)
  writeFileSync(join(info.profileDir, 'SingletonSocket'), 's')
  writeFileSync(join(info.profileDir, 'SingletonCookie'), 'c')
}

function lockExists(file) {
  return lockTest.pathExistsLstat(file)
}

await test('L1', '僵尸锁回收：持锁 pid 已死 → 清掉 SingletonLock/Socket/Cookie 再启动', async () => {
  const info = makeLockProfile('dead')
  writeStaleLock(info)

  const owner = lockTest.readLockOwner(info.profilesDir, info.profile)
  eq(owner.present, true, '应能识别出锁')
  eq(owner.kind, 'symlink', 'Chromium 的锁是符号链接（不是普通文件）')
  eq(owner.pid, DEAD_PID, '应从 "<hostname>-<pid>" 里解析出 pid')
  eq(lockTest.isProcessAlive(DEAD_PID), false, '不存在的 pid 必须判死')
  check(lockExists(info.lockPath), '前置：悬空符号链接必须被认成“存在”（existsSync 会漏，本 bug 的根因）')

  const logs = []
  const first = lockTest.prepareProfileLock(info.profilesDir, info.profile, { log: (line) => logs.push(line) })
  eq(first.action, 'cleared', '死锁应被清掉再启动')
  eq(first.pid, DEAD_PID, '结果里要带被清掉的 pid（可诊断）')
  eq([...first.removed].sort(), ['SingletonCookie', 'SingletonLock', 'SingletonSocket'],
    '三个文件都要清（悬空符号链接的主锁也不能留下）')
  eq(lockExists(info.lockPath), false, '主锁 SingletonLock 必须真的不在')
  eq(lockExists(join(info.profileDir, 'SingletonSocket')), false, 'SingletonSocket 也要清')
  check(logs.some((line) => line.includes('已删')), '清理要留日志（谁、多久、删了什么）：' + JSON.stringify(logs))
  eq(lockTest.prepareProfileLock(info.profilesDir, info.profile).action, 'none', '没有锁时是廉价的 none')

  // 桥的接线：ensureProfileLock 清完锁，但绝不 spawn 子进程
  const bridge = new BrowserBridge({
    python: join(TMP, 'no-such-python'), aiBrowserHome: TMP, profilesDir: info.profilesDir,
    profile: info.profile, tmpDir: TMP,
  })
  const second = makeLockProfile('dead2')
  writeStaleLock(second)
  const viaBridge = new BrowserBridge({
    python: join(TMP, 'no-such-python'), aiBrowserHome: TMP, profilesDir: second.profilesDir,
    profile: second.profile, tmpDir: TMP,
  })
  eq(viaBridge.ensureProfileLock().action, 'cleared', 'BrowserBridge.ensureProfileLock 也要清僵尸锁')
  eq(viaBridge.child, undefined, '只清锁，不在这里 spawn')
  eq(bridge.child, undefined, '没启动过的桥不持有子进程')
})

await test('L2', '活锁拒启：持锁进程还活着 → browser/profile-locked（pid/时长/hint），不 spawn、不动文件', async () => {
  const info = makeLockProfile('alive')
  symlinkSync(hostname() + '-' + process.pid, info.lockPath)
  const old = new Date(Date.now() - 18 * 60 * 1000) // 现场：18 分钟前的僵尸 Chrome
  lutimesSync(info.lockPath, old, old)

  const bridge = new BrowserBridge({
    python: join(TMP, 'no-such-python'), aiBrowserHome: TMP, profilesDir: info.profilesDir,
    profile: info.profile, tmpDir: TMP,
  })
  let caught = null
  try {
    bridge.start()
  } catch (error) {
    caught = error
  }
  check(caught !== null, '活进程占锁必须拒绝启动（不能猜着清）')
  eq(caught?.code, 'browser/profile-locked', '错误码应是 browser/profile-locked')
  eqStringIncludes(caught?.message, 'pid=' + process.pid, '错误里要说清**谁**占着')
  eqStringIncludes(caught?.message, '18 分钟', '错误里要说清占了**多久**')
  check(String(caught?.hint).includes('kill ' + process.pid), 'hint 给出下一步（kill 该 pid）：' + caught?.hint)
  eq(bridge.child, undefined, '拒启时绝不能 spawn 子进程')
  check(lockExists(info.lockPath), '活锁的文件一个都不许动')

  // 另一台主机的锁：本机判不了活，同样只报错、不动文件
  const foreign = makeLockProfile('foreign')
  symlinkSync('some-other-host-' + DEAD_PID, foreign.lockPath)
  let foreignError = null
  try {
    lockTest.prepareProfileLock(foreign.profilesDir, foreign.profile)
  } catch (error) {
    foreignError = error
  }
  eq(foreignError?.code, 'browser/profile-locked', '别的主机的锁也要拒（判不了活就不能清）')
  eqStringIncludes(foreignError?.message, 'some-other-host', '错误要指出锁属于哪台主机')
  check(lockExists(foreign.lockPath), '别的主机的锁文件不许动')
})

await test('L3', '桥退场清理：只清主人已死的锁（活锁原样留着），stop() 也要清', async () => {
  const dead = makeLockProfile('exit-dead')
  writeStaleLock(dead)
  const cleaned = lockTest.cleanupProfileLock(dead.profilesDir, dead.profile)
  eq(cleaned.action, 'cleared', '主人已死的锁应在退出时清掉')
  eq(lockExists(dead.lockPath), false, '退出清理后主锁不在')

  const live = makeLockProfile('exit-live')
  symlinkSync(hostname() + '-' + process.pid, live.lockPath)
  const kept = lockTest.cleanupProfileLock(live.profilesDir, live.profile)
  eq(kept.action, 'left', '活进程的锁不许动')
  eq(kept.reason, 'alive', '原因如实报 alive')
  eq(lockExists(live.lockPath), true, '活锁文件仍在')

  // 桥从没起过子进程（上次被 kill）：stop() 也必须做一次退场清理
  const stale = makeLockProfile('exit-bridge')
  writeStaleLock(stale)
  const bridge = new BrowserBridge({
    python: join(TMP, 'no-such-python'), aiBrowserHome: TMP, profilesDir: stale.profilesDir,
    profile: stale.profile, tmpDir: TMP,
  })
  await bridge.stop()
  eq(lockExists(stale.lockPath), false, '桥退场（stop）应清掉自己档案里主人已死的锁')
})

/* ============================================ 会话过期自愈 / 不误重开 ==== */

/** 造一个「桥里会话过期」的错误（与 ai_browser core 的文案同形状，带 sid）。 */
function expiredError(sid) {
  const error = new Error('ValueError: 会话 ' + sid + ' 不存在或已过期')
  error.code = 'session/expired'
  return error
}

await test('E11', '会话过期自愈：collab_list 遇 session/expired 自动重开一次并重试成功', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  let fired = false
  const factory = useFakeBridge((bridge) => {
    bridge.state.beforeRequest = (op, args) => {
      if (!fired && op === 'act' && args.action?.action === 'dom_eval' && args.session_id === 'sid-1') {
        fired = true
        throw expiredError(args.session_id)
      }
    }
  })
  const ctx = makeCtx()
  apply(ctx, {})
  const listed = await call(ctx, 'collab_list', {})
  eq(listed.ok, true, '过期后应自愈成功（不再要求 pkill 桥）：' + JSON.stringify(listed).slice(0, 200))
  eq(listed.rows.length, 2, '重开后仍应列出 2 行')
  eq(factory.last().state.opened, 2, '应自动重开一次浏览器会话')
  const acts = factory.last().requests.filter((item) => item.op === 'act' && item.args.action?.action === 'dom_eval')
  eq(acts[acts.length - 1]?.args.session_id, 'sid-2', '重试必须用**新**会话 id')
  const status = await call(ctx, 'collab_status', {})
  check(status.log.some((line) => line.includes('自动重开')), '日志要留「自动重开」痕迹：' + JSON.stringify(status.log.slice(-3)))
})

await test('E12', '会话过期自愈：collab_read 重开是空白页 → 先重新选中目标会话再重试读书', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  let fired = false
  const factory = useFakeBridge((bridge) => {
    bridge.state.texts = ['第一行', '第二行']
    bridge.state.beforeRequest = (op, args) => {
      if (!fired && op === 'texts' && args.session_id === 'sid-1') {
        fired = true
        throw expiredError(args.session_id)
      }
    }
  })
  const ctx = makeCtx()
  apply(ctx, {})
  const read = await call(ctx, 'collab_read', { session: FAKE_SESSIONS[IDS.a] })
  eq(read.ok, true, '读文本遇过期应自愈：' + JSON.stringify(read).slice(0, 200))
  eq(read.lines, ['第一行', '第二行'], '重试后应读到目标会话的文本')
  eq(factory.last().state.opened, 2, '只重开一次')
  const requests = factory.last().requests
  const openAt = requests.map((item, index) => (item.op === 'open' ? index : -1)).filter((index) => index >= 0)
  const afterReopen = requests.slice(openAt[1])
  check(afterReopen.some((item) => item.op === 'act' && item.args.action?.action === 'click_text'
    && item.args.action.text === FAKE_SESSIONS[IDS.a]),
  '重开=空白页：重试读书之前必须重新点中目标会话（否则会读错会话）')
})

await test('E13', '自愈只做一次：重开后再过期 → 抛**原始**错误，不无限重开', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge((bridge) => {
    bridge.state.beforeRequest = (op, args) => {
      if (op === 'act' && args.action?.action === 'dom_eval') throw expiredError(args.session_id)
    }
  })
  const ctx = makeCtx()
  apply(ctx, {})
  const listed = await call(ctx, 'collab_list', {})
  eq(listed.ok, false, '重试仍失败时工具应报错')
  eq(listed.error.code, 'session/expired', '错误码保留 session/expired')
  eqStringIncludes(listed.error.message, '不存在或已过期', '抛回原始错误文案')
  eq(factory.last().state.opened, 2, '只重开一次（不是循环重开）')
})

await test('E14', '传错 session 名不算过期：addressing/not-found，不重开浏览器会话', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})
  const read = await call(ctx, 'collab_read', { session: '根本不存在这个会话' })
  eq(read.ok, false, '传错会话名应报找不到')
  eq(read.error.code, 'addressing/not-found', '错误码 addressing/not-found（不是会话过期）')
  eq(factory.last().state.opened, 1, '不许因为「找不到会话」就重开浏览器')
  const status = await call(ctx, 'collab_status', {})
  check(!status.log.some((line) => line.includes('自动重开')), '也不许留下自动重开日志')
})

await test('E15', '带 sid 的其它错误不误判成过期；判据本身要求「本会话 id + 过期文案」', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge((bridge) => {
    bridge.state.beforeRequest = (op, args) => {
      if (op === 'act' && args.action?.action === 'dom_eval') {
        throw new Error('ValueError: 会话 ' + args.session_id + ' 正在执行其它操作')
      }
    }
  })
  const ctx = makeCtx()
  apply(ctx, {})
  const listed = await call(ctx, 'collab_list', {})
  eq(listed.ok, false, '非过期错误应原样报出')
  eq(factory.last().state.opened, 1, '不是过期 → 不重开')

  eq(isExpiredSessionError(new Error('ValueError: 会话 sid-1 不存在或已过期'), 'sid-1'), true, '本会话的过期文案 → 自愈')
  eq(isExpiredSessionError(new Error('ValueError: 会话 sid-9 不存在或已过期'), 'sid-1'), false, '别的会话 id 的过期错误不重开')
  eq(isExpiredSessionError(Object.assign(new Error('boom'), { code: 'session/expired' }), 'sid-1'), false, '没有本会话 id 也不能重开')
  eq(isExpiredSessionError(new Error('会话数已达上限 8（AI_BROWSER_MAX_SESSIONS 可调）'), 'sid-1'), false, '会话数上限不是过期')
})

/* =============================================== 折叠分组展开（回归） ==== */

await test('E16', '侧边栏里找不到会话时自动展开折叠的工作区分组再重读（展开后仍没有 → 报错并带当前可见列表）', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const GROUP = '查询用的工作区'
  const GROUPED_ID = 'session-dddd4444'
  const GROUPED_TITLE = '查询显存资源占用情况'
  const factory = useFakeBridge((bridge) => {
    bridge.state.groups = [{ name: GROUP, expanded: false }]
    bridge.state.groupSessions = { [GROUP]: [GROUPED_ID] }
    bridge.state.sessionTitles = { [GROUPED_ID]: GROUPED_TITLE }
    bridge.state.texts = ['显存占用 60%（8/16 GB）']
  })
  const ctx = makeCtx()
  apply(ctx, {})

  // 现场形状：collab_list 只看得到已展开的行，目标会话藏在折叠的工作区分组里
  const listed = await call(ctx, 'collab_list', {})
  check(!listed.rows.some((row) => row.title === GROUPED_TITLE),
    '折叠分组里的会话不应出现在未展开的列表里（复现现场：列表里看不见，read 找不到）')
  eq(factory.last().state.groups[0].expanded, false, '只调 collab_list 不应展开分组')

  // 正例：collab_read 走「找不到 → 点折叠分组展开 → 重读」→ 读得到
  const read = await call(ctx, 'collab_read', { session: GROUPED_TITLE })
  eq(read.ok, true, '折叠分组里的会话应能被 collab_read 找到：' + JSON.stringify(read).slice(0, 200))
  eq(read.lines, ['显存占用 60%（8/16 GB）'], '读到的应是目标会话的文本（不是空白页/别的会话）')
  eq(read.to?.title, GROUPED_TITLE, 'to.title 应回目标标题')
  eq(factory.last().state.groups[0].expanded, true, '分组应被展开（groups 里该项 expanded === true）')

  // 顺序证据：先点分组、再点会话 —— 只断言「读到了」会放过「本来就在 rows 里」的假阳性
  const clicked = factory.last().requests
    .filter((item) => item.op === 'act' && item.args.action?.action === 'click_text')
    .map((item) => item.args.action.text)
  const groupAt = clicked.indexOf(GROUP)
  check(groupAt >= 0, '应先点击折叠分组的 projectRow 触发展开（实际点击：' + JSON.stringify(clicked) + '）')
  check(clicked.indexOf(GROUPED_TITLE) > groupAt, '展开之后才点目标会话（实际点击：' + JSON.stringify(clicked) + '）')

  // 反例：展开后仍然没有这个会话 → addressing/not-found，错误信息里必须带「当前可见」
  const missing = await call(ctx, 'collab_read', { session: '分组里也没有的会话' })
  eq(missing.ok, false, '展开后仍找不到必须报错（不许瞎读当前页）')
  eq(missing.error.code, 'addressing/not-found', '错误码应是 addressing/not-found')
  const detail = String(missing.error.message) + ' ' + String(missing.error.hint ?? '')
  eqStringIncludes(detail, '当前可见', '错误信息要带「当前可见」列表，给调用方核对')
  eqStringIncludes(detail, GROUPED_TITLE, '「当前可见」应是展开后的列表（含刚展开出来的那行）')
})

/* ================================================== from_id（半截改动收口） ==== */

await test('X11', '信封 from_id 用当前会话活 id（agent.session.id），回退 agent.id / 环境变量', async () => {
  const home = freshHome()
  writeConfig(home, loopbackConfig())
  const factory = useFakeBridge()
  const ctx = makeCtx()
  apply(ctx, {})

  // 现场复现的形状：resume 之后 exec.agent.id 还是旧 id，session.id 才是活的
  const exec = { agent: { id: 'session-stale-0000', session: { id: IDS.a } } }
  const sent = await call(ctx, 'collab_send', { session: FAKE_SESSIONS[IDS.a], text: 'from_id 测试' }, exec)
  eq(sent.ok, true, 'send 应成功：' + JSON.stringify(sent).slice(0, 200))
  const filled = String(factory.last().state.lastFilled)
  eqStringIncludes(filled, 'from_id=' + IDS.a + ' goto=', '信封里的 from_id 应是活会话 id')
  check(!filled.includes('session-stale-0000'), '不能拿 resume 前的旧 agent.id')
  const listed = await call(ctx, 'collab_list', {}, exec)
  eq(listed.selfSessionId, IDS.a, 'collab_list 应报告与信封一致的 from_id')

  const fallback = await call(ctx, 'collab_list', {}, { agent: { id: 'only-id' } })
  eq(fallback.selfSessionId, 'only-id', '没有 agent.session.id 时回退 agent.id')
  const noExec = await call(ctx, 'collab_list', {}, {})
  eq(noExec.selfSessionId, 'session-test-self', '没有 exec 时回退环境变量 DSH_SESSION_ID')
})

/* ── 收尾 ───────────────────────────────────────────────── */

/* ---------- HTTP 小工具（放在文件末尾，函数声明会提升） ---------- */

async function getJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000) })
  return response.json()
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  })
  return response.json()
}

function eqStringIncludes(haystack, needle, message) {
  return check(String(haystack).includes(needle), message + '（未包含 ' + JSON.stringify(needle) + '）')
}

rmSync(TMP, { recursive: true, force: true })
console.log('通过 ' + passed + ' 项断言')
if (failures.length > 0) {
  for (const failure of failures) console.log('[FAIL] ' + failure)
  console.log('\n==== FAIL（' + failures.length + ' 项失败）====')
  process.exit(1)
}
console.log('\n==== ALL PASS（' + passed + ' 项断言）====')
process.exit(0)
