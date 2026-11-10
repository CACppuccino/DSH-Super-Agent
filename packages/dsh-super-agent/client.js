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
    const SURFACE_STOCK = 'stock'
    const SURFACE_CUSTOM = 'custom'

    /** Locale dictionaries; every visible string lives here. */
    const DICT = {
      zh: {
        title: 'Super Agent',
        subtitle: '把任务分发给持久的工作会话，并在这里跟踪进度。',
        conversations: '对话',
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
        copy: '复制',
        copied: '已复制',
        codeBlock: '代码',
        wrap: '自动换行',
        unwrap: '不换行',
        footnotes: '脚注',
        workersRunning: '{count} 个 worker 运行中',
        noWorkersRunning: '没有运行中的 worker',
      },
      en: {
        title: 'Super Agent',
        subtitle: 'Delegate work to persistent worker conversations and follow their progress here.',
        conversations: 'Conversations',
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
        copy: 'Copy',
        copied: 'Copied',
        codeBlock: 'Code',
        wrap: 'Wrap',
        unwrap: 'Unwrap',
        footnotes: 'Footnotes',
        workersRunning: '{count} workers running',
        noWorkersRunning: 'No workers running',
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
.sa-title { font-size: 14px; font-weight: 650; letter-spacing: .01em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-subtitle { font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.sa-top-meta { display: flex; align-items: center; gap: 8px; margin-left: auto; flex: 0 0 auto; }
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
.sa-rail-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 2px 8px 12px; }
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
@media (max-width: 980px) {
  .sa-rail { position: absolute; right: 0; top: 0; bottom: 0; z-index: 10; box-shadow: -12px 0 36px color-mix(in srgb, #000 16%, transparent); }
  .sa-rail-toggle { display: inline-flex; }
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
    function groupConversations(conversations) {
      const items = Array.isArray(conversations) ? conversations.slice() : []
      const byUpdated = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)
      const supers = items.filter((item) => item.kind === 'super').sort(byUpdated)
      const workers = items.filter((item) => item.kind === 'worker')
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

    /** One-line progress text without breaking the compact strip. */
    function clipText(text, limit = 160) {
      const value = String(text || '').replace(/\s+/g, ' ').trim()
      return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`
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

    /** The header of the panel. */
    function Header({ t, conversation, statusLabel, onNew, onToggleRail, railOpen, onOpenInDsh, onBack }) {
      const isWorker = conversation && conversation.kind === 'worker'
      return h('div', { className: 'sa-top' },
        h('div', { className: 'sa-brand' },
          h('span', { className: 'sa-brand-mark' }, h(Icon, { size: 20, active: true })),
          h('div', { className: 'sa-brand-text' },
            h('div', { className: 'sa-title' }, isWorker ? `${t('worker')} · ${conversation.title}` : (conversation ? conversation.title : t('title'))),
            h('div', { className: 'sa-subtitle' }, isWorker ? t('workerBanner') : t('subtitle')))),
        h('div', { className: 'sa-top-meta' },
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
        item.lastMessage && h('span', { className: 'sa-item-message' }, item.lastMessage)))
    }

    /** The conversation history rail. */
    function HistoryRail({ t, data, selectedId, now, onSelect, onNew, onRefresh, onClose }) {
      const conversations = data ? data.conversations : []
      const { groups, orphans } = groupConversations(conversations)
      return h('aside', { className: 'sa-rail' },
        h('div', { className: 'sa-rail-head' },
          h('span', { className: 'sa-rail-title' }, t('conversations')),
          h('span', { className: 'sa-rail-count' }, conversations.length),
          h('span', { style: { flex: 1 } }),
          h('button', { type: 'button', className: 'sa-icon-button', title: t('refresh'), onClick: onRefresh, 'aria-label': t('refresh') },
            h('svg', { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
              h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' }))),
          h('button', { type: 'button', className: 'sa-icon-button sa-rail-toggle', title: t('close'), onClick: onClose, 'aria-label': t('close') }, '×')),
        h('div', { className: 'sa-rail-list' },
          conversations.length === 0 && h('div', { className: 'sa-rail-empty' }, t('emptyHistory')),
          groups.map((group) => h('div', { className: 'sa-group', key: group.parent.id },
            h(HistoryItem, { t, item: group.parent, selected: group.parent.id === selectedId, now, onSelect }),
            group.workers.map((worker) => h(HistoryItem, { key: worker.id, t, item: worker, selected: worker.id === selectedId, now, onSelect, nested: true })))),
          orphans.length > 0 && h('div', { className: 'sa-group' },
            h('div', { className: 'sa-group-head' }, t('otherWorkers')),
            orphans.map((worker) => h(HistoryItem, { key: worker.id, t, item: worker, selected: worker.id === selectedId, now, onSelect, nested: true }))),
          conversations.length > 0 && h('div', { style: { padding: '10px 8px 0' } },
            h('button', { type: 'button', className: 'sa-button', style: { width: '100%' }, onClick: onNew }, t('newConversation')))))
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
      const now = useNow()
      const [selectedId, setSelectedId] = React.useState(() => {
        try { return window.localStorage.getItem(SELECTED_KEY) || '' } catch { return '' }
      })
      const [railOpen, setRailOpen] = React.useState(() => {
        try { return window.localStorage.getItem('dsh-super-agent:rail') !== '0' } catch { return true }
      })
      const [newOpen, setNewOpen] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const data = catalog.data
      const conversations = data ? data.conversations : []
      const selected = conversations.find((item) => item.id === selectedId) || null
      const chat = useSessionChat(ctx, selected ? selected.sessionId : undefined)
      const statusLabel = statusOf(selected ? selected.status : 'idle')
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
          try { window.localStorage.setItem('dsh-super-agent:rail', value ? '0' : '1') } catch { /* ignore */ }
          return !value
        })
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

      return h('div', { className: 'sa-root' },
        h('style', null, CSS),
        h(Header, {
          t,
          conversation: selected,
          statusLabel,
          railOpen,
          onNew: () => setNewOpen(true),
          onToggleRail: toggleRail,
          onOpenInDsh: () => { if (selected) openInDsh(selected.sessionId) },
          onBack: backToSuper,
        }),
        notice && h('div', { className: 'sa-error', style: { padding: '8px 18px 0' } }, notice),
        h('div', { className: 'sa-body' },
          h('main', { className: 'sa-main' },
            catalog.status === 'loading' && !data
              ? h('div', { className: 'sa-empty' }, h('p', null, t('loading')))
              : catalog.status === 'error' && !data
                ? h('div', { className: 'sa-empty' }, h('h2', null, t('loadFailed')), h('p', { className: 'sa-error' }, String(catalog.error && catalog.error.message || '')),
                  h('button', { type: 'button', className: 'sa-button primary', onClick: () => { catalog.bootstrap().catch(() => {}) } }, t('retry')))
                : center),
          railOpen && h(HistoryRail, {
            t,
            data,
            selectedId,
            now,
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
        clipText,
        EmbeddedConversation,
        SURFACE_STOCK,
        SURFACE_CUSTOM,
        STOCK_CHAT_KEY,
        DICT,
      },
    }
  },
})
