#!/bin/sh
# uninstall.sh — remove the Super Agent + dsh-remote suite rows from a profile.
#
# The dependencies and bundle entries for the suite and both plugin packages are
# removed, so no row can be inserted twice and the profile boots without them.
# The bearer token and the Super Agent state directory are left alone unless
# --purge is passed; DSH's own session history is never touched.
set -eu

HERE=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
. "$HERE/scripts/shell-lib.sh"

find_node "$@"

case " $* " in
  *" -h "*|*" --help "*)
    run_node "$HERE/scripts/installer.mjs" help
    exit 0
    ;;
esac

PLAN=$(run_node "$HERE/scripts/installer.mjs" plan --self "$HERE" --uninstall "$@") || exit $?
if [ -z "$PLAN" ]; then
  exit 0
fi
eval "$PLAN"

step "DSH_HOME: $DSH_HOME"
step "profile : $PROFILE ($PROFILE_DIR)"

if [ ! -f "$PROFILE_DIR/package.json" ]; then
  warn "profile '$PROFILE' 不存在，没有可移除的 bundle 行"
else
  step "从 profile 移除 $SUITE_NAME 与两个插件包"
  run_node "$HERE/scripts/installer.mjs" edit-manifest --profile-dir "$PROFILE_DIR" --remove >/dev/null \
    || die "更新 profile manifest 失败"

  # Best-effort prune of the installed copies. The rows are already gone from
  # the manifest, so a failing prune only leaves unused files behind.
  if [ -f "$PROFILE_DIR/pnpm-workspace.yaml" ]; then
    if command -v pnpm >/dev/null 2>&1; then
      ( cd "$PROFILE_DIR" && pnpm install ) >/dev/null 2>&1 || warn "pnpm install 未能清理未使用的包（不影响行已移除）"
    else
      app=$(desktop_app)
      pnpm_entry="$app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
      if [ -f "$pnpm_entry" ]; then
        ( cd "$PROFILE_DIR" && run_node "$pnpm_entry" install ) >/dev/null 2>&1 || warn "pnpm install 未能清理未使用的包（不影响行已移除）"
      fi
    fi
  fi
fi

if [ "$PURGE" = 1 ]; then
  step "清除插件数据（--purge）"
  run_node "$HERE/scripts/installer.mjs" purge \
    --dsh-home "$DSH_HOME" --profile "$PROFILE" --token-file "$TOKEN_FILE" \
    || die "清理失败"
fi

printf '%s\n' ""
step "完成"
printf '%s\n' ""
printf '%s\n' "提示：退出并重新打开 DeepSeek Harness 后，Super Agent 侧边栏与 3443 端点才会消失。"
if [ "$PURGE" != 1 ]; then
  printf '%s\n' "Token 与 Super Agent 状态已保留；要一并删除请重新运行：$0 --profile $PROFILE --purge"
fi
