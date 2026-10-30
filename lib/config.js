/**
 * mira_browser / config.js —— 配置解析与校验
 *
 * 配置分两层（**显式优先**，与任务书约定2 一致）：
 *   1. `$DSH_HOME/mira_config/mira_browser/config.json`（手填文件，带 schemaVersion）
 *   2. 宿主 bundle / profile 补丁层传进来的 `config:`（apply 的第二个参数）
 *   合并顺序：内置默认值 ← config.json ← 宿主传入。宿主传入是最显式的一方，赢。
 *
 * 为什么还要文件：任务书【定】要求 `listen.ip`/`listen.port` **手填**，而 profile 层是
 * 代码仓库里的补丁（跟着仓库走），把「这台机器的监听地址」写在那里既不好改也不好审计。
 * 文件是给人手填的；profile 层继续认（见 README「升级注意」）。
 *
 * 不做自动探测：listen 为空 → `config/missing`，hint 指到具体文件。唯一例外是显式
 * `listen: "loopback"`（只监听 127.0.0.1，端口由系统分配）。
 *
 * 本文件只依赖 node: 内置与 ./kit.mjs。
 */

import { readFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { isIP } from 'node:net'
import { join } from 'node:path'

import {
  MiraError,
  checkSchema,
  deepMerge,
  ensureDir,
  fail,
  fileMode,
  isEmptyValue,
  miraConfigDir,
  readJsonStrict,
  writeJsonAtomic,
} from './kit.mjs'

export const PLUGIN = 'mira_browser'
export const CONFIG_VERSION = 1
export const CREDS_VERSION = 1

/** 本插件自己的目录：配置、别名表、监听令牌、加载标记都放这里（约定1）。 */
export function configDir() {
  return miraConfigDir(PLUGIN)
}

export function configFile() {
  return join(configDir(), 'config.json')
}

export function aliasesFile() {
  return join(configDir(), 'aliases.json')
}

/** 非回环监听的入站令牌（600、只给 /collab/* 用、永不回显）。 */
export function listenTokenFile() {
  return join(configDir(), 'listen-token')
}

export function targetCredsFile(targetName) {
  return join(configDir(), 'creds', String(targetName) + '.json')
}

/**
 * 内置默认值。只放「不填也能跑」的项；**必备项（listen）故意留空**，
 * 由 requireListen() 在工具调用时明确报错，而不是猜一个地址。
 *
 * python / aiBrowserHome / playwrightBrowsersPath 是跨平台差异最大、又没法安全探测的三项：
 * 这里给本机 Linux 实测值，换机器请在 config.json 或 profile 补丁里显式覆盖
 * （Windows 值见 README「跨平台默认值」一节）。
 */
export function defaults() {
  return {
    enabled: true,
    // 本节点在对端 targets 里的名字；留空 = 机器名（只影响显示与信封，不影响投递）
    self: '',
    /**
     * 【定】自身监听地址手填：
     *   { "ip": "192.0.2.10", "port": 8544 }   ← 正常形态
     *   "loopback"                                 ← 唯一例外：只监听本机回环、端口由系统分配
     * 为空 → 所有 collab_* 工具返回 config/missing（MCP 浏览器工具不受影响）。
     */
    listen: { ip: '', port: 0 },
    // 本机 GUI 直连地址（target=local）
    localGuiUrl: 'http://127.0.0.1:3080/',
    // 本机 mira_proxy 的端口：target=proxy 在没登记 targets[0] 时用它拼 https://127.0.0.1:<port>/
    proxyPort: 8543,
    // 浏览器档案名（各目标共用一个档案；cookie 按 host 区分）
    profile: 'dsh-collab',
    // 远程 DSH 实例：{ name, baseUrl, user?, pass?, listenUrl? }
    targets: [],
    // ai_browser 运行期三件事（本机 Linux 实测值；换机器显式覆盖）
    python: process.env.MIRA_BROWSER_PY || '/opt/ai-browser/.venv/bin/python',
    aiBrowserHome: process.env.MIRA_BROWSER_HOME || '/opt/ai-browser',
    playwrightBrowsersPath: process.env.MIRA_BROWSER_PW || ((process.env.HOME || '~') + '/.cache/ms-playwright'),
    // 兼容旧配置：root + .mira_browser/{profiles,tmp}
    root: '',
    profilesDir: '',
    tmpDir: '',
    // 自签证书（mira_proxy 的入口就是自签的）
    ignoreHttps: true,
    openTimeoutMs: 180_000,
    opTimeoutMs: 60_000,
    // 显式覆盖「信封里的回信地址」；空 = 由 listen 推导（一般不要填）
    replyUrl: '',
  }
}

/** 给用户看的配置模板（只在 config.json 不存在时写一次）。 */
export function template() {
  const base = defaults()
  return {
    schemaVersion: CONFIG_VERSION,
    _comment:
      '手填 listen.ip 与 listen.port；只监听本机回环写 "listen": "loopback"。'
      + 'python / aiBrowserHome / playwrightBrowsersPath 按本机实际路径改。详见 mira_browser/README.md。',
    enabled: base.enabled,
    self: base.self,
    listen: { ip: '', port: 0 },
    localGuiUrl: base.localGuiUrl,
    proxyPort: base.proxyPort,
    profile: base.profile,
    python: base.python,
    aiBrowserHome: base.aiBrowserHome,
    playwrightBrowsersPath: base.playwrightBrowsersPath,
    profilesDir: base.profilesDir,
    tmpDir: base.tmpDir,
    targets: [],
  }
}

function invalid(message, hint) {
  const error = { code: 'config/invalid', message: String(message ?? '') }
  if (hint) error.hint = String(hint)
  return error
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function positiveNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

/** 监听地址归一化：只认 "loopback" 与 {ip,port} 两种显式形态。 */
export function normalizeListen(value, file) {
  if (typeof value === 'string') {
    if (value.trim().toLowerCase() === 'loopback') {
      return { mode: 'loopback', ip: '127.0.0.1', port: 0 }
    }
    return {
      mode: 'invalid',
      ip: '',
      port: 0,
      error: invalid(
        'listen=' + JSON.stringify(value) + ' 不是可识别的形态',
        '只接受 "loopback"（只监听本机回环）或 { "ip": "...", "port": N }；见 ' + file,
      ),
    }
  }
  if (!isPlainObject(value)) {
    return {
      mode: 'invalid',
      ip: '',
      port: 0,
      error: invalid('listen 必须是 "loopback" 或 { ip, port } 对象',
        '在 ' + file + ' 里手填 listen.ip 与 listen.port（本插件不自动探测）'),
    }
  }
  const ip = typeof value.ip === 'string' ? value.ip.trim() : ''
  const rawPort = value.port
  const portEmpty = rawPort === undefined || rawPort === null || rawPort === '' || rawPort === 0
  if (ip === '' && portEmpty) return { mode: 'unset', ip: '', port: 0 }
  if (ip === '') {
    return { mode: 'unset', ip: '', port: 0, partial: true }
  }
  if (portEmpty) {
    return { mode: 'unset', ip, port: 0, partial: true }
  }
  const port = Number(rawPort)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return {
      mode: 'invalid',
      ip,
      port: 0,
      error: invalid('listen.port=' + JSON.stringify(rawPort) + ' 不是 1–65535 的整数',
        '在 ' + file + ' 里手填 listen.port；想用系统随机端口请写 "listen": "loopback"'),
    }
  }
  if (ip === '0.0.0.0' || ip === '::') {
    return {
      mode: 'invalid',
      ip,
      port,
      error: invalid('listen.ip=' + JSON.stringify(ip) + ' 不能当回信地址',
        '填本机网卡上的具体 IPv4（本插件不做地址探测）；对端要回连，0.0.0.0 对它是不可达的'),
    }
  }
  if (isIP(ip) !== 4) {
    return {
      mode: 'invalid',
      ip,
      port,
      error: invalid('listen.ip=' + JSON.stringify(ip) + ' 不是 IPv4 字面量',
        '填本机网卡上的 IPv4（如 192.0.2.10）或 127.0.0.1；本轮不支持 IPv6/主机名'),
    }
  }
  return { mode: 'manual', ip, port }
}

/** target 列表校验：名字唯一、baseUrl 可解析、口令字段类型正确（口令永不回显）。 */
function normalizeTargets(raw, file) {
  if (!Array.isArray(raw)) {
    return { ok: false, error: invalid('targets 必须是数组', '在 ' + file + ' 里按 README 的 targets 表填写') }
  }
  const out = []
  const seen = new Set()
  for (const [index, item] of raw.entries()) {
    if (!isPlainObject(item)) {
      return { ok: false, error: invalid('targets[' + index + '] 不是对象', '每项形如 { name, baseUrl, user?, pass? }') }
    }
    const name = String(item.name ?? '').trim()
    if (name === '') {
      return { ok: false, error: invalid('targets[' + index + '].name 为空', '给每个远程实例一个唯一名字（对端据此在信封里认你）') }
    }
    // name 会拼进 creds/<name>.json 的路径：不允许路径分隔符/相对段
    if (/[\\/]/u.test(name) || name === '.' || name === '..' || name.includes(':')) {
      return { ok: false, error: invalid('targets[' + index + '].name 不能含路径分隔符/冒号：' + JSON.stringify(name), '名字只作显示与 creds 文件名，例：pc、mac-mini') }
    }
    const key = name.toLowerCase()
    if (seen.has(key)) {
      return { ok: false, error: invalid('targets 名字重复：' + name, '同一个 name 只能登记一次') }
    }
    seen.add(key)
    const baseUrl = String(item.baseUrl ?? '').trim()
    if (baseUrl === '') {
      return { ok: false, error: invalid('targets[' + index + '].baseUrl 为空', '填对端 mira_proxy 的入口地址，如 https://192.0.2.12:8543/') }
    }
    let parsed
    try {
      parsed = new URL(baseUrl)
    } catch {
      return { ok: false, error: invalid('targets[' + index + '].baseUrl 不是合法 URL：' + baseUrl, '例：https://192.0.2.12:8543/') }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { ok: false, error: invalid('targets[' + index + '].baseUrl 只支持 http/https：' + baseUrl, '例：https://192.0.2.12:8543/') }
    }
    const user = item.user === undefined || item.user === null ? '' : String(item.user)
    const pass = item.pass === undefined || item.pass === null ? '' : String(item.pass)
    out.push({ name, baseUrl, user, pass })
  }
  return { ok: true, value: out }
}

/**
 * 读配置。
 *
 * @returns {{
 *   ok: boolean, file: string, schemaVersion: number, created: boolean,
 *   config: object, warnings: string[], error?: {code,message,hint}
 * }}
 * 即使 ok=false 也返回一份 config（默认值 + 宿主传入），供「建目录 / status 展示」使用；
 * 但工具层会因 error 拒绝使用配置（约定7：不静默兼容）。
 */
export function loadConfig({ raw = {}, logger = null, counters = null } = {}) {
  const file = configFile()
  const warnings = []
  const hostRaw = isPlainObject(raw) ? raw : {}
  ensureDir(configDir())

  let fileValue = null
  let created = false
  const strict = readJsonStrict(file)
  if (!strict.ok) {
    if (strict.reason === 'missing') {
      const wrote = writeJsonAtomic(file, template(), { mode: 0o600 })
      created = wrote
      if (!wrote) {
        warnings.push('无法写入配置模板：' + file + '（权限？目录？）')
      }
      fileValue = template()
    } else if (strict.reason === 'corrupt') {
      return {
        ok: false,
        file,
        schemaVersion: CONFIG_VERSION,
        created,
        warnings,
        config: normalizeBestEffort(hostRaw, warnings, logger),
        error: fail(
          'config/corrupt',
          '配置文件不是合法 JSON：' + file + '（' + (strict.detail ?? '解析失败') + '）',
          '先备份、修好 JSON 再重载；本插件不会静默重建或覆盖你的文件',
        ).error,
      }
    } else {
      return {
        ok: false,
        file,
        schemaVersion: CONFIG_VERSION,
        created,
        warnings,
        config: normalizeBestEffort(hostRaw, warnings, logger),
        error: fail(
          'config/invalid',
          '配置文件顶层必须是 JSON 对象：' + file,
          '文件内容形如 { "schemaVersion": 1, "listen": "loopback" }；见 README 配置模板',
        ).error,
      }
    }
  } else {
    const checked = checkSchema(strict.value, CONFIG_VERSION, file)
    if (!checked.ok) {
      return {
        ok: false,
        file,
        schemaVersion: CONFIG_VERSION,
        created,
        warnings,
        config: normalizeBestEffort(hostRaw, warnings, logger),
        error: checked.error.error,
      }
    }
    fileValue = strict.value
  }

  if (hostRaw.schemaVersion !== undefined && hostRaw.schemaVersion !== CONFIG_VERSION) {
    return {
      ok: false,
      file,
      schemaVersion: CONFIG_VERSION,
      created,
      warnings,
      config: normalizeBestEffort(hostRaw, warnings, logger),
      error: fail(
        'config/schema',
        '宿主传入的 config.schemaVersion=' + JSON.stringify(hostRaw.schemaVersion) + '，本代码要求 ' + CONFIG_VERSION,
        'profile / bundle 补丁层里去掉 schemaVersion（这一层不需要它），或改成 ' + CONFIG_VERSION,
      ).error,
    }
  }

  const merged = deepMerge(deepMerge(defaults(), fileValue ?? {}), hostRaw)
  const normalized = normalize(merged, file, warnings, logger)
  if (!normalized.ok) {
    return {
      ok: false,
      file,
      schemaVersion: CONFIG_VERSION,
      created,
      warnings,
      config: normalizeBestEffort(hostRaw, warnings, logger),
      error: normalized.error,
    }
  }

  // 配置里如果还写着 targets[].pass（旧兼容），提醒迁移到 600 的 creds 文件。
  if (normalized.value.targets.some((target) => target.pass !== '')) {
    const hint = '建议把口令移到 ' + join(configDir(), 'creds', '<target>.json') + '（schemaVersion 1 + user/pass，chmod 600），'
      + 'config.json 里只留 user；旧写法仍被读取，但配置文件本身也请 chmod 600。'
    warnings.push(hint)
    if (logger) logger.warn?.('[mira_browser] 配置里存在明文 targets[].pass。' + hint)
    counters?.bump('config/inline-pass')
  }
  const mode = fileMode(file)
  if (mode !== -1 && (mode & 0o077) !== 0 && normalized.value.targets.some((target) => target.pass !== '')) {
    if (logger) logger.warn?.('[mira_browser] 配置文件含口令且权限为 0' + mode.toString(8) + '（组/其他人可读）；建议 chmod 600 ' + file)
    counters?.bump('config/insecure-mode')
  }

  return { ok: true, file, schemaVersion: CONFIG_VERSION, created, warnings, config: normalized.value }
}

/** 失败路径上尽量还原一份可用的路径配置（只用于建目录/展示，不用于投递）。 */
function normalizeBestEffort(hostRaw, warnings, logger) {
  try {
    const merged = deepMerge(deepMerge(defaults(), {}), hostRaw)
    const normalized = normalize(merged, configFile(), warnings, logger)
    if (normalized.ok) return normalized.value
  } catch {
    /* 落到内置默认 */
  }
  return defaults()
}

function normalize(merged, file, warnings, logger) {
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean') {
    return { ok: false, error: invalid('enabled 必须是 true/false', '在 ' + file + ' 里写 "enabled": true') }
  }
  const config = { ...merged }
  config.enabled = merged.enabled !== false
  config.self = String(merged.self ?? '').trim() || hostname() || 'unknown-host'
  config.listen = normalizeListen(merged.listen, file)
  config.localGuiUrl = String(merged.localGuiUrl ?? '').trim() || defaults().localGuiUrl
  if (config.listen.mode === 'invalid') {
    return { ok: false, error: config.listen.error }
  }

  const proxyPort = Number(merged.proxyPort ?? defaults().proxyPort)
  if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
    return { ok: false, error: invalid('proxyPort 不是 1–65535 的整数', '在 ' + file + ' 里填本机 mira_proxy 的端口（默认 8543）') }
  }
  config.proxyPort = proxyPort

  config.profile = String(merged.profile ?? '').trim() || defaults().profile

  const targets = normalizeTargets(merged.targets ?? [], file)
  if (!targets.ok) return targets
  config.targets = targets.value

  config.python = String(merged.python ?? '').trim()
  config.aiBrowserHome = String(merged.aiBrowserHome ?? '').trim()
  config.playwrightBrowsersPath = String(merged.playwrightBrowsersPath ?? '').trim()
  config.ignoreHttps = merged.ignoreHttps !== false
  config.openTimeoutMs = positiveNumber(merged.openTimeoutMs, defaults().openTimeoutMs)
  config.opTimeoutMs = positiveNumber(merged.opTimeoutMs, defaults().opTimeoutMs)

  config.root = typeof merged.root === 'string' ? merged.root.trim() : ''
  const rootDir = config.root !== '' ? join(config.root, '.mira_browser') : join(configDir(), 'browser')
  config.profilesDir = String(merged.profilesDir ?? '').trim() || join(rootDir, 'profiles')
  config.tmpDir = String(merged.tmpDir ?? '').trim() || join(rootDir, 'tmp')

  config.replyUrl = String(merged.replyUrl ?? '').trim()
  if (config.replyUrl !== '') {
    let parsed
    try {
      parsed = new URL(config.replyUrl)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('protocol')
    } catch {
      return { ok: false, error: invalid('replyUrl 不是合法的 http/https URL：' + config.replyUrl, '一般留空（由 listen 推导）；要覆盖就填完整 URL') }
    }
    // reply_to 是**基地址**：对端会做 `reply_to + 路由`（README「对端可用的路由」）。
    // 不带结尾斜杠时拼出来的是 `http://h:8544collab/deliver` —— 对手方照着做必然失败，
    // 所以在配置层就归一化成基地址（new URL 对空路径本来就会补 '/'，这里兜住带路径的写法）。
    if (!parsed.pathname.endsWith('/')) parsed.pathname += '/'
    const normalized = parsed.href
    if (normalized !== config.replyUrl) {
      warnings.push('replyUrl 已归一化为基地址（补结尾 /）：' + config.replyUrl + ' → ' + normalized)
    }
    config.replyUrl = normalized
    warnings.push('replyUrl 覆盖了信封里的回信地址（实际监听仍由 listen 决定）：' + config.replyUrl)
    logger?.info?.('[mira_browser] replyUrl 显式覆盖回信地址：' + config.replyUrl)
  }
  return { ok: true, value: config }
}

