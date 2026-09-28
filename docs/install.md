# Install

## Requirements

- macOS. Only macOS 27.0 on Apple silicon, with two monitors, has been tested.
- Google Chrome in `/Applications` (tested on Chrome 154; auto-connect debugging needs
  144+)
- Node.js 20 or newer, and npm
- Xcode Command Line Tools (`xcode-select --install`) for `/usr/bin/python3` and
  `clang`

## 1. Run the installer

```bash
git clone https://github.com/ZipLyne-Agency/agent-lanes.git
cd agent-lanes
scripts/install.sh
```

It builds the extension, installs the tools into `~/.local/bin`, the pinned MCP
servers into `~/.local/lib/agent-lanes`, the extension into
`~/.local/share/agent-lanes/extension`, a fresh owner-only token into
`~/.config/agent-lanes/token`, the native messaging host, the launcher app into
`~/Applications`, and the display helper as a launchd agent. Anything it replaces is
backed up under `~/.local/state/agent-lanes/backups`.

Options:

| Option | Effect |
|---|---|
| `--dock` | Replace Chrome's Dock tile with the launcher app. While Chrome runs, the tile switches back to the real Chrome so the Dock shows one icon. |
| `--no-display` | Skip the invisible display. Lanes then sit stacked in a corner of your screen. |

The installer never edits your Chrome profile and never touches another app's Dock
tile.

## 2. Finish in Chrome

These steps are yours; Chrome treats them as human-only.

1. **Remove the Web Store "Playwright MCP Bridge" extension** if you have it. This
   extension reuses its ID so `@playwright/mcp` can find it.
2. **Reopen Chrome with the launcher.** Quit Chrome with Command-Q, then open
   `~/Applications/Google Chrome (Agent Safe).app` (or the Dock icon with `--dock`).
   It starts Chrome with `--disable-backgrounding-occluded-windows`. Always open
   Chrome this way from now on.
3. **Load the extension.** In `chrome://extensions`, turn on Developer mode, click
   **Load unpacked**, and choose `~/.local/share/agent-lanes/extension`
   (press Command-Shift-. in the file picker to see hidden folders). Load that folder,
   not the one in your checkout: the MCP launcher checks that Chrome loaded exactly
   that path.
4. **Let the pool fill.** Click into Chrome for a few seconds. The launcher creates four
   lane windows on the hidden display. Check:

   ```bash
   ~/.local/bin/playwright-mcp-native-bridge --status
   ```

   `parkedWorkspaceCount` should be 4 and `agentDisplay.present` should be `true`.

## 3. Connect your agents

Use the absolute path; JSON and TOML configs do not expand `~`.

**Claude Code**

```bash
claude mcp add --scope user browser -- "$HOME/.local/bin/browser-mcp-server" playwright
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.browser]
command = "/Users/you/.local/bin/browser-mcp-server"
args = ["playwright"]
```

**Cursor** (`~/.cursor/mcp.json`) and **Claude Desktop**

```json
{
  "mcpServers": {
    "browser": {
      "command": "/Users/you/.local/bin/browser-mcp-server",
      "args": ["playwright"]
    }
  }
}
```

More in [`../examples`](../examples). Give your agents the rules in
[`../AGENTS.md`](../AGENTS.md), or install the skill in
[`../skills/browser-mcp`](../skills/browser-mcp).

### Optional: the other two routes

- `browser-mcp-server playwright-isolated` runs a clean, logged-out headless Chromium
  for public pages. It needs Playwright's headless shell, installed with the
  Playwright bundled in the MCP runtime:
  `node ~/.local/lib/agent-lanes/node_modules/playwright/cli.js install --only-shell chromium`.
  The launcher picks the newest headless shell it finds.
- `browser-mcp-server chrome-devtools` runs Chrome DevTools MCP with `--autoConnect
  --channel stable --redactNetworkHeaders`, for debugging only. You have to enable
  remote debugging at `chrome://inspect/#remote-debugging` and approve Chrome's
  dialog, and only one client may use it at a time.

## Settings

The launcher reads these environment variables; the defaults suit a standard install.

| Variable | Default | Use |
|---|---|---|
| `PLAYWRIGHT_MCP_CANARY_PROFILE_DIR` | `~/Library/Application Support/Google/Chrome/Default` | Your Chrome profile folder, if you do not use `Default` |
| `PLAYWRIGHT_MCP_CANARY_DIR` | `~/.local/share/agent-lanes/extension` | Where the extension is installed |
| `PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE` | `~/.config/agent-lanes/token` | The bridge token |
| `PLAYWRIGHT_MCP_LANE_ACTION_TIMEOUT_MS` | `20000` | Playwright's action timeout inside a shared lane |

## Update

```bash
git pull
scripts/install.sh
```

Then click **Reload** on the extension's card in `chrome://extensions`. Restarting
Chrome does not load a new build.

## Uninstall

```bash
scripts/uninstall.sh            # keeps ~/.config/agent-lanes
scripts/uninstall.sh --purge    # removes that too
```

Then remove the extension in `chrome://extensions`.

## FAQ

**The launcher says the extension is not loaded, but it is.** Chrome loaded it from a
different folder, usually your checkout's `extension/out`. Remove it and load
`~/.local/share/agent-lanes/extension`.

**Agents say "must be foreground" or ask me to click into Chrome.** The pool ran empty
and could not be refilled in the background. Check that the display is up
(`~/.local/bin/agent-lane-display status`) and whether
`~/.local/state/agent-lanes/background-prep-disabled.json` exists (see
[operations](operations.md#refill)).

**Chrome says it is "not-ready".** Chrome was opened without the launcher, or
relaunched itself after a crash. Quit it with Command-Q and open it with the launcher.

**Will this interfere with my screen sharing?** Screen-share pickers list a third
display called Agent Lanes. Share a specific screen or window.

**Does this work with multiple Chrome profiles?** It drives the profile that loaded the
extension, by default `Default`. Set `PLAYWRIGHT_MCP_CANARY_PROFILE_DIR` for another.

**Why is the extension ID the same as Microsoft's?** `@playwright/mcp` hardcodes that ID
in its connect flow, so the fork keeps the upstream manifest key. See
[`../NOTICE`](../NOTICE).
