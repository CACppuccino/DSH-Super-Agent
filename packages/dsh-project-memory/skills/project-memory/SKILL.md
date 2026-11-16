---
name: project-memory
description: Read and write two-layer per-project memory (Super Agent summaries + worker-owned tagged detail notes). Load before calling any project_memory_* tool.
---

# Project memory

项目记忆是**按项目隔离的两层存储**。先读这份 Skill，再调用任何 `project_memory_*` 工具；
工具在未加载本 Skill 时会直接报 `project_memory.skill_required`。

## 两层与所有者

| 层 | 谁维护 | 谁可读 | 位置 |
|---|---|---|---|
| **summary**（摘要层） | Super Agent | Super Agent（所有项目） | `<project>/summary.md` |
| **detail notes**（细节层） | Worker | 该项目的 Worker；Super Agent 可读所有项目 | `<project>/notes.jsonl` |

- **Super Agent**：读所有项目、两层的全部内容；只写 summary。不要写 detail note。
- **Worker**：只读、只写**自己绑定的唯一项目根**的 detail notes。不能读或写 summary，
  也不能读其他项目的 notes；越界会在 host 侧被拒绝，不是靠提示词约束。
- 项目身份是目录路径。一个会话可能涉及多个项目：写之前先判断内容属于哪些项目，再逐个写。
  Super Agent 用一条 `project_memory_summary_write({ writes: [...] })` 可同时写多个项目；
  Worker 只能写自己绑定的项目，若任务跨项目，在自己的 note 里记录，并让要求其他项目的人各自写。

## 谁能加载本 Skill

- **Worker**：调用标准 `skill` 工具：`skill({ "name": "project-memory" })`。
- **Super Agent**：`skill` 工具被 Super Agent 策略禁用，调用 `project_memory_guide` 加载同一份内容。
- 也可以由用户显式 `/project-memory` 调用，加载后本会话的门禁即打开。
- 门禁按会话记录在 durable session log 中；加载成功后，本会话后续记忆工具都可用。

## 工具

### Super Agent

- `project_memory_projects`：列出项目注册表（key、路径、note 数、summary 状态）。
- `project_memory_summary_read({ project?, full?, limit? })`：
  指定项目读该项目 summary；省略项目时列出所有项目的 summary 预览。
- `project_memory_summary_write({ project, content, mode? })` 或
  `project_memory_summary_write({ writes: [{ project, content, mode? }, ...] })`：
  写 summary。`mode` 为 `replace`（默认）或 `append`。**多项目必须显式列出每个项目**。
- `project_memory_notes_read({ project?, tags?, since?, limit?, full? })`：
  读 detail notes。省略项目 = 所有项目；可按 tag、时间过滤。
- `project_memory_search({ query?, tags?, project?, since?, limit?, full? })`：
  按 tag、文本或项目搜索；文本会先查索引再查正文。

### Worker

- `project_memory_notes_read({ project?, tags?, since?, limit?, full? })`：
  只能读绑定的项目；绑定后可省略 `project`。
- `project_memory_note_append({ title, body, tags, project? })`：
  只能写绑定的项目；传其他项目会被拒绝。

> 第一次记忆调用会确定绑定。若 assigned workspace 是 `/Users/.../Projects` 这类父目录，
> 必须显式传一次 `project`（实际项目路径）；若 workspace 是项目子目录，会自动解析到
> 所属项目根。绑定后本会话不可切换项目。

## 会话开始检查（重要）

- **Super Agent**：每个新会话/任务开始、做实质工作前，先调用 `project_memory_projects`
  一次，再对绑定/根项目调用 `project_memory_summary_read`（compact）。如果没有任何相关
  项目，明确说明“没有相关项目记忆”再继续；任务收尾后更新受影响项目的 summary。
- **Worker**：开始前先调用 `project_memory_notes_read` 读自己绑定项目的 notes；没有相关
  记忆就说明后继续。任务收尾后追加一条带 tag 的 detail note（summary 由 Super Agent 维护）。
- 系统提示词会在角色说明后注入 **Memory index** 区块（仅 Super Agent）：按 `updatedAt`
  倒序、每个项目一行（title / key / 更新时间 / note 数 / summary 前约 120 字符），整块受
  字符上限约束、按 `memoryIndexRefreshMs` 重建。它只是**上下文索引，不是权威**；
  引用其中内容前先 `project_memory_summary_read` 核实。
- 这些是提示词层面的约定，不是新的门禁：没做会话开始检查不会阻止其他工具调用。

## 项目解析

`project` 参数接受：

1. 项目 key（`project_memory_projects` 返回的 `key`，最稳定）；
2. 绝对路径或相对当前 workspace 的路径；
3. Super Agent 已知 workspace 的 id 或唯一标题；
4. 注册表中唯一的 title / 目录名。

Worker 只能使用自己绑定项目的 key/路径。写操作会按 canonical path 自动注册项目；
读取未知项目时也会注册一个空项目。`~` 会被展开。

## Worker 项目绑定（重要）

“自己的项目”不等于 `session.cwd` 或 worker 被派发时的 workspace 原样字符串。Host 会先
解析出**项目根**，保存为会话级绑定：

1. workspace 本身是项目根（有 `.git` 或 `package.json`/`pyproject.toml`/`Cargo.toml`/
   `go.mod` 等标记，或是已注册项目）→ 绑定 workspace。
2. workspace 在某个项目根内部（例如 `QuantResearch/src`）→ 绑定最近的 enclosing
   project root（例如 `QuantResearch`）。
