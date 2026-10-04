#!/usr/bin/env bash
# Install Agent Lanes for Chrome for the current macOS user.
#
#   scripts/install.sh              extension, bridge, launcher app, agent display
#   scripts/install.sh --dock       also swap Chrome's Dock tile for the launcher
#   scripts/install.sh --no-display skip the invisible Agent Lanes display helper
#
# Nothing here touches your Chrome profile. Loading the unpacked extension is a
# step you do yourself in chrome://extensions; the script prints it at the end.
# Every file it replaces is backed up under ~/.local/state/agent-lanes/backups.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
dock=0
display=1
for arg in "$@"; do
  case "$arg" in
    --dock) dock=1 ;;
    --no-display) display=0 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown option $arg" >&2; exit 2 ;;
  esac
done

BIN="$HOME/.local/bin"
SHARE="$HOME/.local/share/agent-lanes"
RUNTIME="$HOME/.local/lib/agent-lanes"
CONFIG="$HOME/.config/agent-lanes"
STATE="$HOME/.local/state/agent-lanes"
NATIVE_HOSTS="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
HOST_NAME="agency.ziplyne.agent_lanes"
DISPLAY_LABEL="agency.ziplyne.agent-lane-display"
BACKUP="$STATE/backups/$(date +%Y%m%d-%H%M%S)"
# The launcher, the Chrome checks, and the MCP launcher all expect this exact path.
CHROME_APP="/Applications/Google Chrome.app"

