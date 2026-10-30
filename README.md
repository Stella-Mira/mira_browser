# mira_browser

DSH 浏览器与协作插件。三件事：

1. **把 ai_browser 接成 DSH 的浏览器工具**（`mcp__aibrowser__*`）：由 `cordis.patch.yml`
   的第二行 `mcp-aibrowser` 拉起 ai_browser 的 Python MCP 服务端；本插件只负责先建好
   它依赖的运行期目录。
2. **`collab_*` 协作工具**：把同机或其它机器上的 DSH 会话当成对端收发消息。保留 0.1.0
   的浏览器驱动路径（结构信号 / 选中行守卫 / 默认插话），并新增**稳定别名表**、
   **两级回执**、**send_many**、**queue/inflight 可观测**。
3. **本节点监听**：`listen` 手填；对端可以 `POST /collab/deliver` 直投本机会话
   （走宿主 `sessionController` 的 steer/followup，不是去点本机 GUI）。

> 版本 0.2.0。所有工具返回 **JSON 文本**（`{ok:true,...}` / `{ok:false,error:{code,message,hint}}`）。

---

## 升级注意（0.1.0 → 0.2.0，先读这一节）

1. **profile 层现有的配置键一个没改、全都继续生效**：

   ```yaml
   config:
     enabled: true
     python: $HOME/DeepSeek/Browser/.venv/bin/python
     aiBrowserHome: $HOME/DeepSeek/Browser
     playwrightBrowsersPath: $HOME/.cache/ms-playwright
     root: $HOME
     profilesDir: $HOME/.mira_browser/profiles
     tmpDir: $HOME/.mira_browser/tmp
     localGuiUrl: http://127.0.0.1:3080/
     proxyPort: 8543
     targets: []
   ```

   本轮**只新增 `listen`**（以及 `aliases.json` 落盘），没有重命名任何旧键。
   `root` / `profilesDir` / `tmpDir` / `proxyPort` 都还按旧语义读（见配置表）。

2. **缺 `listen` 时的行为（重要）**：
   - 插件**照常加载**，运行期目录照建；MCP 浏览器工具（`mcp__aibrowser__*`）**完全不受影响**；
   - **全部 `collab_*` 工具**返回
     `{"ok":false,"error":{"code":"config/missing","message":"...listen...","hint":"在 <配置文件> 里手填 ..."}}`；
     自检会断言 hint 同时含 `listen` 与配置文件路径；
   - 首次加载而 `config.json` 不存在时，会自动生成一份带空 `listen` 的模板（600），
     填完**重载插件**即可（换代码才需要重启宿主）。

3. **旧 `replyUrl` 仍认**，但它现在只覆盖「信封里的回信地址」，不再有网卡/网段自动推断
   （`replyUrlOf()` 已删除）。不填就由 `listen` 推导；填了会在日志里提示（不影响实际监听）。

4. **工具返回从中文文本改成 JSON**（任务书通用约定4）。字段见「工具清单」；
   `collab_send` 现在返回 `receipt` / `receiptId` / `receiptLevel2`。

5. **标题寻址变严格**：`session` 参数仍然可用，但只做**精确匹配**（不再用前缀猜）；
   目标名也改成精确匹配。若以前靠标题前缀，请用 `collab_alias_set` 登记别名
   （别名记录完整标题或本机 `sessionId`）。

6. **Windows / 其它机器的默认值**已从 `cordis.patch.yml` 移到本文档
   「跨平台默认值」一节；换机器请显式设环境变量或 profile 配置。

7. `cordis.patch.yml` 里 `mira-browser-dirs`（本插件）与 `mcp-aibrowser`（MCP 客户端）
   **必须指向同一个 `profilesDir` / `tmpDir`**，否则 MCP 工具与 `collab_*` 各用一套
   浏览器档案（登录态不共享）。profile 层改一处，另一处要同步改。

---

## 一、ai_browser 的接入

补丁插入两行，顺序不能颠倒：

