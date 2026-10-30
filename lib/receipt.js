/**
 * mira_browser / receipt.js —— 投递回执（两级）与队列/在途观测
 *
 * 一级回执：消息**已写入对端会话**（GUI 里已提交 / 宿主 agent 已收下 steer）。
 *           这是「发出去了」的最强本地事实，写进 receipt.level=1。
 * 二级回执：对端**已开跑 / 已读**（对端 GUI 上出现这段文本，或 agent 从 running 回到 idle）。
 *           只能靠**事后观察**，所以它是一条会推进的状态，不是发送的返回值：
 *
 *             pending ──(看到对端忙/新行)──▶ running ──(看到我们的文本)──▶ read
 *                └──────────────(直接看到文本)──────────────────────────▶ read
 *
 *   状态**只前进不后退**（read 之后不会被后续探测降级）。`failed` 只用于一级都没成功。
 *
 * 探测时机（刻意不跑后台定时器，避免单实例/热加载时多套轮询）：
 *   collab_send 成功时探一次；collab_wait / collab_receipt 再按需探。
 *   collab_status **不探测**（它只回当前缓存，保证 status 快且不会驱动浏览器）。
 *
 * 队列（queue）= 正在等待/正在执行的发送（谁在等、等了多久）；
 * 在途（inflight）= 已写入、二级回执还没到终态的消息。
 * 两者都是**进程内状态**：重启后不恢复（在途消息的浏览器会话已经没了，续观没有意义）。
 */

import { MiraError, toError } from './kit.mjs'

let seq = 0

function nextId(prefix) {
  seq = (seq + 1) % 1_000_000
  return prefix + '-' + Date.now().toString(36) + '-' + String(seq).padStart(4, '0')
}

function isoOf(ms) {
  return new Date(ms).toISOString()
}

function errorOf(error) {
  return toError(error, 'delivery/failed', '看 collab_status 的 lastError / log 定位').error
}

/** 二级状态优先级：只允许前进。 */
const RANK = { pending: 0, running: 1, read: 2, failed: 3 }

export class DeliveryTracker {
  /**
   * @param {{now?: () => number, keep?: number, inflightTtlMs?: number}} options
   */
  constructor({ now = () => Date.now(), keep = 200, inflightTtlMs = 15 * 60 * 1000 } = {}) {
    this.now = now
    this.keep = Math.max(20, Number(keep) || 200)
    this.inflightTtlMs = Math.max(1000, Number(inflightTtlMs) || 15 * 60 * 1000)
    this.records = new Map()
  }

  /**
   * 开始一条投递：先记账再写对端。一级成功后才 markWritten。
   * @returns {string} receiptId
   */
  begin({ target, alias = null, sessionId = null, title = null, text = '', transport = 'browser', meta = null }) {
    const id = nextId('r')
    const at = this.now()
    const record = {
      id,
      target: String(target ?? ''),
      alias: alias === null || alias === undefined || alias === '' ? null : String(alias),
      sessionId: sessionId === null || sessionId === undefined || sessionId === '' ? null : String(sessionId),
      title: title === null || title === undefined || title === '' ? null : String(title),
      transport: String(transport),
      meta: meta && typeof meta === 'object' ? meta : null,
      chars: String(text ?? '').length,
      text: String(text ?? ''),
      createdAt: isoOf(at),
      createdAtMs: at,
      level: 0,
      writtenAt: null,
      writtenAtMs: null,
      failedAt: null,
      error: null,
      level2: { state: 'pending', at: isoOf(at), evidence: null, error: null },
      probe: null,
    }
    this.records.set(id, record)
    this.#prune()
    return id
  }

  /** 挂二级探测闭包（浏览器路径 / 宿主路径各自实现；返回 {running,read,evidence}）。 */
  setProbe(id, probe) {
    const record = this.records.get(id)
    if (record !== undefined && typeof probe === 'function') record.probe = probe
    return record
  }

  markWritten(id, { detail = null } = {}) {
    const record = this.records.get(id)
    if (record === undefined) throw new MiraError('receipt/not-found', '回执不存在：' + id, '回执只存在本进程内；重启后旧 id 失效')
    const at = this.now()
    record.level = 1
    record.writtenAt = isoOf(at)
    record.writtenAtMs = at
    record.level2.at = isoOf(at)
    if (detail !== null) record.meta = { ...(record.meta ?? {}), ...(detail && typeof detail === 'object' ? detail : { detail }) }
    return record
  }

  markFailed(id, error) {
    const record = this.records.get(id)
    if (record === undefined) return null
    const at = this.now()
    record.level = 0
    record.failedAt = isoOf(at)
    record.error = errorOf(error)
    record.level2 = { state: 'failed', at: isoOf(at), evidence: null, error: record.error }
    return record
  }

  /**
   * 推进二级回执。running / read 取并集，只前进不后退。
   * @returns {object|null} 内部记录
   */
  observe(id, { running = false, read = false, evidence = '' } = {}) {
    const record = this.records.get(id)
    if (record === undefined) return null
    if (record.level !== 1) return record
    const current = record.level2.state
    let next = current
    if (read) next = 'read'
    else if (running && current === 'pending') next = 'running'
    if (next !== current && RANK[next] >= RANK[current]) {
      record.level2 = {
        state: next,
        at: isoOf(this.now()),
        evidence: evidence === '' ? null : String(evidence),
        error: null,
      }
    } else if (evidence !== '' && record.level2.evidence === null) {
      record.level2.evidence = String(evidence)
    }
    return record
  }

