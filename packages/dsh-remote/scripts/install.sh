#!/bin/sh
# Install dsh-remote as a bundle into the `web` profile and print next steps.
set -eu

PLUGIN_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
TOKEN_FILE="${DSH_HOME:-$HOME/.dsh}/remote/token"

# `dsh plugin` forwards to pnpm. macOS Homebrew ships pnpm through corepack
# rather than a standalone binary; install a thin shim into ~/.local/bin.
if ! command -v pnpm >/dev/null 2>&1 && command -v corepack >/dev/null 2>&1; then
  mkdir -p "$HOME/.local/bin"
  if [ ! -e "$HOME/.local/bin/pnpm" ]; then
    cat > "$HOME/.local/bin/pnpm" <<'SHIM'
#!/bin/sh
export COREPACK_HOME="$HOME/.dsh/corepack"
exec corepack pnpm "$@"
SHIM
    chmod +x "$HOME/.local/bin/pnpm"
  fi
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "==> adding dsh-remote ($PLUGIN_DIR) to the web profile"
dsh plugin --profile web add "file:$PLUGIN_DIR"

echo "==> ensuring a bearer token exists"
mkdir -p "$(dirname "$TOKEN_FILE")"
if [ ! -f "$TOKEN_FILE" ]; then
  node "$PLUGIN_DIR/scripts/gen-token.mjs" "$TOKEN_FILE" >/dev/null
  chmod 600 "$TOKEN_FILE"
fi
TOKEN="$(cat "$TOKEN_FILE")"
echo "    token: $TOKEN"
echo ""
echo "==> restart the process that boots the web profile so the new row loads:"
echo "    #   a launchd service: launchctl kickstart -k gui/$(id -u)/<your-service-label>"
echo "    #   a foreground dsh web: stop it (Ctrl-C) and start it again"
echo ""
echo "==> verify:"
echo "    curl -fsS -H \"Authorization: Bearer $TOKEN\" http://127.0.0.1:3443/healthz"
