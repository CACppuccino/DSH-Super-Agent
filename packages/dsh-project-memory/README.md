# dsh-project-memory — 项目记忆插件

给 **Super Agent** 和它的 **Worker** 提供按项目隔离的两层记忆：

- **summary（摘要层）**：Super Agent 维护、Super Agent 读；覆盖所有项目。
- **detail notes（细节层）**：Worker 维护、Worker 读自己绑定的项目根；Super Agent 只读。

本包位于 [`DSH-Super-Agent`](../../README.md) 仓库的 `packages/dsh-project-memory/`；
下面的命令以仓库根目录为起点（包内命令会标明 `cd packages/dsh-project-memory`）。
本插件是独立 bundle，**不修改 `dsh-super-agent`**，并且在没有 Super Agent 目录时
自动降级为「只读写本会话 workspace 解析出的项目根细节笔记」的最小权限模式。

- 存储根目录：`$DSH_HOME/state/dsh-project-memory/`
- 项目标识：项目目录的 canonical path（`realpath` 后）
- 笔记格式：append-only JSONL + 可重建的紧凑索引
- 写操作：跨进程锁 + 原子 rename（summary / index / registry）
- 所有读取默认 compact，显式 `full: true` 才返回正文

## 权限矩阵

| 能力 | Super Agent | Worker |
|---|---|---|
| 读取 summary（所有项目） | ✅ | ❌ |
| 写入 summary | ✅（所有项目，支持一次写多个） | ❌ |
| 读取 detail notes | ✅（所有项目） | ✅（仅自己的项目） |
| 写入 detail notes | ❌ | ✅（仅自己的项目） |
| 搜索 notes（tag / 文本 / 项目） | ✅ | ❌（用 `notes_read` 的 tag/since 过滤） |
| 项目注册表 | ✅ | ❌ |

权限不是只靠提示词：Host 在 **agent scope 上按角色注册不同的工具**，并在每次
`execute` 里再次检查能力矩阵与项目边界。Worker 即使拿到其他项目 key 或路径，
也会在写入/读取前被 `project_memory.permission_denied` 拒绝。

## 角色识别

插件在 `agent/created` 时读取 Super Agent 的目录文件：

```
$DSH_HOME/state/dsh-super-agent/state.json
```

（或 `DSH_SUPERAGENT_STATE_DIR/state.json`；非 desktop profile 会自动查找
`.../dsh-super-agent/profiles/<profile>/state.json`。）

- `kind: "super"` → **Super Agent**，项目默认取该会话的 workspace。
- `kind: "worker"` → **Worker**，项目根由 worker 的 `workspacePath` 解析（见下一节）。
- 目录里没有该会话（普通会话、或没装 Super Agent）→ **Worker 降级模式**：
  角色取最小权限，项目取当前 `session.header.cwd`；没有 summary 工具。

因此：

- Super Agent 插件可以单独工作（记忆插件不在时，Super Agent 不受影响）。
- 记忆插件也可以单独工作（没有 Super Agent 时，普通会话仍可维护本项目的 notes）。
- 两种角色都不会因为读不到目录而获得更高权限。

## Worker 项目边界解析（重要）

“自己的项目”不等于 `session.header.cwd`，也不等于 worker 被派发时的 `workspacePath`
原样字符串。Super Agent 有时会把 worker 派发到父目录（例如
`workspace=/Users/me/Projects`，QuantResearch audit worker），而实际要记忆的是
`/Users/me/Projects/QuantResearch`。Host 在第一次记忆调用时解析项目根并做**会话级绑定**：

1. workspace 本身是项目根（`.git`，或 `package.json` / `pyproject.toml` /
   `Cargo.toml` / `go.mod` 等标记，或已注册项目）→ 绑定 workspace。
2. workspace 在某个项目根内部（例如 `QuantResearch/src`）→ 绑定最近的 enclosing root
   （`QuantResearch`）。这修复了“workspace 是项目子目录”时的误判。
3. workspace 不是项目根，但直接子目录中只有一个项目根 → 绑定该唯一子项目。
4. workspace 是普通目录，没有子项目根 → 绑定 workspace 本身。
5. workspace 是包含多个项目根的父目录（例如 `/Users/me/Projects`）→ 先不绑定。
   第一次记忆调用必须显式传一次实际项目路径（子目录会解析到项目根）：
   `project_memory_note_append({ project: "/Users/me/Projects/QuantResearch", ... })`。
   绑定成功后本会话固定在该项目；再访问其他项目一律拒绝。

