# 0001: Lanes

Date: 2026-09-04. Status: accepted, live-proven the same day on version 0.4.4.

## Context

Version 0.3.21 gave every agent its own popup window from a pool created while Chrome
was in front. It worked, but:

1. Popup windows hold exactly one tab (Chrome retargets any navigation into a popup to a
   normal window), and only the active tab of a normal-state window renders, so every
   agent needed its own window. The pool was capped at eight windows.
2. The pool emptied after service-worker restarts and was refilled only while Chrome was
   in front.
3. Each agent start ran `npx -y @playwright/mcp`, so many agents starting at once
   contended on one npm cache.

## Chromium facts the design rests on

Verified from Chromium source:

- `chrome.tabs.update(tabId, {active: true})` calls only `TabList::ActivateTab`. It never
  activates the window or changes the browser activation order.
- `chrome.tabs.create({active: false})` opens a background tab with no window show or
  activate action.
- On macOS, external links go through `FindTabbedBrowser`, which walks windows in
  *activation* order and accepts only normal-type windows on the current Space. The order
  changes only when a window is activated.
- Background tabs get no animation frames and no trusted input (proven live on 0.3.16).

## Decision

- A **lane** is one normal-type, normal-state, unfocused window holding an anchor tab and
  up to 16 session tabs. Four lanes by default: 64 sessions without creating a window per
  agent.
- A per-lane **stage** activates one session's tab at a time, only while that session has
  a command in flight, and never preempts a command.
- **Containment** replaces the popup guarantee: lanes are never activated, so they are
  never first in the link-routing order, and a guard evicts any foreign tab to the user's
  window.
- User reclaim: focusing, moving, resizing, minimizing, or maximizing a lane ends its
  sessions, keeps its tabs, and tombstones its anchor.
- `@playwright/mcp` and `chrome-devtools-mcp` are installed once at pinned versions and
  run directly.
- The built extension is installed with a SHA-256 manifest and an owner-only pin that the
  launcher verifies on every start.

## Result

Live on 0.4.4: pool preparation without changing the user's selection or Space; a covered
lane taking trusted clicks and typing, in-lane `browser_tabs(new)`, same-tab
`target=_blank`, exact cleanup; 24 simultaneous clients across four lanes.

## Rejected

- **Tab groups in the user's window:** only the active tab renders.
- **Fullscreen lanes, each in its own Space:** a fullscreen window reports `focused: true`
  for as long as it exists.
- **Minimized lanes:** no animation frames, no trusted input.
