#!/usr/bin/env bash
# Remove everything scripts/install.sh put on this Mac.
#
#   scripts/uninstall.sh          keeps ~/.config/agent-lanes (the token)
#   scripts/uninstall.sh --purge  removes that too, and the state directory
#
# Remove the unpacked extension yourself in chrome://extensions; this script
# never edits your Chrome profile.
set -euo pipefail

purge=0
[ "${1:-}" = "--purge" ] && purge=1

BIN="$HOME/.local/bin"
DISPLAY_LABEL="agency.ziplyne.agent-lane-display"
PLIST="$HOME/Library/LaunchAgents/$DISPLAY_LABEL.plist"
HOST="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/agency.ziplyne.agent_lanes.json"
APP="$HOME/Applications/Google Chrome (Agent Safe).app"

if [ -f "$HOME/.config/agent-lanes/dock" ] && [ -x "$BIN/install-chrome-background-safe" ]; then
  # Put the regular Chrome tile back before the launcher disappears.
  "$BIN/install-chrome-background-safe" --dock-mode running >/dev/null 2>&1 || true
fi
if [ "${AGENT_LANES_SKIP_LAUNCHD:-0}" != 1 ]; then
  launchctl bootout "gui/$(id -u)/$DISPLAY_LABEL" 2>/dev/null || true
fi
rm -f "$PLIST" "$HOST"
for tool in agent-lane-display browser-mcp-server playwright-mcp-native-bridge chrome-background-safe install-chrome-background-safe; do
  rm -f "$BIN/$tool"
done
[ -d "$APP" ] && rm -rf "$APP"
rm -rf "$HOME/.local/share/agent-lanes" "$HOME/.local/lib/agent-lanes"
if [ "$purge" = 1 ]; then
  rm -rf "$HOME/.config/agent-lanes" "$HOME/.local/state/agent-lanes"
fi
echo "Removed Agent Lanes for Chrome. Remove the unpacked extension in chrome://extensions."
