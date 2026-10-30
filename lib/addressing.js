/**
 * mira_browser / addressing.js —— 稳定别名表
 *
 * 落盘：`$DSH_HOME/mira_config/mira_browser/aliases.json`
 *
 *   {
 *     "schemaVersion": 1,
 *     "aliases": {
 *       "brother": {
 *         "target": "local",              // local / proxy / targets 里的目标名
 *         "sessionId": "session-…",        // 可选：本机的稳定 id（本机目标才有意义）
 *         "title": "给DSH写Node.js反代插件", // 侧边栏里**完整**标题快照（跨机唯一可点的东西）
 *         "note": "哥哥那台机器上的会话",
 *         "createdAt": "…", "updatedAt": "…", "lastUsedAt": "…"
 *       }
 *     }
 *   }
 *
 * 为什么要别名表（任务书功能点7）：
 *   - GUI 的搜索/侧边栏只按**标题**匹配，而标题会截断；让 agent 每次抄标题前缀必踩。
 *   - 跨机的 `session-<id>` 是**各机本地**映射，拿本机 id 去对端必然 0 命中。
 *   所以对外只暴露一个**稳定名字**（alias）；记录里同时留本机 id（本机目标可精确寻址）
 *   与完整标题（跨机目标只能按标题点，但绝不用「用户输入的前缀」去猜）。
 *
 * 原子写：临时文件 + rename（kit.writeJsonAtomic）。每次改动都重新读文件再写，
 * 外部手改也能被下一次操作看见（不做内存缓存，避免旧实例覆盖新内容）。
 */

import {
  MiraError,
  checkSchema,
  readJsonStrict,
  writeJsonAtomic,
} from './kit.mjs'

export const ALIASES_VERSION = 1

const NAME_RE = /^[^\s]{1,64}$/u
const SESSION_ID_RE = /^session-[A-Za-z0-9._-]{1,128}$/u
// 这些名字会撞 Object.prototype；别名是 JSON 对象的键，必须挡掉
const RESERVED_NAMES = new Set(['__proto__', 'prototype', 'constructor'])

export function validateAliasName(alias) {
  const name = typeof alias === 'string' ? alias.trim() : ''
  if (!NAME_RE.test(name)) {
    throw new MiraError('addressing/invalid', '别名不合法：' + JSON.stringify(alias),
      '别名是 1–64 个非空白字符（例：brother）；它是对外唯一稳定的那个名字')
  }
  if (RESERVED_NAMES.has(name)) {
    throw new MiraError('addressing/invalid', '别名不能是保留字：' + name, '换一个名字（例：brother）')
  }
  return name
}

function cleanText(value, max, field) {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (text.length > max) {
    throw new MiraError('addressing/invalid', field + ' 过长（>' + max + ' 字符）', '截短后重试')
  }
  return text
}

function validateSessionId(sessionId) {
  const value = String(sessionId ?? '').trim()
  if (value === '') return ''
  if (!SESSION_ID_RE.test(value)) {
    throw new MiraError('addressing/invalid', 'sessionId 不合法：' + JSON.stringify(sessionId),
      '本机的会话 id 形如 session-<uuid>；跨机 id 不可寻址，请改用 title（或先 collab_list 取完整标题）')
  }
  return value
}

function nowIsoOf(now) {
  return new Date(now()).toISOString()
}

export class AliasStore {
  /**
   * @param {{file: string, logger?: object, counters?: object, now?: () => number}} options
   */
  constructor({ file, logger = null, counters = null, now = () => Date.now() }) {
    this.file = file
    this.logger = logger
    this.counters = counters
    this.now = now
  }

