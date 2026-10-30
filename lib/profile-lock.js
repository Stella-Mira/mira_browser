/**
 * mira_browser / profile-lock.js —— Chromium 持久档案的 SingletonLock 预检
 *
 * 现场 bug：上一个桥/浏览器进程被 kill 后，`profiles/<profile>/SingletonLock` 留了下来，
 * 下一次启动 Playwright 时 Chromium 报 `Failed to create ProcessSingleton ... SingletonLock:
 * File exists (17)`，`collab_list` 直接失败。
 *
 * Chromium（POSIX）的锁是一个**符号链接**，目标是 `"<hostname>-<pid>"`；旁边还有
 * `SingletonSocket` / `SingletonCookie`。所以「锁的主人还活着吗」可以精确回答：
 *   · 解析出 pid → 用 signal 0 判活（Linux 上额外看 /proc/<pid>/stat 的 Z 态，
 *     僵尸进程也算死）；
 *   · 死了 → 清掉三个文件再启动；
 *   · 活着 → **不猜着清**，抛带 pid / 命令 / 锁存在时长的可诊断错误；
 *   · 主机名不是本机 → 不能判活，同样只报错不动文件。
 *
 * 本文件只依赖 node: 内置与 ./kit.mjs。
 */

import { lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { hostname as osHostname } from 'node:os'
import { join } from 'node:path'

import { MiraError } from './kit.mjs'

export const LOCK_FILE = 'SingletonLock'
/** Chromium 在锁旁边放的另两个文件；清锁时一起清，否则下一次仍可能报错。 */
export const SIDECAR_FILES = ['SingletonSocket', 'SingletonCookie']

/** 档案目录：ai_browser 的 `PROFILES_DIR / profile`。 */
export function profilePath(profilesDir, profile) {
  return join(String(profilesDir), String(profile))
}

/** 把时长说人话（给「锁已存在多久」用）。 */
export function describeDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (total < 1) return '不到 1 秒'
  if (total < 60) return Math.round(total) + ' 秒'
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return minutes + ' 分钟'
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? hours + ' 小时' : hours + ' 小时 ' + rest + ' 分钟'
}

/**
 * 解析锁里的 `"<hostname>-<pid>"`。
 * 从**右边**找最后一个 `-`：主机名自己可以带 `-`（实测 `host-12345`）。
 * @returns {{host:string, pid:number}|null}
 */
export function parseLockOwner(raw) {
  const text = String(raw ?? '').trim()
  const match = /^(.+)-(\d+)$/u.exec(text)
  if (match !== null) {
    const pid = Number(match[2])
    if (Number.isInteger(pid) && pid > 0) return { host: match[1], pid }
    return null
  }
  // 少数平台/旧版只写 pid：host 只能当本机。
  if (/^\d+$/u.test(text)) {
    const pid = Number(text)
    if (Number.isInteger(pid) && pid > 0) return { host: null, pid }
  }
  return null
}

/**
 * 读锁文件本身（不判活、不删除）。
 * @returns {{present:false, lockPath:string, mtimeMs:null} |
 *           {present:true, lockPath:string, mtimeMs:number, kind:'symlink'|'file'|'other',
 *            raw:string, host:string|null, pid:number|null, command:string|null}}
 */
export function readLockOwner(profilesDir, profile, { commandOf = readProcessCommand } = {}) {
  const lockPath = join(profilePath(profilesDir, profile), LOCK_FILE)
  let stat
  try {
    stat = lstatSync(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return { present: false, lockPath, mtimeMs: null }
    throw error
  }
  let kind = 'other'
  let raw = ''
  if (stat.isSymbolicLink()) {
    kind = 'symlink'
    try { raw = readlinkSync(lockPath) } catch { raw = '' }
  } else if (stat.isFile()) {
    kind = 'file'
    try { raw = readFileSync(lockPath, 'utf8') } catch { raw = '' }
  }
  const owner = parseLockOwner(raw)
  return {
    present: true,
    lockPath,
    mtimeMs: stat.mtimeMs,
    kind,
    raw: String(raw).trim(),
    host: owner?.host ?? null,
    pid: owner?.pid ?? null,
    command: owner?.pid === null || owner?.pid === undefined ? null : commandOf(owner.pid),
  }
}

/** 进程命令行（Linux /proc；读不到就 null）。 */
export function readProcessCommand(pid) {
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/cmdline', 'utf8')
    const text = raw.split('\u0000').filter((part) => part !== '').join(' ').trim()
    return text === '' ? null : text.slice(0, 200)
  } catch {
    return null
  }
}

/** Linux 上读 /proc/<pid>/stat 的进程状态（Z = 僵尸，X = 已死）。 */
function processState(pid) {
  try {
    const raw = readFileSync('/proc/' + String(pid) + '/stat', 'utf8')
    const close = raw.lastIndexOf(')')
    if (close < 0) return null
    return raw.slice(close + 1).trim().split(/\s+/u)[0] ?? null
  } catch {
    return null
  }
}

/**
 * pid 是否还活着。僵尸进程（/proc 里 state=Z）**不算活**——这正是「僵尸 Chrome 占锁」
 * 要清掉的那一类。
 */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  if (processState(pid) === 'Z') return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但属于别人（仍是活进程）；ESRCH：不存在。
    return error?.code === 'EPERM'
  }
}