| 行 | 谁 | 干什么 |
|---|---|---|
| `mira-browser-dirs` | 本包 `lib/index.js` | apply 时**同步**建好浏览器档案 / 临时目录（MCP 客户端只 spawn，不建目录） |
| `mcp-aibrowser` | `@deepseek-ai/dsh-mcp-client` | 以 stdio 拉起 `ai_browser.mcp_server`，注册 `mcp__aibrowser__*` |

| 工具 | 作用 |
|---|---|
| `mcp__aibrowser__browse` | 渲染网页并返回纯数据 JSON |
| `mcp__aibrowser__session_open` / `session_act` / `session_list` / `session_close` | 有状态会话 |
| `mcp__aibrowser__collect` | 记录级抓取（自动翻页） |
| `mcp__aibrowser__cookies_import` | 把 cookie 文件导进某个 profile |

这部分与 0.1.0 相同；**缺 `listen` 不会影响它们**。

---

## 二、配置

### 落盘位置（任务书约定1）

```
$DSH_HOME := process.env.DSH_HOME（trim 后非空）else ~/.dsh
$DSH_HOME/mira_config/mira_browser/
    config.json          配置（600；不存在时自动生成模板）
    aliases.json         稳定别名表（原子写）
    listen-token         非回环监听的可选入站令牌（600，手填；不走 config）
    creds/<target>.json  远程目标口令（600，手填；可选，优先于 config 里的 targets[].pass）
    loaded.json          加载标记（at/pid/version/listen；排障用）
    browser/profiles/    浏览器档案（cookie；新建时 700）
    browser/tmp/         Playwright artifacts（新建时 700）
```

路径由 `lib/kit.mjs` 的 `miraConfigDir('mira_browser')` 统一计算。

**优先级**：内置默认值 ← `config.json` ← 宿主（bundle/profile 补丁层传入的 `config:`）。
最显式的一方赢。`config.json` 需要 `"schemaVersion": 1`；`aliases.json` 也需要 1。
不匹配 → 拒绝使用并给迁移提示，**不静默兼容**（`config/schema`），且不会覆盖你的文件。

注意 `targets` 是**数组、按整体替换**：profile 层写了 `targets: []` 就会覆盖
`config.json` 里的 targets（本机 profile 目前正是空数组）。要加远程目标，改 profile 层，
或者把 profile 里的 `targets` 键去掉、只写在 `config.json`。

### 配置表

| 键 | 默认 | 说明 |
|---|---|---|
| `schemaVersion` | （必填）`1` | 仅 `config.json` 需要；profile 传入的 config 不需要 |
| `enabled` | `true` | `false` = 插件不注册工具（运行期目录仍建，MCP 依赖它们） |
| `listen` | `{ "ip": "", "port": 0 }` | **手填**。对象形态：IPv4 字面量 + 1–65535 端口；或字符串 `"loopback"`（只监听 127.0.0.1、端口由系统分配）。为空 → 全部 `collab_*` 报 `config/missing`。`0.0.0.0` / IPv6 / 主机名一律拒绝（不探测）。 |
| `self` | `""` → 机器名 | 本节点在对端 `targets` 里的名字；只影响显示与信封 |
| `localGuiUrl` | `http://127.0.0.1:3080/` | `target=local` 的 GUI 地址 |
| `proxyPort` | `8543` | `target=proxy` 在没登记 `targets[0]` 时拼 `https://127.0.0.1:<proxyPort>/` |
| `profile` | `dsh-collab` | 浏览器档案名 |
| `targets` | `[]` | 远程 DSH 实例：`{ name, baseUrl, user?, pass? }`（`baseUrl` 是对方 mira_proxy 入口；名字精确匹配） |
| `python` | `$MIRA_BROWSER_PY` 或 `$HOME/DeepSeek/Browser/.venv/bin/python` | ai_browser 解释器 |
| `aiBrowserHome` | `$MIRA_BROWSER_HOME` 或 `$HOME/DeepSeek/Browser` | ai_browser 仓库根（cwd → sys.path） |
| `playwrightBrowsersPath` | `$MIRA_BROWSER_PW` 或 `$HOME/.cache/ms-playwright` | Playwright 浏览器目录 |
| `root` | `""` | 兼容旧配置：`profilesDir`/`tmpDir` 为空且 `root` 非空时 → `<root>/.mira_browser/{profiles,tmp}` |
| `profilesDir` | `<root>/.mira_browser/profiles`，`root` 空则 `<configDir>/browser/profiles` | 浏览器档案（含 cookie 登录态） |
| `tmpDir` | 同上 `.../tmp` | Playwright artifacts |
| `ignoreHttps` | `true` | 自签证书（mira_proxy 的入口是自签的） |
| `openTimeoutMs` | `180000` | 打开页面的超时 |
| `opTimeoutMs` | `60000` | 单次页面操作超时 |
| `replyUrl` | `""` | 显式覆盖信封里的回信地址（一般留空，由 `listen` 推导）；会自动归一化成以 `/` 结尾的**基地址**，因为对端是拿 `reply_to + 路由` 拼的 |

