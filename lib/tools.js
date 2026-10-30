/**
 * mira_browser / tools.js —— 对 agent 暴露的 collab_* 工具（统一返回 JSON 文本）
 *
 * 工具的**分工**（README 有同一张表）：
 *   collab_list            看对端侧边栏（收件人列表）+ 本机 id 映射
 *   collab_read            读会话文本（可先按别名/标题切过去）
 *   collab_send            投递一条（默认插话；splice:false 排队）；返回一级回执 + 当前二级回执
 *   collab_send_many       一次投多条，逐条回执；单条失败不阻断其余
 *   collab_wait            等回话（并推进所等会话最近一条投递的二级回执）
 *   collab_receipt         查/刷新一条回执的二级状态（不传 id = 列在途与队列）
 *   collab_status          ��作通道状态：listen/aliases/targets/queue/inflight/回执计数
 *   collab_alias_set/list/remove  稳定别名表（aliases.json）
 *
 * **缺 listen 时所有 collab_* 都返回 config/missing**（任务书【定】3 + 本轮兼容约束）：
 * 提示里同时给 `listen` 与 config.json 路径。MCP 浏览器工具（mcp__aibrowser__*）是另一行
 * MCP 客户端，不受这里影响。
 */

import { MiraError, fail, textTool } from './kit.mjs'
import { requireListen } from './config.js'
import { localSessions, resolveTarget, selfSessionId as envSessionId } from './collab.js'

/**
 * 当前会话 id：工具在会话里被调用时，宿主会把 exec.agent 传进来。
 *
 * **优先 agent.session.id**：resume / 克隆 / rekey 之后 `agent.id` 可能还是旧 id，
 * 拿它当 from_id 会让对端回错会话。`agent.session.id` 是会话日志的权威 id
 * （与 mira_account / mira_active / mira_qqbot 同一条实测结论）。
 */
export function currentSessionId(exec) {
  const agent = exec && exec.agent
  if (!agent) return ''
  const live = agent.session && typeof agent.session.id === 'string' ? agent.session.id : ''
  if (live) return live
  return typeof agent.id === 'string' ? agent.id : ''
}

const obj = (properties, required = []) => ({ type: 'object', properties, required })
const str = (description) => ({ type: 'string', description })
const bool = (description) => ({ type: 'boolean', description })
const num = (description) => ({ type: 'number', description })

const targetHelp =
  '目标：local=本机 GUI 直连；proxy=本机 mira_proxy（targets[0] 优先，否则 127.0.0.1:proxyPort）；'
  + '其它名字=config.targets 里登记过的远程实例（精确匹配）。缺省 local。'

const addressingHelp =
  '寻址：**优先 alias**（稳定别名，见 collab_alias_set / aliases.json）；本机可用 sessionId；'
  + 'session=完整标题（兼容旧用法，精确匹配，不再用前缀猜）。'

const listenHelp =
  '本工具属于 collab_*：listen 未配置时返回 config/missing（hint 指到 config.json）。'

/** 缺 listen 时的统一提示（send 与 status 共用）。 */
function listenMissingHint(file) {
  return '在 ' + file + ' 里手填 listen.ip 与 listen.port（ip 必须是本机 IPv4；不探测网卡/主机名），'
    + '只监听本机回环时写 "listen": "loopback"'
}

function guard(app) {
  app.requireConfig()
  requireListen(app.config, app.configFile)
  return app
}

function hasAddressArg(args) {
  return [args.alias, args.sessionId, args.session].some((value) => value !== undefined && value !== null && String(value).trim() !== '')
}

/** 用一次会话存储反查 sessionId（唯一标题才回）。 */
function sessionIdByTitle(title) {
  if (typeof title !== 'string' || title === '') return null
  const hits = [...localSessions().entries()].filter(([, stored]) => stored === title)
  return hits.length === 1 ? hits[0][0] : null
}

