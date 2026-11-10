# dsh-suite

Bundle + 安装器：把 [Super Agent](../dsh-super-agent) 面板和 [dsh-remote](../dsh-remote)
端点装成一套。

**用户文档在仓库根目录的 [README](../../README.md)**（一键安装、iPhone 配对、排错、卸载）。
这里只记安装器本身的结构。

```
dsh-suite/
├── package.json          # name/version/files/engines + dsh.bundle.patch
├── cordis.patch.yml      # 一个 bundle 层插入 dsh-super-agent + dsh-remote 两行
├── install.sh            # 安装流程（POSIX sh，普通用户从这里进；根目录的 install.sh 只是入口包装）
├── uninstall.sh          # 卸载（--purge 清插件数据）
├── scripts/
│   ├── installer.mjs     # plan/stage/prune-stage/edit-manifest/ensure-token/verify/pairing/purge
│   ├── shell-lib.sh      # Node/pnpm/CLI 探测与 profile 依赖同步
│   └── lib/              # 纯逻辑：plan / packages / net / manifest / verify
└── test/                 # node --test：参数、URL、manifest、验证、installer CLI
```

## 一次 stage 是什么

`install.sh` 把三个同级包复制成一份不可变快照：

```
$DSH_HOME/plugins/@local/dsh-suite/<版本>-<内容哈希>/
├── dsh-suite/            # 本包（bundle 根）
├── dsh-super-agent/      # file:../dsh-super-agent 指向这里
└── dsh-remote/           # file:../dsh-remote 指向这里
```

profile 里记录的依赖是 `file:<快照>/dsh-suite`，所以套件自己的 `file:../<name>` 在
快照内、在克隆里都解析到同一份源码。目录名带全部三包内容哈希，重装换了内容也不会
命中 pnpm 的旧快照。

只复制各包 `package.json` 的 `files` 字段列出的文件，`test/`、`node_modules/`、散落的
`*.tgz` 都不会进 profile。

## 测试

```sh
npm test        # node --test test/*.test.mjs
```

纯逻辑 + 临时目录，不需要正在运行的 DSH。
