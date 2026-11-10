#!/bin/sh
# Shared helpers for install.sh / uninstall.sh.
#
# Sourced, never executed. The calling script sets HERE to its own directory
# before sourcing this file.

err() { printf '%s\n' "$(basename -- "$0"): $*" >&2; }
warn() { err "警告: $*"; }
step() { printf '%s\n' "==> $*"; }
die() { err "$*"; exit 1; }

# The Desktop app bundle: its bundled dsh CLI owns the reserved `desktop`
# profile, and its bundled pnpm/Node are the only ones a fresh Mac is
# guaranteed to have.
desktop_app() {
  printf '%s' "${DSH_DESKTOP_APP:-/Applications/DeepSeek Harness.app}"
}

# Value of `--name <value>` / `--name=value` in the given arguments, or empty.
# Used for the tool overrides that must be known before the Node helper runs.
arg_value() {
  _flag=$1
  shift
  _want=0
  for _arg in "$@"; do
    case "$_arg" in
      "$_flag")
        _want=1
        ;;
      "$_flag"=*)
        printf '%s' "${_arg#*=}"
        return 0
        ;;
      --*)
        _want=0
        ;;
      *)
        if [ "$_want" = 1 ]; then
          printf '%s' "$_arg"
          return 0
        fi
        ;;
    esac
  done
  return 0
}

# Pick an interpreter for the Node helper: --node / DSH_NODE, then PATH, then
# the Desktop app's Electron binary in Node mode.
find_node() {
  node_override=$(arg_value --node "$@")
  if [ -n "$node_override" ]; then
    DSH_NODE=$node_override
  fi
  if [ -n "${DSH_NODE:-}" ]; then
    [ -x "$DSH_NODE" ] || die "DSH_NODE=$DSH_NODE 不可执行"
    DSH_NODE_BIN=$DSH_NODE
    DSH_NODE_KIND=bin
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    DSH_NODE_BIN=$(command -v node)
    DSH_NODE_KIND=bin
    return 0
  fi
  app=$(desktop_app)
  if [ -x "$app/Contents/MacOS/DeepSeek Harness" ]; then
    DSH_NODE_BIN="$app/Contents/MacOS/DeepSeek Harness"
    DSH_NODE_KIND=electron
    return 0
  fi
  die "找不到 Node.js：安装 Node 22+，或设置 DSH_NODE=/path/to/node，或先安装 DeepSeek Harness 桌面版"
}

# Run the Node helper with the interpreter found above.
run_node() {
  if [ "$DSH_NODE_KIND" = electron ]; then
    ELECTRON_RUN_AS_NODE=1 "$DSH_NODE_BIN" --expose-internals "$@"
  else
    "$DSH_NODE_BIN" "$@"
  fi
}

# Candidate `dsh` CLIs in preference order, one per line. An explicit --dsh or
# $DSH_CLI wins outright and disables the search.
find_dsh_clis() {
  if [ -n "${DSH_CLI:-}" ]; then
    printf '%s\n' "$DSH_CLI"
    return 0
  fi
  app=$(desktop_app)
  bundled="$app/Contents/Resources/runtime/cli/bin/dsh"
  [ -x "$bundled" ] && printf '%s\n' "$bundled"
  command -v dsh 2>/dev/null || true
}

# Ensure pnpm's hoisted layout: the staged plugin packages must land in the
# profile's own node_modules, because a bundle patch row resolves by bare
# package name from the profile directory.
ensure_workspace_yaml() {
  workspace="$PROFILE_DIR/pnpm-workspace.yaml"
  if [ ! -f "$workspace" ]; then
    printf 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n' > "$workspace"
    return 0
  fi
  if grep -Eq '^[[:space:]]*nodeLinker:' "$workspace"; then
    if ! grep -Eq '^[[:space:]]*nodeLinker:[[:space:]]*["'"'"']?hoisted["'"'"']?[[:space:]]*$' "$workspace"; then
      die "$workspace 的 nodeLinker 不是 hoisted；插件行需要 hoisted 布局才能从 profile 解析，改好后重试"
    fi
    return 0
  fi
  printf '\nnodeLinker: hoisted\n' >> "$workspace"
}

# Install the profile's dependencies with the best available pnpm.
# `$1` is "strict" (default: failure aborts) or "best-effort" (failure warns).
run_pnpm_install() {
  mode=${1:-strict}
  ensure_workspace_yaml
  step "同步 profile 依赖（${PROFILE_DIR}）"
  failed=0
  if [ -n "${DSH_PNPM:-}" ]; then
    ( cd "$PROFILE_DIR" && "$DSH_PNPM" install ) || failed=1
  elif command -v pnpm >/dev/null 2>&1; then
    ( cd "$PROFILE_DIR" && pnpm install ) || failed=1
  else
    app=$(desktop_app)
    pnpm_entry="$app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
    if [ ! -f "$pnpm_entry" ]; then
      if [ "$mode" = best-effort ]; then
        warn "找不到 pnpm，跳过依赖同步"
        return 0
      fi
      die "找不到 pnpm：安装 pnpm（npm i -g pnpm）或设置 DSH_PNPM=/path/to/pnpm，或安装 DeepSeek Harness 桌面版"
    fi
    ( cd "$PROFILE_DIR" && run_node "$pnpm_entry" install ) || failed=1
  fi
  if [ "$failed" = 1 ]; then
    if [ "$mode" = best-effort ]; then
      warn "pnpm install 失败；bundle 行已写入，可稍后手动运行 pnpm install"
      return 0
    fi
    die "pnpm install 失败"
  fi
}