  /** 探测本身失败：记下错误，但**不**改变一级/二级状态（避免把「看不到」当成「没发生」）。 */
  observeError(id, error) {
    const record = this.records.get(id)
    if (record === undefined) return null
    record.level2.error = errorOf(error)
    return record
  }

  get(id) {
    return this.records.get(id) ?? null
  }

  /** 对外视图（不含 text/probe；status 不该泄露消息正文）。 */
  view(id, now = this.now()) {
    const record = this.records.get(id)
    if (record === undefined) return null
    return this.#view(record, now)
  }

  #view(record, now) {
    const writtenAtMs = record.writtenAtMs ?? record.createdAtMs
    return {
      receiptId: record.id,
      target: record.target,
      alias: record.alias,
      sessionId: record.sessionId,
      title: record.title,
      transport: record.transport,
      level: record.level,
      state: record.level2.state,
      writtenAt: record.writtenAt,
      failedAt: record.failedAt,
      createdAt: record.createdAt,
      chars: record.chars,
      waitedMs: Math.max(0, now - writtenAtMs),
      receipt: {
        level: record.level,
        writtenAt: record.writtenAt,
        ...(record.failedAt ? { failedAt: record.failedAt } : {}),
        ...(record.error ? { error: record.error } : {}),
      },
      receiptLevel2: {
        state: record.level2.state,
        at: record.level2.at,
        ...(record.level2.evidence ? { evidence: record.level2.evidence } : {}),
        ...(record.level2.error ? { error: record.level2.error } : {}),
      },
    }
  }

  views({ maxAgeMs = this.inflightTtlMs } = {}) {
    const now = this.now()
    return [...this.records.values()]
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .map((record) => this.#view(record, now))
  }

  /** 已写入、二级未到终态、且没超龄的记录（谁在等、等了多久）。 */
  inflight({ maxAgeMs = this.inflightTtlMs } = {}) {
    const now = this.now()
    return [...this.records.values()]
      .filter((record) => record.level === 1
        && (record.level2.state === 'pending' || record.level2.state === 'running')
        && now - (record.writtenAtMs ?? record.createdAtMs) <= maxAgeMs)
      .sort((a, b) => (a.writtenAtMs ?? a.createdAtMs) - (b.writtenAtMs ?? b.createdAtMs))
      .map((record) => this.#view(record, now))
  }

  /** 最近一条匹配的投递（collab_wait 用它挂上二级回执）。 */
  findLatest({ target, alias = null, sessionId = null, title = null } = {}) {
    const candidates = [...this.records.values()]
      .filter((record) => record.level === 1)
      .sort((a, b) => (b.writtenAtMs ?? b.createdAtMs) - (a.writtenAtMs ?? a.createdAtMs))
    return candidates.find((record) => {
      if (target !== undefined && record.target !== target) return false
      if (alias !== null && alias !== undefined && record.alias !== alias) return false
      if (sessionId !== null && sessionId !== undefined && record.sessionId !== sessionId) return false
      if (title !== null && title !== undefined && record.title !== title) return false
      return true
    }) ?? null
  }

  counts() {
    const out = { total: this.records.size, written: 0, pending: 0, running: 0, read: 0, failed: 0 }
    for (const record of this.records.values()) {
      if (record.level === 1) out.written += 1
      if (Object.prototype.hasOwnProperty.call(out, record.level2.state)) out[record.level2.state] += 1
    }
    return out
  }

  clear() {
    this.records.clear()
  }

  #prune() {
    if (this.records.size <= this.keep) return
    const sorted = [...this.records.values()].sort((a, b) => a.createdAtMs - b.createdAtMs)
    const remove = this.records.size - this.keep
    for (let i = 0; i < remove; i += 1) this.records.delete(sorted[i].id)
  }
}

/**
 * 发送队列：进入 = 已受理、在等目标锁或正在写；完成/失败即移除。
 * 同目标串行（浏览器页面状态是共享的，并发 select/输入会互相踩）；
 * 不同目标可并行 —— send_many 的「逐个回执、单个失败不阻断其余」就靠这层。
 */
export class SendQueue {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now
    this.entries = new Map()
  }

  begin({ target, alias = null, sessionId = null, title = null, label = null }) {
    const id = nextId('q')
    const at = this.now()
    const entry = {
      id,
      target: String(target ?? ''),
      alias: alias === null || alias === undefined || alias === '' ? null : String(alias),
      sessionId: sessionId === null || sessionId === undefined || sessionId === '' ? null : String(sessionId),
      title: title === null || title === undefined || title === '' ? null : String(title),
      label: label === null || label === undefined ? null : String(label),
      state: 'queued',
      enqueuedAt: isoOf(at),
      enqueuedAtMs: at,
      done: false,
    }
    this.entries.set(id, entry)
    return {
      id,
      setState: (state) => {
        if (!entry.done && (state === 'queued' || state === 'sending')) entry.state = state
      },
      done: () => {
        entry.done = true
        this.entries.delete(id)
      },
    }
  }

  snapshot() {
    const now = this.now()
    return [...this.entries.values()]
      .filter((entry) => !entry.done)
      .sort((a, b) => a.enqueuedAtMs - b.enqueuedAtMs)
      .map((entry) => ({
        id: entry.id,
        target: entry.target,
        alias: entry.alias,
        sessionId: entry.sessionId,
        title: entry.title,
        state: entry.state,
        enqueuedAt: entry.enqueuedAt,
        waitedMs: Math.max(0, now - entry.enqueuedAtMs),
      }))
  }

  clear() {
    this.entries.clear()
  }
}

export { nextId }