`listen` 示例：

```json
{ "schemaVersion": 1, "listen": { "ip": "192.0.2.10", "port": 8544 } }
{ "schemaVersion": 1, "listen": "loopback" }
```

- 对象形态的 `port: 0` 视为**未填**（`config/missing`）。想让系统分配端口就用 `"loopback"`。
- 回环形态下 `reply_to` 是 `http://127.0.0.1:<实际端口>/`：**只适合同机协作**；
  跨机对端回连不到 127.0.0.1（这是显式取舍，不是 bug）。
- 非回环监听时，入站请求需要 `Authorization: Bearer <listen-token 文件内容>`；
  没令牌文件 → 除 `/healthz` 外一律 403（出站投递不受影响）。

### 跨平台默认值

| 项 | 本机 Linux（默认） | Windows（旧值；显式覆盖） |
|---|---|---|
| `python` | `$HOME/DeepSeek/Browser/.venv/bin/python` | `D:\Software\_venvs\browser\Scripts\python.exe` |
| `aiBrowserHome` | `$HOME/DeepSeek/Browser` | `D:\Software\Browser` |
| `playwrightBrowsersPath` | `$HOME/.cache/ms-playwright` | `D:\Software\_venvs\pw-browsers` |
| `root` | `""`（或 `$HOME`） | `D:\Software` |
| `profilesDir` / `tmpDir` | `<configDir>/browser/{profiles,tmp}` | `D:\Software\.mira_browser\{profiles,tmp}` |

`cordis.patch.yml` 的环境变量同样默认成本机 Linux 值；Windows 上请用
`MIRA_BROWSER_PY` / `MIRA_BROWSER_HOME` / `MIRA_BROWSER_PW` / `MIRA_BROWSER_PROFILES` /
`MIRA_BROWSER_TMP` 覆盖（或在 profile 层按行覆写）。

### 凭据

- 远程目标的 Basic 口令**推荐**放 `creds/<target>.json`（`chmod 600`）：

  ```json
  { "schemaVersion": 1, "user": "dsh-user", "pass": "……" }
  ```

  它优先于 `config.json` 里的 `targets[].pass`。插件只读、不写、不打印、不回显；
  口令只进 Python 子进程环境（`AI_BROWSER_HTTP_USER/PASS`）。
- 旧写法 `targets[].pass` 仍被读取（兼容），但会在日志里 warn 建议迁移；
  含口令的 `config.json` 模板按 600 落地，权限过宽会 warn。
- 浏览器档案目录（cookie）新建时按 700 落地；已存在的目录不擅自 chmod，只 warn。
  档案里的文件权限由 Playwright 自己决定 —— 本插件不读取、不回显、不记录 cookie 内容。
- 入站令牌永不回显、不进日志；只做 sha256 后的 timing-safe 比较。

---