绑定写入 `bindings.json`，worker resume/reload 后仍保持同一项目。绑定不可变；Worker
没有第二条 summary 或跨项目 path。若父目录第一次调用未传 `project`，工具返回
`project_memory.project_unbound` 并列出候选项目路径。多项目写只属于 Super Agent 的 summary。

## 项目注册表

项目注册表在 `registry.json`，每条记录包含：

```json
{
  "key": "dsh-project-memory-1a2b3c4d5e",
  "path": "/Users/me/Projects/dsh-project-memory",
  "title": "dsh-project-memory",
  "createdAt": 1790000000000,
  "updatedAt": 1790000001000,
  "summaryUpdatedAt": 1790000001000,
  "summaryChars": 1234,
  "noteCount": 7,
  "lastNoteAt": 1790000001000
}
```

- `key` = 目录名 slug + canonical path 的 sha256 前 10 位，稳定且可读。
- 写操作首次遇到某个项目时会自动注册；也可以显式
  `project_memory_projects({ add: "<path 或 workspace id>", title })`。
- Super Agent 还可以用 workspace id / 唯一 workspace 标题解析项目。
- Worker 只能解析到自己的绑定项目；其他路径在权限检查处被拒绝，且绑定后不可切换。

## 存储布局

```
$DSH_HOME/state/dsh-project-memory/
├── registry.json                    # 所有项目的紧凑索引
├── bindings.json                    # worker 会话 → 唯一项目根的持久绑定
├── locks/                           # 跨进程锁目录（mkdir 原子获取）
├── projects/
│   └── <project-key>/
│       ├── project.json             # 项目身份（canonical path / title / git remote / cloud id）
│       ├── summary.md               # Super Agent 的 summary（人类可读 Markdown）
│       ├── notes.jsonl              # append-only 细节笔记，一行一条 JSON
│       └── index.json               # 紧凑索引：id/时间/标题/tags/预览/字节数
└── .cloud/                          # 仅 cloudflare 后端
    ├── cloud.json                   # 非机密配置：Worker URL / machine id / Keychain 名称
    ├── machine-id                   # 自动生成的 per-machine id（未在 cloud.json 指定时）
    ├── sync-state.json              # 每个项目的拉取游标（notes seq / summary version）
    ├── outbox.jsonl                 # 写前队列（append-only + fsync，重启可重放）
    ├── outbox-dead.jsonl            # 永久失败（4xx）的写，保留原文供排查
    └── remote/<cloud-id>/           # 另一台 Mac 上没有本地 checkout 时的缓存项目
```

`notes.jsonl` 一行示例（正文支持 Markdown 子标题和 `<details>`）：

```json
{"id":"note-mabc123-1a2b3c4d","at":1790000000000,"authorRole":"worker","authorId":"superagent-worker-...","projectKey":"demo-1a2b3c4d5e","title":"SSE 空行丢失","tags":["教训","工程"],"body":"## 现象\n\n...\n\n<details><summary>验证</summary>\n\n...\n\n</details>"}
```

### 并发与原子性

- 每个项目的写操作持有 `locks/<project-key>.lock`；注册表写操作持有
  `locks/registry.lock`。锁用 `mkdir` 原子获得，支持跨进程；超时/陈旧锁有上限。
- summary、index、registry、project.json 都是「临时文件 + rename」原子替换。
- notes 使用 O_APPEND 追加；在同一把项目锁内完成，因此多个 worker 同时写也不会交错。
- `index.json` 记录 `sourceBytes`；如果进程在追加 note 与更新索引之间崩溃，下一次读取
  会发现字节数不一致并从 `notes.jsonl` **自动重建索引**。损坏的行会被忽略。
- 读取不会改写 notes；索引缺失/损坏时会重建 `index.json`（只改索引缓存）。

## Detail note 结构

`project_memory_note_append` 接受：

