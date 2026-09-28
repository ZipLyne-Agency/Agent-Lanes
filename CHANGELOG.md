# Changelog

Versions are the extension's `manifest.json` version.

## 0.5.1 (2026-09-28): first public release

- Lanes live on an invisible virtual display ("Agent Lanes"), held by the new
  `agent-lane-display` launchd helper, so they never appear on your screens.
- The extension recognises that display by size and corner-only contact, because Chrome
  reports no display names on macOS.
- Focus that lands on a hidden lane is handed back to your window; a user window is opened
  when only lanes exist.
- Extension reloads keep the pool: husk windows are re-anchored when provably ours.
- Unpooled marker-only lanes are adopted before any new window is created.
- Background pool refill (`--prepare-pool N --background`) behind a front-app fuse.
- The launcher app refills the pool whenever it is short, not once per launch.
- `--status` reports `extensionVersion`, `agentDisplay`, and `backgroundPreparation`.
- Public installer and uninstaller; Dock integration is opt-in.

## 0.4.4 (2026-09-04): lanes

- Normal-type lane windows holding up to 16 session tabs each, four lanes by default.
- A per-lane stage schedules which session's tab renders; commands are never preempted.
- A lane guard evicts foreign tabs to the user's window; user focus reclaims a visible
  lane.
- Pinned MCP servers installed once; the extension installed with hashes and an
  owner-only pin.
- Live: 24 simultaneous clients across four lanes.

## 0.3.x (August 2026): the popup pool

- One popup window per agent from a pool of up to eight, created only while Chrome was in
  front. Superseded by lanes because popup windows hold exactly one tab.