## 三、工具清单（10 个 `collab_*`）

> **缺 `listen` 时全部返回 `config/missing`**（hint 指到 `config.json`）。
> 除 `collab_status` 外，工具都会驱动/读取浏览器；`collab_status` 只读缓存。

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `collab_list` | 列对端侧边栏会话；本机目标附 `sessionId` 映射 | `target`、`expand_groups`（保留兼容） |
| `collab_read` | 读会话文本（可先切过去） | `target`、`alias` / `sessionId` / `session`、`tail` |
| `collab_send` | 投递一条，返回一级 + 当前二级回执 | `text`、`alias` / `sessionId` / `session`、`target`、`splice`（默认 true）、`envelope` |
| `collab_send_many` | 一次发多条，逐条回执 | `items:[{...同上}]`、`envelope` |
| `collab_wait` | 等对端回话；顺带推进所等会话最近一条回执的二级状态 | `target`、`alias`/`sessionId`/`session`、`seconds`（默认 180，最少按 5s） |
| `collab_receipt` | 查/刷新一条回执的二级状态；不传 id 则列 queue/inflight | `id`、`refresh`（默认 true） |
| `collab_status` | 协作通道状态：listen/别名/目标/queue/inflight/计数/日志 | — |
| `collab_alias_set` | 登记/改指向别名（原子写 `aliases.json`） | `alias`、`target`、`sessionId`、`title`、`note`、`overwrite` |
| `collab_alias_list` | 列别名表 | — |
| `collab_alias_remove` | 删别名（幂等） | `alias` |

`collab_send` 返回（节选）：

```json
{
  "ok": true,
  "target": "local",
  "to": { "alias": "brother", "sessionId": "session-…", "title": "兄弟聊天", "addressing": "alias" },
  "mode": "splice",
  "receiptId": "r-…",
  "receipt": { "level": 1, "writtenAt": "2026-10-27T…" },
  "receiptLevel2": { "state": "pending", "at": "2026-10-27T…" },
  "submitted": true, "verified": false, "accepted": true,
  "composer": { "before": "给智能体发消息", "after": "插话…" },
  "splice": true, "to_title": "兄弟聊天",
  "composer_before": "给智能体发消息", "composer_after": "插话…"
}
```

（`splice` / `to_title` / `composer_before` / `composer_after` 是 0.1.0 的旧字段名，
保留着让老调用方不用改；新代码建议用 `mode` / `to.title` / `composer`。）

`collab_send_many` 返回（节选）：

```json
{
  "ok": true, "partial": true, "requested": 3, "sent": 2, "failed": 1,
  "results": [
    { "index": 0, "ok": true, "receipt": { "level": 1 } },
    { "index": 1, "ok": false, "error": { "code": "delivery/failed", "message": "…", "hint": "…" } },
    { "index": 2, "ok": true, "receipt": { "level": 1 } }
  ]
}
```

**逐条回执、单个失败不阻断其余**：同目标串行（浏览器页面状态共享），不同目标并行。
全部失败时顶层 `ok:false`，`results` 仍完整保留。

---

## 四、寻址：稳定别名表

`aliases.json`（原子写；`lastUsedAt` 在发送成功后回写）：

```json
{
  "schemaVersion": 1,
  "aliases": {
    "brother": {
      "target": "local",
      "sessionId": "session-6f6b2649-…",
      "title": "兄弟聊天",
      "note": "哥哥那台机器上的会话",
      "createdAt": "2026-10-27T…",
      "updatedAt": "2026-10-27T…",
      "lastUsedAt": "2026-10-27T…"
    },
    "pc-agent": {
      "target": "pc",
      "title": "为DSH写Node.js反代插件",
      "updatedAt": "2026-10-27T…"
    }
  }
}
```

规则：

- **优先级**：`alias` > 本机 `sessionId` > `session`（完整标题，兼容旧用法）。
- **本机目标**：别名带 `sessionId` 时以本机会话存储里的标题为权威（id 是稳定地址）；
  发送前还会用「侧边栏选中行 == 目标」复核。