| 字段 | 说明 |
|---|---|
| `title` | note 的子标题，≤ 200 字符 |
| `body` | Markdown；用 `##` 分小节，用 `<details><summary>…</summary>…</details>` 放可展开细节；≤ 64 K 字符 |
| `tags` | 1–6 个，来自封闭词表 |
| `project` | 绑定后可省略；父目录 workspace 首次调用需传实际项目路径；只能是自己绑定项目 |

推荐写法：

```markdown
## 现象
一句话结论。

## 根因
...

<details><summary>证据 / 命令输出</summary>

- 命令 ...
- 结果 ...

</details>
```

### 必选 tag 词表

`经验` / `教训` / `研究` / `工程` / `简单执行` / `讨论`

- 未知 tag 会被**拒绝**，不会静默丢弃。
- 英文别名会映射：`experience`→经验、`lesson`→教训、`research`→研究、
  `engineering`→工程、`simple-execution`→简单执行、`discussion`→讨论。
- 重复 tag 会去重。

## 工具

### Super Agent

| 工具 | 说明 |
|---|---|
| `project_memory_guide` | **加载 `project-memory` Skill**。Super Agent 的 `skill` 工具被禁用，所以用它加载同一份已注册 Skill；调用成功后本会话记忆门禁打开。 |
| `project_memory_projects` | 列出项目注册表；可 `add` 一个路径/workspace id。 |
| `project_memory_summary_read` | 指定项目读 summary；省略项目列出所有项目摘要（compact）。`full:true` 读全文。 |
| `project_memory_summary_write` | 写 summary。单项目用 `{project, content}`；跨项目用 `{writes:[{project, content, mode}, ...]}`，一次写多个项目。`mode` 为 `replace`/`append`。 |
| `project_memory_notes_read` | 读 detail notes；可按 `project`、`tags`、`since`、`limit` 过滤。Super Agent 省略 project 时读所有项目。 |
| `project_memory_search` | 按 `tags` / `query` / `project` 搜索；文本先查索引再查正文。 |

### Worker

| 工具 | 说明 |
|---|---|
| `project_memory_notes_read` | 只读自己绑定项目的 notes；可 `tags`/`since`/`limit`/`full`。 |
| `project_memory_note_append` | 写一条自己绑定项目的 note；其他项目直接拒绝。 |

所有结果默认 compact：note 只给 `preview`，summary 只给截断预览；`full:true` 才返回
正文，且仍受存储上限与总字符预算约束。结果里的 `truncated` / `omitted` 表示被截断。

## Super Agent 使用约定

1. **每个用户请求开始时**：先判断这次内容涉及哪些项目；如果是跨项目问题，先读相关项目的 summary（compact），再决定是否读 notes。
2. **派 worker 前**：brief 里写明目标项目路径；如果 workspace 是父目录（如 `/Users/me/Projects`），要求 worker 第一次记忆调用时传 `project`，一次绑定。
3. **重大决策 / 一个任务收尾后**：更新受影响项目的 summary —— `replace` 用于当前状态，`append` 用于时间线；多项目用 `writes` 一次写完。
4. **不要写 detail notes**（那是 worker 的层）；需要记录过程细节时，让执行该工作的 worker 去写。
5. **读 notes 时先过滤**：用 `tags` / `since` / `limit`，默认 compact；确需全文才 `full: true`。
6. **summary 是给"下一次的自己"看的**：写当前状态、关键决策、未完成/风险、相关 note 主题；不要堆原始日志。
7. **引用 note 时说清 project + title**，便于回查。

## Skill 门禁

- Skill 名称：`project-memory`，随插件发布在
  [`skills/project-memory/SKILL.md`](skills/project-memory/SKILL.md)。
- 插件启动时用标准 Harness API `ctx.skills.register()` 注册它，所以：
  - Worker 在会话 skill 目录里能看到它，用 `skill({name:"project-memory"})` 加载；
  - 其他 agent 也可以通过标准的 skill 机制加载。
- Super Agent 的 `SUPER_DENY` 列表明确禁用了 `skill` 工具（这是 `dsh-super-agent`
  既有的安全策略，本插件没有修改它），因此 Super Agent 用 `project_memory_guide`
  加载同一份 Skill 内容。
- **门禁**：任何 `project_memory_*` 读写工具执行前，Host 会扫描本会话的 durable
  session log，确认存在以下之一：
  1. 成功的 `skill({"name":"project-memory"})` 调用；
  2. 成功的 `project_memory_guide` 调用；
  3. 用户显式 `/project-memory` 注入的 `skill-invocation` 消息。
