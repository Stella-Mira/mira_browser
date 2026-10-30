/**
 * mira_browser / collab.js —— 协作内核：把「另一个 DSH 会话」当成可收发消息的对端
 *
 * 保留了 0.1.0 的三条实测结论（都还有效）：
 *   1. list **只信对端侧边栏里的会话行**（结构信号 `[role=treeitem][class*=sessionRow]`），
 *      不用本机会话缓存去拼对面；
 *   2. 发送默认**插话**（Ctrl/Cmd+Enter → GUI 语义 next-step），排队才显式 splice:false；
 *   3. 写文本前核对「侧边栏选中行 == 目标」，不通过就拒绝发送（防误投）。
 *
 * 0.2.0 新增（任务书功能点3–8）：
 *   · **寻址**：优先稳定别名（addressing.js）/ 本机 sessionId；标题是兼容路径，
 *     且不再用「用户给的前缀」猜 —— 侧边栏里必须精确匹配（或多候选时报 ambiguous）。
 *   · **两级回执**（receipt.js）：level 1 = 已写入；level 2 = 对端开跑/已读，惰性推进。
 *   · **队列**：同目标串行（浏览器页面状态共享），不同目标并行；status 里能看到谁在等。
 *   · **send_many**：逐条回执，单个失败不阻断其余。
 *
 * 目标（target）解析（与旧版一致，但去掉名字前缀匹配）：
 *   local  —— 本机 GUI 直连（localGuiUrl）
 *   proxy  —— targets[0]；没登记时用 https://127.0.0.1:<proxyPort>/（旧行为）
 *   <name> —— config.targets 里登记过的远程实例（名字精确匹配）
 *
 * 只依赖 node: 内置与相对模块。
 */

import { readFileSync, readdirSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { BrowserBridge } from './bridge.js'
import { readTargetCreds } from './config.js'
import { dshHome, MiraError, nowIso, sleep as realSleep, toError } from './kit.mjs'

/* ------------------------------------------------------------------ 选择器 ---- */

// 类名带哈希前缀（本机实测 YDXeBa_sessionRow），所以一律用 [class*=…] 匹配。
export const SEL = {
  sessionRow: '[role=treeitem][class*="sessionRow"]',
  projectRow: '[role=treeitem][class*="projectRow"]',
  selectedRow: '[role=treeitem][aria-selected="true"]',
  composer: 'textarea, [contenteditable="true"]',
}

/** GUI 自身文案，读对话时滤掉（内化自 agent-chat 的 NOISE，并补了本版实测到的几项）。 */
const NOISE = new RegExp(
  '^(\\d{2}:\\d{2}|刚刚|\\d+\\s*(秒|分钟|小时|天)前?|进行中|空闲|工作区|默认工作区|新会话|' +
    '系统提示词|指令|添加附件|发送消息|收起侧边栏|展开侧边栏|新建会话|搜索会话|视图选项|' +
    '添加工作区|设置|选择工作区|暂无会话|探索未至之境|预览版|详情|关闭详情|命令|' +
    '展开其余.*个会话|点击消息流中的工具行查看详情|访问模式.*|选择模型.*|' +
    '描述你想要构建的内容.*|发消息或创建任务.*|给智能体发消息.*)$',
)

export function isNoise(text) {
  return NOISE.test(String(text).trim())
}

/* ------------------------------------------------- 侧边栏结构（DOM 片段） ---- */

const JS_SIDEBAR = `() => {
  const longest = (row) => {
    const leaves = [...row.querySelectorAll('*')].filter((el) => el.children.length === 0
      && (el.innerText || '').trim() !== '');
    let best = '';
    for (const el of leaves) { const t = (el.innerText || '').trim(); if (t.length > best.length) best = t; }
    return best || (row.innerText || '').trim();
  };
  const rows = [...document.querySelectorAll(SESSION_SEL)].map((r) => ({
    title: longest(r),
    selected: r.getAttribute('aria-selected') === 'true',
    raw: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
  }));
  const groups = [...document.querySelectorAll(PROJECT_SEL)].map((r) => ({
    name: (r.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    expanded: r.getAttribute('aria-expanded') === 'true',
  }));
  return { rows, groups, url: location.href, title: document.title };
}`

function jsSidebar() {
  return JS_SIDEBAR
    .replace('SESSION_SEL', JSON.stringify(SEL.sessionRow))
    .replace('PROJECT_SEL', JSON.stringify(SEL.projectRow))
}

/** 会话行的几何中心（给 CDP 兜底点击用）。 */
const JS_ROW_RECT = `(title) => {
  const rows = [...document.querySelectorAll(SESSION_SEL)];
  const pick = rows.find((r) => {
    const leaves = [...r.querySelectorAll('*')].filter((el) => el.children.length === 0
      && (el.innerText || '').trim() !== '');
    let best = '';
    for (const el of leaves) { const t = (el.innerText || '').trim(); if (t.length > best.length) best = t; }
    return (best || '').trim() === title;
  });
  if (!pick) return null;
  const r = pick.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
           w: Math.round(r.width), h: Math.round(r.height) };
}`

function jsRowRect() {
  return JS_ROW_RECT.replace('SESSION_SEL', JSON.stringify(SEL.sessionRow))
}

/** 输入框定位（只认可见且非零尺寸的），并回传 ai_browser 分配的 data-ai-id。 */
const JS_COMPOSER = `() => {
  const cands = [...document.querySelectorAll(COMPOSER_SEL)];
  for (const el of cands) {
    const r = el.getBoundingClientRect();
    if (r.width > 40 && r.height > 10) {
      return { aiId: el.getAttribute('data-ai-id') || null, tag: el.tagName,
               placeholder: el.getAttribute('placeholder') || '',
               value: (el.value || el.innerText || '').slice(0, 80),
               x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
  }
  return null;
}`

function jsComposer() {
  return JS_COMPOSER.replace('COMPOSER_SEL', JSON.stringify(SEL.composer))
}

/** composer 状态：空闲 / 忙碌（placeholder 是唯一可观测信号）。 */
const JS_COMPOSER_STATE = `() => {
  const el = [...document.querySelectorAll('textarea, [contenteditable="true"]')]
    .find((e) => { const r = e.getBoundingClientRect(); return r.width > 40 && r.height > 10; });
  if (!el) return null;
  let queue = 0;
  for (const b of document.querySelectorAll('button')) {
    const label = (b.getAttribute('aria-label') || b.innerText || '').trim();
    const m = /(\\d+)\\s*条排队/.exec(label);
    if (m) queue = parseInt(m[1], 10);
  }
  return { placeholder: el.getAttribute('placeholder') || '', value: (el.value || el.innerText || ''),
           queue, busy: /插话/.test(el.getAttribute('placeholder') || '') };
}`

/* ------------------------------------------------------------ 本机会话存储 ---- */

/**
 * 本机会话存储：{session_id: title}（新版单文件 + 旧版目录两种布局）。
 *
 * 用 kit.dshHome()（`$DSH_HOME` > `~/.dsh`），与宿主规则一致；旧版那套「读 .credentials.yaml
 * 判断 DSH_HOME 是 .dsh 还是它的父目录」的探测已去掉 —— 任务书要求不做自动探测。
 */
export function localSessions() {
  const out = new Map()
  const home = dshHome()
  const single = join(home, 'storages', 'session_projcache.json')
  try {
    const doc = JSON.parse(readFileSync(single, 'utf8'))
    const sessions = doc?.tables?.sessions ?? {}
    for (const [sid, rec] of Object.entries(sessions)) {
      if (!String(sid).startsWith('session-')) continue
      const title = rec?.rows?.title?.val
      if (typeof title === 'string' && title.trim() !== '') out.set(sid, title.trim())
    }
    return out
  } catch {
    /* 不是单文件布局，继续试目录布局 */
  }
  try {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('session-') || !name.endsWith('.json')) continue
      try {
        const rec = JSON.parse(readFileSync(join(dir, name), 'utf8'))?.record
        const title = rec?.rows?.title?.val
        const sid = name.slice(0, -'.json'.length)
        out.set(sid, typeof title === 'string' ? title.trim() : '')
      } catch {
        /* 单个文件读不出就跳过 */
      }
    }
  } catch {
    /* 目录也不存在 */
  }
  return out
}

