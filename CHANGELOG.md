# Changelog

Versions are the extension's `manifest.json` version.

## 0.5.3 (2026-10-04)

- **Nothing else lands on Agent Lanes.** The display helper gains two guards behind
  one Accessibility grant. A focus guard never lets an invisible lane keep the
  keyboard: while it does, macOS treats Agent Lanes as the main screen and every app
  opens new windows, dialogs, and launcher panels there. It asks Chrome which window
  holds the keyboard, and after a lane has held it for about a second it raises your
  Chrome window on the current desktop, or activates Finder, so no desktop switch
  happens. A window guard moves any other app's ordinary window off Agent Lanes
  to the screen your pointer is on, leaves per-screen overlays alone, and stops after
  three moves in a minute if an app keeps putting a window back.
- The extension returns a Chrome window dragged or "Move to"-ed onto Agent Lanes, and
  re-adopts anchor-only lanes whenever windows change, which fixes an empty pool after
  a Mac restart (session restore brought the lanes back after the extension looked).
- `agent-lane-display guard-once` and `guard-watch <seconds>` run the guards by hand;
  `status` reports `windowGuard`.
- `scripts/install.sh` signs the helper (set `AGENT_LANES_SIGN_IDENTITY` to a
  Developer ID so the Accessibility grant survives rebuilds).

## 0.5.2 (2026-09-29)

- **Fix: focus never jumps to another Space (desktop).** Lanes live on whichever Space
  was active when they were created. When you switched to that Space with Chrome
  active, macOS focused a hidden lane there, and 0.5.1 handed focus to your
  last-used Chrome window, which was on another Space, so macOS switched you there.
  The guard now asks the native host which Space is showing (`CGSGetActiveSpace`) and
  hands focus only to your most recent window on that Space. With none known there,
  focus stays on the idle hidden lane until you click elsewhere, and the lane keeps
  serving its sessions. A window is opened only when you have no Chrome window at all.
- The bridge turns Python 3.9's `socket.timeout` into `TimeoutError`.

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