- 没有加载就调用记忆工具，会返回可操作的错误：

  ```
  [project_memory.skill_required] Load the "project-memory" skill before using any
  project memory tool. Call skill with {"name":"project-memory"} once in this session,
  then retry this call.
  ```

  失败/被拒绝的加载调用不会打开门禁。

## 安装 / 启用（desktop profile）

前提：DSH 桌面版已创建 `~/.dsh/profiles/desktop`，且 profile 里已有
`@deepseek-ai/dsh-base`（提供 `skills` / `tools` / `agents` 服务）。

### 方式 A：dsh CLI（推荐）

```sh
# 在 DSH-Super-Agent 仓库根目录
cd packages/dsh-project-memory
dsh plugin --profile desktop add "file:$PWD"
```

然后让 profile 重新加载（重启 DSH，或在支持热重载的宿主里 reload profile）。
启用后日志会出现：

```
dsh-project-memory ready (root: ~/.dsh/state/dsh-project-memory; backend: local; super-agent catalog: ~/.dsh/state/dsh-super-agent/state.json)
```

### 方式 B：手工 profile manifest

在 `~/.dsh/profiles/desktop/package.json`：

```json
{
  "dependencies": {
    "@local/dsh-project-memory": "file:/ABSOLUTE/PATH/TO/DSH-Super-Agent/packages/dsh-project-memory"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-super-agent",
        "dsh-remote",
        "@local/dsh-project-memory"
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install`，再 reload。

bundle patch（[`cordis.patch.yml`](cordis.patch.yml)）只插入一行：

```yaml
- insert:
    - id: dsh-project-memory
      name: '@local/dsh-project-memory'
```

### 卸载

```sh
dsh plugin --profile desktop remove @local/dsh-project-memory
```

数据保留在 `$DSH_HOME/state/dsh-project-memory/`，可手动删除。

## 配置

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `DSH_PROJECT_MEMORY_DIR` | `$DSH_HOME/state/dsh-project-memory` | 覆盖存储根目录（测试/隔离部署用） |
| `DSH_HOME` | `~/.dsh` | DSH 根目录 |
| `DSH_SUPERAGENT_STATE_DIR` | `$DSH_HOME/state/dsh-super-agent` | Super Agent 目录位置（与上游一致） |
| `DSH_PROFILE` / `--profile` | `desktop` | 非 desktop 时自动查找 profile 子目录 |
| `DSH_PROJECT_MEMORY_BACKEND` | `auto` | `auto` / `local` / `cloudflare`；`auto` 在发现 Worker URL 时启用云后端 |
| `DSH_PROJECT_MEMORY_CLOUD_URL` | — | Cloudflare Worker 的 `https://…` URL |
| `DSH_PROJECT_MEMORY_MACHINE_ID` | 自动生成 | 本机 id（如 `macbook-a`），用于 note/summary 归属与路径 hint |
| `DSH_PROJECT_MEMORY_TOKEN` | — | 仅 headless/CI；桌面版用 Keychain，不写环境变量 |
| `DSH_PROJECT_MEMORY_IDENTITY` | — | 手动覆盖项目身份（`git:host/path` 或 `title:slug`） |
| `DSH_PROJECT_MEMORY_AUTO_SYNC` | `1` | `0` 关闭后台 30s 重放（前台读写仍会尝试同步） |
| `DSH_PROJECT_MEMORY_CLOUD_WRITE_BUDGET_MS` | `6000` | 单次内联写同步预算（毫秒）；用尽后写入留在 outbox 等下次重放，不会仅因此报离线 |
| `DSH_PROJECT_MEMORY_CLOUD_PULL_BUDGET_MS` | `15000` | 单次拉取预算（毫秒），独立于写预算；每页 50 条 notes，逐页跟进游标 |
| `DSH_PROJECT_MEMORY_PROXY` | — | 可选：本地 HTTP CONNECT 代理（如 `http://127.0.0.1:15236`），用于本机网络拦截 `*.workers.dev` 的情况 |

本机云配置写在 `$DSH_HOME/state/dsh-project-memory/cloud.json`（0600，不含 token）；
字段示例见 [`cloud.json.example`](cloud.json.example)。

