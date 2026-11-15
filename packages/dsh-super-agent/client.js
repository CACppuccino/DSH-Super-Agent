window.__ModuleLoader__.load({
  id: '@local/dsh-super-agent',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    // Stock Markdown primitive used by the built-in conversation surface.
    // It is a static module in the Web client loader; keep a defensive
    // fallback so a future loader change cannot blank the panel.
    const primitives = (() => {
      try { return require('@deepseek-ai/dsh-client-ui-primitives') } catch { return undefined }
    })()
    const MarkdownText = primitives && typeof primitives.MarkdownText === 'function' ? primitives.MarkdownText : undefined
    const NS = 'dshSuperAgent'
    const PANEL_ID = 'superagent'
    const API = '/superagent/api'
    const REQUEST_HEADER = { 'x-superagent-request': '1' }
    const SELECTED_KEY = 'dsh-super-agent:selected'
    const STOCK_CHAT_KEY = 'dsh-super-agent:stock-chat'
    const RAIL_VISIBLE_KEY = 'dsh-super-agent:rail'
    const RAIL_SECTION_KEYS = {
      conversations: 'dsh-super-agent:rail:conversations',
      pending: 'dsh-super-agent:rail:pending',
    }
    const TAG_FILTER_KEY = 'dsh-super-agent:tag-filter'
    const MAX_WORKER_TAGS = 8
    const MAX_TAG_CHARS = 24
    const TAG_FILTER_LIMIT = 32
    const TAG_HUES = [358, 12, 26, 40, 52, 68, 84, 100, 118, 136, 152, 168, 184, 198, 212, 226, 240, 254, 268, 282, 296, 310, 324, 340]
    const PENDING_ANSWER_DISMISS_MS = 1800
    const SURFACE_STOCK = 'stock'
    const SURFACE_CUSTOM = 'custom'

    /** Locale dictionaries; every visible string lives here. */
    const DICT = {
      zh: {
        title: 'Super Agent',
        subtitle: '把任务分发给持久的工作会话，并在这里跟踪进度。',
        conversations: '对话',
        pending: '待决策项',
        pendingEmpty: '没有待决策的问题。',
        pendingAnswerLabel: '回答',
        pendingPlaceholder: '输入你的回答，或选择上方选项…',
        pendingSubmit: '提交回答',
        pendingSubmitting: '提交中…',
        pendingAnswered: '已回答',
        pendingAnswerRequired: '请选择选项或输入回答。',
        pendingSubmitFailed: '提交回答失败',
        pendingCardHint: '回答会作为用户消息发送给 Super Agent。',
        pendingOptions: '{count} 个选项',
        pendingOpen: '打开待决策项',
        pendingDismiss: '关闭回答卡片',
        expandConversations: '展开对话列表',
        collapseConversations: '折叠对话列表',
        expandPending: '展开待决策项',
        collapsePending: '折叠待决策项',
        superConversations: 'Super Agent 对话',
        workers: '工作会话',
        otherWorkers: '其他工作会话',
        newConversation: '新建对话',
        newConversationTitle: '新建 Super Agent 对话',
        conversationTitle: '对话标题',
        workspace: 'Workspace',
        newWorkspace: '新建 workspace',
        workspacePath: '目录路径（留空则在状态目录下创建）',
        create: '创建',
        cancel: '取消',
        close: '关闭',
        send: '发送',
        sending: '发送中…',
        stop: '停止',
        stopped: '已停止',
        placeholder: '告诉 Super Agent 你想完成什么；它会决定是否分发给 worker…',
        workerPlaceholder: '这是 worker 对话；请回到 Super Agent 分派后续工作。',
        emptyTitle: '开始与 Super Agent 对话',
        emptyBody: '描述目标、期望结果和可用的 workspace。Super Agent 会创建 worker 并持续汇报进度。',
        emptyHistory: '还没有对话。',
        loading: '加载中…',
        loadFailed: '无法连接 Super Agent 插件。',
        retry: '重试',
        openInDsh: '在 DSH 中打开',
        openFull: '打开完整对话',
        backToSuper: '返回 Super Agent',
        workerBanner: '这是一个由 Super Agent 创建的 worker 对话。你可以查看完整过程；后续指令由 Super Agent 发送。',
        parent: '上级',
        noParent: '没有上级对话',
        justNow: '刚刚',
        minutesAgo: '{count} 分钟前',
        hoursAgo: '{count} 小时前',
        daysAgo: '{count} 天前',
        statusRunning: '运行中',
        statusDispatching: '启动中',
        statusWaiting: '空闲',
        statusNeedsInput: '等待回复',
        statusFailed: '失败',
        statusStopped: '已停止',
        statusPaused: '已暂停',
        statusIdle: '空闲',
        agent: 'Super Agent',
        worker: 'Worker',
        you: '你',
        progress: '进度',
        result: '结果',
        toolCall: '工具调用',
        toolResult: '工具结果',
        stoppedTurn: '本轮已停止',
        failedTurn: '本轮失败',
        interrupted: '已中断',
        showHistory: '显示历史',
        hideHistory: '隐藏历史',
        refresh: '刷新',
        createFailed: '创建失败',
        sendFailed: '发送失败',
        openFailed: '无法打开该对话',
        untitled: '未命名',
        workspaceFallback: 'workspace',
        workerCount: '{count} 个 worker',
        workerRunningCount: '{count} 个运行中',
        workerTags: '标签',
        tagPlaceholder: '添加标签…',
        addTag: '添加',
        removeTag: '移除标签',
        tagLimit: '每个 worker 最多 {count} 个标签',
        tagSaveFailed: '标签保存失败',
        tagFilter: '按标签筛选',
        tagFilterActive: '{count} 个筛选',
        tagFilterClear: '清除标签筛选',
        tagFilterHint: '显示带有任一选中标签的 worker（any 语义）。',
        tagFilterWorkers: '{shown}/{total} 个 worker',
        noWorkersWithTags: '没有带有这些标签的 worker。',
        tagsEmpty: '还没有标签',
        turnTagLegend: '轮次颜色',
        turnTagsTitle: '第 {turn} 轮 · {tags}',
        copy: '复制',
        copied: '已复制',
        codeBlock: '代码',
        wrap: '自动换行',
        unwrap: '不换行',
        footnotes: '脚注',
        workersRunning: '{count} 个 worker 运行中',
        noWorkersRunning: '没有运行中的 worker',
        balance: '余额',
        balanceTitle: '账户余额',
        usagePanelTitle: '余额与用量',
        spendTitle: '滚动 24h（本地计算）',
        last24h: '24h',
        apiKey: 'API 密钥',
        account: '账户',
        unknownProvider: '未知路由',
        inputTokens: '输入',
        outputTokens: '输出',
        cacheReadTokens: '缓存读',
        cacheWriteTokens: '缓存写',
        usageRequests: '{count} 次请求',
        usageLastRequest: '最近一次',
        usageNote: '金额来自 DeepSeek Platform 的私有页面用量接口（未文档化，可能随时变动），按界面时区取“今日”日历日桶；token 来自本地会话日志，是精确的滚动 24 小时汇总。两者窗口不同，不能相加或互相换算；平台没有公开的按密钥计费 API。',
        today: '今日',
        platformDayLabel: '今日（Platform 日，含时区）',
        platformPrivateTag: '私有/未文档化',
        apiKeysTitle: 'API 密钥 · 今日（Platform 日，含时区）',
        platformSpendTitle: '今日消费（Platform 日，含时区；私有接口）',
        rollingLabel: '滚动 24h（本地计算）',
        localTag: '本地',
        differentWindows: '金额与 token 是不同窗口，不能相加或互相换算。',
        platformDisabled: '已通过配置禁用 Platform 私有接口，仅显示本地 token',
        platformUnavailable: 'Platform 私有用量接口不可用，仅显示本地滚动 24h token',
        platformSignedOut: '登录 DeepSeek 后可显示每个密钥的今日消费',
        noPlatformSpend: '今日没有消费记录',
        keyFallback: '密钥 {id}',
        balanceSignedOut: '登录 DeepSeek 后显示余额',
        balanceUnavailable: '无法读取余额',
        usageUnavailable: '无法读取本地用量',
        usagePartial: '部分会话日志不可读，token 为下限',
        noUsage: '最近 24 小时没有模型调用',
        usageRefresh: '刷新用量',
        usageUpdated: '更新于',
        bonusBalance: '赠送余额',
      },
      en: {
        title: 'Super Agent',
        subtitle: 'Delegate work to persistent worker conversations and follow their progress here.',
        conversations: 'Conversations',
        pending: 'Pending decisions',
        pendingEmpty: 'No pending decisions.',
        pendingAnswerLabel: 'Answer',
        pendingPlaceholder: 'Type your answer, or choose an option above…',
        pendingSubmit: 'Submit answer',
        pendingSubmitting: 'Submitting…',
        pendingAnswered: 'Answered',
        pendingAnswerRequired: 'Choose an option or enter an answer.',
        pendingSubmitFailed: 'Could not submit the answer',
        pendingCardHint: 'Your answer is sent to the Super Agent as a user message.',
        pendingOptions: '{count} options',
        pendingOpen: 'Open pending decision',
        pendingDismiss: 'Dismiss answer card',
        expandConversations: 'Expand conversations',
        collapseConversations: 'Collapse conversations',
        expandPending: 'Expand pending decisions',
        collapsePending: 'Collapse pending decisions',
        superConversations: 'Super Agent conversations',
        workers: 'Workers',
        otherWorkers: 'Other workers',
        newConversation: 'New conversation',
        newConversationTitle: 'New Super Agent conversation',
        conversationTitle: 'Conversation title',
        workspace: 'Workspace',
        newWorkspace: 'New workspace',
        workspacePath: 'Directory path (blank uses the state directory)',
        create: 'Create',
        cancel: 'Cancel',
        close: 'Close',
        send: 'Send',
        sending: 'Sending…',
        stop: 'Stop',
        stopped: 'Stopped',
        placeholder: 'Tell the Super Agent what you want done; it decides what to delegate…',
        workerPlaceholder: 'This is a worker conversation. Return to the Super Agent to assign follow-up work.',
        emptyTitle: 'Start a conversation with the Super Agent',
        emptyBody: 'Describe the goal, the expected result, and the workspace to use. The Super Agent creates workers and keeps reporting progress.',
        emptyHistory: 'No conversations yet.',
        loading: 'Loading…',
        loadFailed: 'Could not reach the Super Agent plugin.',
        retry: 'Retry',
        openInDsh: 'Open in DSH',
        openFull: 'Open full conversation',
        backToSuper: 'Back to Super Agent',
        workerBanner: 'This worker conversation was created by the Super Agent. You can inspect the full run; follow-up instructions are sent by the Super Agent.',
        parent: 'Parent',
        noParent: 'No parent conversation',
        justNow: 'just now',
        minutesAgo: '{count}m ago',
        hoursAgo: '{count}h ago',
        daysAgo: '{count}d ago',
        statusRunning: 'Running',
        statusDispatching: 'Starting',
        statusWaiting: 'Idle',
        statusNeedsInput: 'Needs reply',
        statusFailed: 'Failed',
        statusStopped: 'Stopped',
        statusPaused: 'Paused',
        statusIdle: 'Idle',
        agent: 'Super Agent',
        worker: 'Worker',
        you: 'You',
        progress: 'Progress',
        result: 'Result',
        toolCall: 'Tool call',
        toolResult: 'Tool result',
        stoppedTurn: 'Turn stopped',
        failedTurn: 'Turn failed',
        interrupted: 'interrupted',
        showHistory: 'Show history',
        hideHistory: 'Hide history',
        refresh: 'Refresh',
        createFailed: 'Could not create the conversation',
        sendFailed: 'Could not send the message',
        openFailed: 'Could not open that conversation',
        untitled: 'Untitled',
        workspaceFallback: 'workspace',
        workerCount: '{count} workers',
        workerRunningCount: '{count} running',
        workerTags: 'Tags',
        tagPlaceholder: 'Add tag…',
        addTag: 'Add',
        removeTag: 'Remove tag',
        tagLimit: 'At most {count} tags per worker',
        tagSaveFailed: 'Could not save the tags',
        tagFilter: 'Filter by tag',
        tagFilterActive: '{count} filters',
        tagFilterClear: 'Clear tag filters',
        tagFilterHint: 'Showing workers with any of the selected tags (any semantics).',
        tagFilterWorkers: '{shown}/{total} workers',
        noWorkersWithTags: 'No workers with these tags.',
        tagsEmpty: 'No tags yet',
        turnTagLegend: 'Turn colours',
        turnTagsTitle: 'Turn {turn} · {tags}',
        copy: 'Copy',
        copied: 'Copied',
        codeBlock: 'Code',
        wrap: 'Wrap',
        unwrap: 'Unwrap',
        footnotes: 'Footnotes',
        workersRunning: '{count} workers running',
        noWorkersRunning: 'No workers running',
        balance: 'Balance',
        balanceTitle: 'Account balance',
        usagePanelTitle: 'Balance & usage',
        spendTitle: 'Rolling 24h (local)',
        last24h: '24h',
        apiKey: 'API key',
        account: 'Account',
        unknownProvider: 'Unknown route',
        inputTokens: 'in',
        outputTokens: 'out',
        cacheReadTokens: 'cache read',
        cacheWriteTokens: 'cache write',
        usageRequests: '{count} requests',
        usageLastRequest: 'last',
        usageNote: 'Money comes from DeepSeek Platform’s private, undocumented dashboard usage endpoint and is the “today” calendar-day bucket in the UI timezone; it may change at any time. Tokens come from local Session logs and are an exact rolling 24-hour sum. The windows differ and cannot be added or converted; the platform exposes no documented per-key billing API.',
        today: 'Today',
        platformDayLabel: 'Today (Platform day, tz-aware)',
        platformPrivateTag: 'private/undocumented',
        apiKeysTitle: 'API keys · Today (Platform day, tz-aware)',
        platformSpendTitle: 'Today spend (Platform day, tz-aware; private endpoint)',
        rollingLabel: 'Rolling 24h (local)',
        localTag: 'local',
        differentWindows: 'Money and tokens cover different windows; they cannot be added or converted into each other.',
        platformDisabled: 'Platform private endpoint disabled by configuration; showing local tokens only',
        platformUnavailable: 'Platform private usage unavailable; showing local rolling-24h tokens only',
        platformSignedOut: 'Sign in to DeepSeek to show per-key spend today',
        noPlatformSpend: 'No spend recorded today',
        keyFallback: 'Key {id}',
        balanceSignedOut: 'Sign in to DeepSeek to see the balance',
        balanceUnavailable: 'Balance unavailable',
        usageUnavailable: 'Local usage unavailable',
        usagePartial: 'Some Session logs were unreadable; token totals are a lower bound',
        noUsage: 'No model calls in the last 24 hours',
        usageRefresh: 'Refresh usage',
        usageUpdated: 'Updated',
        bonusBalance: 'Bonus',
      },
    }

    const CSS = `
.sa-root { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 14px; }
.sa-top { display: flex; align-items: center; gap: 12px; padding: 12px 18px; border-bottom: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); flex: 0 0 auto; }
.sa-brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.sa-brand-mark { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px;
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); flex: 0 0 auto; }
.sa-brand-text { min-width: 0; }
.sa-title { display: flex; align-items: baseline; gap: 7px; min-width: 0; font-size: 14px; font-weight: 650; letter-spacing: .01em; white-space: nowrap; }
.sa-title-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sa-title-counts { flex: 0 0 auto; display: inline-flex; align-items: baseline; gap: 4px; color: var(--dsw-alias-label-secondary);
  font-size: 11.5px; font-weight: 500; font-variant-numeric: tabular-nums; letter-spacing: 0; }
.sa-title-count { font-variant-numeric: tabular-nums; }
.sa-title-sep { color: var(--dsw-alias-label-caption); }
.sa-subtitle { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-top-meta { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }
.sa-usage { position: relative; display: inline-flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.sa-usage-chip { font: inherit; font-size: 12px; cursor: pointer; }
.sa-usage-chip .sa-usage-amount { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-usage-balance .sa-usage-amount { min-width: 42px; text-align: right; }
.sa-usage-spend .sa-usage-amount { min-width: 30px; text-align: right; }
.sa-usage-chip.spend { gap: 5px; }
.sa-usage-chip.spend .sa-usage-window { color: var(--dsw-alias-label-caption); font-size: 10.5px; letter-spacing: .02em; text-transform: uppercase; }
.sa-usage-chip .sa-usage-caret { color: var(--dsw-alias-label-caption); margin-left: 1px; }
.sa-usage-chip[aria-expanded="true"] { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 36%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-2)); }
.sa-usage-pop { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: min(326px, 88vw);
  max-height: min(70vh, 520px); overflow-y: auto;
  border: 1px solid var(--dsw-alias-border-l1); border-radius: 12px; background: var(--dsw-alias-bg-overlay);
  box-shadow: 0 16px 44px color-mix(in srgb, #000 24%, transparent); padding: 11px 12px; text-align: left; }
.sa-usage-pop-head { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.sa-usage-pop-title { font-size: 12px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.sa-usage-pop-time { margin-left: auto; font-size: 10.5px; color: var(--dsw-alias-label-caption); white-space: nowrap; }
.sa-usage-refresh { display: inline-grid; place-items: center; width: 22px; height: 22px; border-radius: 6px;
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sa-usage-refresh:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sa-usage-section { border-top: 1px solid var(--dsw-alias-border-l1); padding-top: 8px; margin-top: 8px; }
.sa-usage-pop-head + .sa-usage-section { border-top: 0; padding-top: 0; margin-top: 0; }
.sa-usage-section-title { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-caption); margin-bottom: 5px; }
.sa-usage-tag { margin-left: 6px; padding: 0 5px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  font-size: 9.5px; font-weight: 500; letter-spacing: 0; text-transform: none; color: var(--dsw-alias-label-secondary); }
.sa-usage-window-note { margin: 2px 0 8px; font-size: 10.5px; line-height: 1.45; color: var(--dsw-alias-label-caption); }
.sa-usage-wallet { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; padding: 3px 0;
  font-size: 12.5px; color: var(--dsw-alias-label-secondary); }
.sa-usage-wallet strong { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.sa-usage-key { display: flex; flex-direction: column; gap: 2px; padding: 6px 0; border-top: 1px dashed var(--dsw-alias-border-l1); }
.sa-usage-key:first-of-type { border-top: 0; }
.sa-usage-key-head { display: flex; align-items: baseline; gap: 8px; }
.sa-usage-key-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: 12.5px; color: var(--dsw-alias-label-primary); }
.sa-usage-key-kind { flex: 0 0 auto; font-size: 10.5px; color: var(--dsw-alias-label-caption); }
.sa-usage-key-total { margin-left: auto; flex: 0 0 auto; font-size: 12.5px; font-weight: 600;
  color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.sa-usage-key-detail { font-size: 10.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.sa-usage-empty { padding: 3px 0 2px; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.45; }
.sa-usage-note { margin-top: 9px; padding-top: 8px; border-top: 1px solid var(--dsw-alias-border-l1);
  font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-caption); }
.sa-chip { display: inline-flex; align-items: center; gap: 6px; max-width: 240px; padding: 4px 9px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-2);
  font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-chip strong { color: var(--dsw-alias-label-primary); font-weight: 560; }
.sa-button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 11px;
  border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; cursor: pointer; white-space: nowrap; }
.sa-button:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-button:disabled { opacity: .55; cursor: default; }
.sa-button.primary { background: var(--dsw-alias-brand-primary); border-color: transparent; color: #fff; }
.sa-button.primary:hover { filter: brightness(1.05); }
.sa-button.ghost { border-color: transparent; background: transparent; }
.sa-button.ghost:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-icon-button { display: inline-grid; place-items: center; width: 32px; height: 32px; border-radius: 8px;
  border: 1px solid transparent; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.sa-icon-button:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.sa-body { display: flex; flex: 1 1 auto; min-height: 0; }
.sa-main { display: flex; flex-direction: column; flex: 1 1 auto; min-width: 0; min-height: 0; }
.sa-chat { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 22px 26px 10px; }
.sa-stock { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.sa-stock-progress { display: flex; align-items: center; gap: 8px; flex: 0 0 auto; padding: 7px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 12px; }
.sa-stock-progress .sa-dot { margin-top: 0; }
.sa-stock-progress .sa-stock-progress-sep { color: var(--dsw-alias-label-caption); }
.sa-stock-progress .sa-stock-progress-text { min-width: 0; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; color: var(--dsw-alias-label-primary); }
.sa-stock-surface { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow: hidden; }
.sa-stock-surface > [data-slot] { min-height: 0; }
.sa-stock-surface > [data-slot] > * { flex: 1 1 auto; min-height: 0; }
.sa-thread { width: 100%; max-width: 840px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
.sa-row { display: flex; flex-direction: column; gap: 5px; }
.sa-row.user { align-items: flex-end; }
.sa-row.assistant { align-items: flex-start; }
.sa-row-label { font-size: 11px; color: var(--dsw-alias-label-secondary); padding: 0 4px; }
.sa-bubble { max-width: min(100%, 700px); border-radius: 14px; padding: 10px 14px; line-height: 1.55; }
.sa-row.user .sa-bubble { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, var(--dsw-alias-bg-layer-1));
  border: 1px solid color-mix(in srgb, var(--dsw-alias-brand-primary) 22%, transparent); border-bottom-right-radius: 5px; }
.sa-row.assistant .sa-bubble { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1);
  border-bottom-left-radius: 5px; }
.sa-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.sa-markdown { white-space: normal; }
.sa-markdown > :first-child { margin-top: 0; }
.sa-markdown > :last-child { margin-bottom: 0; }
.sa-markdown :where(pre, table) { max-width: 100%; }
.sa-notice .sa-notice-text.sa-markdown { white-space: normal; }
.sa-code { margin: 8px 0 0; padding: 10px 12px; border-radius: 9px; overflow-x: auto; background: color-mix(in srgb, #000 8%, var(--dsw-alias-bg-layer-2));
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.5; }
.sa-notice { display: flex; gap: 9px; align-items: flex-start; width: 100%; max-width: 780px; margin: 0 auto;
  padding: 9px 12px; border-radius: 10px; border: 1px dashed var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 12.5px; }
.sa-notice .sa-notice-mark { flex: 0 0 auto; color: var(--dsw-alias-brand-primary); margin-top: 1px; }
.sa-notice .sa-notice-body { min-width: 0; }
.sa-notice .sa-notice-summary { color: var(--dsw-alias-label-primary); font-weight: 560; }
.sa-notice .sa-notice-text { margin-top: 2px; white-space: pre-wrap; overflow-wrap: anywhere; }
.sa-tool { width: 100%; max-width: 780px; margin: 0 auto; border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 9px; background: var(--dsw-alias-bg-layer-1); padding: 7px 10px; font-size: 12px;
  display: flex; align-items: flex-start; gap: 8px; color: var(--dsw-alias-label-secondary); }
.sa-tool .sa-tool-name { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.sa-tool .sa-tool-detail { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-tool.done { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, var(--dsw-alias-border-l1)); }
.sa-tool.error { border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, var(--dsw-alias-border-l1)); }
.sa-tool-details { margin-top: 3px; }
.sa-tool-details summary { cursor: pointer; color: var(--dsw-alias-label-secondary); font-size: 11.5px; user-select: none; }
.sa-tool-code { margin: 5px 0 0; padding: 7px 8px; max-height: 260px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; line-height: 1.45; }
.sa-error-row { width: 100%; max-width: 780px; margin: 0 auto; padding: 8px 12px; border-radius: 9px;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, var(--dsw-alias-bg-layer-1));
  color: var(--dsw-alias-state-error-primary); font-size: 12.5px; white-space: pre-wrap; }
.sa-typing { display: inline-flex; align-items: center; gap: 7px; color: var(--dsw-alias-label-secondary); font-size: 12px; padding: 2px 4px; }
.sa-typing i { width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-brand-primary); animation: sa-blink 1.1s infinite; }
.sa-typing i:nth-child(2) { animation-delay: .18s; }
.sa-typing i:nth-child(3) { animation-delay: .36s; }
@keyframes sa-blink { 0%, 80%, 100% { opacity: .25; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-2px); } }
.sa-empty { flex: 1 1 auto; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 32px; text-align: center; }
.sa-empty h2 { margin: 0; font-size: 20px; }
.sa-empty p { margin: 0; max-width: 520px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.sa-composer { flex: 0 0 auto; padding: 10px 26px 16px; }
.sa-composer-inner { max-width: 840px; margin: 0 auto; border: 1px solid var(--dsw-alias-border-l2); border-radius: 14px;
  background: var(--dsw-alias-bg-layer-1); padding: 9px 10px 9px 14px; display: flex; align-items: flex-end; gap: 10px;
  box-shadow: 0 2px 10px color-mix(in srgb, #000 7%, transparent); }
.sa-composer textarea { flex: 1 1 auto; min-height: 26px; max-height: 180px; resize: none; border: 0; outline: 0;
  background: transparent; color: var(--dsw-alias-label-primary); font: inherit; line-height: 1.55; padding: 5px 0; }
.sa-composer textarea::placeholder { color: var(--dsw-alias-label-secondary); }
.sa-composer-actions { display: flex; align-items: center; gap: 6px; flex: 0 0 auto; }
.sa-composer-hint { max-width: 840px; margin: 6px auto 0; color: var(--dsw-alias-label-secondary); font-size: 11px; display: flex; gap: 10px; }
.sa-composer-error { max-width: 840px; margin: 6px auto 0; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.sa-worker-banner { max-width: 840px; margin: 0 auto; width: 100%; display: flex; gap: 12px; align-items: center;
  border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); border-radius: 12px; padding: 11px 13px; }
.sa-worker-banner p { margin: 0; flex: 1 1 auto; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.5; }
.sa-rail { flex: 0 0 304px; width: 304px; min-height: 0; display: flex; flex-direction: column;
  border-left: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.sa-rail-head { display: flex; align-items: center; gap: 8px; padding: 12px 13px 9px; }
.sa-rail-title { font-size: 12px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.sa-rail-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sa-rail-sections { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; }
.sa-rail-section { display: flex; flex-direction: column; min-height: 0; }
.sa-rail-section.conversations { flex: 1 1 auto; }
.sa-rail-section.pending { flex: 0 1 auto; max-height: 46%; border-top: 1px solid var(--dsw-alias-border-l1); }
.sa-rail-section.pending.expanded { flex: 0 1 46%; }
.sa-rail-section.collapsed { flex: 0 0 auto; max-height: none; }
.sa-rail-section-head { display: flex; align-items: center; gap: 7px; width: 100%; padding: 9px 12px 7px;
  border: 0; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; cursor: pointer; text-align: left; }
.sa-rail-section-head:hover { color: var(--dsw-alias-label-primary); }
.sa-rail-section-title { font-size: 12px; font-weight: 650; letter-spacing: .03em; text-transform: uppercase;
  color: var(--dsw-alias-label-secondary); }
.sa-rail-section-count { font-size: 11px; color: var(--dsw-alias-label-secondary); }
.sa-rail-section-head .sa-rail-chevron { flex: 0 0 auto; color: var(--dsw-alias-label-caption);
  transition: transform .15s ease; transform: rotate(0deg); }
.sa-rail-section.collapsed .sa-rail-section-head .sa-rail-chevron { transform: rotate(-90deg); }
.sa-rail-section-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; }
.sa-group { margin-top: 7px; }
.sa-group-head { display: flex; align-items: center; gap: 7px; padding: 7px 7px 6px; border-radius: 8px;
  color: var(--dsw-alias-label-secondary); font-size: 11px; font-weight: 650; }
.sa-item { width: 100%; display: flex; align-items: flex-start; gap: 8px; text-align: left; border: 1px solid transparent;
  background: transparent; border-radius: 9px; padding: 8px 8px; cursor: pointer; color: inherit; font: inherit; }
.sa-item:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-item.selected { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-2));
  border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 24%, transparent); }
.sa-item.worker { padding-left: 20px; }
.sa-dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; margin-top: 6px; background: var(--dsw-alias-state-idle-primary); }
.sa-dot.running { background: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
.sa-dot.waiting, .sa-dot.idle { background: var(--dsw-alias-state-idle-primary); }
.sa-dot.needs_input { background: var(--dsw-alias-state-warn-primary); }
.sa-dot.failed { background: var(--dsw-alias-state-error-primary); }
.sa-dot.stopped, .sa-dot.paused { background: var(--dsw-alias-label-secondary); }
.sa-item-main { min-width: 0; flex: 1 1 auto; }
.sa-item-title { display: flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 560;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-item-meta { margin-top: 2px; display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary);
  font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-item-message { margin-top: 2px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; line-height: 1.35;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.sa-badge { flex: 0 0 auto; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1);
  color: var(--dsw-alias-label-secondary); }
.sa-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 35%, transparent); }
.sa-badge.error { color: var(--dsw-alias-state-error-primary); border-color: color-mix(in srgb, var(--dsw-alias-state-error-primary) 35%, transparent); }
.sa-rail-empty { padding: 22px 14px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; text-align: center; line-height: 1.6; }
.sa-pending-mark { flex: 0 0 auto; display: grid; place-items: center; width: 17px; height: 17px; margin-top: 2px;
  border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 16%, transparent);
  color: var(--dsw-alias-state-warn-primary); font-size: 10.5px; font-weight: 700; }
.sa-pending-item .sa-item-message { -webkit-line-clamp: 2; }
.sa-pending-inline { flex: 0 0 auto; padding: 10px 26px 0; }
.sa-pending-card { width: 100%; max-width: 840px; max-height: 46vh; overflow-y: auto; margin: 0 auto;
  border: 1px solid color-mix(in srgb, var(--dsw-alias-state-warn-primary) 32%, var(--dsw-alias-border-l1));
  border-radius: 12px; background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 5%, var(--dsw-alias-bg-layer-1));
  padding: 12px 14px; font-size: 13px; }
.sa-pending-card.answered { border-color: color-mix(in srgb, var(--dsw-alias-state-success-primary) 32%, var(--dsw-alias-border-l1));
  background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 5%, var(--dsw-alias-bg-layer-1)); }
.sa-pending-card-head { display: flex; align-items: center; gap: 8px; margin-bottom: 7px; }
.sa-pending-card-label { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-state-warn-primary); }
.sa-pending-card.answered .sa-pending-card-label { color: var(--dsw-alias-state-success-primary); }
.sa-pending-card-check { color: var(--dsw-alias-state-success-primary); font-weight: 700; }
.sa-pending-card-close { margin-left: auto; }
.sa-pending-question { font-size: 14px; font-weight: 600; line-height: 1.5; overflow-wrap: anywhere; }
.sa-pending-context { margin-top: 6px; color: var(--dsw-alias-label-secondary); font-size: 12.5px; line-height: 1.55; }
.sa-pending-options { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 2px; }
.sa-pending-option { max-width: 100%; padding: 6px 10px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px;
  line-height: 1.4; text-align: left; cursor: pointer; overflow-wrap: anywhere; }
.sa-pending-option:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-pending-option.selected { border-color: color-mix(in srgb, var(--dsw-alias-brand-primary) 55%, transparent);
  background: color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, var(--dsw-alias-bg-layer-1)); }
.sa-pending-free { margin-top: 9px; }
.sa-pending-free textarea { width: 100%; min-height: 54px; max-height: 150px; resize: vertical; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; outline: none; padding: 8px 10px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 12.5px; line-height: 1.5; }
.sa-pending-free textarea:focus { border-color: var(--dsw-alias-brand-primary); }
.sa-pending-actions { display: flex; align-items: center; gap: 9px; margin-top: 8px; }
.sa-pending-hint { color: var(--dsw-alias-label-caption); font-size: 11px; line-height: 1.4; }
.sa-pending-error { margin-top: 7px; color: var(--dsw-alias-state-error-primary); font-size: 12px; }
.sa-pending-answer { margin-top: 8px; }
.sa-pending-answer-label { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase;
  color: var(--dsw-alias-label-caption); margin-bottom: 3px; }
.sa-pending-answer-text { white-space: pre-wrap; overflow-wrap: anywhere; color: var(--dsw-alias-label-primary); }
.sa-tag-chip { --sa-tag-hue: 210; display: inline-flex; align-items: center; gap: 4px; max-width: 170px; padding: 1px 6px;
  border-radius: 999px; border: 1px solid hsl(var(--sa-tag-hue) 58% 50% / .34);
  background: hsl(var(--sa-tag-hue) 62% 50% / .10); color: var(--dsw-alias-label-secondary);
  font-size: 10.5px; line-height: 1.65; white-space: nowrap; }
.sa-tag-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.sa-tag-swatch { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; background: hsl(var(--sa-tag-hue) 68% 48%);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--dsw-alias-bg-base) 55%, transparent); }
.sa-tag-remove { flex: 0 0 auto; display: inline-grid; place-items: center; width: 13px; height: 13px; padding: 0; border: 0;
  border-radius: 50%; background: transparent; color: var(--dsw-alias-label-caption); font: inherit; font-size: 12px;
  line-height: 1; cursor: pointer; }
.sa-tag-remove:hover { color: var(--dsw-alias-state-error-primary); background: var(--dsw-alias-bg-layer-2); }
.sa-worker-tags-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; flex: 0 0 auto; padding: 6px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 11.5px; }
.sa-tags-label { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }
.sa-tag-add { display: inline-flex; align-items: center; gap: 4px; }
.sa-tag-add input { width: 96px; height: 22px; padding: 0 7px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
  background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; outline: none; }
.sa-tag-add input:focus { border-color: var(--dsw-alias-brand-primary); }
.sa-tag-add button { height: 22px; padding: 0 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font: inherit; font-size: 11px; cursor: pointer; }
.sa-tag-add button:disabled { opacity: .5; cursor: default; }
.sa-tags-empty, .sa-tags-hint { color: var(--dsw-alias-label-caption); font-size: 10.5px; }
.sa-tags-error { color: var(--dsw-alias-state-error-primary); font-size: 10.5px; }
.sa-tag-filter { display: flex; flex-direction: column; gap: 5px; padding: 4px 7px 8px; margin: 0 0 4px;
  border-bottom: 1px dashed var(--dsw-alias-border-l1); }
.sa-tag-filter-head { display: flex; align-items: center; gap: 6px; }
.sa-tag-filter-title { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }
.sa-tag-filter-active { color: var(--dsw-alias-brand-primary); font-size: 10.5px; font-weight: 600; }
.sa-tag-filter-clear { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary);
  font: inherit; font-size: 10.5px; cursor: pointer; }
.sa-tag-filter-clear:hover { text-decoration: underline; }
.sa-tag-filter-chips { display: flex; flex-wrap: wrap; gap: 4px; max-height: 84px; overflow-y: auto; }
.sa-tag-filter-chip { --sa-tag-hue: 210; display: inline-flex; align-items: center; gap: 4px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary);
  font: inherit; font-size: 10.5px; line-height: 1.6; cursor: pointer; }
.sa-tag-filter-chip:hover { background: var(--dsw-alias-bg-layer-2); }
.sa-tag-filter-chip[aria-pressed="true"] { border-color: hsl(var(--sa-tag-hue) 58% 50% / .55);
  background: hsl(var(--sa-tag-hue) 62% 50% / .16); color: var(--dsw-alias-label-primary); }
.sa-tag-filter-count { color: var(--dsw-alias-label-caption); font-variant-numeric: tabular-nums; }
.sa-tag-filter-hint { color: var(--dsw-alias-label-caption); font-size: 10.5px; line-height: 1.45; }
.sa-tag-filter-empty { padding: 8px 7px 10px; color: var(--dsw-alias-label-secondary); font-size: 12px; line-height: 1.5; }
.sa-tag-filter-empty button { margin-top: 6px; }
.sa-item-tags { display: flex; flex-wrap: wrap; gap: 3px; margin-top: 3px; }
.sa-item-tags .sa-tag-chip { padding: 0 5px; font-size: 10px; line-height: 1.55; max-width: 120px; }
.sa-turn-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; flex: 0 0 auto; padding: 5px 18px;
  border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary); font-size: 11px; }
.sa-turn-legend-title { font-size: 10.5px; font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--dsw-alias-label-caption); }
.sa-turn-legend-clear { margin-left: auto; padding: 0; border: 0; background: transparent; color: var(--dsw-alias-brand-primary);
  font: inherit; font-size: 10.5px; cursor: pointer; }
.sa-turn-legend-clear:hover { text-decoration: underline; }
[data-sa-turn-tag="1"]::before { background: hsl(var(--sa-tag-primary-hue, 210) 68% 48%) !important; }
[data-sa-turn-tag="1"][data-sa-secondary="1"]::before {
  background: linear-gradient(90deg,
    hsl(var(--sa-tag-primary-hue, 210) 68% 48%) 0 70%,
    hsl(var(--sa-tag-secondary-hue, 210) 68% 48%) 70% 100%) !important; }
.sa-overlay { position: absolute; inset: 0; z-index: 20; background: color-mix(in srgb, #000 28%, transparent); display: flex;
  align-items: flex-start; justify-content: center; padding-top: 9vh; }
.sa-dialog { width: min(92%, 460px); border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-overlay); box-shadow: 0 18px 60px color-mix(in srgb, #000 30%, transparent); padding: 16px; }
.sa-dialog h3 { margin: 0 0 12px; font-size: 15px; }
.sa-field { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; }
.sa-field label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.sa-field input, .sa-field select { height: 34px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); font: inherit; padding: 0 9px; outline: none; }
.sa-field input:focus, .sa-field select:focus { border-color: var(--dsw-alias-brand-primary); }
.sa-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
.sa-error { color: var(--dsw-alias-state-error-primary); font-size: 12px; white-space: pre-wrap; }
.sa-hidden { display: none !important; }
.sa-rail-toggle { display: none; }
@media (max-width: 820px) {
  .sa-usage-spend { display: none; }
}
@media (max-width: 980px) {
  .sa-rail { position: absolute; right: 0; top: 0; bottom: 0; z-index: 10; box-shadow: -12px 0 36px color-mix(in srgb, #000 16%, transparent); }
  .sa-rail-toggle { display: inline-flex; }
}
@media (max-width: 820px) {
  .sa-pending-inline { padding: 8px 14px 0; }
  .sa-pending-card { max-height: 52vh; }
}
`

    // ---------------------------------------------------------------------
    // Pure presentation helpers
    // ---------------------------------------------------------------------

    /** Text blocks of a message-like value. */
    function textOfMessage(message) {
      const content = message && typeof message === 'object' && Array.isArray(message.content) ? message.content : []
      return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
        .trim()
    }

    /** Parse a tool-call argument string without throwing. */
    function parseToolArgs(value) {
      if (typeof value !== 'string' || value.length === 0) return {}
      try {
        const parsed = JSON.parse(value)
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
      } catch {
        return {}
      }
    }

    /** A one-line detail for a tool-call row. */
    function toolDetail(name, args) {
      const text = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
      if (name === 'superagent_dispatch_task') return [text(args.title), text(args.workspace)].filter(Boolean).join(' · ')
      if (name === 'superagent_send_message') return [text(args.worker_id), text(args.message)].filter(Boolean).join(' · ')
      if (name === 'superagent_report_progress') return text(args.summary)
      if (name === 'superagent_create_workspace' || name === 'superagent_create_conversation') return [text(args.title), text(args.path)].filter(Boolean).join(' · ')
      if (name === 'superagent_pending_decision') return [text(args.action), text(args.question) || text(args.id)].filter(Boolean).join(' · ')
      for (const key of ['command', 'path', 'query', 'pattern', 'title', 'description']) {
        if (text(args[key])) return text(args[key])
      }
      return ''
    }

    /** Turn durable session events into chat rows. */
    function transcriptRows(entries, t) {
      const rows = []
      const calls = new Map()
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.type !== 'event' || !entry.event) continue
        const event = entry.event
        if (event.type === 'user/message') {
          const message = event.data
          const source = message && message.source
          const text = textOfMessage(message)
          if (!text) continue
          if (source && source.kind === 'user') rows.push({ kind: 'user', text, time: event.time })
          else if (source && (source.kind === 'plugin' || source.kind === 'dsh-super-agent')) {
            rows.push({ kind: 'notice', text, summary: source.summary, tone: 'progress', time: event.time })
          }
          continue
        }
        if (event.type === 'assistant/message') {
          const text = textOfMessage(event.data && event.data.message)
          if (text) rows.push({ kind: 'assistant', text, time: event.time, interrupted: !!(event.data && event.data.interrupted) })
          continue
        }
        if (event.type === 'tool/call') {
          const data = event.data || {}
          const args = parseToolArgs(data.arguments)
          const row = {
            kind: 'tool',
            callId: data.callId,
            name: typeof data.name === 'string' ? data.name : 'tool',
            detail: toolDetail(data.name, args),
            status: 'running',
            time: event.time,
          }
          calls.set(data.callId, row)
          rows.push(row)
          continue
        }
        if (event.type === 'tool/result') {
          const data = event.data || {}
          const message = data.message
          const call = calls.get(message && message.toolCallId)
          if (call) {
            call.status = data.error || (message && message.isError) ? 'error' : 'done'
            const output = textOfMessage(message)
            if (output) call.output = output.length > 420 ? `${output.slice(0, 419)}…` : output
          }
          continue
        }
        if (event.type === 'turn/end') {
          const reason = event.data && event.data.reason
          if (reason && reason.kind === 'error') rows.push({ kind: 'error', text: (reason.error && reason.error.message) || (t ? t('failedTurn') : 'Turn failed'), time: event.time })
          else if (reason && reason.kind === 'aborted') rows.push({ kind: 'notice', text: '', summary: t ? t('stoppedTurn') : 'Turn stopped', tone: 'muted', time: event.time })
        }
      }
      return rows
    }

    /** Resolve a run of rows into the message shape the renderer expects. */
    function rowKey(row, index) {
      return `${row.kind}:${row.callId || ''}:${index}`
    }

    /** Last path segment, for compact workspace labels. */
    function basename(path) {
      const text = String(path || '').replace(/[\\/]+$/, '')
      const index = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
      return index >= 0 ? text.slice(index + 1) || text : text
    }

    /** Relative time, localized through the supplied translator. */
    function relativeTime(ms, t, now = Date.now()) {
      const delta = Math.max(0, now - (Number(ms) || 0))
      const minutes = Math.floor(delta / 60_000)
      if (minutes < 1) return t('justNow')
      if (minutes < 60) return t('minutesAgo', { count: minutes })
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return t('hoursAgo', { count: hours })
      return t('daysAgo', { count: Math.floor(hours / 24) })
    }

    /** Group workers under their Super Agent conversation. */
    /** Compact token count: 942, 12.3k, 4.5M. */
    function formatTokens(value) {
      const number = Number(value)
      if (!Number.isFinite(number) || number <= 0) return '0'
      if (number < 1_000) return String(Math.trunc(number))
      const units = [
        [999_950_000_000, 'T'],
        [999_950_000, 'B'],
        [999_950, 'M'],
        [1_000, 'k'],
      ]
      for (const [size, suffix] of units) {
        if (number >= size) {
          const scaled = number / size
          const decimals = scaled >= 100 ? 0 : 1
          return `${scaled.toFixed(decimals).replace(/\.0$/, '')}${suffix}`
        }
      }
      return String(Math.trunc(number))
    }

    /** One wallet as a currency amount; unknown currencies keep their code. */
    function formatWallet(wallet) {
      if (!wallet || typeof wallet !== 'object') return '—'
      const currency = typeof wallet.currency === 'string' ? wallet.currency.trim().toUpperCase() : ''
      const symbol = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : ''
      const number = Number(wallet.balance)
      const amount = Number.isFinite(number)
        ? number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : String(wallet.balance ?? '')
      if (symbol.length > 0) return `${symbol}${amount}`
      return `${currency} ${amount}`.trim()
    }

    /** A Platform calendar-day cost, in its reported currency. */
    function formatMoney(value, currency) {
      if (value === null || value === undefined || value === '') return '—'
      const number = Number(value)
      if (!Number.isFinite(number)) return '—'
      const code = typeof currency === 'string' ? currency.trim().toUpperCase() : ''
      const symbol = code === 'CNY' ? '¥' : code === 'USD' ? '$' : ''
      const amount = number.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      return symbol.length > 0 ? `${symbol}${amount}` : `${code} ${amount}`.trim()
    }

    /** Normalize the Platform per-key spend rows. */
    function platformRows(platform) {
      if (!platform || platform.status !== 'ready' || !Array.isArray(platform.keys)) return []
      return platform.keys
        .filter((key) => key && typeof key === 'object')
        .map((key) => ({
          id: typeof key.id === 'string' ? key.id : '',
          label: typeof key.label === 'string' ? key.label : typeof key.name === 'string' ? key.name : '',
          keyType: typeof key.keyType === 'string' ? key.keyType : '',
          currency: typeof key.currency === 'string' ? key.currency.trim().toUpperCase() : '',
          cost: Number(key.cost) || 0,
          models: Array.isArray(key.models) ? key.models.filter((model) => typeof model === 'string') : [],
        }))
        .sort((left, right) => right.cost - left.cost)
    }

    /** The largest Platform currency total, or a sum-by-currency fallback. */
    function platformTotal(platform) {
      if (!platform || platform.status !== 'ready') return undefined
      const totals = Array.isArray(platform.totals)
        ? platform.totals.filter((total) => total && typeof total.currency === 'string' && Number.isFinite(Number(total.cost)))
        : []
      if (totals.length > 0) {
        const largest = totals.slice().sort((left, right) => Number(right.cost) - Number(left.cost))[0]
        return { currency: largest.currency, cost: Number(largest.cost) }
      }
      const byCurrency = new Map()
      for (const row of platformRows(platform)) {
        byCurrency.set(row.currency, (byCurrency.get(row.currency) || 0) + row.cost)
      }
      const entries = [...byCurrency.entries()].filter(([currency]) => currency.length > 0).sort((left, right) => right[1] - left[1])
      return entries.length > 0 ? { currency: entries[0][0], cost: entries[0][1] } : undefined
    }

    /** Chip text for the account balance; a signed-out or failed read is an em dash. */
    function balanceText(balance) {
      if (!balance || balance.status !== 'ready') return '—'
      const wallets = Array.isArray(balance.wallets) ? balance.wallets : []
      if (wallets.length === 0) return '—'
      return wallets.slice(0, 2).map(formatWallet).join(' · ')
    }

    /** Total 24-hour tokens, tolerating a partial payload. */
    function totalUsageTokens(usage) {
      if (!usage || usage.status !== 'ready') return 0
      const direct = Number(usage.totalTokens)
      if (Number.isFinite(direct) && direct > 0) return direct
      const keys = Array.isArray(usage.keys) ? usage.keys : []
      return keys.reduce((sum, key) => sum + (Number(key && key.totalTokens) || 0), 0)
    }

    /** Normalize the usage rows the widget renders. */
    function usageKeyRows(usage) {
      if (!usage || usage.status !== 'ready' || !Array.isArray(usage.keys)) return []
      return usage.keys
        .filter((key) => key && typeof key === 'object')
        .map((key) => ({
          provider: typeof key.provider === 'string' && key.provider.length > 0 ? key.provider : 'unknown',
          providerName: typeof key.providerName === 'string' && key.providerName.length > 0 ? key.providerName : '',
          kind: key.kind === 'account' ? 'account' : 'api-key',
          requests: Number(key.requests) || 0,
          inputTokens: Number(key.inputTokens) || 0,
          outputTokens: Number(key.outputTokens) || 0,
          cacheReadTokens: Number(key.cacheReadTokens) || 0,
          cacheWriteTokens: Number(key.cacheWriteTokens) || 0,
          totalTokens: Number(key.totalTokens) || 0,
          lastAt: Number(key.lastAt) || 0,
          models: Array.isArray(key.models) ? key.models.filter((model) => typeof model === 'string') : [],
        }))
        .sort((left, right) => right.totalTokens - left.totalTokens)
    }

    /** One compact breakdown line for a usage row. */
    function usageBreakdown(row, t) {
      if (!row) return ''
      const parts = []
      if (row.inputTokens > 0) parts.push(`${t('inputTokens')} ${formatTokens(row.inputTokens)}`)
      if (row.outputTokens > 0) parts.push(`${t('outputTokens')} ${formatTokens(row.outputTokens)}`)
      if (row.cacheReadTokens > 0) parts.push(`${t('cacheReadTokens')} ${formatTokens(row.cacheReadTokens)}`)
      if (row.cacheWriteTokens > 0) parts.push(`${t('cacheWriteTokens')} ${formatTokens(row.cacheWriteTokens)}`)
      if (row.requests > 0) parts.push(t('usageRequests', { count: row.requests }))
      return parts.join(' · ')
    }


    /**
     * Trim, collapse, dedupe (case-insensitively), and bound a tag list.
     * The host applies the authoritative version; the client uses this for
     * immediate inline-edit feedback and to sanitize persisted filter state.
     */
    function normalizeTagList(value, { limit = MAX_WORKER_TAGS, maxLength = MAX_TAG_CHARS } = {}) {
      if (!Array.isArray(value)) return []
      const seen = new Set()
      const tags = []
      for (const entry of value) {
        if (typeof entry !== 'string') continue
        const tag = entry.trim().replace(/^#+/, '').replace(/\s+/g, ' ').slice(0, maxLength).trim()
        if (tag.length === 0) continue
        const key = tag.toLocaleLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        tags.push(tag)
        if (tags.length >= limit) break
      }
      return tags
    }

    /** FNV-1a over UTF-16 code units; stable across browsers and reloads. */
    function stableHash(value) {
      let hash = 2166136261
      const text = String(value || '')
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    /** Deterministic hue for one tag (24-entry palette). */
    function tagHue(tag) {
      return TAG_HUES[stableHash(tag) % TAG_HUES.length]
    }

    /** CSS custom properties the tag swatch/chip and turn marker read. */
    function tagStyle(tag) {
      return { '--sa-tag-hue': String(tagHue(tag)) }
    }

    /** Whether a worker status counts as in progress. Waiting/idle does not. */
    function isWorkerRunning(status) {
      return status === 'running' || status === 'dispatching'
    }

    /** Total and in-progress worker counts for the header. */
    function workerStats(workers) {
      const list = Array.isArray(workers) ? workers.filter((worker) => worker && typeof worker === 'object') : []
      const running = list.filter((worker) => worker.running === true || isWorkerRunning(worker.status)).length
      return { total: list.length, running, waiting: list.length - running }
    }

    /** The distinct tags across a conversation list, with worker counts. */
    function workerTagIndex(conversations) {
      const byTag = new Map()
      for (const worker of Array.isArray(conversations) ? conversations : []) {
        if (!worker || worker.kind !== 'worker') continue
        for (const tag of normalizeTagList(worker.tags)) {
          const key = tag.toLocaleLowerCase()
          const entry = byTag.get(key) || { tag, count: 0 }
          entry.count += 1
          byTag.set(key, entry)
        }
      }
      return [...byTag.values()].sort((left, right) => left.tag < right.tag ? -1 : left.tag > right.tag ? 1 : 0)
    }

    /** Workers whose tags contain any selected tag; an empty filter matches all. */
    function filterWorkers(workers, filterTags) {
      const selected = normalizeTagList(filterTags, { limit: TAG_FILTER_LIMIT })
      if (selected.length === 0) return Array.isArray(workers) ? workers.slice() : []
      const wanted = new Set(selected.map((tag) => tag.toLocaleLowerCase()))
      return (Array.isArray(workers) ? workers : []).filter((worker) => normalizeTagList(worker && worker.tags)
        .some((tag) => wanted.has(tag.toLocaleLowerCase())))
    }

    /**
     * Group workers under their Super Agent conversation. An active tag filter
     * keeps only matching workers (any-of semantics); Super Agent rows remain
     * so the hierarchy and selection stay navigable.
     */
    function groupConversations(conversations, filterTags = []) {
      const items = Array.isArray(conversations) ? conversations.slice() : []
      const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      const supers = items.filter((item) => item.kind === 'super').sort(byUpdated)
      const workers = filterWorkers(items.filter((item) => item.kind === 'worker'), filterTags)
      const known = new Set(supers.map((item) => item.id))
      const groups = supers.map((parent) => ({
        parent,
        workers: workers.filter((worker) => worker.parentId === parent.id).sort(byUpdated),
      }))
      const orphans = workers.filter((worker) => !known.has(worker.parentId)).sort(byUpdated)
      return { groups, orphans }
    }

    /** Status label key and tone. */
    function statusOf(status) {
      switch (status) {
        case 'running': return { label: 'statusRunning', tone: 'running' }
        case 'dispatching': return { label: 'statusDispatching', tone: 'running' }
        case 'waiting': return { label: 'statusWaiting', tone: 'waiting' }
        case 'needs_input': return { label: 'statusNeedsInput', tone: 'needs_input' }
        case 'failed': return { label: 'statusFailed', tone: 'failed' }
        case 'stopped': return { label: 'statusStopped', tone: 'stopped' }
        case 'paused': return { label: 'statusPaused', tone: 'paused' }
        default: return { label: 'statusIdle', tone: 'idle' }
      }
    }

    /** Localized chrome labels the stock Markdown primitive expects. */
    function markdownLabels(t) {
      return {
        code: {
          copyLabel: t('copy'),
          copiedLabel: t('copied'),
          toolbarLabels: {
            codeLabel: t('codeBlock'),
            wrapLabel: t('wrap'),
            unwrapLabel: t('unwrap'),
          },
        },
        footnotes: t('footnotes'),
      }
    }

    /** Safe plain-text fallback, used only when the stock renderer is missing. */
    function renderText(text) {
      const parts = []
      const source = String(text || '')
      const regex = /```([\w-]*)\n?([\s\S]*?)```/g
      let last = 0
      let match
      let index = 0
      while ((match = regex.exec(source)) !== null) {
        if (match.index > last) parts.push(h('span', { key: `t${index++}` }, source.slice(last, match.index)))
        parts.push(h('pre', { key: `c${index++}`, className: 'sa-code' }, match[2].replace(/\n$/, '')))
        last = match.index + match[0].length
      }
      if (last < source.length) parts.push(h('span', { key: `t${index++}` }, source.slice(last)))
      return parts.length > 0 ? parts : [source]
    }

    /**
     * Render model text through the stock Markdown primitive.
     *
     * The primitive parses to React nodes (never raw HTML), validates link
     * protocols, and owns code-block copy/wrap chrome. Model output remains
     * untrusted and is passed only as its `text` prop.
     */
    function renderMarkdown(t, text, options = {}) {
      const source = String(text || '')
      if (!MarkdownText) return renderText(source)
      return h(MarkdownText, {
        text: source,
        labels: markdownLabels(t),
        variant: options.variant === 'compact' ? 'compact' : 'body',
        streaming: false,
      })
    }

    /** Stock chat is on unless localStorage explicitly opts out. */
    function resolveStockChatFlag(value) {
      return value !== '0'
    }

    /** Read the reversible renderer flag; a missing storage API keeps the default. */
    function readStockChatFlag() {
      try { return resolveStockChatFlag(window.localStorage.getItem(STOCK_CHAT_KEY)) } catch { return true }
    }

    /**
     * Choose the center surface for the selected conversation.
     *
     * Stock is used only for a ready Super Agent Session with a retained
     * reference and the standard SessionProvider/renderSlot props. Workers and
     * every failure case stay on the custom read-only transcript.
     */
    function selectConversationSurface(options = {}) {
      if (options.flag === false) return SURFACE_CUSTOM
      if (options.status !== 'ready') return SURFACE_CUSTOM
      if (options.kind !== 'super') return SURFACE_CUSTOM
      if (options.sessionId === undefined || options.chatSessionId !== options.sessionId) return SURFACE_CUSTOM
      if (!options.reference) return SURFACE_CUSTOM
      if (typeof options.SessionProvider !== 'function') return SURFACE_CUSTOM
      if (typeof options.renderSlot !== 'function') return SURFACE_CUSTOM
      return SURFACE_STOCK
    }

    /** Compact worker activity for the strip above the stock conversation. */
    function workerActivity(conversations, parentId) {
      const workers = (conversations || []).filter((item) => item && item.kind === 'worker' && item.parentId === parentId)
      const active = workers.filter((item) => item.running === true || item.status === 'running' || item.status === 'dispatching')
      let latest
      for (const worker of workers) {
        for (const entry of worker.progress || []) {
          if (!entry || typeof entry !== 'object') continue
          if (!latest || (entry.at || 0) > (latest.at || 0)) latest = { ...entry, workerId: worker.id, title: worker.title }
        }
      }
      return { workers, active, latest }
    }

    /** Tools whose arguments name the worker a Super Agent turn is working on. */
    const WORKER_TOOL_NAMES = new Set([
      'superagent_send_message',
      'superagent_worker_output',
      'superagent_worker_tags',
      'superagent_stop_worker',
    ])

    /** The worker ids a Super Agent turn touched, in first-touch order. */
    function turnWorkerIds(entries, workers) {
      const list = (Array.isArray(workers) ? workers : []).filter((worker) => worker && typeof worker.id === 'string')
      const byId = new Set(list.map((worker) => worker.id))
      const byTitle = new Map()
      for (const worker of list) {
        const title = typeof worker.title === 'string' ? worker.title.trim() : ''
        if (!title) continue
        const ids = byTitle.get(title) || []
        ids.push(worker.id)
        byTitle.set(title, ids)
      }
      const calls = new Map()
      const owned = new Map()
      let currentTurn
      const associate = (turn, id) => {
        if (!Number.isInteger(turn) || typeof id !== 'string' || !byId.has(id)) return
        const ids = owned.get(turn) || []
        if (!ids.includes(id)) ids.push(id)
        owned.set(turn, ids)
      }
      const associateTitle = (turn, title) => {
        if (typeof title !== 'string') return
        for (const id of byTitle.get(title.trim()) || []) associate(turn, id)
      }
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!entry || entry.type !== 'event' || !entry.event) continue
        const event = entry.event
        const data = event.data && typeof event.data === 'object' ? event.data : {}
        if (event.type === 'turn/start') {
          if (Number.isInteger(data.turn)) currentTurn = data.turn
          continue
        }
        const turn = Number.isInteger(data.turn) ? data.turn : currentTurn
        if (event.type === 'tool/call') {
          const name = typeof data.name === 'string' ? data.name : ''
          const args = parseToolArgs(data.arguments)
          calls.set(data.callId, { name, args, turn })
          if (WORKER_TOOL_NAMES.has(name) && typeof args.worker_id === 'string') associate(turn, args.worker_id)
          // While a dispatch turn is still streaming, its result does not exist
          // yet; the task title already identifies an existing worker.
          if (name === 'superagent_dispatch_task' && typeof args.title === 'string') associateTitle(turn, args.title)
          continue
        }
        if (event.type === 'tool/result') {
          const message = data.message
          const call = calls.get((message && message.toolCallId) || data.toolCallId)
          if (call && call.name === 'superagent_dispatch_task') {
            const output = textOfMessage(message)
            if (output) {
              try {
                const parsed = JSON.parse(output)
                const id = parsed && (parsed.id || (parsed.worker && parsed.worker.id) || parsed.worker_id)
                if (typeof id === 'string') associate(call.turn, id)
              } catch { /* a failed dispatch keeps its title association */ }
            }
          }
          continue
        }
        if (event.type !== 'user/message') continue
        const source = data.source && typeof data.source === 'object' ? data.source : {}
        if (source.kind !== 'dsh-super-agent' && source.plugin !== 'dsh-super-agent') continue
        const text = textOfMessage(data)
        const summary = typeof source.summary === 'string' ? source.summary : ''
        const quoted = /Worker\s+"([^"]+)"/.exec(text)
        if (quoted) {
          associateTitle(turn, quoted[1])
          continue
        }
        // Titles are also the stable join key in notices such as
        // "Worker finished: <title>"; try the longest match first.
        const haystack = `${summary}\n${text}`
        for (const worker of list.slice().sort((left, right) => String(right.title || '').length - String(left.title || '').length)) {
          if (worker.title && haystack.includes(worker.title)) associate(turn, worker.id)
        }
      }
      return owned
    }

    /**
     * Per-turn tag ownership for the stock turn rail.
     *
     * A turn can touch several workers; the owning tag set is the ordered union
     * of their tags. The first tag is the primary marker colour and the first
     * different tag becomes the secondary stripe, so a multi-tag turn is never
     * reduced to one ambiguous colour.
     */
    function turnTagMap(entries, workers) {
      const list = (Array.isArray(workers) ? workers : []).filter((worker) => worker && typeof worker.id === 'string')
      const byId = new Map(list.map((worker) => [worker.id, normalizeTagList(worker.tags)]))
      const map = new Map()
      for (const [turn, ids] of turnWorkerIds(entries, list)) {
        const tags = []
        const seen = new Set()
        for (const id of ids) {
          for (const tag of byId.get(id) || []) {
            const key = tag.toLocaleLowerCase()
            if (seen.has(key)) continue
            seen.add(key)
            tags.push(tag)
          }
        }
        if (tags.length === 0) continue
        const primary = tags[0]
        const secondary = tags.find((tag) => tag.toLocaleLowerCase() !== primary.toLocaleLowerCase()) || ''
        map.set(turn, { turn, tags, primary, secondary })
      }
      return map
    }

    /** The first integer in a localized turn-navigation aria-label. */
    function turnFromLabel(label) {
      const match = /(\d+)/.exec(String(label || ''))
      return match ? Number(match[1]) : undefined
    }

    /** Attributes and CSS custom properties for one decorated rail marker. */
    function markerPresentation(info, t) {
      if (!info || typeof info.primary !== 'string' || info.primary.length === 0) return { attributes: {}, style: {} }
      const attributes = {
        'data-sa-turn-tag': '1',
        'data-sa-tags': info.tags.join(','),
        title: t ? t('turnTagsTitle', { turn: info.turn, tags: info.tags.join(', ') }) : `Turn ${info.turn} · ${info.tags.join(', ')}`,
      }
      if (info.secondary) attributes['data-sa-secondary'] = '1'
      return {
        attributes,
        style: {
          '--sa-tag-primary-hue': String(tagHue(info.primary)),
          '--sa-tag-secondary-hue': String(tagHue(info.secondary || info.primary)),
        },
      }
    }

    /**
     * Decorate the stock turn-rail buttons without touching their handlers.
     * Only attributes, a title tooltip, and two CSS variables are written, so
     * scrolling, jumping, virtualization, and focus behavior stay stock.
     */
    function decorateTurnMarks(root, turnTags, t) {
      const marks = root && typeof root.querySelectorAll === 'function' ? root.querySelectorAll('nav button[data-index]') : []
      const decorate = { marks: marks.length, tagged: 0 }
      for (const mark of marks) {
        if (!mark || typeof mark.getAttribute !== 'function' || typeof mark.setAttribute !== 'function') continue
        const turn = turnFromLabel(mark.getAttribute('aria-label'))
        const info = turn !== undefined && turnTags && typeof turnTags.get === 'function' ? turnTags.get(turn) : undefined
        const wasTagged = mark.getAttribute('data-sa-turn-tag') === '1'
        if (!info) {
          if (wasTagged) {
            for (const name of ['data-sa-turn-tag', 'data-sa-tags', 'data-sa-secondary', 'title']) mark.removeAttribute(name)
            if (mark.style && typeof mark.style.removeProperty === 'function') {
              mark.style.removeProperty('--sa-tag-primary-hue')
              mark.style.removeProperty('--sa-tag-secondary-hue')
            }
          }
          continue
        }
        const { attributes, style } = markerPresentation(info, t)
        // The observer runs on every child insertion, including virtualized
        // rail scrolling; skip DOM writes that would not change anything.
        for (const [name, value] of Object.entries(attributes)) {
          if (mark.getAttribute(name) !== value) mark.setAttribute(name, value)
        }
        if (mark.style && typeof mark.style.setProperty === 'function') {
          for (const [name, value] of Object.entries(style)) {
            const current = typeof mark.style.getPropertyValue === 'function' ? mark.style.getPropertyValue(name) : undefined
            if (current !== value) mark.style.setProperty(name, value)
          }
        }
        decorate.tagged += 1
      }
      return decorate
    }

    /** One-line progress text without breaking the compact strip. */
    function clipText(text, limit = 160) {
      const value = String(text || '').replace(/\s+/g, ' ').trim()
      return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
    }

    /** Whether one rail section is expanded; a missing value keeps it open. */
    function readRailExpanded(storage, key) {
      try { return storage.getItem(key) !== '0' } catch { return true }
    }

    /** Persist one rail section's expanded state; storage errors are harmless. */
    function writeRailExpanded(storage, key, expanded) {
      try { storage.setItem(key, expanded ? '1' : '0') } catch { /* private mode / closed storage */ }
    }

    /** Read the persisted multi-select tag filter; malformed values clear it. */
    function readTagFilter(storage) {
      try {
        const raw = storage.getItem(TAG_FILTER_KEY)
        if (!raw) return []
        return normalizeTagList(JSON.parse(raw), { limit: TAG_FILTER_LIMIT })
      } catch {
        return []
      }
    }

    /** Persist the tag filter (same failure-tolerant pattern as rail collapse). */
    function writeTagFilter(storage, tags) {
      const normalized = normalizeTagList(tags, { limit: TAG_FILTER_LIMIT })
      try {
        if (normalized.length === 0) storage.removeItem(TAG_FILTER_KEY)
        else storage.setItem(TAG_FILTER_KEY, JSON.stringify(normalized))
      } catch { /* private mode / closed storage */ }
      return normalized
    }

    /** Unanswered decisions, newest first, for the sidebar and question card. */
    function unresolvedPending(items) {
      return (Array.isArray(items) ? items : [])
        .filter((item) => item && typeof item === 'object' && item.id && item.question)
        .filter((item) => item.resolved_at === null || item.resolved_at === undefined)
        .slice()
        .sort((left, right) => (Number(right.created_at) || 0) - (Number(left.created_at) || 0))
    }

    /** Clear the expanded card only when its own answer has been submitted. */
    function answeredCardAfterDismiss(currentId, answeredId) {
      return currentId === answeredId ? '' : currentId
    }

    // ---------------------------------------------------------------------
    // Host API
    // ---------------------------------------------------------------------

    /** Call one plugin API route. */
    async function api(path, options = {}) {
      const headers = { ...REQUEST_HEADER }
      const init = { method: options.method || 'GET', headers }
      if (options.body !== undefined) {
        headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      let response
      try {
        response = await fetch(`${API}${path}`, init)
      } catch {
        throw new Error('offline')
      }
      const text = await response.text()
      let value = {}
      try { value = text ? JSON.parse(text) : {} } catch { value = {} }
      if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`)
      return value
    }

    /** Retain a Session and subscribe to its transcript. */
    function useSessionChat(ctx, sessionId) {
      const [nonce, setNonce] = React.useState(0)
      const [state, setState] = React.useState({ sessionId, status: sessionId ? 'loading' : 'idle', binding: undefined, reference: undefined, error: undefined, revision: 0 })
      React.useEffect(() => {
        if (!sessionId) {
          setState({ sessionId, status: 'idle', binding: undefined, reference: undefined, error: undefined, revision: 0 })
          return undefined
        }
        let alive = true
        let reference
        let released = false
        let unsubscribeSession
        let unsubscribeEvents
        setState({ sessionId, status: 'loading', binding: undefined, reference: undefined, error: undefined, revision: 0 })
        const release = () => {
          if (reference && !released) {
            released = true
            reference.release()
          }
        }
        const open = async () => {
          try {
            if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh()
            const retained = ctx.sessions.retain(sessionId, { source: 'gateway' })
            reference = retained
            const binding = await retained.ready
            if (!alive) {
              release()
              return
            }
            const bump = () => setState((previous) => ({ ...previous, revision: previous.revision + 1 }))
            unsubscribeSession = binding.session.subscribe(bump)
            unsubscribeEvents = binding.eventSource.subscribe(bump)
            setState({ sessionId, status: 'ready', binding, reference: retained, error: undefined, revision: 0 })
          } catch (error) {
            if (alive) setState({ sessionId, status: 'error', binding: undefined, reference: undefined, error: error instanceof Error ? error : new Error(String(error)), revision: 0 })
          }
        }
        open()
        return () => {
          alive = false
          if (unsubscribeSession) unsubscribeSession()
          if (unsubscribeEvents) unsubscribeEvents()
          release()
        }
      }, [ctx, sessionId, nonce])
      return { ...state, retry: () => setNonce((value) => value + 1) }
    }

    /** Poll the plugin's conversation catalog. */
    function useCatalog() {
      const [state, setState] = React.useState({ status: 'loading', data: undefined, error: undefined })
      const load = React.useCallback(async (bootstrap) => {
        try {
          const data = bootstrap ? await api('/bootstrap', { method: 'POST' }) : await api('/state')
          setState({ status: 'ready', data, error: undefined })
          return data
        } catch (error) {
          setState((previous) => ({ ...previous, status: previous.data ? previous.status : 'error', error: error instanceof Error ? error : new Error(String(error)) }))
          throw error
        }
      }, [])
      React.useEffect(() => {
        let alive = true
        let timer
        const boot = async () => {
          try {
            await load(true)
          } catch {
            if (!alive) return
            timer = setTimeout(boot, 3000)
            return
          }
          timer = setInterval(async () => {
            if (document.hidden) return
            try { await load(false) } catch { /* keep the last good catalog */ }
          }, 2500)
        }
        boot()
        return () => { alive = false; clearTimeout(timer); clearInterval(timer) }
      }, [load])
      return { ...state, reload: () => load(false), bootstrap: () => load(true) }
    }

    /** A ticking clock for relative labels. */
    /**
     * The locale/timezone the host should report to Platform. The account
     * client metadata makes Platform answer as this UI, not the last caller.
     */
    function usageRequestPath(ctx) {
      let locale = 'en'
      try {
        const snapshot = ctx && ctx.locale && typeof ctx.locale.getSnapshot === 'function' ? ctx.locale.getSnapshot() : undefined
        if (snapshot && typeof snapshot.active === 'string' && snapshot.active.length > 0) locale = snapshot.active
      } catch { /* keep the English default */ }
      const offset = -new Date().getTimezoneOffset() * 60
      return `/usage?locale=${encodeURIComponent(locale)}&tz=${offset}`
    }

    /**
     * Balance + 24-hour usage. Refreshes every 60 seconds and whenever the
     * panel regains window focus or visibility. A failed refresh keeps the last
     * good payload; the widget never surfaces a raw error.
     */
    function useUsage(ctx) {
      const [state, setState] = React.useState({ status: 'loading', data: undefined, error: undefined })
      const aliveRef = React.useRef(true)
      React.useEffect(() => () => { aliveRef.current = false }, [])
      const load = React.useCallback(async () => {
        try {
          const data = await api(usageRequestPath(ctx))
          if (aliveRef.current) setState({ status: 'ready', data, error: undefined })
        } catch (error) {
          if (aliveRef.current) {
            setState((previous) => ({ ...previous, status: previous.data ? 'stale' : 'error', error }))
          }
        }
      }, [ctx])
      React.useEffect(() => {
        aliveRef.current = true
        let timer
        const tick = () => { load().catch(() => {}) }
        tick()
        timer = setInterval(() => {
          if (typeof document === 'undefined' || !document.hidden) tick()
        }, 60_000)
        const onFocus = () => tick()
        const onVisibility = () => {
          if (typeof document === 'undefined' || !document.hidden) tick()
        }
        if (typeof window !== 'undefined') window.addEventListener('focus', onFocus)
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
        return () => {
          aliveRef.current = false
          clearInterval(timer)
          if (typeof window !== 'undefined') window.removeEventListener('focus', onFocus)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
        }
      }, [load])
      return { ...state, refresh: load }
    }


    /** A ticking clock for relative labels. */
    function useNow() {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 30_000)
        return () => clearInterval(timer)
      }, [])
      return now
    }

    // ---------------------------------------------------------------------
    // Components
    // ---------------------------------------------------------------------

    /** The sidebar glyph. */
    function Icon({ size = 18, active }) {
      return h('svg', {
        width: size,
        height: size,
        viewBox: '0 0 24 24',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.7,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': true,
        style: { display: 'block', opacity: active ? 1 : 0.9 },
      },
      h('circle', { cx: 12, cy: 12, r: 3.1, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M12 2.8v3.2M12 18v3.2M2.8 12h3.2M18 12h3.2' }),
      h('path', { d: 'M5.5 5.5l2.3 2.3M16.2 16.2l2.3 2.3M18.5 5.5l-2.3 2.3M7.8 16.2l-2.3 2.3' }),
      h('circle', { cx: 12, cy: 12, r: 8.4, opacity: 0.35 }))
    }

    /** Account balance plus the last 24 hours of local usage, in the header. */
    function UsageWidget({ t, usage, now }) {
      const [open, setOpen] = React.useState(false)
      const rootRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          const node = rootRef.current
          if (node && typeof node.contains === 'function' && !node.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        if (typeof document !== 'undefined') {
          document.addEventListener('pointerdown', onPointer)
          document.addEventListener('keydown', onKey)
        }
        return () => {
          if (typeof document !== 'undefined') {
            document.removeEventListener('pointerdown', onPointer)
            document.removeEventListener('keydown', onKey)
          }
        }
      }, [open])

      const data = usage ? usage.data : undefined
      const balance = data ? data.balance : undefined
      const usageData = data ? data.usage : undefined
      const platformData = data ? data.platform : undefined
      const rows = usageKeyRows(usageData)
      const moneyRows = platformRows(platformData)
      const moneyTotal = platformTotal(platformData)
      const readyUsage = !!(usageData && usageData.status === 'ready')
      const usagePartial = !!(usageData && usageData.status === 'ready' && usageData.partial === true)
      const total = totalUsageTokens(usageData)
      const generatedAt = data ? Number(data.generatedAt) : 0
      const updatedLabel = Number.isFinite(generatedAt) && generatedAt > 0
        ? `${t('usageUpdated')} ${relativeTime(generatedAt, t, now)}`
        : ''
      const refresh = () => { if (usage && typeof usage.refresh === 'function') usage.refresh().catch(() => {}) }

      const wallets = balance && balance.status === 'ready' && Array.isArray(balance.wallets) ? balance.wallets : []
      const bonusWallets = balance && balance.status === 'ready' && Array.isArray(balance.bonusWallets) ? balance.bonusWallets : []
      const balanceNote = !balance || balance.status === 'failed' || balance.status === 'unavailable'
        ? t('balanceUnavailable')
        : balance.status === 'signed-out'
          ? t('balanceSignedOut')
          : wallets.length === 0 ? t('balanceUnavailable') : ''
      const usageNote = !usageData || usageData.status === 'unavailable' || usageData.status === 'failed'
        ? t('usageUnavailable')
        : t('noUsage')
      const platformNote = platformData && platformData.status === 'disabled'
        ? t('platformDisabled')
        : !platformData || platformData.status === 'unavailable' || platformData.status === 'failed'
          ? t('platformUnavailable')
          : platformData.status === 'signed-out'
            ? t('platformSignedOut')
            : moneyRows.length === 0 ? t('noPlatformSpend') : ''
      const spendWindow = moneyTotal ? t('today') : t('last24h')
      const spendAmount = moneyTotal ? formatMoney(moneyTotal.cost, moneyTotal.currency) : readyUsage ? formatTokens(total) : '—'
      const spendTitle = moneyTotal ? t('platformSpendTitle') : t('spendTitle')

      const walletRow = (wallet, key) => h('div', { key, className: 'sa-usage-wallet' },
        h('span', null, wallet.currency),
        h('strong', null, formatWallet(wallet)))

      return h('div', { className: 'sa-usage', ref: rootRef },
        h('button', {
          type: 'button',
          className: 'sa-chip sa-usage-chip sa-usage-balance',
          title: `${t('balanceTitle')}${balanceNote ? ` — ${balanceNote}` : ''}`,
          'aria-label': t('balanceTitle'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: 'sa-usage-amount' }, balanceText(balance)),
        h('svg', {
          className: 'sa-usage-caret', width: 10, height: 10, viewBox: '0 0 24 24', fill: 'none',
          stroke: 'currentColor', strokeWidth: 2.2, strokeLinecap: 'round', 'aria-hidden': true,
        }, h('path', { d: 'M8 10l4 4 4-4' }))),
        h('button', {
          type: 'button',
          className: 'sa-chip sa-usage-chip spend sa-usage-spend',
          title: spendTitle,
          'aria-label': spendTitle,
          'aria-haspopup': 'dialog',
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => setOpen((value) => !value),
        },
        h('span', { className: 'sa-usage-window' }, spendWindow),
        h('span', { className: 'sa-usage-amount' }, spendAmount)),
        open && h('div', { className: 'sa-usage-pop', role: 'dialog', 'aria-label': t('usagePanelTitle') },
          h('div', { className: 'sa-usage-pop-head' },
            h('span', { className: 'sa-usage-pop-title' }, t('usagePanelTitle')),
            updatedLabel && h('span', { className: 'sa-usage-pop-time' }, updatedLabel),
            h('button', {
              type: 'button', className: 'sa-usage-refresh', title: t('usageRefresh'), 'aria-label': t('usageRefresh'), onClick: refresh,
            }, h('svg', { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', 'aria-hidden': true },
              h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' })))),
          h('div', { className: 'sa-usage-window-note' }, t('differentWindows')),
          h('div', { className: 'sa-usage-section' },
            wallets.length > 0
              ? wallets.map((wallet, index) => walletRow(wallet, `wallet-${index}`))
              : h('div', { className: 'sa-usage-empty' }, balanceNote),
            bonusWallets.length > 0 && h('div', { className: 'sa-usage-section' },
              h('div', { className: 'sa-usage-section-title' }, t('bonusBalance')),
              bonusWallets.map((wallet, index) => walletRow(wallet, `bonus-${index}`)))),
          h('div', { className: 'sa-usage-section' },
            h('div', { className: 'sa-usage-section-title' }, t('apiKeysTitle'), h('span', { className: 'sa-usage-tag' }, t('platformPrivateTag'))),
            moneyRows.length > 0
              ? moneyRows.map((row) => h('div', { key: `platform-${row.id}-${row.currency}`, className: 'sa-usage-key' },
                h('div', { className: 'sa-usage-key-head' },
                  h('span', { className: 'sa-usage-key-name', title: row.label || row.id },
                    row.label || t('keyFallback', { id: row.id.slice(0, 6) })),
                  row.keyType && h('span', { className: 'sa-usage-key-kind' }, row.keyType),
                  h('span', { className: 'sa-usage-key-total' }, formatMoney(row.cost, row.currency))),
                row.models.length > 0 && h('div', { className: 'sa-usage-key-detail' }, row.models.join(' · '))))
              : h('div', { className: 'sa-usage-empty' }, platformNote)),
          h('div', { className: 'sa-usage-section' },
            h('div', { className: 'sa-usage-section-title' }, t('rollingLabel'), h('span', { className: 'sa-usage-tag' }, t('localTag'))),
            rows.length > 0
              ? rows.map((row) => h('div', { key: row.provider, className: 'sa-usage-key' },
                h('div', { className: 'sa-usage-key-head' },
                  h('span', { className: 'sa-usage-key-name', title: row.models.join(', ') },
                    row.providerName || (row.provider === 'unknown' ? t('unknownProvider') : row.provider)),
                  h('span', { className: 'sa-usage-key-kind' }, row.kind === 'account' ? t('account') : t('apiKey')),
                  h('span', { className: 'sa-usage-key-total', title: `${row.totalTokens} tokens` }, formatTokens(row.totalTokens))),
                h('div', { className: 'sa-usage-key-detail' }, usageBreakdown(row, t)),
                row.lastAt > 0 && h('div', { className: 'sa-usage-key-detail' }, `${t('usageLastRequest')} ${relativeTime(row.lastAt, t, now)}`)))
              : h('div', { className: 'sa-usage-empty' }, usageNote),
            usagePartial && h('div', { className: 'sa-usage-key-detail' }, t('usagePartial'))),
          h('div', { className: 'sa-usage-note' }, t('usageNote')))
      )
    }

    /** The header of the panel. */
    function Header({ t, conversation, statusLabel, usage, now, stats, onNew, onToggleRail, railOpen, onOpenInDsh, onBack }) {
      const isWorker = conversation && conversation.kind === 'worker'
      const title = isWorker ? `${t('worker')} · ${conversation.title}` : (conversation ? conversation.title : t('title'))
      const counts = !isWorker && conversation && stats && stats.total > 0
        ? h('span', { className: 'sa-title-counts' },
          h('span', { className: 'sa-title-count' }, t('workerCount', { count: stats.total })),
          stats.running > 0 && h('span', { className: 'sa-title-sep' }, '·'),
          stats.running > 0 && h('span', { className: 'sa-title-count sa-title-running' }, t('workerRunningCount', { count: stats.running })))
        : null
      return h('div', { className: 'sa-top' },
        h('div', { className: 'sa-brand' },
          h('span', { className: 'sa-brand-mark' }, h(Icon, { size: 20, active: true })),
          h('div', { className: 'sa-brand-text' },
            h('div', { className: 'sa-title', title },
              h('span', { className: 'sa-title-text' }, title),
              counts),
            h('div', { className: 'sa-subtitle' }, isWorker ? t('workerBanner') : t('subtitle')))),
        h('div', { className: 'sa-top-meta' },
          h(UsageWidget, { t, usage, now }),
          conversation && h('span', { className: 'sa-chip', title: conversation.workspacePath || '' },
            h('span', null, t('workspace')),
            h('strong', null, basename(conversation.workspacePath) || t('workspaceFallback'))),
          conversation && h('span', { className: 'sa-chip' }, h('span', { className: `sa-dot ${statusLabel.tone}` }), t(statusLabel.label)),
          isWorker && onBack && h('button', { type: 'button', className: 'sa-button ghost', onClick: onBack }, t('backToSuper')),
          conversation && h('button', { type: 'button', className: 'sa-icon-button', title: t('openInDsh'), onClick: onOpenInDsh, 'aria-label': t('openInDsh') },
            h('svg', { width: 16, height: 16, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
              h('path', { d: 'M14 4h6v6' }), h('path', { d: 'M20 4l-9 9' }), h('path', { d: 'M19 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h5' }))),
          h('button', { type: 'button', className: 'sa-button primary', onClick: onNew }, t('newConversation')),
          h('button', { type: 'button', className: 'sa-icon-button sa-rail-toggle', title: railOpen ? t('hideHistory') : t('showHistory'), onClick: onToggleRail, 'aria-label': railOpen ? t('hideHistory') : t('showHistory') },
            h('svg', { width: 17, height: 17, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' },
              h('path', { d: 'M4 6h16M4 12h16M4 18h16' })))))
    }

    /** Tags plus inline add/remove controls for the selected worker. */
    function WorkerTagsBar({ t, worker, onSave }) {
      const tags = normalizeTagList(worker && worker.tags)
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const commit = async (next) => {
        setBusy(true)
        setError('')
        try {
          await onSave(normalizeTagList(next))
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      const add = () => {
        const incoming = normalizeTagList(String(draft || '').split(','))
        if (incoming.length === 0) { setDraft(''); return }
        const next = normalizeTagList([...tags, ...incoming])
        if (next.length === tags.length) {
          setError(t('tagLimit', { count: MAX_WORKER_TAGS }))
          return
        }
        setDraft('')
        commit(next)
      }
      const remove = (tag) => commit(tags.filter((value) => value !== tag))
      return h('div', { className: 'sa-worker-tags-bar', 'data-sa-worker-tags': worker.id },
        h('span', { className: 'sa-tags-label' }, t('workerTags')),
        tags.length === 0 && h('span', { className: 'sa-tags-empty' }, t('tagsEmpty')),
        tags.map((tag) => h('span', {
          key: tag, className: 'sa-tag-chip', style: tagStyle(tag), title: tag,
        },
        h('span', { className: 'sa-tag-swatch' }),
        h('span', { className: 'sa-tag-label' }, tag),
        h('button', {
          type: 'button',
          className: 'sa-tag-remove',
          title: t('removeTag'),
          'aria-label': `${t('removeTag')}: ${tag}`,
          disabled: busy,
          onClick: () => remove(tag),
        }, '×'))),
        h('span', { className: 'sa-tag-add' },
          h('input', {
            value: draft,
            placeholder: t('tagPlaceholder'),
            'aria-label': t('workerTags'),
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') { event.preventDefault(); add() }
              else if (event.key === 'Escape') setDraft('')
            },
          }),
          h('button', { type: 'button', disabled: busy || draft.trim().length === 0, onClick: add }, t('addTag'))),
        error && h('span', { className: 'sa-tags-error' }, error),
        tags.length >= MAX_WORKER_TAGS && h('span', { className: 'sa-tags-hint' }, t('tagLimit', { count: MAX_WORKER_TAGS })))
    }

    /** Multi-select tag filter with an active indicator and a clear action. */
    function TagFilterBar({ t, tags, active, onToggle, onClear, shown, total }) {
      const index = Array.isArray(tags) ? tags : []
      const selected = normalizeTagList(active, { limit: TAG_FILTER_LIMIT })
      if (index.length === 0 && selected.length === 0) return null
      const isSelected = (tag) => selected.some((value) => value.toLocaleLowerCase() === tag.toLocaleLowerCase())
      return h('div', { className: 'sa-tag-filter', 'data-sa-tag-filter': '1' },
        h('div', { className: 'sa-tag-filter-head' },
          h('span', { className: 'sa-tag-filter-title' }, t('tagFilter')),
          selected.length > 0 && h('span', { className: 'sa-tag-filter-active', 'data-sa-filter-active': String(selected.length) }, t('tagFilterActive', { count: selected.length })),
          selected.length > 0 && h('button', { type: 'button', className: 'sa-tag-filter-clear', onClick: onClear }, t('tagFilterClear'))),
        h('div', { className: 'sa-tag-filter-chips' },
          index.map(({ tag, count }) => h('button', {
            key: tag,
            type: 'button',
            className: 'sa-tag-filter-chip',
            style: tagStyle(tag),
            'aria-pressed': isSelected(tag) ? 'true' : 'false',
            title: tag,
            onClick: () => onToggle(tag),
          },
          h('span', { className: 'sa-tag-swatch' }),
          h('span', { className: 'sa-tag-label' }, tag),
          h('span', { className: 'sa-tag-filter-count' }, String(count))))),
        selected.length > 0 && h('div', { className: 'sa-tag-filter-hint' },
          t('tagFilterHint'),
          typeof shown === 'number' && typeof total === 'number' ? ` ${t('tagFilterWorkers', { shown, total })}` : ''))
    }

    /** Colour legend for the turn rail while a tag filter is active. */
    function TurnTagLegend({ t, tags, onClear }) {
      const selected = normalizeTagList(tags, { limit: TAG_FILTER_LIMIT })
      if (selected.length === 0) return null
      return h('div', { className: 'sa-turn-legend', 'data-sa-turn-legend': '1' },
        h('span', { className: 'sa-turn-legend-title' }, t('turnTagLegend')),
        selected.map((tag) => h('span', { key: tag, className: 'sa-tag-chip', style: tagStyle(tag), title: tag },
          h('span', { className: 'sa-tag-swatch' }),
          h('span', { className: 'sa-tag-label' }, tag))),
        onClear && h('button', { type: 'button', className: 'sa-turn-legend-clear', onClick: onClear }, t('tagFilterClear')))
    }

    /**
     * Decorate the stock turn rail in place. React owns the buttons, so this
     * writes only data attributes/CSS variables and observes child insertion;
     * clicks, focus, intersection, and virtualization behavior stay untouched.
     */
    function TurnTagRail({ rootRef, turnTags, t }) {
      React.useEffect(() => {
        const root = rootRef && rootRef.current
        if (!root) return undefined
        if (typeof MutationObserver === 'undefined') {
          decorateTurnMarks(root, turnTags, t)
          return undefined
        }
        let cancelled = false
        let frame
        const run = () => {
          frame = undefined
          if (!cancelled) decorateTurnMarks(root, turnTags, t)
        }
        const schedule = () => {
          if (cancelled || frame !== undefined) return
          frame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(run) : setTimeout(run, 0)
        }
        schedule()
        const observer = new MutationObserver(schedule)
        observer.observe(root, { childList: true, subtree: true })
        return () => {
          cancelled = true
          observer.disconnect()
          if (frame !== undefined) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame)
            else clearTimeout(frame)
          }
        }
      }, [rootRef, turnTags, t])
      return null
    }

    const ReactComponent = React.Component || class {}

    /** Keep a broken stock surface from blanking the panel; fall back to the custom transcript. */
    class StockSurfaceBoundary extends ReactComponent {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        try { console.warn('dsh-super-agent: stock conversation surface failed; using the custom transcript', error) } catch { /* ignore */ }
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    /** Fix the embedded Conversation occurrence to the normal Chat view. */
    function FixedChatConversationView(props) {
      return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' }))
    }

    /** Embed the stock Conversation content factory for the retained Session. */
    function EmbeddedConversation({ sessionId, fallback, useSession, useConversation, useSessions, renderFactorySlot }) {
      const session = useSession((value) => value)
      const conversation = useConversation((value) => value)
      if (!session || !conversation) return null
      const shellPhase = conversation.activeTargets.size > 0 || !session.blank && !session.awaitingFirstTurn || session.running
        ? 'active'
        : session.promptAttempted ? 'engaging' : 'blank'
      const summaryBlank = useSessions((state) => state.byId[sessionId]?.blank)
      const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
      const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
      return renderFactorySlot('conversation.content', {
        variant: 'embedded',
        phase: settling ? 'settling' : hero ? 'hero' : 'active',
        hero,
      }, { slots: { views: FixedChatConversationView }, fallback })
    }

    /** Slim worker activity strip shown above the stock conversation. */
    function ProgressStrip({ t, activity }) {
      const { workers, active, latest } = activity
      if (workers.length === 0) return null
      return h('div', { className: 'sa-stock-progress' },
        h('span', { className: `sa-dot ${active.length > 0 ? 'running' : 'idle'}` }),
        h('span', null, active.length > 0 ? t('workersRunning', { count: active.length }) : t('noWorkersRunning')),
        latest && latest.text && h('span', { className: 'sa-stock-progress-sep' }, '·'),
        latest && latest.text && h('span', { className: 'sa-stock-progress-text' },
          `${latest.title || t('worker')}: ${clipText(latest.text)}`))
    }

    /** Render the conversation transcript. */
    function Transcript({ t, chat, conversation, onEmptyNew }) {
      const scrollRef = React.useRef(null)
      const snapshot = chat.binding ? chat.binding.session.getSnapshot() : undefined
      const entries = chat.binding ? chat.binding.eventSource.getSnapshot().entries : []
      const rows = React.useMemo(() => transcriptRows(entries, t), [entries, t])
      const running = !!(snapshot && snapshot.running)
      React.useEffect(() => {
        const node = scrollRef.current
        if (node) node.scrollTop = node.scrollHeight
      }, [rows.length, running])
      if (!conversation) {
        return h('div', { className: 'sa-empty' },
          h('h2', null, t('emptyTitle')),
          h('p', null, t('emptyBody')),
          h('button', { type: 'button', className: 'sa-button primary', onClick: onEmptyNew }, t('newConversation')))
      }
      if (chat.status === 'loading') {
        return h('div', { className: 'sa-chat' }, h('div', { className: 'sa-empty' }, h('p', null, t('loading'))))
      }
      if (chat.status === 'error') {
        return h('div', { className: 'sa-chat' }, h('div', { className: 'sa-empty' },
          h('h2', null, t('loadFailed')),
          h('p', { className: 'sa-error' }, String(chat.error && chat.error.message ? chat.error.message : chat.error || '')),
          h('button', { type: 'button', className: 'sa-button', onClick: () => chat.retry && chat.retry() }, t('retry'))))
      }
      if (rows.length === 0 && !running) {
        return h('div', { className: 'sa-chat' }, h('div', { className: 'sa-empty' },
          h('h2', null, conversation.kind === 'worker' ? conversation.title : t('emptyTitle')),
          h('p', null, conversation.kind === 'worker' ? t('workerBanner') : t('emptyBody'))))
      }
      return h('div', { className: 'sa-chat', ref: scrollRef },
        h('div', { className: 'sa-thread' },
          rows.map((row, index) => h(Row, { key: rowKey(row, index), t, row, conversation })),
          running && h('div', { className: 'sa-typing' }, h('i'), h('i'), h('i'), h('span', null, t('progress')))))
    }

    /** One transcript row. */
    function Row({ t, row, conversation }) {
      if (row.kind === 'user') {
        return h('div', { className: 'sa-row user' },
          h('div', { className: 'sa-row-label' }, t('you')),
          h('div', { className: 'sa-bubble' }, h('div', { className: 'sa-text' }, renderText(row.text))))
      }
      if (row.kind === 'assistant') {
        return h('div', { className: 'sa-row assistant' },
          h('div', { className: 'sa-row-label' }, conversation && conversation.kind === 'worker' ? t('worker') : t('agent')),
          h('div', { className: 'sa-bubble' }, h('div', { className: 'sa-text sa-markdown' }, renderMarkdown(t, row.text))),
          row.interrupted && h('div', { className: 'sa-row-label' }, t('interrupted')))
      }
      if (row.kind === 'notice') {
        return h('div', { className: 'sa-notice' },
          h('span', { className: 'sa-notice-mark' }, '✦'),
          h('div', { className: 'sa-notice-body' },
            row.summary && h('div', { className: 'sa-notice-summary' }, row.summary),
            row.text && h('div', { className: 'sa-notice-text sa-markdown' }, renderMarkdown(t, row.text, { variant: 'compact' }))))
      }
      if (row.kind === 'tool') {
        return h('div', { className: `sa-tool ${row.status}` },
          h('span', null, row.status === 'running' ? '◌' : row.status === 'error' ? '!' : '✓'),
          h('div', { style: { minWidth: 0 } },
            h('div', { className: 'sa-tool-name' }, row.name),
            row.detail && h('div', { className: 'sa-tool-detail' }, row.detail),
            row.output && h('details', { className: 'sa-tool-details' },
              h('summary', null, t('toolResult')),
              h('pre', { className: 'sa-tool-code' }, row.output))))
      }
      if (row.kind === 'error') {
        return h('div', { className: 'sa-error-row' }, row.text)
      }
      return null
    }

    /** The message composer. */
    function Composer({ t, chat, disabled, placeholder, onSend }) {
      const [text, setText] = React.useState('')
      const [sending, setSending] = React.useState(false)
      const [error, setError] = React.useState('')
      const areaRef = React.useRef(null)
      const resize = () => {
        const node = areaRef.current
        if (!node) return
        node.style.height = 'auto'
        node.style.height = `${Math.min(180, node.scrollHeight)}px`
      }
      const send = async () => {
        const value = text.trim()
        if (!value || sending || disabled) return
        setSending(true)
        setError('')
        try {
          await onSend(value)
          setText('')
          if (areaRef.current) areaRef.current.style.height = '26px'
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setSending(false)
        }
      }
      const keyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          send()
        }
      }
      const snapshot = chat.binding ? chat.binding.session.getSnapshot() : undefined
      const running = !!(snapshot && snapshot.running)
      return h('div', { className: 'sa-composer' },
        h('div', { className: 'sa-composer-inner' },
          h('textarea', {
            ref: areaRef,
            value: text,
            placeholder,
            rows: 1,
            disabled: disabled || sending,
            onChange: (event) => { setText(event.target.value); resize() },
            onKeyDown: keyDown,
          }),
          h('div', { className: 'sa-composer-actions' },
            running && h('button', { type: 'button', className: 'sa-button', onClick: () => { Promise.resolve(chat.binding.session.cancel()).catch(() => {}) } }, t('stop')),
            h('button', { type: 'button', className: 'sa-button primary', disabled: disabled || sending || text.trim().length === 0, onClick: send },
              sending ? t('sending') : t('send')))),
        error && h('div', { className: 'sa-composer-error' }, error),
        h('div', { className: 'sa-composer-hint' }, h('span', null, 'Enter ↵'), h('span', null, 'Shift+Enter')))
    }

    /** Inline question card: choices plus free text, with an answered state. */
    function PendingQuestionCard({ t, item, answer, onAnswer, onDismiss }) {
      const [selected, setSelected] = React.useState('')
      const [text, setText] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const answered = typeof answer === 'string' && answer.length > 0
      const options = Array.isArray(item.options) ? item.options : []
      const submit = async () => {
        const value = text.trim() || selected
        if (value.length === 0) {
          setError(t('pendingAnswerRequired'))
          return
        }
        setBusy(true)
        setError('')
        try {
          await onAnswer(item, value)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setBusy(false)
        }
      }
      return h('section', {
        className: `sa-pending-card${answered ? ' answered' : ''}`,
        'data-sa-pending-card': item.id,
        'data-state': answered ? 'answered' : 'open',
      },
      h('div', { className: 'sa-pending-card-head' },
        h('span', { className: 'sa-pending-card-label' }, answered ? t('pendingAnswered') : t('pending')),
        answered && h('span', { className: 'sa-pending-card-check' }, '✓'),
        !answered && h('button', {
          type: 'button',
          className: 'sa-icon-button sa-pending-card-close',
          title: t('pendingDismiss'),
          'aria-label': t('pendingDismiss'),
          onClick: onDismiss,
        }, '×')),
      h('div', { className: 'sa-pending-question' }, item.question),
      item.context && h('div', { className: 'sa-pending-context sa-markdown' }, renderMarkdown(t, item.context, { variant: 'compact' })),
      answered
        ? h('div', { className: 'sa-pending-answer' },
          h('div', { className: 'sa-pending-answer-label' }, t('pendingAnswerLabel')),
          h('div', { className: 'sa-pending-answer-text' }, answer))
        : h(React.Fragment, null,
          options.length > 0 && h('div', { className: 'sa-pending-options' },
            options.map((option, index) => h('button', {
              key: `option-${index}`,
              type: 'button',
              className: `sa-pending-option${selected === option ? ' selected' : ''}`,
              disabled: busy,
              onClick: () => { setSelected(option); setText(option) },
            }, option))),
          h('div', { className: 'sa-pending-free' },
            h('textarea', {
              value: text,
              rows: 2,
              disabled: busy,
              placeholder: t('pendingPlaceholder'),
              'aria-label': t('pendingAnswerLabel'),
              onChange: (event) => { setText(event.target.value); setSelected('') },
            })),
          error && h('div', { className: 'sa-pending-error' }, error),
          h('div', { className: 'sa-pending-actions' },
            h('button', {
              type: 'button',
              className: 'sa-button primary',
              disabled: busy || (text.trim().length === 0 && selected.length === 0),
              onClick: submit,
            }, busy ? t('pendingSubmitting') : t('pendingSubmit')),
            h('span', { className: 'sa-pending-hint' }, t('pendingCardHint')))))
    }

    /** One pending-decision row in the rail. */
    function PendingDecisionItem({ t, item, now, onOpen, expanded }) {
      const optionCount = Array.isArray(item.options) ? item.options.length : 0
      return h('button', {
        type: 'button',
        className: `sa-item sa-pending-item${expanded ? ' selected' : ''}`,
        title: item.question,
        'data-pending-id': item.id,
        onClick: () => onOpen(item),
      },
      h('span', { className: 'sa-pending-mark' }, '?'),
      h('span', { className: 'sa-item-main' },
        h('span', { className: 'sa-item-title' }, item.question),
        item.context && h('span', { className: 'sa-item-message' }, clipText(item.context, 120)),
        h('span', { className: 'sa-item-meta' },
          optionCount > 0 && h('span', null, t('pendingOptions', { count: optionCount })),
          optionCount > 0 && h('span', null, '·'),
          h('span', null, relativeTime(item.created_at, t, now)))))
    }

    /** One history row. */
    function HistoryItem({ t, item, selected, now, onSelect, nested }) {
      const status = statusOf(item.status)
      const badge = item.status === 'needs_input' ? h('span', { className: 'sa-badge warn' }, t('statusNeedsInput'))
        : item.status === 'failed' ? h('span', { className: 'sa-badge error' }, t('statusFailed')) : null
      return h('button', {
        type: 'button',
        className: `sa-item${selected ? ' selected' : ''}${nested ? ' worker' : ''}`,
        onClick: () => onSelect(item),
        title: item.workspacePath || '',
      },
      h('span', { className: `sa-dot ${status.tone}` }),
      h('span', { className: 'sa-item-main' },
        h('span', { className: 'sa-item-title' }, item.title || t('untitled'), badge),
        h('span', { className: 'sa-item-meta' },
          h('span', null, basename(item.workspacePath) || t('workspaceFallback')),
          h('span', null, '·'),
          h('span', null, relativeTime(item.updatedAt, t, now))),
        normalizeTagList(item.tags).length > 0 && h('span', { className: 'sa-item-tags' },
          normalizeTagList(item.tags).map((tag) => h('span', {
            key: tag, className: 'sa-tag-chip', style: tagStyle(tag), title: tag,
          },
          h('span', { className: 'sa-tag-swatch' }),
          h('span', { className: 'sa-tag-label' }, tag)))),
        item.lastMessage && h('span', { className: 'sa-item-message' }, item.lastMessage)))
    }

    /** One collapsible rail section header. */
    function RailSectionHead({ t, section, title, count, expanded, onToggle }) {
      return h('button', {
        type: 'button',
        className: 'sa-rail-section-head',
        'data-section-head': section,
        'aria-expanded': expanded ? 'true' : 'false',
        title: expanded
          ? (section === 'pending' ? t('collapsePending') : t('collapseConversations'))
          : (section === 'pending' ? t('expandPending') : t('expandConversations')),
        onClick: () => onToggle(section),
      },
      h('svg', {
        className: 'sa-rail-chevron', width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 2.1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      }, h('path', { d: 'M6 9l6 6 6-6' })),
      h('span', { className: 'sa-rail-section-title' }, title),
      h('span', { className: 'sa-rail-section-count' }, count))
    }

    /** The conversation history rail with independent conversation and pending sections. */
    function HistoryRail({
      t, data, selectedId, now, onSelect, onNew, onRefresh, onClose,
      expanded = {}, onToggleSection = () => {}, pending = [], pendingExpandedId, onOpenPending,
      filterTags = [], onToggleTag = () => {}, onClearFilter = () => {},
    }) {
      const conversations = data ? data.conversations : []
      const activeFilter = normalizeTagList(filterTags, { limit: TAG_FILTER_LIMIT })
      const tagIndex = workerTagIndex(conversations)
      const allWorkers = conversations.filter((item) => item.kind === 'worker')
      const matchedWorkers = filterWorkers(allWorkers, activeFilter)
      const { groups, orphans } = groupConversations(conversations, activeFilter)
      const visibleCount = conversations.filter((item) => item.kind === 'super').length + matchedWorkers.length
      const noTagMatches = activeFilter.length > 0 && matchedWorkers.length === 0
      const pendingItems = unresolvedPending(pending)
      const conversationsOpen = expanded.conversations !== false
      const pendingOpen = expanded.pending !== false
      return h('aside', { className: 'sa-rail' },
        h('div', { className: 'sa-rail-head' },
          h('span', { className: 'sa-rail-title' }, t('title')),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'sa-icon-button', title: t('refresh'), onClick: onRefresh, 'aria-label': t('refresh') },
            h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
              h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' }))),
          h('button', { type: 'button', className: 'sa-icon-button sa-rail-toggle', title: t('close'), onClick: onClose, 'aria-label': t('close') }, '×')),
        h('div', { className: 'sa-rail-sections' },
          h('section', {
            className: `sa-rail-section conversations${conversationsOpen ? '' : ' collapsed'}`,
            'data-rail-section': 'conversations',
          },
          h(RailSectionHead, {
            t, section: 'conversations', title: t('conversations'), count: visibleCount,
            expanded: conversationsOpen, onToggle: onToggleSection,
          }),
          conversationsOpen && h('div', { className: 'sa-rail-section-list' },
            h(TagFilterBar, {
              t,
              tags: tagIndex,
              active: activeFilter,
              onToggle: onToggleTag,
              onClear: onClearFilter,
              shown: matchedWorkers.length,
              total: allWorkers.length,
            }),
            noTagMatches && h('div', { className: 'sa-tag-filter-empty', 'data-sa-tag-empty': '1' },
              h('div', null, t('noWorkersWithTags')),
              h('button', { type: 'button', className: 'sa-button', onClick: onClearFilter }, t('tagFilterClear'))),
            conversations.length === 0 && h('div', { className: 'sa-rail-empty' }, t('emptyHistory')),
            groups.map((group) => h('div', { className: 'sa-group', key: group.parent.id },
              h(HistoryItem, { t, item: group.parent, selected: group.parent.id === selectedId, now, onSelect }),
              group.workers.map((worker) => h(HistoryItem, { key: worker.id, t, item: worker, selected: worker.id === selectedId, now, onSelect, nested: true })))),
            orphans.length > 0 && h('div', { className: 'sa-group' },
              h('div', { className: 'sa-group-head' }, t('otherWorkers')),
              orphans.map((worker) => h(HistoryItem, { key: worker.id, t, item: worker, selected: worker.id === selectedId, now, onSelect, nested: true }))),
            h('div', { style: { padding: '10px 8px 0' } },
              h('button', { type: 'button', className: 'sa-button', style: { width: '100%' }, onClick: onNew }, t('newConversation'))))),
          h('section', {
            className: `sa-rail-section pending${pendingOpen ? ' expanded' : ' collapsed'}`,
            'data-rail-section': 'pending',
          },
          h(RailSectionHead, {
            t, section: 'pending', title: t('pending'), count: pendingItems.length,
            expanded: pendingOpen, onToggle: onToggleSection,
          }),
          pendingOpen && h('div', { className: 'sa-rail-section-list' },
            pendingItems.length === 0 && h('div', { className: 'sa-rail-empty' }, t('pendingEmpty')),
            pendingItems.map((item) => h(PendingDecisionItem, {
              key: item.id,
              t,
              item,
              now,
              expanded: item.id === pendingExpandedId,
              onOpen: onOpenPending,
            }))))))
    }

    /** The new-conversation dialog. */
    function NewConversationDialog({ t, workspaces, currentWorkspaceId, onClose, onCreate }) {
      const [title, setTitle] = React.useState('')
      const [workspaceId, setWorkspaceId] = React.useState(
        workspaces.some((workspace) => workspace.id === currentWorkspaceId)
          ? currentWorkspaceId
          : (workspaces[0] && workspaces[0].id) || '__new__',
      )
      const [path, setPath] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const submit = async () => {
        setBusy(true)
        setError('')
        try {
          await onCreate({
            title: title.trim() || undefined,
            workspaceId: workspaceId !== '__new__' ? workspaceId : undefined,
            path: workspaceId === '__new__' && path.trim() ? path.trim() : undefined,
            newWorkspace: workspaceId === '__new__',
          })
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
          setBusy(false)
        }
      }
      return h('div', { className: 'sa-overlay', onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() } },
        h('div', { className: 'sa-dialog', role: 'dialog', 'aria-modal': 'true' },
          h('h3', null, t('newConversationTitle')),
          h('div', { className: 'sa-field' },
            h('label', null, t('conversationTitle')),
            h('input', { value: title, autoFocus: true, placeholder: t('title'), onChange: (event) => setTitle(event.target.value) })),
          h('div', { className: 'sa-field' },
            h('label', null, t('workspace')),
            h('select', { value: workspaceId, onChange: (event) => setWorkspaceId(event.target.value) },
              workspaces.map((workspace) => h('option', { key: workspace.id, value: workspace.id }, `${workspace.title} — ${workspace.path}`)),
              h('option', { value: '__new__' }, t('newWorkspace')))),
          workspaceId === '__new__' && h('div', { className: 'sa-field' },
            h('label', null, t('workspacePath')),
            h('input', { value: path, placeholder: '~/Projects/…', onChange: (event) => setPath(event.target.value) })),
          error && h('div', { className: 'sa-error' }, error),
          h('div', { className: 'sa-dialog-actions' },
            h('button', { type: 'button', className: 'sa-button', onClick: onClose, disabled: busy }, t('cancel')),
            h('button', { type: 'button', className: 'sa-button primary', onClick: submit, disabled: busy }, busy ? t('loading') : t('create')))))
    }

    /** The whole panel. */
    function App({ ctx, t, stockChat, renderSlot, SessionProvider }) {
      const catalog = useCatalog()
      const usage = useUsage(ctx)
      const now = useNow()
      const rootRef = React.useRef(null)
      const [selectedId, setSelectedId] = React.useState(() => {
        try { return window.localStorage.getItem(SELECTED_KEY) || '' } catch { return '' }
      })
      const [railOpen, setRailOpen] = React.useState(() => {
        try { return window.localStorage.getItem(RAIL_VISIBLE_KEY) !== '0' } catch { return true }
      })
      const [railSections, setRailSections] = React.useState(() => ({
        conversations: readRailExpanded(window.localStorage, RAIL_SECTION_KEYS.conversations),
        pending: readRailExpanded(window.localStorage, RAIL_SECTION_KEYS.pending),
      }))
      const [expandedPendingId, setExpandedPendingId] = React.useState('')
      const [answeredPending, setAnsweredPending] = React.useState({})
      const [tagFilter, setTagFilter] = React.useState(() => readTagFilter(window.localStorage))
      const [newOpen, setNewOpen] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const data = catalog.data
      const conversations = data ? data.conversations : []
      const pending = data && Array.isArray(data.pending) ? data.pending : []
      const selected = conversations.find((item) => item.id === selectedId) || null
      const chat = useSessionChat(ctx, selected ? selected.sessionId : undefined)
      const statusLabel = statusOf(selected ? selected.status : 'idle')
      const selectedWorkers = selected && selected.kind === 'super'
        ? conversations.filter((item) => item.kind === 'worker' && item.parentId === selected.id)
        : []
      const stats = selected && selected.kind === 'super' ? workerStats(selectedWorkers) : undefined
      const workerTagsSignature = React.useMemo(() => conversations
        .filter((item) => item && item.kind === 'worker')
        .map((item) => `${item.id}:${normalizeTagList(item.tags).join(',')}`)
        .join('|'), [conversations])
      const chatEntries = chat.binding ? chat.binding.eventSource.getSnapshot().entries : []
      const turnTags = React.useMemo(
        () => turnTagMap(chatEntries, conversations.filter((item) => item && item.kind === 'worker')),
        [chat.revision, chat.status, selectedId, workerTagsSignature],
      )
      const surface = selectConversationSurface({
        flag: stockChat,
        status: chat.status,
        kind: selected ? selected.kind : undefined,
        sessionId: selected ? selected.sessionId : undefined,
        chatSessionId: chat.sessionId,
        reference: chat.reference,
        SessionProvider,
        renderSlot,
      })
      const activity = workerActivity(conversations, selected ? selected.id : undefined)

      React.useEffect(() => {
        if (conversations.length === 0) return
        if (selectedId && conversations.some((item) => item.id === selectedId)) return
        const fallback = (data && data.activeConversationId) || (conversations.find((item) => item.kind === 'super') || conversations[0]).id
        setSelectedId(fallback)
        try { window.localStorage.setItem(SELECTED_KEY, fallback) } catch { /* ignore */ }
      }, [conversations, selectedId, data])

      const select = (item) => {
        setSelectedId(item.id)
        try { window.localStorage.setItem(SELECTED_KEY, item.id) } catch { /* ignore */ }
        setNotice('')
      }
      const toggleRail = () => {
        setRailOpen((value) => {
          try { window.localStorage.setItem(RAIL_VISIBLE_KEY, value ? '0' : '1') } catch { /* ignore */ }
          return !value
        })
      }
      const toggleRailSection = (section) => {
        if (section !== 'conversations' && section !== 'pending') return
        setRailSections((value) => {
          const next = { ...value, [section]: !value[section] }
          writeRailExpanded(window.localStorage, RAIL_SECTION_KEYS[section], next[section])
          return next
        })
      }
      const openPending = (item) => {
        if (!item) return
        const owner = conversations.find((conversation) => conversation.id === item.conversation_id)
        if (owner) select(owner)
        setExpandedPendingId(item.id)
      }
      const answerPending = async (item, answer) => {
        const response = await api(`/pending/${encodeURIComponent(item.id)}/resolve`, {
          method: 'POST',
          body: { answer },
        })
        const resolved = response.item || { ...item, answer, resolved_at: Date.now() }
        setAnsweredPending((value) => ({ ...value, [item.id]: { item: resolved, answer } }))
        await catalog.reload()
        // Show the answered state briefly, then collapse the inline card even
        // if the user never touches the X. Only clear this item if the user has
        // not opened another pending card in the meantime.
        setTimeout(() => {
          setExpandedPendingId((current) => answeredCardAfterDismiss(current, item.id))
        }, PENDING_ANSWER_DISMISS_MS)
        return resolved
      }
      const dismissPending = () => setExpandedPendingId('')
      const toggleTagFilter = (tag) => {
        const normalized = normalizeTagList([tag], { limit: 1 })[0]
        if (!normalized) return
        setTagFilter((current) => {
          const key = normalized.toLocaleLowerCase()
          const exists = current.some((value) => value.toLocaleLowerCase() === key)
          const next = normalizeTagList(exists ? current.filter((value) => value.toLocaleLowerCase() !== key) : [...current, normalized], { limit: TAG_FILTER_LIMIT })
          writeTagFilter(window.localStorage, next)
          return next
        })
      }
      const clearTagFilter = () => {
        setTagFilter([])
        writeTagFilter(window.localStorage, [])
      }
      const saveWorkerTags = async (worker, tags) => {
        try {
          await api(`/workers/${encodeURIComponent(worker.id)}/tags`, { method: 'POST', body: { tags } })
          await catalog.reload()
        } catch (failure) {
          setNotice(`${t('tagSaveFailed')}: ${failure instanceof Error ? failure.message : String(failure)}`)
          throw failure
        }
      }
      const openInDsh = async (id) => {
        try {
          const list = ctx.sessions.list.getSnapshot()
          if (list.phase !== 'ready' || !list.byId[id]) await ctx.sessions.refresh()
          const next = ctx.sessions.list.getSnapshot()
          if (next.phase === 'ready' && next.byId[id]) ctx.uiWorkspace.openSession(id)
          else setNotice(t('openFailed'))
        } catch {
          setNotice(t('openFailed'))
        }
      }
      const create = async (input) => {
        const response = await api('/conversations', { method: 'POST', body: input })
        const conversation = response.conversation
        await catalog.reload()
        if (conversation) select(conversation)
        setNewOpen(false)
      }
      const send = async (text) => {
        if (!chat.binding) throw new Error(t('loadFailed'))
        const result = await chat.binding.session.prompt([{ type: 'text', text }], 'queue')
        if (result && result.ok === false) throw new Error(result.error && result.error.message ? result.error.message : t('sendFailed'))
      }
      const emptyNew = () => setNewOpen(true)
      const backToSuper = () => {
        const parent = selected && conversations.find((item) => item.id === selected.parentId)
          || conversations.find((item) => item.kind === 'super')
        if (parent) select(parent)
      }
      const openFull = () => { if (selected) openInDsh(selected.sessionId) }
      const customCenter = h(React.Fragment, null,
        h(Transcript, { t, chat, conversation: selected, onEmptyNew: emptyNew }),
        selected && selected.kind === 'super' && h(Composer, { t, chat, disabled: !chat.binding, placeholder: t('placeholder'), onSend: send }),
        selected && selected.kind === 'worker' && h('div', { className: 'sa-composer' },
          h('div', { className: 'sa-worker-banner' },
            h('p', null, t('workerBanner')),
            h('button', { type: 'button', className: 'sa-button', onClick: openFull }, t('openFull')),
            h('button', { type: 'button', className: 'sa-button', onClick: backToSuper }, t('backToSuper')))))
      const center = surface === SURFACE_STOCK
        ? h(StockSurfaceBoundary, { key: `stock:${selected.sessionId}`, fallback: customCenter },
          h('div', { className: 'sa-stock' },
            h(ProgressStrip, { t, activity }),
            h(SessionProvider, { session: chat.reference },
              h('div', { className: 'sa-stock-surface' }, renderSlot('superagent.conversation', { sessionId: selected.sessionId, fallback: customCenter }, { fallback: customCenter })))))
        : customCenter

      const pendingCardItem = expandedPendingId
        ? (pending.find((item) => item.id === expandedPendingId) || (answeredPending[expandedPendingId] && answeredPending[expandedPendingId].item))
        : undefined
      const pendingCardAnswer = expandedPendingId && answeredPending[expandedPendingId]
        ? answeredPending[expandedPendingId].answer
        : ''
      const pendingCard = pendingCardItem && selected && pendingCardItem.conversation_id === selected.id
        ? h(PendingQuestionCard, {
          t,
          item: pendingCardItem,
          answer: pendingCardAnswer,
          onAnswer: answerPending,
          onDismiss: dismissPending,
        })
        : null

      return h('div', { className: 'sa-root', ref: rootRef },
        h('style', null, CSS),
        h(Header, {
          t,
          conversation: selected,
          statusLabel,
          usage,
          now,
          stats,
          railOpen,
          onNew: () => setNewOpen(true),
          onToggleRail: toggleRail,
          onOpenInDsh: () => { if (selected) openInDsh(selected.sessionId) },
          onBack: backToSuper,
        }),
        selected && selected.kind === 'worker' && h(WorkerTagsBar, {
          t,
          worker: selected,
          onSave: (tags) => saveWorkerTags(selected, tags),
        }),
        notice && h('div', { className: 'sa-error', style: { padding: '8px 18px 0' } }, notice),
        h('div', { className: 'sa-body' },
          h('main', { className: 'sa-main' },
            pendingCard && h('div', { className: 'sa-pending-inline' }, pendingCard),
            surface === SURFACE_STOCK && h(TurnTagLegend, { t, tags: tagFilter, onClear: clearTagFilter }),
            catalog.status === 'loading' && !data
              ? h('div', { className: 'sa-empty' }, h('p', null, t('loading')))
              : catalog.status === 'error' && !data
                ? h('div', { className: 'sa-empty' }, h('h2', null, t('loadFailed')), h('p', { className: 'sa-error' }, String(catalog.error && catalog.error.message || '')),
                  h('button', { type: 'button', className: 'sa-button primary', onClick: () => { catalog.bootstrap().catch(() => {}) } }, t('retry')))
                : center,
            h(TurnTagRail, { rootRef, turnTags, t })),
          railOpen && h(HistoryRail, {
            t,
            data,
            selectedId,
            now,
            pending,
            filterTags: tagFilter,
            onToggleTag: toggleTagFilter,
            onClearFilter: clearTagFilter,
            pendingExpandedId: expandedPendingId,
            onOpenPending: openPending,
            expanded: railSections,
            onToggleSection: toggleRailSection,
            onSelect: select,
            onNew: () => setNewOpen(true),
            onRefresh: () => { catalog.reload().catch(() => {}) },
            onClose: toggleRail,
          })),
        newOpen && h(NewConversationDialog, {
          t,
          workspaces: data ? data.workspaces : [],
          currentWorkspaceId: selected ? selected.workspaceId : undefined,
          onClose: () => setNewOpen(false),
          onCreate: create,
        }))
    }

    return {
      inject: ['slots', 'locale', 'sessions', 'uiWorkspace'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en }), 'dsh-super-agent: locale')
        const translate = ctx.locale.bind(NS)
        const t = (key, values) => {
          const text = translate(key)
          if (!values) return text
          return String(text).replace(/\{(\w+)\}/g, (_, name) => values[name] === undefined ? '' : String(values[name]))
        }
        let stockChat = readStockChatFlag()
        ctx.slots.inject('main', () => ctx.slots.register(
          {
            name: 'main',
            key: PANEL_ID,
            locale: NS,
            children: { 'superagent.conversation': { kind: 'single', scope: 'session' } },
          },
          (props) => h(App, { ...props, ctx, t, stockChat }),
        ))
        try {
          ctx.slots.inject('superagent.conversation', () => ctx.slots.register(
            { name: 'superagent.conversation' },
            EmbeddedConversation,
          ))
        } catch (error) {
          stockChat = false
          console.warn('dsh-super-agent: could not register the embedded conversation slot', error)
        }
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: PANEL_ID, order: -10, label: () => t('title'), locale: NS },
          Icon,
        ))
      },
      __internals: {
        textOfMessage,
        parseToolArgs,
        toolDetail,
        transcriptRows,
        basename,
        relativeTime,
        groupConversations,
        statusOf,
        renderText,
        renderMarkdown,
        markdownLabels,
        hasMarkdownRenderer: MarkdownText !== undefined,
        resolveStockChatFlag,
        selectConversationSurface,
        workerActivity,
        normalizeTagList,
        stableHash,
        tagHue,
        tagStyle,
        isWorkerRunning,
        workerStats,
        workerTagIndex,
        filterWorkers,
        readTagFilter,
        writeTagFilter,
        turnWorkerIds,
        turnTagMap,
        turnFromLabel,
        markerPresentation,
        decorateTurnMarks,
        clipText,
        unresolvedPending,
        answeredCardAfterDismiss,
        readRailExpanded,
        writeRailExpanded,
        formatTokens,
        formatWallet,
        formatMoney,
        platformRows,
        platformTotal,
        balanceText,
        totalUsageTokens,
        usageKeyRows,
        usageBreakdown,
        usageRequestPath,
        UsageWidget,
        Header,
        WorkerTagsBar,
        TagFilterBar,
        TurnTagLegend,
        TurnTagRail,
        HistoryRail,
        HistoryItem,
        PendingDecisionItem,
        PendingQuestionCard,
        EmbeddedConversation,
        RAIL_VISIBLE_KEY,
        RAIL_SECTION_KEYS,
        TAG_FILTER_KEY,
        TAG_HUES,
        MAX_WORKER_TAGS,
        MAX_TAG_CHARS,
        TAG_FILTER_LIMIT,
        PENDING_ANSWER_DISMISS_MS,
        SURFACE_STOCK,
        SURFACE_CUSTOM,
        STOCK_CHAT_KEY,
        DICT,
      },
    }
  },
})