/**
 * 文件存在吗（**不跟随符号链接**）。
 *
 * 这里绝不能用 `existsSync`：Chromium 的 `SingletonLock` 是一个指向
 * `"<hostname>-<pid>"` 的**悬空**符号链接（那个“目标文件”从来不存在），
 * `existsSync` 会对它回 false → 主锁永远清不掉，只清了两个 sidecar，
 * 下一次启动照旧报 ProcessSingleton。这正是本 bug 的第一现场。
 */
export function pathExistsLstat(file) {
  try {
    lstatSync(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    return true // 权限等异常：当作存在，让后面删/报错如实发生
  }
}

/**
 * 清掉锁与两个 sidecar。返回真正删掉的文件名（best-effort，删不掉不抛）。
 */
export function clearLockFiles(profilesDir, profile) {
  const dir = profilePath(profilesDir, profile)
  const removed = []
  for (const name of [LOCK_FILE, ...SIDECAR_FILES]) {
    const file = join(dir, name)
    try {
      if (!pathExistsLstat(file)) continue
      rmSync(file, { force: true })
      removed.push(name)
    } catch {
      /* 删不掉就留给下一次报错，但不要让清理本身把启动搞挂 */
    }
  }
  return removed
}

/**
 * 启动浏览器**之前**检查档案锁。
 *
 * @param {string} profilesDir
 * @param {string} profile
 * @param {{log?: ((line:string)=>void)|null, now?: ()=>number, host?: string,
 *          isAlive?: (pid:number)=>boolean}} [options]
 * @returns {{action:'none'|'cleared', profileDir:string, lockPath:string,
 *            pid?:number, host?:string|null, ageMs?:number, removed?:string[]}}
 * @throws {MiraError} 活进程占锁（browser/profile-locked）或锁格式不可识别（browser/profile-lock-unknown）
 */
export function prepareProfileLock(profilesDir, profile, options = {}) {
  if (!profilesDir || !profile) return { action: 'none', profileDir: '', lockPath: '' }
  const now = options.now ?? (() => Date.now())
  const host = (options.host ?? osHostname()).toLowerCase()
  const isAlive = options.isAlive ?? isProcessAlive
  const log = options.log ?? null
  const owner = readLockOwner(profilesDir, profile)
  if (!owner.present) {
    return { action: 'none', profileDir: profilePath(profilesDir, profile), lockPath: owner.lockPath }
  }
  const where = profilePath(profilesDir, profile)
  if (owner.pid === null) {
    throw new MiraError('browser/profile-lock-unknown',
      '浏览器档案 ' + where + ' 的 ' + LOCK_FILE + ' 无法识别占用者：' + JSON.stringify(owner.raw).slice(0, 120),
      '本插件不猜着删未知锁。先 `ps -ef | grep -i chrome` 找到占用进程；确认无害后手动删 '
        + join(where, LOCK_FILE) + '、SingletonSocket、SingletonCookie，再重试')
  }
  const ageMs = Math.max(0, now() - owner.mtimeMs)
  const who = 'pid=' + owner.pid + (owner.command ? '（' + owner.command + '）' : '')
  if (owner.host !== null && owner.host.toLowerCase() !== host) {
    throw new MiraError('browser/profile-locked',
      '浏览器档案 ' + where + ' 的锁属于另一台主机 ' + owner.host + '（' + who + '），锁已存在 '
        + describeDuration(ageMs) + '，本机无法判断它是否还活着',
      '不要跨主机共享同一个 Chromium 档案；把 profilesDir 指到本机目录，或换 profile 名')
  }
  if (isAlive(owner.pid)) {
    throw new MiraError('browser/profile-locked',
      '浏览器档案 ' + where + ' 正被活进程 ' + who + ' 占用，锁已存在 ' + describeDuration(ageMs),
      '这是活进程，不自动清锁（可能是另一个正在用的浏览器）。先 `ps -fp ' + owner.pid
        + '` 确认；若确认是僵尸桥留下的 headless Chrome，`kill ' + owner.pid + '` 后重试；'
        + '长期方案：一个实例一个 profile（换 profile 名）')
  }
  const removed = clearLockFiles(profilesDir, profile)
  log?.('清理僵尸锁 ' + owner.lockPath + '：' + who + ' 已不存在，锁已存在 '
    + describeDuration(ageMs) + '，已删 ' + (removed.join(', ') || '(无)'))
  return {
    action: 'cleared',
    profileDir: where,
    lockPath: owner.lockPath,
    pid: owner.pid,
    host: owner.host,
    ageMs,
    removed,
  }
}

/**
 * 退出时尽量清「自己留下的」锁：只清**主人已死**的锁；
 * 活进程 / 别的主机 / 无法识别的锁一律不动，也绝不抛。
 */
export function cleanupProfileLock(profilesDir, profile, options = {}) {
  if (!profilesDir || !profile) return { action: 'none' }
  const log = options.log ?? null
  const host = (options.host ?? osHostname()).toLowerCase()
  const isAlive = options.isAlive ?? isProcessAlive
  let owner
  try {
    owner = readLockOwner(profilesDir, profile)
  } catch {
    return { action: 'none', error: 'read-failed' }
  }
  if (!owner.present) return { action: 'none' }
  if (owner.pid === null) return { action: 'left', reason: 'unparsed' }
  if (owner.host !== null && owner.host.toLowerCase() !== host) return { action: 'left', reason: 'foreign-host' }
  if (isAlive(owner.pid)) return { action: 'left', reason: 'alive' }
  const removed = clearLockFiles(profilesDir, profile)
  log?.('退出清理僵尸锁 ' + owner.lockPath + '（pid=' + owner.pid + ' 已不存在）')
  return { action: 'cleared', pid: owner.pid, removed }
}
