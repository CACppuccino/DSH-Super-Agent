#!/bin/sh
# uninstall.sh — remove the Super Agent suite rows from a DSH profile.
#
#   ./uninstall.sh                     # default desktop profile
#   ./uninstall.sh --profile web
#   ./uninstall.sh --purge             # also delete the token and plugin state
#
# The real work is `packages/dsh-suite/uninstall.sh`, which removes the suite
# and both plugin packages from the profile manifest and bundle list. DSH's own
# session history is never touched.
set -eu

err() { printf '%s\n' "uninstall.sh: $*" >&2; }
die() { err "$*"; exit 1; }

if [ -n "${DSH_SUPER_AGENT_SRC:-}" ]; then
  ROOT=$DSH_SUPER_AGENT_SRC
else
  ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || ROOT=''
fi
[ -n "$ROOT" ] && [ -f "$ROOT/packages/dsh-suite/uninstall.sh" ] \
  || die "找不到仓库：请在 DSH-Super-Agent 仓库根目录运行 ./uninstall.sh（或设置 DSH_SUPER_AGENT_SRC）"

exec "$ROOT/packages/dsh-suite/uninstall.sh" "$@"