- **跨机目标**：`session-<id>` 是**各机本地**映射，拿本机 id 去对端必然 0 命中。
  所以跨机别名**必须带 `title`**（对端侧边栏里完整的那串）；`collab_alias_set` 会拒绝
  跨机别名带 `sessionId`，避免给你一个「看着稳定、其实不可寻址」的假象。
  跨机的稳定名字是**alias 本身**，记录里的标题是快照；对端改名后用 `overwrite:true` 更新。
- **不依赖标题前缀**：`session` 与别名记录的标题都做**精确匹配**（去掉尾部 … / 空白后全等）。
  只有「目标本身以 … 结尾」（说明它就是侧边栏里被截断的那串）才允许唯一前缀匹配；
  多个候选时报 `addressing/ambiguous`，不猜着点。
- `collab_alias_set` 只登记地址，**不探测**（不会去开浏览器核对标题对不对）；
  第一次 `collab_send` 时若找不到会报 `addressing/not-found` 并列出当前可见标题。
- 别名表坏/`schemaVersion` 不匹配：`config/corrupt` / `config/schema`，不会覆盖原文件；
  此时按 `session`/`sessionId` 直接投递仍然可用（别名是增强，不是唯一入口）。

---

## 五、投递语义与两级回执

### 排队 vs 插话（`splice`，默认插话）

| `splice` | GUI 按键 | 语义 | 适用 |
|---|---|---|---|
| `true`（默认） | `Ctrl/Cmd+Enter` | `next-step`：空闲会话立刻开一轮；在跑就插到最近一步 | 「现在就告诉它」 |
| `false` | `Enter` | `next-turn`：排到下一轮，跑得快的 agent 可能已经过时 | 明确要求排队 |

入站 `/collab/deliver` 同理：`splice:true` → `agent.steer`；`splice:false` → `agent.followup`。

### 两级回执

- **一级**（`receipt.level=1`）：消息**已写入对端会话**（GUI 已提交 / 宿主 agent 已收下 steer）。
  失败的一级 = `level:0` + `level2.state:"failed"`（不进 inflight）。
- **二级**（`receiptLevel2.state`）：对端**已开跑 / 已读**。它只能事后观察，所以是**惰性推进**：

```
pending ──(对端忙 / 排队数增加 / 新行)──▶ running ──(看到我们发的文本)──▶ read
   └──────────────────(直接看到文本)──────────────────────────────────▶ read
```

状态**只前进不后退**（`read` 之后不会被后续探测降级）。

**探测时机**（刻意不跑后台定时器，避免单实例/热加载时多套轮询）：

| 触发 | 行为 |
|---|---|
| `collab_send` 成功 | 立刻探一次（可能直接是 `read`，如果页面已能看到文本） |
| `collab_receipt {id}` | 再探一次 |
| `collab_wait` 结束 | 对「所等会话最近一条投递」探一次 |
| `collab_status` | **不探测**（只回缓存；保证 status 快且不驱动浏览器） |

**证据口径**（README 说清，避免把「我没看到」当成「没发生」）：

| 路径 | running | read |
|---|---|---|
| 浏览器（GUI） | composer 显示忙（placeholder 含「插话」）/ 排队数比发送前大 / 文本行数变多 | 我们发的那段文本出现在对端对话里（`text-visible`） |
| 宿主（入站直投） | `agent.status === "running"` | 观察到 running 之后回到 `idle`（`agent-returned-idle`，视为「已处理」） |

浏览器路径若发现页面已切到别的会话，返回 `evidence:"page-moved:…"` 且**不推进**——
不拿别人的文本冒充回执。

回执是**进程内状态**（最多 200 条，inflight TTL 15 分钟）；重启后旧 `receiptId` 失效。
`sent` 的正文不会进 status（只给 `chars`）。

### queue / inflight（`collab_status`）