## 跨机器共享（Cloudflare，可选）

**共享**：项目注册表、每个项目的 `summary`、`notes`。
**不同步**：DSH 对话、session、worker transcript、workspace、`bindings.json`、本地锁。
云端没有 session 概念，另一台 Mac 看不到你本机的对话历史。

### 项目身份与路径

项目**不按绝对路径**合并。身份优先级：

1. git remote（`git -C <path> remote get-url origin`，忽略协议/大小写/`.git`：
   `git@github.com:Me/Repo.git`、`ssh://…`、`https://…` 都归一为 `git:github.com/me/repo`）；
2. 归一化标题（`title:my-project`；无 git remote 时的 best-effort，可能有同名冲突）；
3. 显式覆盖 `DSH_PROJECT_MEMORY_IDENTITY` 或 `project.json.identity`。

每台 Mac 的路径作为 **path hint** 存在云端，只用于“在另一台机器上找同一个 checkout”：
如果 hint 在本机存在且 git remote 匹配，就复用该路径；否则缓存到
`.cloud/remote/<cloud-id>/`。同一项目在两台机器上可以有不同路径。

### 冲突规则

- **notes 只追加**：以 note id 为幂等键 union，两台机器的写入不会互相覆盖/重复。
  拉取游标用服务端递增 `seq`，不依赖本机时钟。
- **summary last-write-wins，但保留上一版**：每次写入 version +1，旧内容进
  `summary_versions` 表；响应里的 `conflict` 表示写入基于过期版本。重放同一个
  `clientOpId` 是幂等的，不会重复升版。
- **离线不丢写**：本地先写（本地 store 仍是 source of truth），随后追加到
  `.cloud/outbox.jsonl`；网络恢复后按顺序重放 note append / summary upsert。4xx 等
  永久失败移到 `outbox-dead.jsonl` 并在结果里报告，不静默丢弃。
- **首次启用自动回填**：项目第一次注册到云端时，本机已有的 detail notes 会按 note id
  （并集、幂等）分批上传；本机 summary 只在云端还没有 summary 时上传，避免覆盖另一台
  机器已经写的摘要。回填标记写入 `project.json`，重启不会重复上传。

### 同步状态

cloudflare 后端下，每个 `project_memory_*` 结果多一个 `sync` 对象：

```json
{
  "backend": "cloudflare", "configured": true, "online": true, "stale": false,
  "lastSyncAt": "2026-11-15T05:00:00.000Z", "pendingWrites": 0, "failedWrites": 0,
  "machineId": "macbook-a"
}
```

离线/超时会变成 `online:false, stale:true, error:{kind:"network"}`；这时读取来自本地
缓存，写入照常成功但 `pendingWrites > 0`。达到 `stale` 时请勿假设另一台 Mac 已看到内容。

内联写同步只是预算用尽（`error.kind:"timeout"`，写仍在 outbox）时，状态保持
`online:true`，只体现为 `pendingWrites > 0`，下一次读写会继续重放；真正的网络/认证
失败才会把 `online` 置为 `false`。

### 当前部署（非机密）

本仓库对应的 Cloudflare 部署已经创建（2026-11-15），以下两项**不是 secret**：

- Worker URL：`https://dsh-project-memory.ziyang-liu03.workers.dev`
- D1 database：`dsh-project-memory`，id `cc6a9f97-e273-4025-b99d-d156b6eb3b74`（region WNAM）

`cloudflare/wrangler.toml` 已经写入这个 database id。自己部署一份时，用
`wrangler d1 create` 生成自己的 id 替换即可。bearer token 只存在于 Worker secret
（`MEMORY_TOKEN`）和每台 Mac 的 Keychain 中，**不在本仓库**。
当前状态：Worker/D1、本机回填和模拟第二机读取已验证；真实第二台 Mac 的 Phase 4
（note A→B、summary 冲突、离线重放）仍待在该机器上执行。

### 一次性部署（任意一台 Mac）