/**
 * 必备配置：listen。为空 → config/missing（**不探测**）。
 * hint 里必须同时出现「listen」与配置文件路径（自检与排障都靠这两点）。
 */
export function requireListen(config, file = configFile()) {
  const listen = config?.listen
  if (!listen || listen.mode === 'unset' || listen.mode === undefined) {
    throw new MiraError(
      'config/missing',
      '必备配置项为空：listen.ip / listen.port（本插件不自动探测）',
      '在 ' + file + ' 里手填 listen.ip 与 listen.port（例：{ "ip": "192.0.2.10", "port": 8544 }）；'
        + '只监听本机回环时写 "listen": "loopback"。改完重载插件即可，不必重启宿主。',
    )
  }
  if (listen.mode === 'invalid') {
    throw new MiraError(
      listen.error?.code ?? 'config/invalid',
      listen.error?.message ?? 'listen 配置不合法',
      listen.error?.hint ?? '见 ' + file,
    )
  }
  return listen
}

/** 浏览器驱动三项：为空 → config/missing（不探测；默认值在 defaults() 里）。 */
export function requireBrowserRuntime(config, file = configFile()) {
  for (const key of ['python', 'aiBrowserHome']) {
    if (isEmptyValue(config?.[key])) {
      throw new MiraError(
        'config/missing',
        '必备配置项为空：' + key,
        '在 ' + file + ' 里手填 ' + key + '（本插件不自动探测）',
      )
    }
  }
  return config
}

