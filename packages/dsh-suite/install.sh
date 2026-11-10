#!/bin/sh
# install.sh — install the Super Agent + dsh-remote suite into a DSH profile.
#
# The suite is one bundle package: it depends on the two plugin packages in
# this repository (`file:../dsh-super-agent`, `file:../dsh-remote`) and its
# patch inserts both rows with the defaults the DSH Remote iPhone app expects.
# This script:
#
#   1. resolves the Harness home and target profile (default: desktop),
#   2. stages an immutable copy of the three packages under $DSH_HOME/plugins,
#   3. installs it through the dsh CLI, falling back to the profile's
#      package.json + pnpm when the CLI cannot manage the reserved profile,
#   4. ensures the bearer token exists (0600),
#   5. verifies GET /healthz and an authenticated session.list,
#   6. prints exactly what to type into the phone.
#
# It is idempotent: re-running repairs the dependency row, the bundle entry,
# the token mode, and re-verifies. It never edits a profile while a DSH process
# is using it beyond what the plugin manager itself does (pnpm add).
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/scripts/shell-lib.sh"

# Tool overrides must be known before the Node helper runs, so they are read
# from the raw arguments here as well as validated by the plan below.
pnpm_override=$(arg_value --pnpm "$@")
if [ -n "$pnpm_override" ]; then
  DSH_PNPM=$pnpm_override
fi
find_node "$@"

case " $* " in
  *" -h "*|*" --help "*)
    run_node "$HERE/scripts/installer.mjs" help
    exit 0
    ;;
esac

PLAN=$(run_node "$HERE/scripts/installer.mjs" plan --self "$HERE" "$@") || exit $?
if [ -z "$PLAN" ]; then
  exit 0
fi
eval "$PLAN"

step "DSH_HOME: $DSH_HOME"
step "profile : $PROFILE ($PROFILE_DIR)"
step "suite   : $SUITE_NAME $SUITE_VERSION"

if [ ! -d "$DSH_HOME" ]; then
  mkdir -p "$DSH_HOME"
  chmod 700 "$DSH_HOME"
fi

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  if [ "$PROFILE" = desktop ]; then
    die "找不到 $PROFILE_DIR/package.json：请先打开一次 DeepSeek Harness 桌面版（首次启动会创建 desktop profile），再重新运行本脚本。"
  fi
  warn "profile '$PROFILE' 还不存在：将尝试用 dsh CLI 按模板初始化"
fi

if [ "$VERIFY_ONLY" = 1 ]; then
  step "跳过安装（--verify-only）"
else
  step "把套件与两个插件复制到 $STAGE_DIR"
  run_node "$HERE/scripts/installer.mjs" stage --self "$HERE" --stage "$STAGE_DIR" >/dev/null \
    || die "复制套件失败（需要同一仓库里的 packages/dsh-super-agent 与 packages/dsh-remote）"

  installed=0
  cli_list=$(mktemp "${TMPDIR:-/tmp}/dsh-suite-clis.XXXXXX") || die "无法创建临时文件"
  find_dsh_clis > "$cli_list"
  while IFS= read -r cli; do
    [ -n "$cli" ] || continue
    step "用 dsh CLI 安装：$cli"
    if "$cli" plugin --profile "$PROFILE" add "$SUITE_SPEC"; then
      installed=1
      break
    fi
    warn "这个 dsh CLI 没能完成安装，尝试下一个方案"
  done < "$cli_list"
  rm -f "$cli_list"

  if [ "$installed" = 1 ]; then
    run_node "$HERE/scripts/installer.mjs" edit-manifest \
      --profile-dir "$PROFILE_DIR" --suite-spec "$SUITE_SPEC" >/dev/null \
      || die "更新 profile manifest 失败"
    # A profile that previously listed the two plugins on their own still has
    # their symlinks in node_modules; one install prunes them so every row
    # resolves to the staged copies inside the suite snapshot.
    run_pnpm_install best-effort
  else
    warn "dsh CLI 不可用，回退到 profile package.json + pnpm"
    if [ ! -f "$PROFILE_DIR/package.json" ]; then
      die "profile '$PROFILE' 不存在，且没有可用的 dsh CLI 来初始化它；请先运行一次 DeepSeek Harness"
    fi
    run_node "$HERE/scripts/installer.mjs" edit-manifest \
      --profile-dir "$PROFILE_DIR" --suite-spec "$SUITE_SPEC" >/dev/null \
      || die "更新 profile manifest 失败"
    run_pnpm_install
    # pnpm may have reconciled the bundle list; normalize once more so the
    # standalone plugin names can never insert the rows twice.
    run_node "$HERE/scripts/installer.mjs" edit-manifest \
      --profile-dir "$PROFILE_DIR" --suite-spec "$SUITE_SPEC" >/dev/null \
      || die "更新 profile manifest 失败"
  fi
  run_node "$HERE/scripts/installer.mjs" prune-stage --home "$DSH_HOME" --keep "$STAGE_DIR" \
    || warn "清理旧套件副本失败（不影响安装）"
  step "安装完成（bundle 行已写入 $PROFILE_DIR/package.json）"