/* ------------------------------------------------------------ 目标与身份 ---- */

/**
 * 解析一个目标名。**名字精确匹配**（旧版允许前缀，容易把 remote-a 解析成 remote-b，已去掉）。
 * @returns {{name:string, kind:'local'|'proxy'|'remote', url:string, credsName:string|null, user?:string, pass?:string}}
 */
export function resolveTarget(config, name) {
  const wanted = String(name ?? 'local').trim() || 'local'
  const key = wanted.toLowerCase()
  if (key === 'local') {
    return { name: 'local', kind: 'local', url: config.localGuiUrl, credsName: null }
  }
  if (key === 'proxy') {
    const first = config.targets?.[0]
    if (first !== undefined) {
      return { name: 'proxy', kind: 'proxy', url: first.baseUrl, credsName: first.name, user: first.user, pass: first.pass }
    }
    return { name: 'proxy', kind: 'proxy', url: 'https://127.0.0.1:' + String(config.proxyPort ?? 8543) + '/', credsName: null }
  }
  const hit = (config.targets ?? []).find((item) => String(item.name).toLowerCase() === key)
  if (hit === undefined) {
    const known = ['local', 'proxy', ...(config.targets ?? []).map((item) => item.name)].join(', ')
    throw new MiraError('addressing/unknown-target', '未知目标 ' + JSON.stringify(name) + '；可用：' + known,
      '远程目标要在 config.json 的 targets 里登记（名字精确匹配）；本插件不探测目标')
  }
  return { name: hit.name, kind: 'remote', url: hit.baseUrl, credsName: hit.name, user: hit.user, pass: hit.pass }
}

/** 本节点的名字（对端据此查它自己那份 targets）；只影响显示与信封。 */
export function selfNameOf(config) {
  if (typeof config?.self === 'string' && config.self.trim() !== '') return config.self.trim()
  return hostname() || 'unknown-host'
}

/** 本机的会话 id（对端据此回来；DSH 会话里自带，裸终端里才是空）。 */
export function selfSessionId() {
  return process.env.DSH_SESSION_ID ?? ''
}

/* ------------------------------------------------------------ 标题匹配 ---- */

function stripEllipsis(text) {
  return String(text ?? '').trim().replace(/[.…\s]+$/u, '')
}

/**
 * 标题匹配（**严格**）：
 *   · 全等（去掉尾部的 … / . / 空白）→ 匹配；
 *   · 只有当「目标本身以省略号结尾」（说明它就是侧边栏里被截断的那串字）时，
 *     才允许用它去前缀匹配候选 —— 且调用方必须自己保证候选唯一。
 *
 * 旧版对两侧都做前缀匹配，于是「兄弟」会命中「兄弟的第二个会话」：
 * 这正是任务书功能点7 说的「不依赖会话标题前缀」要修掉的东西。
 */
export function matchesTitleStrict(candidate, want) {
  const a = String(candidate ?? '').trim()
  const b = String(want ?? '').trim()
  if (a === '' || b === '') return false
  if (a === b) return true
  const sa = stripEllipsis(a)
  const sb = stripEllipsis(b)
  if (sa === '' || sb === '') return false
  if (sa === sb) return true
  if (/[.…]$/u.test(b) && sa.startsWith(sb)) return true
  return false
}

/**
 * 这个错误是不是「桥里的浏览器会话没了」？
 *
 * 必须同时满足两条，才允许自愈重开：
 *   1. 文案/错误码明确是「会话不存在/已过期」；
 *   2. 文案里带**我们刚用的那个 browser session id** —— 用户传错的会话名在寻址阶段
 *      就已经报 addressing/not-found，根本到不了桥；带上 id 是为了防止把别的
 *      ValueError（例如会话数上限）误判成过期。
 */
export function isExpiredSessionError(error, sid) {
  const id = String(sid ?? '')
  if (id === '') return false
  const text = String(error?.message ?? error ?? '')
  if (!text.includes(id)) return false
  if (error?.code === 'session/expired') return true
  return /不存在或已过期|not found or expired|does not exist or (?:has )?expired|session\s+\S+\s+expired/iu.test(text)
}

/* ------------------------------------------------------------------ 客户端 ---- */