/**
 * 读远程目标的口令：`<configDir>/creds/<target>.json` 优先，其次配置文件里的 targets[].pass（旧兼容）。
 * **永不回显**：返回值只给 bridge 进子进程环境，不得写日志/工具输出。
 *
 * @returns {{user:string, pass:string, source:'creds'|'config'|'none', file?:string}}
 */
export function readTargetCreds(target, file = configFile()) {
  if (!target || typeof target.name !== 'string') return { user: '', pass: '', source: 'none' }
  const credsFile = targetCredsFile(target.name)
  const strict = readJsonStrict(credsFile)
  if (strict.ok) {
    const checked = checkSchema(strict.value, CREDS_VERSION, credsFile)
    if (!checked.ok) throw new MiraError(checked.error.error.code, checked.error.error.message, checked.error.error.hint)
    const user = typeof strict.value.user === 'string' ? strict.value.user : (target.user ?? '')
    const pass = typeof strict.value.pass === 'string' ? strict.value.pass : (target.pass ?? '')
    return { user, pass, source: 'creds', file: credsFile }
  }
  if (strict.reason === 'corrupt' || strict.reason === 'not-object') {
    throw new MiraError(
      'config/corrupt',
      '凭据文件不可用：' + credsFile + '（' + (strict.detail ?? strict.reason) + '）',
      '先备份再重写；口令绝不放进 config.json、日志或工具返回值',
    )
  }
  if (target.pass) return { user: target.user ?? '', pass: target.pass, source: 'config', file }
  return { user: target.user ?? '', pass: '', source: 'none' }
}

/** 状态里的目标视图（**不含 pass**）。 */
export function targetsView(config, logger = null) {
  return (config?.targets ?? []).map((target) => {
    let hasCreds = Boolean(target.user && target.pass)
    let credsError = null
    try {
      const creds = readTargetCreds(target)
      hasCreds = Boolean(creds.user && creds.pass)
    } catch (error) {
      credsError = { code: error?.code ?? 'config/corrupt', message: error?.message ?? String(error) }
      logger?.warn?.('[mira_browser] 目标 ' + target.name + ' 的凭据文件不可用：' + (error?.message ?? String(error)))
    }
    return {
      name: target.name,
      kind: 'remote',
      baseUrl: target.baseUrl,
      user: target.user || null,
      hasCreds,
      ...(credsError ? { credsError } : {}),
    }
  })
}

/** 读监听令牌（非回环监听才需要）。返回 null 表示没配；永不回显。 */
export function readListenToken(file = listenTokenFile()) {
  try {
    const text = readFileSync(file, 'utf8').trim()
    if (text === '') return null
    return { token: text, mode: fileMode(file) }
  } catch {
    return null
  }
}

export { ensureDir }