3. workspace 不是项目根，且其直接子目录中只有一个项目根 → 绑定该唯一子项目。
4. workspace 是普通目录，没有子项目根 → 绑定 workspace 本身。
5. workspace 是包含多个项目根的父目录（例如 `/Users/me/Projects`）→ 先不绑定。
   第一次记忆调用必须传一次实际项目路径（可以是项目内子目录，解析到项目根），
   例如 `project_memory_note_append({ project: "/Users/me/Projects/QuantResearch", ... })`。
   绑定成功后本会话固定在该项目；再访问其他项目会被拒绝。

- 绑定持久化在 `bindings.json`，worker resume/reload 后仍保持同一项目。
- 绑定后省略 `project` 即使用绑定项目。
- Worker 不能通过传其他项目 key/path 切换项目；多项目写只属于 Super Agent 的 summary。
- 如果第一次调用时不传 `project` 且 workspace 是多项目父目录，会返回
  `project_memory.project_unbound` 并列出候选项目路径；按提示传一次即可。

## 先决定项目，再写

写任何内容前，先回答：**这段内容属于哪个/哪些项目？**

- 只属于一个项目：写一个项目。
- 跨多个项目：拆成每个项目各自的 summary，用 `writes` 数组一次写完；
  不要把 A 项目的内容写进 B 项目。
- 不确定项目时先调用 `project_memory_projects`，不要猜路径。
- Worker 的 detail note 只写自己绑定的项目；跨项目内容不要偷偷写进自己的 note
  当别人的项目记录，应在 note 里注明涉及的项目路径，由对应项目的会话去写。

## Detail note 结构

`project_memory_note_append` 的 `body` 是 Markdown，推荐：

- `##` 子标题拆分子主题；
- 用 `<details><summary>展开看细节</summary> ... </details>` 放可展开的细节；
- 关键结论放前面，长日志/命令输出放 `<details>` 里；
- `title` 是这条 note 的子标题（最多 200 字符）；
- `tags` 从下面的封闭词表选，1–6 个；未知 tag 会被拒绝（英文别名会被映射）。

### 必选 tag 词表

`经验` / `教训` / `研究` / `工程` / `简单执行` / `讨论`

英文别名：`experience`→经验，`lesson`→教训，`research`→研究，`engineering`→工程，
`simple-execution`→简单执行，`discussion`→讨论。

示例：

```json
{
  "title": "修复 SSE 空行丢失",
  "tags": ["教训", "工程"],
  "body": "## 现象\n\nSSE 流里空行被吞掉，解析器一直等不到消息边界。\n\n## 根因\n\n`AsyncBytes.lines` 不保留空行。\n\n<details><summary>验证与修复</summary>\n\n- 用按字节解析器复现\n- 保留空行后重跑 `node --test` 通过\n\n</details>"
}
```

## 读的限制与 compact 行为

所有工具**默认紧凑**：note 只返回 `preview`，summary 只返回截断预览。需要完整内容时传
`full: true`；仍受存储上限约束。

- note body 写入上限 64 K 字符；title 200 字符；summary 32 K 字符；
- note 读取默认 20 条（最多 100），search 默认 20 条（最多 50）；
- 一次 summary 写入最多 20 个项目；
- 结果默认有总字符预算，超出会标 `truncated` / `omitted`。

## 读之前先想清楚

- 要回忆某个项目的结论：先读 summary（Super Agent），再按 tag 读相关 notes。
- 要找特定经验：`project_memory_search({ tags: ["教训"], query: "..." })`。
- 要最近变更：`since` + `limit`。
- 不要把所有 notes 一次性 `full: true` 拉进上下文；先 compact，再按 id/主题精读。

## Super Agent 使用约定

1. **每个新会话/任务开始（做实质工作前）**：先调用一次 `project_memory_projects`，再对绑定/根项目调用 `project_memory_summary_read`（compact）；如果没有任何相关项目，明确说明“没有相关项目记忆”后再继续。随后判断这次内容涉及哪些项目；如果是跨项目问题，先读相关项目的 summary（compact），再决定是否读 notes。
2. **派 worker 前**：brief 里写明目标项目路径；如果 workspace 是父目录（如 `/Users/me/Projects`），要求 worker 第一次记忆调用时传 `project`，一次绑定。
3. **重大决策 / 一个任务收尾后**：更新受影响项目的 summary —— `replace` 用于当前状态，`append` 用于时间线；多项目用 `writes` 一次写完。
4. **不要写 detail notes**（那是 worker 的层）；需要记录过程细节时，让执行该工作的 worker 去写。
5. **读 notes 时先过滤**：用 `tags` / `since` / `limit`，默认 compact；确需全文才 `full: true`。
6. **summary 是给"下一次的自己"看的**：写当前状态、关键决策、未完成/风险、相关 note 主题；不要堆原始日志。
7. **引用 note 时说清 project + title**，便于回查。

## 写 summary（仅 Super Agent）

summary 是给 Super Agent 自己下次用的**精炼状态**，不是 note 的复制。建议结构：

```markdown
# <project title>

## 当前状态
- ...

## 关键决策
- ...

## 未完成 / 风险
- ...

## 相关 note 主题
- ...
```

写 summary 时保留项目内仍然有效的结论；不要堆原始日志。`append` 适合追加时间线，
`replace` 适合重写当前状态。写完后在回复里告诉用户或 worker 写了哪些项目。

## 写 detail note（仅 Worker）

- 一个 note 只讲一个可复用的经验/教训/研究结论/工程动作，标题具体。
- 不要把整个任务日志塞进一条 note；拆成多个带 tag 的小 note。
- 结论先行；细节放 `<details>`。
- 写完 note 后，最终回复里写清楚写了哪个项目、note 的 title 和 tags。