  /** 读表；文件不存在 = 空表（不是错误）。坏文件 → 抛 config/corrupt / config/schema。 */
  #read() {
    const strict = readJsonStrict(this.file)
    if (!strict.ok) {
      if (strict.reason === 'missing') return { schemaVersion: ALIASES_VERSION, aliases: {} }
      if (strict.reason === 'corrupt') {
        throw new MiraError('config/corrupt', '别名表不是合法 JSON：' + this.file + '（' + (strict.detail ?? '') + '）',
          '先备份再修；别名表坏了不影响按 sessionId/title 直接投递，但别名不可用')
      }
      throw new MiraError('config/invalid', '别名表顶层必须是 JSON 对象：' + this.file, '文件形如 { "schemaVersion": 1, "aliases": {} }')
    }
    const checked = checkSchema(strict.value, ALIASES_VERSION, this.file)
    if (!checked.ok) throw new MiraError(checked.error.error.code, checked.error.error.message, checked.error.error.hint)
    const aliases = checked.value.aliases
    if (aliases === undefined) return { schemaVersion: ALIASES_VERSION, aliases: {} }
    if (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases)) {
      throw new MiraError('config/invalid', '别名表的 aliases 必须是对象：' + this.file, '形如 "aliases": { "brother": { ... } }')
    }
    for (const [name, record] of Object.entries(aliases)) {
      const valid = record !== null && typeof record === 'object' && !Array.isArray(record)
        && typeof record.target === 'string' && record.target.trim() !== ''
        && (record.sessionId === undefined || typeof record.sessionId === 'string')
        && (record.title === undefined || typeof record.title === 'string')
      if (!valid) {
        throw new MiraError('config/invalid', '别名表里有一条坏记录：' + name + '（' + this.file + '）',
          '每条至少要有字符串 target；可选 sessionId/title。先备份再修；别名表坏了不影响按 sessionId/标题直接投递')
      }
    }
    return { schemaVersion: ALIASES_VERSION, aliases }
  }

  #write(aliases) {
    const wrote = writeJsonAtomic(this.file, { schemaVersion: ALIASES_VERSION, aliases })
    if (!wrote) {
      throw new MiraError('addressing/write-failed', '别名表写盘失败：' + this.file,
        '检查目录权限（' + this.file + ' 的父目录）与磁盘空间')
    }
  }

  /** 公开视图（不含内部字段；口令类东西本来就不在这里）。 */
  view(alias, record) {
    return {
      alias,
      target: String(record?.target ?? ''),
      sessionId: typeof record?.sessionId === 'string' && record.sessionId !== '' ? record.sessionId : null,
      title: typeof record?.title === 'string' && record.title !== '' ? record.title : null,
      note: typeof record?.note === 'string' && record.note !== '' ? record.note : null,
      createdAt: record?.createdAt ?? null,
      updatedAt: record?.updatedAt ?? null,
      lastUsedAt: record?.lastUsedAt ?? null,
    }
  }

  list() {
    const { aliases } = this.#read()
    return Object.keys(aliases)
      .sort((a, b) => a.localeCompare(b))
      .map((alias) => this.view(alias, aliases[alias]))
  }

  /** 查一个别名；找不到 → addressing/unknown（带可用列表，便于 agent 自纠）。 */
  get(alias) {
    const name = validateAliasName(alias)
    const { aliases } = this.#read()
    const record = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined
    if (record === undefined) {
      const known = Object.keys(aliases).sort((a, b) => a.localeCompare(b))
      throw new MiraError('addressing/unknown', '别名不存在：' + name,
        known.length === 0
          ? '别名表是空的：先用 collab_alias_set 登记（例：collab_alias_set({alias:"brother", target:"local", title:"…"})）'
          : '可用别名：' + known.join(', ') + '；要新增/改指向用 collab_alias_set')
    }
    return { alias: name, record }
  }

  /**
   * 登记/改指向。已存在且 overwrite!==true → addressing/conflict（不静默改指向）。
   * @returns {{ok:true, alias:string, record:object, file:string}}
   */
  set({ alias, target, sessionId, title, note, overwrite = false }) {
    const name = validateAliasName(alias)
    const targetName = String(target ?? '').trim()
    if (targetName === '') {
      throw new MiraError('addressing/invalid', '别名必须绑定一个 target', 'target 填 local / proxy / config.targets 里的名字')
    }
    const sid = validateSessionId(sessionId)
    const cleanTitle = cleanText(title, 512, 'title')
    const cleanNote = cleanText(note, 200, 'note')
    if (sid === '' && cleanTitle === '') {
      throw new MiraError('addressing/invalid', '别名必须至少带 sessionId 或 title',
        '本机目标给 sessionId（稳定 id）或 title；跨机目标给对端侧边栏里**完整**的 title')
    }
    const { aliases } = this.#read()
    // 必须用 hasOwnProperty：`aliases['toString']` 会摸到 Object.prototype 上的同名成员，
    // 于是「空表里登记 valueOf」被误判成「别名已存在」（overwrite 时还会带上继承来的字段）。
    // 与 get()/remove() 保持一致：只认表里真实存在的键。
    const existing = Object.prototype.hasOwnProperty.call(aliases, name) ? aliases[name] : undefined
    if (existing !== undefined && overwrite !== true) {
      throw new MiraError('addressing/conflict', '别名已存在：' + name + '（' + existing.target + ' → ' + (existing.title ?? existing.sessionId ?? '?') + '）',
        '要改指向请带 overwrite:true；不想改就换一个别名')
    }
    const at = nowIsoOf(this.now)
    const record = {
      target: targetName,
      ...(sid !== '' ? { sessionId: sid } : {}),
      ...(cleanTitle !== '' ? { title: cleanTitle } : {}),
      ...(cleanNote !== '' ? { note: cleanNote } : {}),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    }
    aliases[name] = record
    this.#write(aliases)
    this.logger?.info?.('[mira_browser] 别名已登记：' + name + ' → ' + targetName + ' ' + (record.title ?? record.sessionId ?? ''))
    return { ok: true, alias: name, record: this.view(name, record), file: this.file }
  }

  /** 删除（幂等：不存在也返回 ok，removed:false）。 */
  remove(alias) {
    const name = validateAliasName(alias)
    const { aliases } = this.#read()
    if (!Object.prototype.hasOwnProperty.call(aliases, name)) {
      return { ok: true, alias: name, removed: false, file: this.file }
    }
    delete aliases[name]
    this.#write(aliases)
    this.logger?.info?.('[mira_browser] 别名已删除：' + name)
    return { ok: true, alias: name, removed: true, file: this.file }
  }

  /**
   * 记一次使用（lastUsedAt）。写盘失败只 warn，不影响投递本身。
   * @returns {boolean} 是否落盘成功
   */
  touch(alias) {
    const name = validateAliasName(alias)
    try {
      const { aliases } = this.#read()
      const record = aliases[name]
      if (record === undefined) return false
      record.lastUsedAt = nowIsoOf(this.now)
      this.#write(aliases)
      return true
    } catch (error) {
      this.counters?.bump('addressing/touch-failed')
      this.logger?.warn?.('[mira_browser] 别名 lastUsedAt 写盘失败（不影响本次投递）：' + name + ' — ' + (error?.message ?? String(error)))
      return false
    }
  }

  /** 给 status 用：永不抛。 */
  summary() {
    const strict = readJsonStrict(this.file)
    if (!strict.ok) {
      if (strict.reason === 'missing') return { file: this.file, exists: false, count: 0, schemaVersion: ALIASES_VERSION, error: null }
      return {
        file: this.file,
        exists: true,
        count: 0,
        schemaVersion: ALIASES_VERSION,
        error: {
          code: strict.reason === 'corrupt' ? 'config/corrupt' : 'config/invalid',
          message: strict.reason === 'corrupt'
            ? '别名表不是合法 JSON（' + (strict.detail ?? '') + '）'
            : '别名表顶层不是对象',
        },
      }
    }
    try {
      const checked = checkSchema(strict.value, ALIASES_VERSION, this.file)
      if (!checked.ok) {
        return { file: this.file, exists: true, count: 0, schemaVersion: ALIASES_VERSION, error: checked.error.error }
      }
      const aliases = checked.value.aliases
      if (aliases !== undefined && (aliases === null || typeof aliases !== 'object' || Array.isArray(aliases))) {
        return {
          file: this.file,
          exists: true,
          count: 0,
          schemaVersion: ALIASES_VERSION,
          error: { code: 'config/invalid', message: '别名表的 aliases 必须是对象' },
        }
      }
      const count = aliases ? Object.keys(aliases).length : 0
      return { file: this.file, exists: true, count, schemaVersion: ALIASES_VERSION, error: null }
    } catch (error) {
      return {
        file: this.file,
        exists: true,
        count: 0,
        schemaVersion: ALIASES_VERSION,
        error: { code: error?.code ?? 'config/invalid', message: error?.message ?? String(error) },
      }
    }
  }
}