```sh
cd packages/dsh-project-memory/cloudflare
npm install
npx wrangler login                         # 交互式浏览器登录
npx wrangler d1 create dsh-project-memory   # 把 database_id 填进 wrangler.toml
npx wrangler d1 migrations apply dsh-project-memory --remote
openssl rand -base64 48                    # 生成共享 bearer token（不要提交/发聊天）
npx wrangler secret put MEMORY_TOKEN       # 粘贴同一个 token
npx wrangler deploy                        # 记下 https://<worker>.workers.dev
```

### 每台 Mac 配置

```sh
# token 存 macOS Keychain；-w 会交互式询问，不进入 shell 历史
security add-generic-password -U -s dsh-project-memory -a cloudflare-token -w

cd packages/dsh-project-memory
node scripts/cloud-setup.mjs --url https://<worker>.workers.dev --machine-id macbook-a
node scripts/cloud-setup.mjs --check        # 验证 Keychain token + Worker health
```

如果本机网络拦截 `*.workers.dev`（DNS 返回错误 IP、TLS reset 或超时），给本机加一个
HTTP CONNECT 代理（Veee / Clash / Surge 等客户端一般会监听 `127.0.0.1:<port>`）：

```sh
node scripts/cloud-setup.mjs --url https://<worker>.workers.dev \
  --machine-id macbook-a --proxy http://127.0.0.1:15236
node scripts/cloud-setup.mjs --check
```

`proxy` 只写入本机 `cloud.json`，不影响第二台 Mac；第二台能直连就不要配。Node 22 的
`fetch` 不读 `HTTPS_PROXY`，插件用内置的 CONNECT 隧道实现（无额外依赖）。

然后重启 DSH（或 reload profile）。`cloud.json` 只有 URL / machine id / Keychain
名称 / proxy（0600），**不含 token**；token 只出现在 Keychain 和 Worker secret 中。
同样的步骤在第二台 Mac 上执行，`--machine-id` 用不同值（如 `macbook-b`），token 相同。

详细设计见 [`docs/cloudflare-backend.md`](docs/cloudflare-backend.md)，Worker 部署与运维见
[`cloudflare/README.md`](cloudflare/README.md)。

## 上限与截断

| 项 | 限制 |
|---|---|
| note title | 200 字符 |
| note body | 64 K 字符 |
| summary | 32 K 字符 |
| note 读取 | 默认 20，最多 100 |
| search | 默认 20，最多 50 |
| summary 写入 | 每次最多 20 个项目 |
| summary 读取 compact | 6,000 字符 |
| 单次结果预算 | 120,000 字符（超出标 `truncated` / `omitted`） |

写超限会直接报错，不会截断后写入；读取会截断并明确标记。

## 开发与测试

```sh
cd packages/dsh-project-memory
npm test
```

测试覆盖：

- 权限矩阵（Super/Worker × summary/notes × 自己/其他项目）；
- Worker 项目根解析、父目录首次绑定、子目录 workspace、绑定持久化；
- tag 词表、别名、拒绝未知 tag；
- 多项目 summary 写入；
- 两个 store 实例并发 append、索引一致性；
- summary/index 原子写、损坏索引自动重建；
- 写入/读取大小限制与 compact/full；
- Skill 门禁（成功、失败、用户显式调用、guide）；
- plugin `apply()` 的 skill 注册、agent 装饰、无 Super Agent 降级；
- 云端：git remote 身份归一化、配置优先级、outbox WAL/损坏行/死信、HTTP
  超时/重试/401、离线读取与重放、以及**真实 Worker + SQLite D1 shim** 的两机集成测试
  （A 写 note → B 读到；B 写 summary → A 读到；冲突 summary 保留历史版本）；
- Worker 单元测试：`npm run test:worker`（21 项，`node:sqlite` D1 shim，无需 Cloudflare 账号）。

全部跑一遍：`npm run test:all`（无需网络/Cloudflare 账号；wrangler 部署只能对真实账户验证）。

## 与 dsh-super-agent 的关系

- **零修改**：没有改 `dsh-super-agent` 的代码、提示词或测试；它的 44 个测试保持通过。
- 只读取它的公开状态文件 `state.json` 做角色识别。
- Super Agent 被禁用的 `skill` 工具由本插件的 `project_memory_guide` 补位；
  Worker 继续使用标准 `skill` 工具。
- Worker 的 workspace 可以是项目根、项目子目录或多项目父目录；解析规则与绑定见上文。
- 两个插件可以分别安装、分别卸载。