export function registerTools(ctx, app) {
  const defs = []

  defs.push(textTool(
    'collab_list',
    '列出某个 DSH 实例侧边栏里的会话（收件人列表）。只信对端侧边栏的结构信号，不用本机会话缓存拼对端。'
    + '本机目标会同时给出 sessionId 映射（跨机 id 不可寻址，别拿本机 id 去对面）。'
    + addressingHelp + targetHelp,
    obj({
      target: str(targetHelp),
      expand_groups: bool('保留参数（兼容旧调用）；折叠分组在找不到会话时会自动展开'),
    }),
    async (args, exec) => {
      guard(app)
      const bar = await app.client.sidebar(args.target ?? 'local')
      const local = bar.target.kind === 'local' ? localSessions() : null
      const byTitle = new Map()
      if (local !== null) {
        for (const [sessionId, title] of local) {
          if (title === '') continue
          if (!byTitle.has(title)) byTitle.set(title, [])
          byTitle.get(title).push(sessionId)
        }
      }
      const rows = bar.rows.map((row) => ({
        title: row.title,
        selected: row.selected,
        ...(byTitle.get(row.title)?.length === 1 ? { sessionId: byTitle.get(row.title)[0] } : {}),
      }))
      return {
        ok: true,
        target: { name: bar.target.name, kind: bar.target.kind, url: bar.target.url },
        rows,
        groups: bar.groups,
        expanded: bar.expanded,
        // 让调用方/排障能确认「信封里的 from_id 会是谁」：优先活会话 id，其次 agent.id，最后环境变量。
        selfSessionId: currentSessionId(exec) || envSessionId(),
        ...(local !== null ? { localSessions: [...local].map(([sessionId, title]) => ({ sessionId, title })) } : {}),
        hint: '跨机寻址不要用本机 session-<id>（各机本地映射，必然 0 命中）。用 collab_alias_set 把别名绑到对端侧边栏里**完整**的标题，之后 collab_send({alias})。',
      }
    },
  ))

  defs.push(textTool(
    'collab_read',
    '读某个会话的对话文本（滤掉 GUI 自身文案）。给了 alias/sessionId/session 会先切到那个会话；不给就读书签页当前会话。'
    + addressingHelp + targetHelp,
    obj({
      target: str(targetHelp),
      alias: str('别名（推荐；见 collab_alias_set）'),
      sessionId: str('本机会话 id（仅本机目标可寻址）'),
      session: str('会话完整标题（兼容旧用法）'),
      tail: num('只回最后 N 行（默认全部）'),
    }),
    async (args) => {
      guard(app)
      const address = hasAddressArg(args)
        ? app.client.resolveAddress({ target: args.target, alias: args.alias, sessionId: args.sessionId, title: args.session })
        : null
      const result = await app.client.read(args.target ?? 'local', { address, tail: args.tail })
      return {
        ok: true,
        ...result,
        to: address === null ? null : { alias: address.alias, sessionId: address.sessionId, title: address.title, addressing: address.source },
      }
    },
  ))

  defs.push(textTool(
    'collab_send',
    '把一条消息写进某个 DSH 会话（默认自动加身份头：from_id / from_peer / reply_to）。'
    + '**默认插话**（Ctrl/Cmd+Enter，GUI 语义 next-step，立即插进对端当前轮）；splice:false 才是排队（Enter，next-turn）。'
    + '返回**两级回执**：receipt.level=1 表示已写入对端会话；receiptLevel2.state=pending/running/read 是对端开跑/已读（惰性推进，可用 collab_receipt / collab_wait 再查）。'
    + '写入前核对「侧边栏选中行 == 目标」；不通过就拒绝发送，避免把消息投给别的会话。'
    + listenHelp + addressingHelp + targetHelp,
    obj({
      target: str(targetHelp),
      alias: str('别名（推荐）：用 collab_alias_set 登记，避免标题截断/歧义'),
      sessionId: str('本机会话 id（仅本机目标可寻址）'),
      session: str('会话完整标题（兼容旧用法；会被精确匹配，不再按前缀猜）'),
      text: str('要发送的正文'),
      splice: bool('true=插话（默认）；false=排队到下一轮'),
      envelope: bool('是否自动加身份头（默认 true）'),
    }, ['text']),
    async (args, exec) => {
      guard(app)
      const { replyTo } = await app.requireAdvertised()
      const result = await app.client.send(args.target, {
        alias: args.alias,
        sessionId: args.sessionId,
        title: args.session,
        text: args.text,
        splice: args.splice !== false,
        envelope: args.envelope !== false,
        replyTo,
        self: app.self,
        fromId: currentSessionId(exec),
      })
      return { ok: true, ...result }
    },
  ))

  defs.push(textTool(
    'collab_send_many',
    '一次发给多个会话：**逐条回执**，单个失败不阻断其余（结果在 results[]，失败的只有那一条）。'
    + '不同目标并行、同目标自动排队（不会互相踩页面）。每项字段同 collab_send：'
    + '{ alias|sessionId|session|target, text, splice? }。顶层 ok = 至少一条成功；partial=true 表示部分失败。'
    + '所有投递都失败时顶层 ok=false，并保留 results 供逐条排查。'
    + listenHelp + addressingHelp + targetHelp,
    obj({
      items: {
        type: 'array',
        description: '投递列表（每项同 collab_send 的参数）',
        items: obj({
          target: str(targetHelp),
          alias: str('别名'),
          sessionId: str('本机会话 id'),
          session: str('完整标题'),
          text: str('正文'),
          splice: bool('true=插话（默认）；false=排队'),
        }, ['text']),
      },
      envelope: bool('是否给每条都加身份头（默认 true）'),
    }, ['items']),
    async (args, exec) => {
      guard(app)
      const { replyTo } = await app.requireAdvertised()
      return app.client.sendMany(args.items, {
        envelope: args.envelope !== false,
        replyTo,
        self: app.self,
        fromId: currentSessionId(exec),
      })
    },
  ))

  defs.push(textTool(
    'collab_wait',
    '等对端回话：先等自己的消息落地（免得把回声当回复），再轮询文本增长；结束时顺带推进所等会话'
    + '最近一条投递的二级回执（receiptLevel2）。没有新内容也返回 timeout=true（不是错误）。'
    + addressingHelp + targetHelp,
    obj({
      target: str(targetHelp),
      alias: str('别名（推荐）'),
      sessionId: str('本机会话 id'),
      session: str('完整标题（兼容旧用法）'),
      seconds: num('最长等待秒数（默认 180，最少按 5 秒算）'),
    }),
    async (args) => {
      guard(app)
      const result = await app.client.waitReply(args.target ?? 'local', {
        alias: args.alias,
        sessionId: args.sessionId,
        title: args.session,
        seconds: args.seconds,
      })
      return { ok: true, ...result }
    },
  ))

  defs.push(textTool(
    'collab_receipt',
    '查/刷新一条投递回执的二级状态（对端已开跑/已读）。不传 id 时列出当前 inflight 与 queue，'
    + '并给出回执计数（这一条不会去探测，避免批量驱动浏览器）。'
    + '二级状态只前进不后退：pending → running → read。',
    obj({
      id: str('collab_send / collab_send_many 返回的 receiptId'),
      refresh: bool('传 id 时是否重新探测（默认 true）'),
    }),
    async (args) => {
      guard(app)
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id === '') {
        return {
          ok: true,
          queue: app.queue.snapshot(),
          inflight: app.tracker.inflight(),
          receipts: app.tracker.counts(),
        }
      }
      if (args.refresh === false) {
        const view = app.tracker.view(id)
        if (view === null) throw new MiraError('receipt/not-found', '回执不存在：' + id, '回执是进程内状态；用 collab_status 看当前在途')
        return { ok: true, ...view }
      }
      const view = await app.client.refreshReceipt(id)
      return { ok: true, ...view }
    },
  ))

  defs.push(textTool(
    'collab_status',
    '查看协作通道状态：listen（模式/实际地址/是否监听）、回信地址、别名表、目标、浏览器桥、'
    + '**queue**（谁在等、等了多久）、**inflight**（已写入、二级回执还没到终态）、回执计数、最近日志。排障先看这个。'
    + '注意：status 只回缓存，不主动探测二级回执（用 collab_receipt / collab_wait 推进）。'
    + '**缺 listen 时本工具仍然可用**（它会把缺的那项如实报告），否则「为什么发不出去」就无处可查。',
    obj({}),
    async () => {
      // 刻意不调 requireListen：配置不全的时候最需要看状态。
      // 缺 listen 不报错，而是把缺项放进 status.warnings / listen.error。
      app.requireConfig()
      await app.waitListen()
      const status = app.status()
      if (app.config?.listen?.mode === 'unset') {
        const hint = listenMissingHint(app.configFile)
        status.listen = {
          ...(status.listen ?? {}),
          mode: 'unset',
          state: 'unset',
          error: { code: 'config/missing', message: 'listen 未配置（投递类 collab_* 会返回 config/missing）', hint },
        }
        status.warnings = [
          ...(Array.isArray(status.warnings) ? status.warnings : []),
          'listen 未配置：collab_send / collab_wait / 入站监听都不可用。' + hint,
        ]
      }
      return status
    },
  ))

  defs.push(textTool(
    'collab_alias_set',
    '登记/改指向一个稳定别名，落盘到 $DSH_HOME/mira_config/mira_browser/aliases.json（原子写）。'
    + '对外只用 alias，不再让 agent 抄标题前缀：本机目标给 sessionId（稳定 id）或 title；'
    + '跨机目标必须给 title（对端侧边栏里完整的那串），因为 session-<id> 是各机本地映射。'
    + '已存在的别名默认拒绝改指向（加 overwrite:true 才改）。'
    + listenHelp,
    obj({
      alias: str('别名（1–64 个非空白字符，例：brother）'),
      target: str('local / proxy / config.targets 里的名字（默认 local）'),
      sessionId: str('本机会话 id（仅本机目标；形如 session-<uuid>）'),
      title: str('完整标题（跨机目标必填；本机可选）'),
      note: str('备注（只用于显示）'),
      overwrite: bool('true=允许改指向已存在的别名'),
    }, ['alias']),
    async (args) => {
      guard(app)
      const targetName = String(args.target ?? 'local').trim() || 'local'
      const resolved = resolveTarget(app.config, targetName)
      const title = typeof args.title === 'string' ? args.title.trim() : ''
      const sessionId = typeof args.sessionId === 'string' ? args.sessionId.trim() : ''
      if (resolved.kind !== 'local') {
        if (title === '') {
          throw new MiraError('addressing/invalid', '跨机别名必须带 title（对端侧边栏里完整的那串）',
            'session-<id> 只在目标机器上有意义，跨机按 id 必然 0 命中；先 collab_list 取标题')
        }
        if (sessionId !== '') {
          throw new MiraError('addressing/invalid', '跨机别名不接受 sessionId（不可寻址）',
            '只填 title；本机目标才用 sessionId')
        }
      } else if (sessionId !== '') {
        const local = localSessions()
        if (local.size > 0 && !local.has(sessionId)) {
          throw new MiraError('addressing/not-found', 'sessionId 不在本机会话存储里：' + sessionId,
            '用 collab_list 核对本机 id；或改传完整 title')
        }
      }
      const result = app.aliases.set({
        alias: args.alias,
        target: resolved.name,
        sessionId,
        title,
        note: args.note,
        overwrite: args.overwrite === true,
      })
      return { ...result, targetKind: resolved.kind }
    },
  ))

  defs.push(textTool(
    'collab_alias_list',
    '列出别名表（文件路径、条数、每条 target/sessionId/title/最近使用时间）。' + listenHelp,
    obj({}),
    async () => {
      guard(app)
      const aliases = app.aliases.list()
      return { ok: true, file: app.aliases.file, count: aliases.length, aliases }
    },
  ))

  defs.push(textTool(
    'collab_alias_remove',
    '删除一个别名（幂等：不存在也返回 ok，removed:false）。' + listenHelp,
    obj({ alias: str('要删除的别名') }, ['alias']),
    async (args) => {
      guard(app)
      return app.aliases.remove(args.alias)
    },
  ))

  // 注册到一半失败时，把已注册的摘掉再抛（避免半装配留下残工具）
  const disposers = []
  try {
    for (const def of defs) disposers.push(ctx.tools.register(def))
  } catch (error) {
    for (const dispose of disposers) {
      try { dispose() } catch { /* 退场不抛 */ }
    }
    throw error
  }
  app.toolNames = defs.map((def) => def.name)
  return {
    names: app.toolNames,
    dispose() {
      for (const dispose of disposers) {
        try { dispose() } catch { /* 退场不抛 */ }
      }
    },
  }
}

/** 供自检断言工具名/数量（不是运行时 API）。 */
export const __testing = { fail, sessionIdByTitle, guard, currentSessionId }