- `queue[]`：已受理、在等目标锁或正在写。字段 `{id,target,alias,sessionId,state:"queued"|"sending",enqueuedAt,waitedMs}`。
  同目标串行、不同目标并行；`waitedMs` 就是「等了多久」。
- `inflight[]`：一级已写入、二级还没到终态且未超龄。字段
  `{receiptId,target,alias,sessionId,title,state,level,writtenAt,waitedMs,receiptLevel2}`。
- `receipts`：`{total,written,pending,running,read,failed}` 计数。
- 两者都是**进程内状态**，不落盘；重启后在途浏览器会话也没了，续观没有意义。

---

## 六、本节点监听与入站 API

`listen` 两种形态（见配置表）。监听就绪后，信封里的 `reply_to` 是

```
http://<listen.ip>:<实际端口>/        # 对象形态
http://127.0.0.1:<实际端口>/          # loopback 形态（只适合同机）
```

对端可用的路由（`reply_to + 路由`）：

| 路由 | 方法 | 需要令牌 | 作用 |
|---|---|---|---|
| `/healthz` | GET | 否 | 存活信息（版本/listen 实际地址/pid） |
| `/collab/status` | GET | 非回环时是 | 协作状态（不含正文/口令） |
| `/collab/sessions` | GET | 非回环时是 | 本机会话 `{sessionId,title}`（稳定 id 的发现入口） |
| `/collab/deliver` | POST | 非回环时是 | 投递到本机会话（宿主 steer/followup） |
| `/collab/receipts?id=` | GET | 非回环时是 | 查入站投递的二级回执 |

`POST /collab/deliver` 正文：

```json
{ "sessionId": "session-…", "text": "…", "splice": true,
  "from": { "peer": "my-pc", "sessionId": "session-…" } }
```

也可以只给 `title`（本机会话存储里**完全一致且唯一**的标题）。
返回一级回执 + `receiptId` + 当前二级回执；业务失败也以 200 + `{ok:false,error}` 返回，
传输层错误（400/403/404/405/413/500 等）才用非 200。

- 入站投递走宿主 `sessionController`（软取；宿主没有这个能力时 `/collab/deliver` 返回
  `delivery/failed`，出站与 MCP 不受影响）。
- **不要**把这里的 `reply_to` 当成公网入口：非回环形态是明文 HTTP，请放在 mira_proxy /
  VPN / 内网之后；令牌只是最低限度的写保护。

---

## 七、已知取舍 / 限制

1. **`config.json` 改动需要重载插件才生效**（`listen` 是绑定资源，热切换会打断在途回执）；
   `aliases.json` 是热读的（每次操作都重新读文件），改完下一次调用即生效。
   「不让旧实例用旧状态覆写新文件」靠的是原子写 + 别名表不缓存。
2. **`listen` 不做任何自动探测**：不猜网卡、不猜主机名、不接受 `0.0.0.0`/IPv6/主机名。
   只支持 IPv4。
3. `loopback` 形态的 `reply_to` 是 127.0.0.1，跨机对端回连不到；跨机请手填本机局域网 IP。
   入站令牌在监听启动时读一次；换令牌要重载插件（与 `config.json` 同理）。
4. 跨机**出站**仍走浏览器（对端 mira_proxy → GUI），没有「直接 POST 到对端
   `/collab/deliver`」的出站路径。入站是新增的另一条路；两条都支持回信。
5. 二级回执是**观察**，不是协议确认：对端 GUI 没有已读标记，`read` 只等于「文本已出现在
   对端对话里」（宿主路径等于「跑完一轮」）。长会话的页面文本窗口会滚掉刚送达的消息，
   这时最多停在 `running`/`pending`，**不要据此重发**。
6. `collab_status` 不主动探测回执（避免 status 变慢/驱动浏览器）；要看最新二级状态用
   `collab_receipt` / `collab_wait`。