function flatText(text) {
  return String(text).replace(/[#*_>`\s]+/gu, '')
}

export class CollabClient {
  /**
   * @param {{
   *   config: object, configFile: string,
   *   logger?: object, counters?: object,
   *   aliases: import('./addressing.js').AliasStore,
   *   tracker: import('./receipt.js').DeliveryTracker,
   *   queue: import('./receipt.js').SendQueue,
   *   listener?: import('./listen.js').CollabListener|null,
   *   version?: string,
   *   now?: () => number, sleep?: (ms:number)=>Promise<void>, pollMs?: number,
   *   createBridge?: ((options:object)=>object)|null,
   *   inboundStatus?: (()=>object)|null,
   * }} options
   */
  constructor(options) {
    this.config = options.config
    this.configFile = options.configFile
    this.logger = options.logger ?? null
    this.counters = options.counters ?? null
    this.aliases = options.aliases
    this.tracker = options.tracker
    this.queue = options.queue
    this.listener = options.listener ?? null
    this.version = options.version ?? ''
    this.now = options.now ?? (() => Date.now())
    this.sleep = options.sleep ?? realSleep
    this.pollMs = options.pollMs ?? 5000
    this.createBridge = options.createBridge ?? ((bridgeOptions) => new BrowserBridge(bridgeOptions))
    this.inboundStatus = options.inboundStatus ?? null

    this.bridges = new Map() // target.name -> BrowserBridge
    this.sessions = new Map() // target.name -> browser session id
    this.locks = new Map() // target.name -> Promise（同目标串行）
    this.reopening = new Map() // target.name -> Promise（会话过期后的单飞重开）
    this.log = []
    this.lastError = null
  }

  /* ── 日志与错误 ─────────────────────────────────────────── */

  note(line) {
    this.log.push(nowIso(this.now()) + ' ' + line)
    if (this.log.length > 300) this.log.shift()
  }

  #fail(error) {
    const normalized = toError(error, 'delivery/failed', '看 collab_status 的 log / lastError')
    this.lastError = normalized.error
    this.counters?.bump('error/' + normalized.error.code)
    return normalized
  }

  /* ── 目标桥 ─────────────────────────────────────────────── */

  #bridgeFor(target) {
    let bridge = this.bridges.get(target.name)
    if (bridge !== undefined) return bridge
    let user = target.user ?? ''
    let pass = target.pass ?? ''
    if (target.credsName !== null && target.credsName !== undefined) {
      const creds = readTargetCreds({ name: target.credsName, user, pass }, this.configFile)
      user = creds.user
      pass = creds.pass
    }
    bridge = this.createBridge({
      python: this.config.python,
      aiBrowserHome: this.config.aiBrowserHome,
      profilesDir: this.config.profilesDir,
      profile: this.config.profile,
      tmpDir: this.config.tmpDir,
      playwrightBrowsersPath: this.config.playwrightBrowsersPath,
      ignoreHttps: this.config.ignoreHttps,
      httpUser: user,
      httpPass: pass,
      onLog: (line) => {
        this.note('[py:' + target.name + '] ' + line)
        if (/error|Error|Traceback/.test(line)) {
          this.logger?.warn?.('[mira_browser] ' + line)
          this.counters?.bump('bridge/stderr-error')
        }
      },
    })
    this.bridges.set(target.name, bridge)
    return bridge
  }

  /** 打开（或复用）目标 GUI 的浏览器会话。 */
  async open(targetName) {
    const target = resolveTarget(this.config, targetName)
    const bridge = this.#bridgeFor(target)
    const existing = this.sessions.get(target.name)
    if (existing !== undefined && bridge.running) return { target, bridge, sid: existing }
    // 桥常驻时也可能带着上一次留下的僵尸锁：新建浏览器会话前再查一次，
    // 否则要到 Playwright 里才炸出 ProcessSingleton 原始错误。
    bridge.ensureProfileLock?.()
    const opened = await bridge.request(
      'open',
      { url: target.url, profile: this.config.profile, include_urls: false, max_chars: 0 },
      this.config.openTimeoutMs,
    )
    const sid = opened.session_id
    this.sessions.set(target.name, sid)
    this.note('open ' + target.name + ' url=' + (opened.url ?? target.url) + ' sid=' + sid)
    return { target, bridge, sid }
  }

  /**
   * 会话过期后的单飞重开：同一目标并发遇到过期时只重开一次。
   * 返回新的 {target, bridge, sid}；失败时抛**重开本身的**错误（调用方保留原始错误）。
   */
  async #reopenSession(targetName, staleSid, cause) {
    const target = resolveTarget(this.config, targetName)
    const pending = this.reopening.get(target.name)
    if (pending !== undefined) {
      const reopened = await pending
      if (reopened.sid === staleSid) throw cause
      return reopened
    }
    const task = (async () => {
      this.note('浏览器会话过期/失效，自动重开一次：target=' + target.name + ' sid=' + staleSid
        + '（' + String(cause?.message ?? cause).slice(0, 120) + '）')
      this.sessions.delete(target.name)
      return this.open(target.name)
    })()
    this.reopening.set(target.name, task)
    try {
      return await task
    } finally {
      if (this.reopening.get(target.name) === task) this.reopening.delete(target.name)
    }
  }

  /**
   * 所有「带 session_id 的桥调用」都走这里：遇到会话过期自动重开 + 重试一次；
   * 重开/重试仍失败就把**原始错误**抛回调用方。
   *
   * 两个边界：
   *   · `retryOnExpired:false` 给「选好会话之后」的写路径用 —— 重开等于换了一张
   *     空白页（输入框/焦点/选中行全没了），单条重试不可能把消息投给对的人，
   *     宁可按投递失败如实报出来；
   *   · `afterReopen` 给读路径用 —— 重试前先重新选中目标会话，否则读到的
   *     是空白页（或别的会话）的文本。这是「自愈后仍读对」的必要条件。
   */
  async #request(targetName, op, args = {}, { retryOnExpired = true, afterReopen = null } = {}) {
    const first = await this.open(targetName)
    try {
      return await first.bridge.request(op, { ...args, session_id: first.sid }, this.config.opTimeoutMs)
    } catch (error) {
      if (!retryOnExpired || !isExpiredSessionError(error, first.sid)) throw error
      let fresh
      try {
        fresh = await this.#reopenSession(targetName, first.sid, error)
        if (typeof afterReopen === 'function') await afterReopen(fresh)
      } catch (reopenError) {
        this.note('会话过期后重开（或重开后的重新选中）失败，抛原始错误：'
          + String(reopenError?.message ?? reopenError).slice(0, 120))
        throw error
      }
      try {
        return await fresh.bridge.request(op, { ...args, session_id: fresh.sid }, this.config.opTimeoutMs)
      } catch (retryError) {
        this.note('重开会话后重试仍失败，抛原始错误：' + String(retryError?.message ?? retryError).slice(0, 120))
        throw error
      }
    }
  }

  /**
   * 写路径专用：**选好会话之后**不再自愈重开。
   *
   * 重开 = 换一张空白页：选中行、输入框内容、焦点全没了。此时单条重试
   * `press` 只会在空白页上按一下回车，`act` 写输入框会把正文写进「当前页面」
   * 而不是目标会话 —— 把消息投给错的人比投递失败贵得多。所以写路径遇到
   * 会话过期就如实报失败（一级回执按 failed 记），由调用方重发。
   */
  #requestLocked(targetName, op, args = {}) {
    return this.#request(targetName, op, args, { retryOnExpired: false })
  }

  /* ── 浏览器操作 ─────────────────────────────────────────── */

  async #readSidebar(targetName) {
    const res = await this.#request(targetName, 'act', {
      action: { allow_js: true, action: 'dom_eval', js: jsSidebar() },
    })
    const data = res.dom_eval?.result ?? {}
    return {
      rows: (data.rows ?? []).filter((row) => row.title !== ''),
      groups: data.groups ?? [],
      url: data.url ?? null,
    }
  }

  /** 读侧边栏：会话行 + 工作区分组（对端与 local 走同一结构信号）。 */
  async sidebar(targetName) {
    const { target } = await this.open(targetName)
    let bar = await this.#readSidebar(targetName)
    const collapsed = bar.groups.filter((group) => !group.expanded)
    if (collapsed.length > 0 && bar.rows.length === 0) {
      for (const group of collapsed.slice(0, 4)) {
        await this.#clickRowByTitle(targetName, group.name, 'projectRow')
      }
      bar = await this.#readSidebar(targetName)
      return { target, text: bar, rows: bar.rows, groups: bar.groups, url: bar.url, expanded: true }
    }
    return { target, text: bar, rows: bar.rows, groups: bar.groups, url: bar.url, expanded: false }
  }

  async #clickRowByTitle(targetName, title, rowKind = 'sessionRow') {
    const sel = rowKind === 'projectRow' ? SEL.projectRow : SEL.sessionRow
    // 结构化点击（自带遮挡预检）
    try {
      const res = await this.#request(targetName, 'act', { action: { action: 'click_text', text: title } })
      if (res.receipt?.clicked !== undefined) return { how: 'click_text', res }
    } catch (error) {
      this.note('click_text 失败（' + title + '）：' + String(error?.message ?? error).slice(0, 120))
    }
    // 兜底：CDP 坐标点击（绕过浮层；调用方必须再做结构校验）
    const rect = await this.#request(targetName, 'act', {
      action: {
        allow_js: true,
        action: 'dom_eval',
        js: '(() => { const rows=[...document.querySelectorAll(' + JSON.stringify(sel) + ')];'
          + ' const pick = rows.find((r)=>((r.innerText||"").trim().includes(' + JSON.stringify(title) + ')));'
          + ' if(!pick) return null; const b=pick.getBoundingClientRect();'
          + ' return {x:Math.round(b.left+b.width/2), y:Math.round(b.top+b.height/2)}; })()',
      },
    })
    const at = rect.dom_eval?.result
    if (at === null || at === undefined) throw new MiraError('addressing/not-found', '侧边栏里找不到 ' + JSON.stringify(title) + '（' + rowKind + '）', '用 collab_list 核对当前可见标题')
    await this.#request(targetName, 'cdp_click', { x: at.x, y: at.y })
    return { how: 'cdp_click', at }
  }

  /**
   * 打开目标里的某个会话。
   * 打开成功的**唯一凭据**是「选中行 == 目标」的结构信号，而不是「页面上出现过这串字」。
   */
  async select(targetName, address) {
    const want = String(address?.title ?? '').trim()
    if (want === '') throw new MiraError('addressing/missing', 'select 需要 title', '用 alias / sessionId / 完整标题寻址')
    const { target } = await this.open(targetName)

    // 先看侧边栏：0 个候选 → 报「找不到」而不是瞎点；多个候选 → 报 ambiguous（不猜）
    let bar = (await this.sidebar(targetName)).text
    let matches = bar.rows.filter((row) => matchesTitleStrict(row.title, want))
    if (matches.length === 0) {
      const collapsed = bar.groups.filter((group) => !group.expanded)
      if (collapsed.length > 0) {
        for (const group of collapsed.slice(0, 4)) {
          await this.#clickRowByTitle(targetName, group.name, 'projectRow')
        }
        bar = (await this.sidebar(targetName)).text
        matches = bar.rows.filter((row) => matchesTitleStrict(row.title, want))
      }
    }
    if (matches.length === 0) {
      const visible = bar.rows.map((row) => row.title).slice(0, 12).join(' / ') || '(侧边栏里没有会话行)'
      throw new MiraError('addressing/not-found', '侧边栏里没有「' + want + '」这个会话（目标 ' + target.name + '）',
        '当前可见：' + visible + '。标题寻址是精确匹配（不再用前缀猜）；若标题被截断，把别名 title 改成侧边栏里原样的那串（含 …）再 collab_alias_set(overwrite:true)')
    }
    if (matches.length > 1) {
      throw new MiraError('addressing/ambiguous', '「' + want + '」匹配到 ' + matches.length + ' 个会话：'
        + matches.map((row) => row.title).join(' / '),
      '标题有歧义，不猜着点：改用本机 sessionId，或把别名 title 补到唯一（collab_alias_set + overwrite:true）')
    }

    await this.#request(targetName, 'wait', { ms: 600 })
    await this.#clickRowByTitle(targetName, want, 'sessionRow')
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await this.#request(targetName, 'wait', { ms: 900 })
      const check = await this.#readSidebar(targetName)
      const selected = check.rows.find((row) => row.selected)
      if (selected !== undefined && matchesTitleStrict(selected.title, want)) {
        return { target, sid: this.sessions.get(target.name) ?? null, title: selected.title, raw: selected.raw, verified: true }
      }
      if (attempt === 2) {
        // 可能目标在折叠的工作区里：展开后再试一次
        for (const group of check.groups.filter((item) => !item.expanded).slice(0, 4)) {
          await this.#clickRowByTitle(targetName, group.name, 'projectRow')
        }
        await this.#clickRowByTitle(targetName, want, 'sessionRow')
      }
    }
    const rows = (await this.sidebar(targetName)).rows
    const selected = rows.find((row) => row.selected)
    throw new MiraError('delivery/failed',
      '点开了「' + want + '」，但侧边栏选中的是「' + (selected?.title ?? '(读不到选中行)') + '」——判定为**没打开**',
      '不返回成功，以免把消息投给别的会话。用 collab_list 核对侧边栏里看得见的标题')
  }

  /** 读对话文本（滤掉 GUI 自身文案）。 */
  async read(targetName, { address = null, tail } = {}) {
    const resolvedTargetName = address?.target ?? targetName
    if (address !== null) await this.select(resolvedTargetName, address)
    const { target } = await this.open(resolvedTargetName)
    const res = await this.#request(resolvedTargetName, 'texts', { wait_ms: 600 }, {
      // 自愈重开得到的是一张空白页；先按同一地址重新选中，再重试读书，
      // 否则会把「别的会话/空白页」的文本当成本会话的（这类错读比报错更贵）。
      afterReopen: address === null ? null : async () => { await this.select(resolvedTargetName, address) },
    })
    const body = (res.texts ?? []).filter((item) => String(item.text).trim() !== '' && !isNoise(item.text))
    const lines = body.map((item) => String(item.text))
    return {
      target: target.name,
      url: res.page_url ?? null,
      count: lines.length,
      lines: tail !== undefined && tail > 0 ? lines.slice(-tail) : lines,
    }
  }

  /* ── 寻址 ───────────────────────────────────────────────── */

  /**
   * 把工具参数解析成一个可点的地址。
   * 优先级：alias > sessionId（本机）> title（兼容路径，精确匹配）。
   * @returns {{target:string, targetKind:string, alias:string|null, sessionId:string|null, title:string, source:string}}
   */
  resolveAddress({ target, alias, sessionId, title } = {}) {
    const explicitTarget = target === undefined || target === null || String(target).trim() === '' ? null : String(target).trim()
    const rawAlias = alias === undefined || alias === null || String(alias).trim() === '' ? null : String(alias).trim()
    const rawSessionId = sessionId === undefined || sessionId === null || String(sessionId).trim() === '' ? null : String(sessionId).trim()
    const rawTitle = title === undefined || title === null || String(title).trim() === '' ? null : String(title).trim()

    if (rawAlias !== null) {
      const { record } = this.aliases.get(rawAlias)
      if (explicitTarget !== null && explicitTarget.toLowerCase() !== String(record.target).toLowerCase()) {
        throw new MiraError('addressing/conflict',
          '别名 ' + rawAlias + ' 指向 ' + record.target + '，与本次 target=' + explicitTarget + ' 冲突',
          '去掉 target（让它跟着别名走）或 collab_alias_set(overwrite:true) 改指向')
      }
      const resolved = resolveTarget(this.config, record.target)
      let resolvedTitle = typeof record.title === 'string' ? record.title : ''
      let resolvedSessionId = typeof record.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null
      if (resolvedSessionId !== null) {
        if (resolved.kind === 'local') {
          const local = localSessions()
          const stored = local.get(resolvedSessionId)
          if (stored === undefined) {
            throw new MiraError('addressing/not-found',
              '别名 ' + rawAlias + ' 记的 sessionId ' + resolvedSessionId + ' 不在本机会话存储里（可能已被删除）',
              '用 collab_list 核对本机 id；或 collab_alias_set(alias:"' + rawAlias + '", overwrite:true, title:"…") 改指向')
          }
          if (stored !== '') resolvedTitle = stored
        } else if (resolvedTitle === '') {
          throw new MiraError('addressing/not-found',
            '别名 ' + rawAlias + ' 只有跨机 sessionId，没有 title —— 跨机 id 不可寻址',
            '跨机别名必须带对端侧边栏里完整的 title；重新 collab_alias_set(overwrite:true) 登记')
        }
      }
      if (resolvedTitle === '') {
        throw new MiraError('addressing/not-found', '别名 ' + rawAlias + ' 没有可点的 title',
          '重新 collab_alias_set(alias:"' + rawAlias + '", overwrite:true, title:"…") 登记完整标题')
      }
      return {
        target: resolved.name,
        targetKind: resolved.kind,
        alias: rawAlias,
        sessionId: resolvedSessionId,
        title: resolvedTitle,
        source: 'alias',
      }
    }

    if (rawSessionId !== null) {
      const resolved = resolveTarget(this.config, explicitTarget ?? 'local')
      if (resolved.kind !== 'local') {
        throw new MiraError('addressing/not-found',
          'sessionId ' + rawSessionId + ' 是**本机**会话存储里的 id，而目标是 ' + resolved.name + '（' + resolved.kind + '）',
          'id↔标题的映射是各机本地的，跨机按 id 必然 0 命中；跨机请用别名（collab_alias_set）或对端侧边栏里完整的标题')
      }
      const stored = localSessions().get(rawSessionId)
      if (stored === undefined) {
        throw new MiraError('addressing/not-found', 'sessionId ' + rawSessionId + ' 不在本机会话存储里',
          '用 collab_list 看本机 id 与标题；id 可能属于别的工作区/已被删除')
      }
      return {
        target: resolved.name,
        targetKind: resolved.kind,
        alias: null,
        sessionId: rawSessionId,
        title: stored !== '' ? stored : rawTitle ?? '',
        source: 'sessionId',
      }
    }

    if (rawTitle !== null) {
      const resolved = resolveTarget(this.config, explicitTarget ?? 'local')
      // 本机可用标题反查稳定 id（唯一时），让回执与别名都能挂到 id 上
      let resolvedSessionId = null
      if (resolved.kind === 'local') {
        const hits = [...localSessions().entries()].filter(([, storedTitle]) => storedTitle === rawTitle)
        if (hits.length === 1) resolvedSessionId = hits[0][0]
      }
      return {
        target: resolved.name,
        targetKind: resolved.kind,
        alias: null,
        sessionId: resolvedSessionId,
        title: rawTitle,
        source: 'title',
      }
    }

    throw new MiraError('addressing/missing', '缺少寻址参数：alias / sessionId / session',
      '推荐 collab_alias_set 登记稳定别名后传 alias；本机也可传 sessionId；session 传完整标题（兼容旧用法，标题被截断时不可靠）')
  }

  /* ── 队列与锁 ───────────────────────────────────────────── */

  /** 同目标串行（页面状态共享）；不同目标互不阻塞。 */
  async #withTarget(name, fn) {
    const prev = this.locks.get(name) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const current = prev.then(() => gate)
    this.locks.set(name, current)
    await prev.catch(() => {})
    try {
      return await fn()
    } finally {
      release()
      if (this.locks.get(name) === current) this.locks.delete(name)
    }
  }

  /* ── 发送 ───────────────────────────────────────────────── */

  /**
   * 发一条消息。
   * @param {string} targetName
   * @param {{alias?:string, sessionId?:string, title?:string, text:string, splice?:boolean,
   *          envelope?:boolean, replyTo?:string, self?:string}} options
   */
  async send(targetName, { alias, sessionId, title, text, splice = true, envelope = true, replyTo, self, fromId } = {}) {
    const bodyText = String(text ?? '')
    if (bodyText.trim() === '') throw new MiraError('delivery/failed', 'send 需要非空 text', '把要发的正文放进 text')
    const resolved = this.resolveAddress({ target: targetName, alias, sessionId, title })
    const queueEntry = this.queue.begin({
      target: resolved.target,
      alias: resolved.alias,
      sessionId: resolved.sessionId,
      title: resolved.title,
    })
    try {
      return await this.#withTarget(resolved.target, async () => {
        queueEntry.setState('sending')
        return this.#sendLocked(resolved, {
          text: bodyText,
          splice: splice !== false,
          envelope: envelope !== false,
          replyTo,
          self,
          fromId,
        })
      })
    } catch (error) {
      this.#fail(error)
      const normalized = toError(error, 'delivery/failed', '看 collab_status 的 log / lastError')
      this.note('send 失败 target=' + resolved.target + '：' + normalized.error.code + ' ' + normalized.error.message)
      throw new MiraError(normalized.error.code, normalized.error.message, normalized.error.hint)
    } finally {
      queueEntry.done()
    }
  }

  async #sendLocked(resolved, { text, splice, envelope, replyTo, self, fromId }) {
    const picked = await this.select(resolved.target, resolved)
    const { target } = await this.open(resolved.target)

    const before = await this.#requestLocked(resolved.target, 'act', {
      action: { allow_js: true, action: 'dom_eval', js: JS_COMPOSER_STATE },
    })
    const stateBefore = before.dom_eval?.result ?? null

    const body = envelope
      ? withEnvelope(text, {
        to: target.name,
        toTitle: picked.title,
        self: self ?? selfNameOf(this.config),
        replyTo: replyTo ?? this.advertisedReplyTo(),
        fromId,
      })
      : text

    const composer = await this.#requestLocked(resolved.target, 'act', {
      action: { allow_js: true, action: 'dom_eval', js: jsComposer() },
    })
    const box = composer.dom_eval?.result
    if (box === null || box === undefined) throw new MiraError('delivery/failed', '找不到聊天输入框（可见的 textarea / contenteditable）', '先 collab_read 触发一次页面提取；或确认对端 GUI 已加载')
    if (box.aiId === null) {
      throw new MiraError('delivery/failed', '输入框没有 data-ai-id：ai_browser 没把它识别成可输入元素', '先做一次 collab_read 触发提取')
    }

    const filled = await this.#requestLocked(resolved.target, 'act', {
      action: { id: box.aiId, text: body },
    })
    if (filled.receipt?.error !== undefined) {
      throw new MiraError('delivery/failed', '写入输入框失败：' + JSON.stringify(filled.receipt.error).slice(0, 200), '看桥日志；确认输入框可写')
    }

    const receiptId = this.tracker.begin({
      target: target.name,
      alias: resolved.alias,
      sessionId: resolved.sessionId,
      title: picked.title,
      text: body,
      transport: 'browser',
      meta: { splice, addressing: resolved.source },
    })

    try {
      await this.#requestLocked(resolved.target, 'press', { key: 'Enter', modifiers: splice ? ['Control'] : [] })
      this.tracker.markWritten(receiptId, { detail: { submitted: true } })
    } catch (error) {
      this.tracker.markFailed(receiptId, error)
      throw error
    }

    // 校验：分三个事实报，不把「我没看到」编码成「没发生」（agent-chat 的教训）。
    // 注意：这里已经是一级回执之后了 —— 校验本身失败**不能**把「已写入」改判成失败。
    const probe = flatText(body).slice(0, 14)
    let verified = false
    let linesSeen = 0
    try {
      await this.#requestLocked(resolved.target, 'wait', { ms: 2000 })
      for (let i = 0; i < 6 && !verified; i += 1) {
        const texts = await this.#requestLocked(resolved.target, 'texts', { wait_ms: 300 })
        const lines = (texts.texts ?? []).filter((item) => String(item.text).trim() !== '' && !isNoise(item.text))
        linesSeen = lines.length
        const blob = lines.map((item) => item.text).join('\n')
        if (probe.length >= 4 && flatText(blob).includes(probe)) verified = true
        else await this.#requestLocked(resolved.target, 'wait', { ms: 800 })
      }
    } catch (error) {
      this.note('写入后校验失败（不影响一级回执）：' + String(error?.message ?? error).slice(0, 120))
    }
    let stateAfter = null
    try {
      const after = await this.#requestLocked(resolved.target, 'act', {
        action: { allow_js: true, action: 'dom_eval', js: JS_COMPOSER_STATE },
      })
      stateAfter = after.dom_eval?.result ?? null
    } catch (error) {
      this.note('读取 composer 状态失败（不影响一级回执）：' + String(error?.message ?? error).slice(0, 120))
    }
    const queued = (stateAfter?.queue ?? 0) > (stateBefore?.queue ?? 0)
    const busy = Boolean(stateAfter?.busy)

    // 挂二级探测：拿当前页面（仍停在目标会话）判断「开跑 / 已读」
    this.tracker.setProbe(receiptId, () => this.#probeBrowser({
      targetName: target.name,
      title: picked.title,
      text: body,
      baseline: { queue: stateBefore?.queue ?? 0, lines: linesSeen },
    }))
    await this.refreshReceipt(receiptId)

    if (resolved.alias !== null) {
      const touched = this.aliases.touch(resolved.alias)
      if (!touched) this.counters?.bump('addressing/touch-skipped')
    }

    const view = this.tracker.view(receiptId)
    return {
      target: target.name,
      to: {
        alias: resolved.alias,
        sessionId: resolved.sessionId,
        title: picked.title,
        addressing: resolved.source,
      },
      mode: splice ? 'splice' : 'queue',
      // 兼容 0.1.0 的字段名（值同新字段；老调用方不用改）
      splice: splice === true,
      to_title: picked.title,
      composer_before: stateBefore?.placeholder ?? null,
      composer_after: stateAfter?.placeholder ?? null,
      receiptId,
      receipt: view.receipt,
      receiptLevel2: view.receiptLevel2,
      submitted: true,
      verified,
      accepted: verified || queued || busy,
      queued,
      busy,
      chars: body.length,
      composer: { before: stateBefore?.placeholder ?? null, after: stateAfter?.placeholder ?? null },
      ...(resolved.source === 'title'
        ? { addressingNote: '标题寻址是兼容路径：标题可能被截断/重名。建议 collab_alias_set 登记别名（或本机用 sessionId）后改传 alias。' }
        : {}),
      ...(verified
        ? {}
        : {
          note: '已提交（submitted=true），但页面上没看到该文本、排队数也没变——这**不等于**没发出去'
            + '（长会话的页面文本窗口会滚掉刚送达的消息）。用 collab_receipt/collab_wait 看二级回执，**不要重发**。',
        }),
    }
  }

  /**
   * 二级探测（浏览器路径）：只读当前页面，返回 {running, read, evidence}。
   * 若页面已经切到别的会话，返回 evidence=page-moved 且不推进（不拿别人的文本冒充）。
   */
  async #probeBrowser({ targetName, title, text, baseline }) {
    let selected = null
    try {
      const bar = await this.#readSidebar(targetName)
      selected = bar.rows.find((row) => row.selected) ?? null
    } catch (error) {
      return { evidence: 'sidebar-read-failed:' + (error?.message ?? String(error)).slice(0, 80) }
    }
    if (selected !== null && !matchesTitleStrict(selected.title, title)) {
      return { evidence: 'page-moved:' + selected.title }
    }
    let state = null
    try {
      const res = await this.#request(targetName, 'act', {
        action: { allow_js: true, action: 'dom_eval', js: JS_COMPOSER_STATE },
      })
      state = res.dom_eval?.result ?? null
    } catch {
      /* 读不到 composer 就只看文本 */
    }
    let lines = []
    try {
      const res = await this.#request(targetName, 'texts', { wait_ms: 300 })
      lines = (res.texts ?? []).filter((item) => String(item.text).trim() !== '' && !isNoise(item.text))
    } catch {
      /* 读不到文本就算「没观察到」 */
    }
    const probe = flatText(text).slice(0, 14)
    const readVisible = probe.length >= 4 && flatText(lines.map((item) => item.text).join('\n')).includes(probe)
    const grew = lines.length > (baseline?.lines ?? 0)
    const queue = state?.queue ?? 0
    const running = readVisible || Boolean(state?.busy) || queue > (baseline?.queue ?? 0) || grew
    return {
      read: readVisible,
      running,
      evidence: readVisible ? 'text-visible' : running ? 'busy-or-new-lines' : 'no-change',
    }
  }

  /**
   * 推进一条回执的二级状态（浏览器探测或宿主 agent 探测都由 record.probe 提供）。
   * 探测失败只记 error，不改状态。
   */
  async refreshReceipt(id) {
    const record = this.tracker.get(id)
    if (record === null) {
      throw new MiraError('receipt/not-found', '回执不存在：' + id, '回执是进程内状态（重启即失效）；用 collab_status 看当前在途')
    }
    if (typeof record.probe === 'function') {
      try {
        const observation = await record.probe()
        if (observation && typeof observation === 'object') this.tracker.observe(id, observation)
      } catch (error) {
        this.tracker.observeError(id, error)
      }
    }
    return this.tracker.view(id)
  }

  /** 一次发给多个目标；逐条回执，单个失败不阻断其余。 */
  async sendMany(items, { envelope = true, replyTo, self, fromId } = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      throw new MiraError('addressing/missing', 'send_many 需要非空 items', '每项：{ alias 或 sessionId 或 session 或 target+session, text, splice? }')
    }
    const results = await Promise.all(items.map(async (item, index) => {
      const payload = item && typeof item === 'object' ? item : {}
      const label = payload.alias ?? payload.session ?? payload.sessionId ?? payload.target ?? ('#' + index)
      try {
        const sent = await this.send(payload.target, {
          alias: payload.alias,
          sessionId: payload.sessionId,
          title: payload.session ?? payload.title,
          text: payload.text,
          splice: payload.splice,
          envelope,
          replyTo,
          self,
          fromId,
        })
        return { index, ok: true, label, ...sent }
      } catch (error) {
        const normalized = toError(error, 'delivery/failed', '逐条看 results[].error；修好后只重试失败的那几条')
        return {
          index,
          ok: false,
          label,
          target: payload.target ?? null,
          alias: payload.alias ?? null,
          error: normalized.error,
        }
      }
    }))
    const failed = results.filter((item) => !item.ok).length
    const sent = results.length - failed
    return {
      ok: sent > 0,
      partial: failed > 0 && sent > 0,
      requested: results.length,
      sent,
      failed,
      results,
      ...(sent === 0
        ? {
          error: {
            code: 'delivery/failed',
            message: '所有目标都投递失败（' + failed + '/' + results.length + '）',
            hint: '逐条看 results[].error；单条失败同样会带回这条 receipt/error',
          },
        }
        : {}),
    }
  }

  /* ── 等待与回执 ─────────────────────────────────────────── */

  /**
   * 等对端回话：先等自己的消息落地（免得把回声当回复），再轮询文本增长。
   * 顺带推进所等会话最近一条投递的二级回执。
   */
  async waitReply(targetName, { alias, sessionId, title, seconds = 180, pollMs } = {}) {
    const hasAddress = [alias, sessionId, title].some((value) => value !== undefined && value !== null && String(value).trim() !== '')
    const address = hasAddress ? this.resolveAddress({ target: targetName, alias, sessionId, title }) : null
    const resolvedTargetName = address?.target ?? targetName
    if (address !== null) await this.select(resolvedTargetName, address)
    const { target } = await this.open(resolvedTargetName)

    const readLines = async () => {
      const res = await this.#request(resolvedTargetName, 'texts', { wait_ms: 300 }, {
        // 同上：自愈重开后要重新选中，别把空白页/别的会话当成目标会话。
        afterReopen: address === null ? null : async () => { await this.select(resolvedTargetName, address) },
      })
      return (res.texts ?? []).filter((item) => String(item.text).trim() !== '' && !isNoise(item.text)).map((item) => String(item.text))
    }
    await this.#request(resolvedTargetName, 'wait', { ms: 2500 })
    const base = await readLines()
    const deadline = this.now() + Math.max(5, Number(seconds) || 180) * 1000
    let grew = 0
    let lines = []
    while (this.now() < deadline) {
      await this.sleep(pollMs ?? this.pollMs)
      const nowLines = await readLines()
      if (nowLines.length > base.length) {
        grew = nowLines.length - base.length
        lines = nowLines.slice(base.length)
        break
      }
    }

    let receipt = null
    // 没给地址 = 等「当前页面」，此时不能把同目标里别的会话的回执挂上来
    const record = address === null
      ? null
      : this.tracker.findLatest({
        target: target.name,
        alias: address.alias,
        sessionId: address.sessionId,
        title: address.title,
      })
    if (record !== null) {
      try {
        receipt = await this.refreshReceipt(record.id)
      } catch (error) {
        this.tracker.observeError(record.id, error)
        receipt = this.tracker.view(record.id)
      }
    }
    return {
      target: target.name,
      // 兼容 0.1.0：to_title 是老字段名
      to_title: address?.title ?? null,
      to: address === null ? null : { alias: address.alias, sessionId: address.sessionId, title: address.title },
      grew,
      lines,
      timeout: grew === 0,
      receiptId: receipt?.receiptId ?? null,
      receiptLevel2: receipt?.receiptLevel2 ?? null,
      receipt,
    }
  }

  /* ── 状态 ───────────────────────────────────────────────── */

  advertisedReplyTo() {
    if (typeof this.config.replyUrl === 'string' && this.config.replyUrl.trim() !== '') return this.config.replyUrl.trim()
    const described = this.listener?.describe?.()
    return described?.url ?? null
  }

  statusSnapshot({ configView = null, inbound = null } = {}) {
    const described = this.listener?.describe?.() ?? {
      mode: this.config.listen?.mode ?? 'unset',
      host: this.config.listen?.ip ?? null,
      port: null,
      url: null,
      state: 'unset',
      loopback: false,
      auth: 'unset',
    }
    const config = configView ?? {
      file: this.configFile,
      schemaVersion: null,
      listen: {
        mode: this.config.listen?.mode ?? 'unset',
        host: this.config.listen?.ip ?? null,
        port: this.config.listen?.port ?? null,
      },
      replyTo: this.advertisedReplyTo(),
      self: selfNameOf(this.config),
      localGuiUrl: this.config.localGuiUrl,
      proxyPort: this.config.proxyPort,
      profilesDir: this.config.profilesDir,
      tmpDir: this.config.tmpDir,
      python: this.config.python,
      aiBrowserHome: this.config.aiBrowserHome,
      playwrightBrowsersPath: this.config.playwrightBrowsersPath,
      targets: [],
    }
    return {
      ok: true,
      name: 'mira_browser',
      version: this.version,
      pid: process.pid,
      config,
      listen: described,
      aliases: this.aliases.summary(),
      bridges: this.bridges.size,
      sessions: this.sessions.size,
      queue: this.queue.snapshot(),
      inflight: this.tracker.inflight(),
      receipts: this.tracker.counts(),
      inbound: inbound ?? (this.inboundStatus ? this.inboundStatus() : { ready: false, reason: '未接线' }),
      counters: this.counters?.snapshot?.() ?? {},
      lastError: this.lastError,
      log: this.log.slice(-12),
    }
  }

  async closeBrowsers() {
    const out = []
    for (const [key, bridge] of this.bridges) {
      try {
        await bridge.stop()
        out.push(key)
      } catch (error) {
        this.logger?.warn?.('[mira_browser] 关闭桥失败（' + key + '）：' + (error?.message ?? String(error)))
      }
    }
    this.bridges.clear()
    this.sessions.clear()
    this.queue.clear()
    return out
  }
}

