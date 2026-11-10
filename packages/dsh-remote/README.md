# dsh-remote

> **本机同一进程部署**：dsh-remote 安装在 **desktop profile**（Harness Plugin Manager），
> iOS 的 `3443` 端点直接连 Mac 桌面的 dsh 进程。这样 iOS 和 Mac 本机看到的是同一个
> workspace、同一份会话和同一个 Super Agent。不要同时把 dsh-remote / Super Agent 装到
> web profile，否则会出现两个进程和两套 workspace。下面的 `dsh plugin --profile web add`
> 是独立 web profile 部署示例，不用于本机同一进程模式。

给 DeepSeek Harness 增加一个**带鉴权的远程控制端点**，完全以插件（Cordis bundle）形式接入，不修改 dsh 核心。

它在独立端口上保留 iOS 客户端使用的旧四象限协议（点号方法名、`client-request` / `server-response`、`events.mux` / `events.host` SSE），内部通过 0.2.x 的 Host Services 和事件总线完成兼容翻译，并在前面加 Bearer Token 鉴权：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/remote-api/<method>` | 与 Web `/api/<method>` 完全相同的 RPC（session.list / create / history / prompt / cancel / respond …） |
| POST | `/remote-api/respond` | 回答权限审批、ask-user-question |
| GET | `/remote-api/events.mux` | SSE 会话事件流（消息、assistant chunk、工具、状态） |
| GET | `/remote-api/events.host` | SSE 主机事件流（session/workspace/archived 变化） |
| GET | `/healthz` | 无鉴权存活探针 |

## 安装

一键装 Super Agent + 远程端点（推荐）：在仓库根目录运行 `./install.sh`，见根目录
[README](../../README.md)。

只把远程端点装进某个 profile：

```sh
dsh plugin --profile <profile> add "file:$PWD"
```

或者用独立安装脚本（默认 web profile，并打印重启/验证命令）：

```sh
./scripts/install.sh
```

插件作为 bundle 自动加入 web profile 的 `dsh.profile.bundles`。首次启动时若
`$DSH_HOME/remote/token` 不存在，会自动生成 32 字节随机 token（0600）。

## DSH 0.2.x 兼容层

DSH 0.2.1 把网关改成了 slash 端点、需要 `peer` 的共享 fetch handler，以及 WebSocket
`/api/remote.mux`。iOS App 仍然说旧协议，因此 `lib/compat.js` 直接调用 Host Services
并为 App 翻译：

- 一元方法：`session.list`、`session.history`、`session.create`、`session.prompt`、
  `session.cancel`、`session.rename`、`session.fork`、`session.models`、
  `session.selectModel`、`session.updateQueue`、`workspace.list`、
  `workspace.archiveSession`、`workspace.unarchiveSession`、`workspace.rename`、
  `host.describe`、`host.listDirectory`、`host.createDirectory`。
- `session.history` 使用 0.2.x `follow` 的 opening snapshot，保持旧的
  `{events, hasMore, projections}` 响应。
- `events.mux` 把 `session/event` 和 `agent/assistant-stream` 翻译成旧
  `server-request` 帧；`events.host` 翻译 `agent/status`、session 增删、
  workspace/archived 变化。
- Super Agent 会话和 worker 会话被设置为 `danger-full-access`，并拒绝
  `ask_user_question`，因此远程 App 不需要处理审批/提问；问题通过会话消息转述。

`tests/smoke.test.mjs` 覆盖 Host Service 映射、SSE 帧、Bearer 鉴权、RPC 和 SSE
路由。运行：

```sh
node --test tests/*.test.mjs
```

## 配置

bundle 默认值写在 `cordis.patch.yml`，在 profile 自己的 `cordis.patch.yml`
（`~/.dsh/profiles/web/cordis.patch.yml`）里覆盖即可：

```yaml
- id: dsh-remote
  config:
    enabled: true
    path: /remote-api          # URL 前缀
    listen:
      host: 0.0.0.0            # 127.0.0.1 只允许本机；Tailscale 建议 0.0.0.0
      port: 3443
    auth:
      token: "可选，直接写 token"
      # tokens: ["多个 token 也可以"]
      tokenFile: null          # null = 使用 $DSH_HOME/remote/token
    tls:
      certFile: null           # 同时设置 certFile/keyFile 时启用 HTTPS
      keyFile: null
    maxBodyBytes: 33554432
```

Token 优先级：`auth.token` / `auth.tokens` / `auth.tokenFile`；都没有时才
回落到默认 `$DSH_HOME/remote/token` 并自动创建。Token 至少 16 字符。

## 外网访问

- **推荐 Tailscale**：Mac 和 iPhone 加入同一 tailnet 后，WireGuard 已经加密
  传输，HTTP + token 即可安全使用。
- **公网 HTTPS**：准备证书后设置 `tls.certFile/keyFile`；iOS 端如果使用自签
  名证书，在 App 里填写证书公钥的 SPKI SHA-256（Base64）。不要在没有 TLS
  的情况下把 3443 端口直接暴露到公网。

Token 拥有和 dsh Web 前端相同甚至更高（settings/credentials）的权限，请像
root 密码一样保管。