7. `send_many` 的同目标条目是串行的（浏览器页面只有一个输入框）；跨目标才并行。
8. `collab_wait` 的最短等待按 5 秒算；没有新内容返回 `timeout:true`（不是错误）。
9. 浏览器档案里的 cookie 文件权限由 Playwright 决定；本插件只保证**新建目录 700**、
   不读取/不回显/不记录 cookie 内容。要更严可以自己在宿主层加磁盘权限。
10. 别名 `collab_alias_set` 不探测标题是否存在；首次发送时才判定（并报 `addressing/not-found`）。
11. 回执只存在进程内（200 条上限，15 分钟 inflight TTL）；重启后旧 id 失效。
12. 未做：IPv6、`0.0.0.0` 监听、TLS 终止、多用户令牌、对端的入站回执主动回调。

---

## 八、迁移步骤（0.1.0 → 0.2.0）

1. **备份**：`cp $DSH_HOME/mira_config/mira_browser/config.json{,.bak}`（若已有）；
   `aliases.json` 是本版新增，无需迁移。
2. **加 `listen`**（推荐写在 `config.json`，而不是 profile 补丁里）：

   ```json
   {
     "schemaVersion": 1,
     "listen": { "ip": "192.0.2.10", "port": 8544 }
   }
   ```

   只在本机协作写 `"listen": "loopback"` 即可。`schemaVersion` 必须是 `1`。
3. **profile 层不用改名**：旧的 `python / aiBrowserHome / playwrightBrowsersPath / root /
   profilesDir / tmpDir / localGuiUrl / proxyPort / targets` 原样保留即可。
   若你改了 `profilesDir`/`tmpDir`，记得把 `mcp-aibrowser` 行的
   `AI_BROWSER_PROFILES`/`TEMP`/`TMP` 也改成同一对目录。
4. **口令迁移（建议）**：把 `targets[].pass` 移到 `creds/<target>.json`
   （`{"schemaVersion":1,"user":"…","pass":"…"}`，`chmod 600`），然后从 config 里删掉 `pass`。
5. **别名**：把常用的对端会话登记成别名（本机用 `sessionId`，跨机用完整 `title`）：

   ```
   collab_alias_set { alias: "brother", target: "local", sessionId: "session-…" }
   collab_alias_set { alias: "pc-agent", target: "pc", title: "为DSH写Node.js反代插件" }
   ```

   以后 `collab_send { alias: "brother", text: "…" }`。
6. **旧标题前缀用法**：若以前 `session` 传的是标题前缀，现在会 `addressing/not-found`；
   改用别名（或在 `session` 里传侧边栏可见的完整标题）。
7. **`replyUrl`**：若旧配置显式写了，仍生效（仅覆盖信封地址）并会 warn；
   想回到「由 listen 推导」就删掉。
8. 跑自检：

   ```bash
   cd mira_browser && node test/smoke.mjs          # 末行 ==== ALL PASS（N 项断言）====
   cd .. && node tool_shared/tools/check-zero-dep.mjs mira_browser
   node tool_shared/tools/check-kit.mjs                # mira_browser 必须是 [OK]
   ```

---

## 九、本机实测结论（仍然有效，写进代码的那些）

### 侧边栏与结构守卫

- 会话行的结构信号：`[role=treeitem][class*="sessionRow"]`（本机类名带哈希前缀
  `YDXeBa_sessionRow`，所以必须 `[class*=…]`）；工作区行 `[class*="projectRow"]` +
  `aria-expanded`；折叠组里的会话**不在 DOM 里**，找不到时要先展开。
- 打开成功的唯一凭据是「侧边栏选中行 == 目标」，不是「页面上出现过这串字」；
  核对不过就**拒绝发送**，避免把消息投给别的会话。
- 发送前还会做一次候选检查：0 个 → `addressing/not-found`；多个 → `addressing/ambiguous`。
- 装饰性浮层（Live2D 看板娘 canvas）会吃掉指针事件 → `click_text` 报 `blocked_by=overlay`，
  兜底用 CDP 坐标点击（`py/browser_bridge.py` 的 `cdp_click`），但发送仍以选中行复核为准。

