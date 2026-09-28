# The Agent Lanes extension

A fork of Microsoft's Playwright browser extension (see [`UPSTREAM.md`](UPSTREAM.md)
for the exact upstream revision and every local change). It keeps the upstream
manifest public key, so `@playwright/mcp --extension` resolves the same extension
ID (`mmlmfjhmonkocbjadbfplnigmagldckm`). That also means it cannot be installed next
to the Chrome Web Store "Playwright MCP Bridge" extension: remove that one first.

## Build

```sh
npm ci
npm run typecheck
npm run build      # writes out/
```

`scripts/install.sh` does this for you and then copies `out/` into
`~/.local/share/agent-lanes/extension` with `bin/install-extension`, which records
a SHA-256 for every file plus an owner-only pin. Load **that** directory with
"Load unpacked" in `chrome://extensions`. The MCP launcher refuses to connect unless
Chrome's own extension record points at exactly that path and every hash matches.

Reloading on `chrome://extensions` is the only thing that loads a new build. A
Chrome restart keeps running the version that was loaded before.

## What it does differently from upstream

- **Lanes instead of your tabs.** Every agent session is a background tab created
  inside a *lane*: a normal-type, normal-state, never-focused Chrome window with one
  inert anchor tab and room for 16 session tabs. Four lanes are the default pool.
  Connections never create windows.
- **A stage per lane.** Chrome renders and accepts trusted input only for the active
  tab of a window, so each lane activates one session's tab at a time, only while
  that session has a command running, and never preempts a command in flight.
- **No focus changes.** `Page.bringToFront` and `Target.activateTarget` are
  suppressed. Tab activation inside a lane (`chrome.tabs.update`) changes only the
  tab strip; it never focuses the window or changes the order Chrome uses to route
  external links.
- **A lane guard.** A tab that lands in a lane without being asked for (an external
  link, a restored tab) is moved to your own window. A lane you focus, move, resize,
  minimize, or maximize becomes yours; its sessions end and its tabs are kept.
- **The hidden display.** When the Agent Lanes virtual display is present
  (`agent-display/`), lanes are placed on it and every other window is kept off it.
  Focus that lands on a hidden lane is handed straight back to your window.
- **Native messaging only.** The MCP server reaches the extension through an
  allowlisted native messaging host and an owner-only Unix socket, so the pairing
  token never appears in an MCP config, environment, argument list, or URL.

Private pool workspaces intentionally create **no Chrome tab groups**. Exact
owned-tab IDs provide isolation and cleanup within a shared lane without needing a
group. Chrome keeps (and can sync) closed group records, so per-task grouping made the
tab-group menu grow after every agent task.

## Recovery

Lanes and sessions are recorded in `chrome.storage.local`. After a service-worker
restart, dead sessions' tabs are removed and lanes are re-adopted by their anchor's
marker URL. After an extension reload, each anchor becomes a new-tab "husk"; the
loader re-anchors a husk when its record comes from the same Chrome process or when
it sits on the Agent Lanes display. An unproven husk on a visible screen is left
alone, because after a full Chrome restart a numeric window ID can point at one of
your own windows. A `chrome.runtime.onStartup` listener wakes the service worker
after every Chrome restart so the native host reconnects on its own.

This is an ownership boundary between agent sessions, not an authorization
boundary. Every session acts with your logins; see [`../docs/security.md`](../docs/security.md).