fi

step "确保 Bearer token 存在：$TOKEN_FILE"
TOKEN=$(run_node "$HERE/scripts/installer.mjs" ensure-token --file "$TOKEN_FILE") \
  || die "创建 token 失败"
[ -n "$TOKEN" ] || die "token 为空，检查 $TOKEN_FILE"

if [ "$RESTART" = 1 ]; then
  if [ "$(uname -s)" != Darwin ]; then
    warn "--restart 目前只支持 macOS，请手动重启 DSH"
  elif [ "$DSH_HOME" != "${HOME}/.dsh" ] && [ "$DSH_HOME" != "${HOME}/.dsh/" ]; then
    warn "--restart 只对默认 DSH_HOME（~/.dsh）生效；当前是 $DSH_HOME，请手动用同一个 DSH_HOME 重启 DSH"
  else
    step "重启 DeepSeek Harness"
    osascript -e 'tell application "DeepSeek Harness" to quit' >/dev/null 2>&1 || true
    sleep 2
    open -a "DeepSeek Harness" >/dev/null 2>&1 || warn "无法自动打开 DeepSeek Harness，请手动打开"
  fi
fi

if [ "$NO_VERIFY" = 1 ]; then
  step "跳过验证（--no-verify）"
else
  step "验证端点：${VERIFY_URL}（最多等待 ${WAIT_SECONDS}s）"
  if ! run_node "$HERE/scripts/installer.mjs" verify \
    --base-url "$VERIFY_URL" --prefix "$PATH_PREFIX" \
    --token-file "$TOKEN_FILE" --wait "$WAIT_SECONDS"; then
    printf '\n' >&2
    err "验证未通过。这通常是因为 DSH 还没重启，新 bundle 行尚未加载。"
    err "请先退出并重新打开 DeepSeek Harness（桌面版），然后运行：$0 --verify-only"
    exit 2
  fi
fi

step "配对信息"
extra_tailscale=''
if command -v tailscale >/dev/null 2>&1; then
  extra_tailscale=$(tailscale ip -4 2>/dev/null | tr '\n' ',' | sed 's/,$//') || extra_tailscale=''
fi
if [ -n "$extra_tailscale" ]; then
  run_node "$HERE/scripts/installer.mjs" pairing \
    --host "$LISTEN_HOST" --port "$PORT" --prefix "$PATH_PREFIX" \
    --profile "$PROFILE" --token-file "$TOKEN_FILE" \
    --extra-tailscale "$extra_tailscale"
else
  run_node "$HERE/scripts/installer.mjs" pairing \
    --host "$LISTEN_HOST" --port "$PORT" --prefix "$PATH_PREFIX" \
    --profile "$PROFILE" --token-file "$TOKEN_FILE"
fi

if [ "$VERIFY_ONLY" != 1 ]; then
  printf '%s\n' ""
  printf '%s\n' "提示：如果 Super Agent 侧边栏和 3443 端口还没出现，退出并重新打开 DeepSeek Harness 即可。"
  printf '%s\n' "卸载：$HERE/uninstall.sh --profile $PROFILE"
fi