### 为什么需要常驻 Python 子进程

`ai_browser` 的 CLI 每次调用都是新进程（无状态），而协作是跨多次工具调用的
（先 list、再 send、再 wait），浏览器会话必须一直活着。`lib/bridge.js` 维持一个长驻
`py/browser_bridge.py`，用行分隔 JSON 收发（`{"id":N,"op":"…"}` → `{"id":N,"ok":true,…}`）。

### 跨机回信的两个坑（为什么有别名表 / 手填 listen）

1. 只给本机 `session-<id>` 不够：对端不知道「哪台机器、哪个入口」。所以信封里补
   `from_peer` 与 `reply_to`（现在是手填 listen 推导，不再靠网卡探测）。
2. GUI 的侧边栏/搜索只按**标题**寻址，而跨机 id 是各机本地映射。把本机 id 发给对端，
   对端拿它查自己的存储必然 0 命中。所以对外的稳定名字是**别名**；跨机别名的记录里
   必须有对端侧边栏里完整的标题。

### `local` 目标没有凭据可用（Linux 上暴露）

`resolveTarget('local')` 只给 url、不带 user/pass；本机 GUI 的 `/api` 还要一枚绑定
authority 的签名 cookie。解法（插件代码零改动）：复用 mira_proxy 的实现现签一枚，
导进插件自己的浏览器档案：

```bash
node tools/mint-local-cookie.mjs 127.0.0.1:3080 ~/.mira_browser/local-cookie.json
# 再 mcp__aibrowser__cookies_import(profile="dsh-collab", cookie_file=...)
```

密钥取自 `~/.dsh/.credentials.yaml`；cookie 默认 29 天有效，到期重跑即可（不必重启宿主）。

---

## 十、文件

| 文件 | 作用 |
|---|---|
| `lib/index.js` | 唯一入口：配置装配、单实例、运行期目录、监听、入站投递、status |
| `lib/config.js` | `config.json` 读取/校验/schemaVersion/监听归一化/凭据读取 |
| `lib/addressing.js` | 稳定别名表 `aliases.json`（原子写、无缓存、只前进的 lastUsedAt） |
| `lib/receipt.js` | 两级回执状态机 + send 队列（queue/inflight 的数据源） |
| `lib/listen.js` | 本节点 HTTP 监听：健康检查/入站投递/回执查询/令牌校验 |
| `lib/collab.js` | 协作内核：目标解析、侧边栏结构信号、选中行守卫、发送、等待、状态 |
| `lib/bridge.js` | 常驻 Python 子进程的行分隔 JSON 客户端（本轮未改） |
| `lib/kit.mjs` | 共享小工具（`tool_shared/kit/kit.mjs` 的逐字节副本） |
| `lib/tools.js` | 10 个 `collab_*` 工具 |
| `test/smoke.mjs` | 自检（假 bridge / 假宿主；不 spawn Python、不连对端） |
| `py/browser_bridge.py` | 驱动端（本轮未改） |
| `tools/mint-local-cookie.mjs` | 给浏览器档案现签一枚 DSH 会话 cookie（本轮未改） |
| `cordis.patch.yml` | 插入 `mira-browser-dirs` 与 `mcp-aibrowser` 两行 |
| `package.json` | bundle 清单（`main: lib/index.js`、`dsh.bundle.patch`），无 npm 依赖 |

## 十一、自检

```bash
cd mira_browser
node test/smoke.mjs
# 通过 217 项断言
# ==== ALL PASS（217 项断言）====
```

自检覆盖：缺 listen 的 `config/missing` 与 hint、loopback 实际监听 127.0.0.1、
别名落盘/一级回执、二级回执 pending→running→read、`send_many` 单条失败不阻断、
status 的 queue/inflight、单实例、schemaVersion 不匹配、别名表坏、旧 profile 键兼容、
凭据不回显、入站 `/collab/deliver` 与令牌鉴权。