say() { printf '==> %s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

# Copy a file into place, keeping a backup of whatever it replaces.
place() {
  local src="$1" dest="$2" mode="${3:-644}"
  mkdir -p "$(dirname "$dest")"
  if [ -e "$dest" ] && ! cmp -s "$src" "$dest"; then
    mkdir -p "$BACKUP$(dirname "$dest")"
    cp -p "$dest" "$BACKUP$dest"
  fi
  cp "$src" "$dest.tmp.$$"
  chmod "$mode" "$dest.tmp.$$"
  mv -f "$dest.tmp.$$" "$dest"
}

render() { sed "s|__HOME__|$HOME|g" "$1"; }

cdhash() { [ -e "$1" ] && codesign -dvvv "$1" 2>&1 | sed -n 's/^CDHash=//p'; }

preflight() {
  [ "$(uname -s)" = Darwin ] || fail "macOS only (the launcher, native host paths, and display helper are macOS-specific)"
  [ -d "$CHROME_APP" ] || fail "Google Chrome is not installed at $CHROME_APP"
  command -v node >/dev/null || fail "Node.js 20 or newer is required (brew install node)"
  local node_major
  node_major="$(node -p 'process.versions.node.split(".")[0]')"
  [ "$node_major" -ge 20 ] || fail "Node.js 20 or newer is required (found $(node -v))"
  command -v npm >/dev/null || fail "npm is required"
  # /usr/bin/python3 and clang are stubs until the Command Line Tools are installed.
  xcode-select -p >/dev/null 2>&1 || fail "the Xcode Command Line Tools are required (xcode-select --install)"
  /usr/bin/python3 -c "import sys" >/dev/null 2>&1 || fail "/usr/bin/python3 does not run (xcode-select --install)"
  if [ "$display" = 1 ]; then
    /usr/bin/xcrun --find clang >/dev/null 2>&1 || fail "clang is required for the display helper (xcode-select --install), or pass --no-display"
  fi
}

install_extension() {
  say "Building the extension"
  npm --prefix "$REPO/extension" ci --no-audit --no-fund --silent
  npm --prefix "$REPO/extension" run build --silent >/dev/null
  mkdir -p "$SHARE" "$CONFIG"
  chmod 700 "$CONFIG"
  "$REPO/bin/install-extension" --source "$REPO/extension/out" --dest "$SHARE/extension"
}

install_tools() {
  say "Installing the bridge and launcher tools into $BIN"
  for tool in browser-mcp-server playwright-mcp-native-bridge chrome-background-safe install-chrome-background-safe; do
    place "$REPO/bin/$tool" "$BIN/$tool" 755
  done
}

install_runtime() {
  say "Installing the pinned MCP servers into $RUNTIME"
  mkdir -p "$RUNTIME"
  for file in package.json package-lock.json lane-popups.js; do
    place "$REPO/mcp-runtime/$file" "$RUNTIME/$file"
  done
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --silent --prefix "$RUNTIME"
}

install_token() {
  mkdir -p "$CONFIG"
  chmod 700 "$CONFIG"
  if [ -f "$CONFIG/token" ]; then
    say "Keeping the existing bridge token"
  else
    say "Creating the owner-only bridge token"
    /usr/bin/python3 - "$CONFIG/token" <<'PY'
import os, secrets, sys
fd = os.open(sys.argv[1], os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
os.write(fd, secrets.token_urlsafe(32).encode() + b"\n")
os.close(fd)
PY
  fi
  chmod 600 "$CONFIG/token"
  "$BIN/playwright-mcp-native-bridge" --check-token >/dev/null || fail "the bridge rejected the token file"
}

install_native_host() {
  say "Registering the native messaging host $HOST_NAME"
  local rendered
  rendered="$(mktemp "${TMPDIR:-/tmp}/native-host.XXXXXX")"
  render "$REPO/native-messaging/$HOST_NAME.json" > "$rendered"
  place "$rendered" "$NATIVE_HOSTS/$HOST_NAME.json"
  rm -f "${rendered:?}"
}

install_launcher() {
  say "Installing ~/Applications/Google Chrome (Agent Safe).app"
  local args=(--source-contents "$REPO/launcher/Contents" --backup-root "$BACKUP")
  if [ "$dock" = 1 ]; then
    args+=(--dock)
    if "$BIN/chrome-background-safe" --check >/dev/null 2>&1; then
      args+=(--preserve-running-chrome)
    fi
    touch "$CONFIG/dock"
  else
    rm -f "$CONFIG/dock"
  fi
  "$BIN/install-chrome-background-safe" "${args[@]}" >/dev/null
}

install_display() {
  [ "$display" = 1 ] || { say "Skipping the Agent Lanes display (--no-display)"; return; }
  say "Building and starting the Agent Lanes display helper"
  local build plist="$LAUNCH_AGENTS/$DISPLAY_LABEL.plist" rendered changed=0
  build="$(mktemp "${TMPDIR:-/tmp}/agent-lane-display.XXXXXX")"
  /usr/bin/xcrun clang -fobjc-arc -O2 -Wall -framework AppKit -framework CoreGraphics -framework ApplicationServices \
    -o "$build" "$REPO/agent-display/agent-lane-display.m"
  # The guards need Accessibility, which macOS ties to the code signature. Set
  # AGENT_LANES_SIGN_IDENTITY to a Developer ID to keep one grant across
  # rebuilds; ad hoc signing needs a fresh grant whenever the code changes.
  codesign --force --sign "${AGENT_LANES_SIGN_IDENTITY:--}" --identifier "$DISPLAY_LABEL" --timestamp=none "$build" 2>/dev/null
  if [ "$(cdhash "$build")" != "$(cdhash "$BIN/agent-lane-display" 2>/dev/null)" ]; then
    place "$build" "$BIN/agent-lane-display" 755
    rm -f "$STATE/display/accessibility-prompted"
    changed=1
  fi
  rm -f "${build:?}"
  rendered="$(mktemp "${TMPDIR:-/tmp}/display-plist.XXXXXX")"
  render "$REPO/agent-display/$DISPLAY_LABEL.plist" > "$rendered"
  if ! cmp -s "$rendered" "$plist" 2>/dev/null; then
    place "$rendered" "$plist"
    changed=1
  fi
  rm -f "${rendered:?}"
  mkdir -p "$HOME/.cache"
  if [ "${AGENT_LANES_SKIP_LAUNCHD:-0}" = 1 ]; then
    return
  fi
  local target="gui/$(id -u)/$DISPLAY_LABEL"
  if [ "$changed" = 1 ] || ! launchctl print "$target" >/dev/null 2>&1; then
    launchctl bootout "$target" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$plist"
  fi
}

print_next_steps() {
  cat <<EOF

Installed. Five things are left, and they are yours to do:

  1. Remove the Chrome Web Store "Playwright MCP Bridge" extension if you have it.
     It shares this extension's ID.
  2. Quit Chrome with Command-Q, then open it again with
     ~/Applications/Google Chrome (Agent Safe).app
     (that launcher adds --disable-backgrounding-occluded-windows, which the agent
     windows need).
  3. In chrome://extensions turn on Developer mode, click "Load unpacked", and pick
       $SHARE/extension
     Load that folder, not the one in this checkout: the launcher checks that Chrome
     loaded exactly that path.
  4. Click into Chrome once. The launcher creates the agent windows, then check:
       ~/.local/bin/playwright-mcp-native-bridge --status
  5. Allow Accessibility for agent-lane-display when macOS asks (or in System
     Settings, Privacy & Security, Accessibility). It keeps other apps' windows,
     and the keyboard focus, off the invisible Agent Lanes screen.

Then point your agent at the MCP server (see docs/install.md for Claude Code,
Codex, and Cursor):

  command: $BIN/browser-mcp-server
  args:    ["playwright"]

Backups of anything replaced: $BACKUP
EOF
}

preflight
install_extension
install_tools
install_runtime
install_token
install_native_host
install_launcher
install_display
print_next_steps
