#!/usr/bin/env bash
# Register the three browser routes with Claude Code for your user.
set -euo pipefail
server="$HOME/.local/bin/browser-mcp-server"
claude mcp add --scope user browser -- "$server" playwright
claude mcp add --scope user browser-isolated -- "$server" playwright-isolated
# Debugging only; needs remote debugging enabled at chrome://inspect/#remote-debugging.
# claude mcp add --scope user chrome-devtools -- "$server" chrome-devtools
