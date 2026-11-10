#!/bin/sh
# install.sh — one command to install the Super Agent suite on this Mac.
#
#   ./install.sh --restart                 # from a git clone
#   curl -fsSL <raw install.sh> | sh -s -- --restart    # without cloning
#
# The work is done by `packages/dsh-suite/install.sh`, which stages the three
# packages into $DSH_HOME/plugins, registers the suite as a bundle in the
# target profile, ensures the `dsh-remote` bearer token, verifies
# `/healthz` + an authenticated `session.list`, and prints the server URL and
# token for the iPhone app. This wrapper only locates the repository:
#
#   * clone form — the checkout that contains this script;
#   * piped form — download the branch tarball to a temporary directory and run
#     the installer from there (the temp directory is removed afterwards).
#
# It is safe to re-run: the installer is idempotent.
set -eu

REPO=${DSH_SUPER_AGENT_REPO:-CACppuccino/DSH-Super-Agent}
REF=${DSH_SUPER_AGENT_REF:-main}
ARCHIVE_URL=${DSH_SUPER_AGENT_ARCHIVE:-https://codeload.github.com/${REPO}/tar.gz/refs/heads/${REF}}

err() { printf '%s\n' "install.sh: $*" >&2; }
step() { printf '%s\n' "==> $*"; }
die() { err "$*"; exit 1; }

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Install the Super Agent panel + the dsh-remote endpoint into a DeepSeek Harness
profile, then print the server URL and bearer token for the DSH Remote iPhone
app.

Options:
  --profile <name>      target profile (default: desktop)
  --dsh-home <dir>      Harness home (default: $DSH_HOME or ~/.dsh)
  --port <number>       remote endpoint port (default: 3443)
  --host <address>      listen address used in the printed pairing block
  --token-file <path>   bearer token file (default: <dsh-home>/remote/token)
  --verify-url <url>    base URL the verification calls
  --wait <seconds>      retry budget for a not-yet-loaded endpoint (default: 30)
  --dsh <path>          dsh CLI used for plugin management
  --node <path>         Node.js used by the installer itself
  --pnpm <path>         pnpm used to sync the profile's dependencies
  --restart             quit and reopen DeepSeek Harness (macOS) before verifying
  --verify-only         skip installation; only verify the running endpoint
  --no-verify           skip the healthz/session.list verification
  -h, --help            show this help

Environment:
  DSH_HOME, DSH_PROFILE, DSH_CLI, DSH_NODE, DSH_PNPM, DSH_DESKTOP_APP,
  DSH_SUPER_AGENT_REPO, DSH_SUPER_AGENT_REF, DSH_SUPER_AGENT_ARCHIVE,
  DSH_SUPER_AGENT_SRC
EOF
}

case " $* " in
  *" -h "*|*" --help "*)
    usage
    exit 0
    ;;
esac

# The checkout this script belongs to, or empty when it was piped into sh.
self_root() {
  if [ -n "${DSH_SUPER_AGENT_SRC:-}" ]; then
    [ -f "$DSH_SUPER_AGENT_SRC/packages/dsh-suite/install.sh" ] \
      || die "DSH_SUPER_AGENT_SRC=$DSH_SUPER_AGENT_SRC 不是本仓库的根目录（缺少 packages/dsh-suite/install.sh）"
    printf '%s' "$DSH_SUPER_AGENT_SRC"
    return 0
  fi
  dir=$(CDPATH='' cd -- "$(dirname -- "$0")" 2>/dev/null && pwd) || dir=''
  if [ -n "$dir" ] && [ -f "$dir/packages/dsh-suite/install.sh" ] \
    && [ -f "$dir/packages/dsh-super-agent/package.json" ] \
    && [ -f "$dir/packages/dsh-remote/package.json" ]; then
    printf '%s' "$dir"
  fi
  return 0
}

ROOT=$(self_root)
if [ -z "$ROOT" ]; then
  command -v curl >/dev/null 2>&1 || die "找不到 curl：请先 git clone 仓库再运行 ./install.sh"
  command -v tar >/dev/null 2>&1 || die "找不到 tar：请先 git clone 仓库再运行 ./install.sh"
  TMP=$(mktemp -d "${TMPDIR:-/tmp}/dsh-super-agent.XXXXXX") || die "无法创建临时目录"
  # shellcheck disable=SC2064
  trap 'rm -rf "$TMP"' EXIT
  trap 'rm -rf "$TMP"; exit 130' INT TERM

  step "没有本地仓库：下载 ${REPO}（${REF}）"
  curl -fsSL --retry 2 --connect-timeout 20 "$ARCHIVE_URL" -o "$TMP/repo.tar.gz" \
    || die "下载失败：$ARCHIVE_URL（可以用 DSH_SUPER_AGENT_ARCHIVE 指定镜像/代理地址）"
  tar -xzf "$TMP/repo.tar.gz" -C "$TMP" || die "解压失败：$TMP/repo.tar.gz"
  ROOT=$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n 1)
  [ -n "$ROOT" ] && [ -f "$ROOT/packages/dsh-suite/install.sh" ] \
    || die "压缩包里没有 packages/dsh-suite/install.sh：${ARCHIVE_URL}"
  step "临时仓库：$ROOT"
else
  step "仓库：$ROOT"
fi

set +e
"$ROOT/packages/dsh-suite/install.sh" "$@"
status=$?
set -e
exit "$status"
