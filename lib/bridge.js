/**
 * 与 `py/browser_bridge.py` 通信的 Node 适配器。
 *
 * 为什么要有这一层：agent 与另一个 DSH 会话的来往是**跨多次工具调用**的
 * （先 list，再 send，再 wait），浏览器会话必须一直活着；而 ai_browser 的 CLI
 * 每次调用都是新进程（无状态）。所以这里维持一个长驻 Python 子进程，
 * 用**行分隔 JSON** 收发：`{"id":N,"op":"…"}` → `{"id":N,"ok":true,…}`。
 *
 * 子进程环境里必须显式给三样东西（都踩过坑）：
 *   · PYTHONPATH 指向 ai_browser 仓库根 —— 否则 import 不到；
 *   · AI_BROWSER_PROFILES 与 TEMP/TMP —— 必须是**子进程可写**的目录。
 *     DSH 沙箱下 `~/.dsh/**` 会 WinError 5、`%LOCALAPPDATA%\Temp` 会 EPERM，
 *     只有会话工作区可写；所以这两个目录由上层算好传进来。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { cleanupProfileLock, prepareProfileLock } from './profile-lock.js'

const DEFAULT_TIMEOUT_MS = 120_000

export class BrowserBridge {
  /**
   * @param {{python: string, aiBrowserHome: string, profilesDir: string, tmpDir: string,
   *          profile?: string,
   *          playwrightBrowsersPath?: string, ignoreHttps?: boolean,
   *          httpUser?: string, httpPass?: string, script?: string, onLog?: (line: string) => void}} options
   */
  constructor(options) {
    this.options = options
    this.child = undefined
    this.nextId = 1
    this.pending = new Map()
    this.buffer = ''
    this.lastError = undefined
    this.lockCheck = null
  }

  get running() {
    return this.child !== undefined && this.child.exitCode === null && !this.child.killed
  }

  #script() {
    return this.options.script ?? join(import.meta.dirname, '..', 'py', 'browser_bridge.py')
  }

  #env() {
    const o = this.options
    const env = {
      ...process.env,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
      PYTHONPATH: o.aiBrowserHome,
      AI_BROWSER_PROFILES: o.profilesDir,
      TEMP: o.tmpDir,
      TMP: o.tmpDir,
      AI_BROWSER_STEALTH: '1',
      AI_BROWSER_DOM_CLICK_FALLBACK: '1',
    }
    if (o.playwrightBrowsersPath) env.PLAYWRIGHT_BROWSERS_PATH = o.playwrightBrowsersPath
    if (o.ignoreHttps) env.AI_BROWSER_IGNORE_HTTPS = '1'
    if (o.httpUser && o.httpPass) {
      env.AI_BROWSER_HTTP_USER = o.httpUser
      env.AI_BROWSER_HTTP_PASS = o.httpPass
    }
    // 目标 GUI 的地址不在这里给：由上层每次 open 时传（不同目标不同 URL）。
    delete env.AI_BROWSER_EXECUTABLE
    return env
  }

  /**
   * 启动浏览器之前检查档案的 SingletonLock：
   *   · 锁的主人已经死了 → 清掉再启动（现场那台 18 分钟的僵尸 Chrome 不会再挡住 collab_list）；
   *   · 主人还活着 → 抛 `browser/profile-locked`（带 pid / 命令 / 锁存在时长），不猜着清。
   * 不存在锁时是廉价的一次 lstat。桥常驻时也要在**新建浏览器会话**前调用
   * （见 CollabClient.open），否则上一次会话的僵尸锁会留到 Playwright 里才报原始错误。
   */
  ensureProfileLock() {
    const { profilesDir, profile } = this.options
    this.lockCheck = prepareProfileLock(profilesDir, profile, {
      log: (line) => this.options.onLog?.('[profile-lock] ' + line),
    })
    return this.lockCheck
  }

  /** 桥退出时尽量清理自己留下的、主人已死的锁（活进程的锁一律不动）。 */
  #cleanupProfileLock() {
    const { profilesDir, profile } = this.options
    try {
      cleanupProfileLock(profilesDir, profile, {
        log: (line) => this.options.onLog?.('[profile-lock] ' + line),
      })
    } catch (error) {
      this.options.onLog?.('[profile-lock] 退出清理失败：' + String(error?.message ?? error).slice(0, 160))
    }
  }

  start() {
    if (this.running) return
    const script = this.#script()
    if (!existsSync(script)) throw new Error(`bridge script 不存在：${script}`)
    this.ensureProfileLock()
    const child = spawn(this.options.python, [script], {
      cwd: this.options.aiBrowserHome,
      env: this.#env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    this.buffer = ''

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onData(chunk))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/u)) {
        if (line.trim() !== '') this.options.onLog?.(line)
      }
    })
    child.on('error', (error) => this.#failAll(error))
    child.on('exit', (code, signal) => {
      const reason = new Error(`bridge 退出（code=${String(code)} signal=${String(signal)}）`)
      this.#failAll(reason)
      this.child = undefined
      this.#cleanupProfileLock()
    })
  }

  #onData(chunk) {
    this.buffer += chunk
    let index = this.buffer.indexOf('\n')
    while (index >= 0) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      index = this.buffer.indexOf('\n')
      const trimmed = line.trim()
      if (trimmed === '') continue
      let msg
      try {
        msg = JSON.parse(trimmed)
      } catch {
        this.options.onLog?.(`非 JSON 输出：${trimmed.slice(0, 200)}`)
        continue
      }
      const waiter = this.pending.get(msg.id)
      if (waiter === undefined) continue
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.ok) waiter.resolve(msg)
      else {
        const error = new Error(msg.error ?? 'bridge 失败')
        // Python 侧把「会话不存在/已过期」标成 session/expired；JS 侧据此自愈，
        // 不去猜中文文案（文案仍保留给调用方看）。
        if (typeof msg.code === 'string' && msg.code !== '') error.code = msg.code
        error.detail = msg.trace
        waiter.reject(error)
      }
    }
  }

  #failAll(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
    }
    this.pending.clear()
  }

  /** 发一条命令并等它完成；超时/进程死掉都会 reject。 */
  request(op, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`bridge 超时（${op} ${String(timeoutMs)}ms）`))
      }, timeoutMs)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.child.stdin.write(`${JSON.stringify({ id, op, ...args })}\n`)
    })
  }

  async stop() {
    const child = this.child
    this.child = undefined
    if (child === undefined) {
      // 没起过子进程也可能在档案里留了上一轮的僵尸锁（进程被 kill 过）：
      // 退场时顺手清掉「主人已死」的那把，活锁一律不动（见 cleanupProfileLock）。
      this.#cleanupProfileLock()
      return
    }
    try {
      child.stdin.write(`${JSON.stringify({ id: this.nextId++, op: 'quit' })}\n`)
      child.stdin.end()
    } catch {
      /* 已经死了 */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* 忽略 */
        }
        resolve()
      }, 2000)
      timer.unref?.()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.#cleanupProfileLock()
  }
}