/* -------------------------------------------------------------- 消息信封 ---- */

/**
 * 消息信封：让对端知道**消息从哪来、该回哪儿**。
 *
 * 与 0.1.0 的差别：`reply_to` 不再是「网卡探测出来的」地址，而是**本插件手填的监听地址**
 * （`listen` 推导，或在 config 里显式 replyUrl 覆盖）。回环监听时它就是 127.0.0.1 ——
 * 那意味着只有同机对端能回调，跨机对端仍可用「在你正看着的会话里回复」。
 */
export function withEnvelope(text, { to, toTitle, self, replyTo, fromId } = {}) {
  const from = typeof fromId === 'string' && fromId !== '' ? fromId : selfSessionId()
  const where = toTitle ? to + ':' + toTitle : to
  const lines = ['【mira_browser】from_id=' + from + ' goto=' + where]
  if (self !== undefined || replyTo !== undefined) {
    lines.push('from_peer=' + (self ?? '(未命名)') + '  reply_to=' + (replyTo ?? '(未配置)'))
    lines.push('回信：**就在你正看着的这条会话里回复即可**，我会读回来。')
    if (replyTo) {
      lines.push('（本节点同时监听 ' + replyTo + '，可用 POST ' + replyTo + 'collab/deliver 直投本机会话；'
        + '非回环监听需要 Bearer 令牌，令牌不随消息传递。）')
    }
  }
  return lines.join('\n') + '\n\n' + text
}

/* --------------------------------------------------------------- 自检钩子 ---- */

/** 给 test/smoke.mjs 用：假 bridge 靠这些 JS 字符串识别操作（不是公开运行时 API）。 */
export const __testing = {
  jsSidebar,
  jsComposer,
  jsComposerState: () => JS_COMPOSER_STATE,
  jsRowRect,
  flatText,
  makeError: (code, message, hint) => new MiraError(code, message, hint),
}
