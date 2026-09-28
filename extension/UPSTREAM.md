# Upstream provenance and replacement policy

This extension is derived from Microsoft Playwright commit
`d5a185a894ab3ab17ff77a44e116a1339c6bdaed`, the first upstream revision with
simultaneous extension clients and exclusive per-client tab groups. The copied
code remains under Microsoft's Apache-2.0 license in `LICENSE`.

Local changes are intentionally narrow:

> **Protected invariant:** never change agent workspaces back to minimized. Chrome
> does not produce the animation frames or trusted input delivery Playwright needs
> in that state. Any workspace lifecycle change must pass the live trusted-click,
> trusted-keyboard, full-window-occlusion, focus, Space, ownership, and cleanup
> acceptance test. On macOS this also depends on regular Chrome retaining
> `--disable-backgrounding-occluded-windows`; do not remove the MCP process attestation.
>
> **Protected pool invariant:** routine connections create a background session
> tab inside an existing lane and return only that tab's ownership. They must
> never create/close a lane window per task or synthesize macOS focus, activation,
> window ordering, or Space changes. Missing lanes are requested only through the
> native management channel (`playwright-mcp-native-bridge --prepare-pool`, which
> the launcher app and `tests/live/prepare_browser_workspace_pool.py` use); pool
> preparation must never open an MCP relay, background preparation must stay on
> the agent display behind the bridge's front-app fuse, and every pool lifecycle
> change must retain crash/restart, multi-client, external-link, and cleanup
> coverage.
>
> **Protected stage invariant:** a lane's active tab may change only through the
> per-lane stage (idle handoff or its hard-cap unwedge) or the eviction path. An
> in-flight debugger command's tab is never backgrounded to activate another
> session's tab in the same lane.

- token-bypassed clients run each session as a background tab inside a shared
  normal-type, non-focused lane window (default four lanes, up to 16 sessions
  each) so Chrome continues producing animation frames and accepting trusted CDP
  input without a window per client;
- pool preparation is an authenticated native management operation, separate from
  relay connection and debugger initialization, and publishes only repeatedly
  stable lanes;
- routine connections create the session's task tab directly in the background
  (`active: false`); a per-lane stage activates a tab only while that session's
  own command is running, never during ordinary connection, because activating a
  tab during connection would change Chrome's internal front-window selection and
  risk breaking external-link routing;
- each connection's tabs are pinned to the lane that created them; a page-created
  window with window features still escapes and is removed as a spill; a plain
  `window.open()` or `browser_tabs(new)` instead lands as an ordinary tab in the
  same lane;
- controlled tabs are marked non-discardable;
- automated handshakes use an allowlisted native-messaging host instead of opening
  an extension URL, and the local token never enters upstream MCP argv or env;
- `Page.bringToFront` and `Target.activateTarget` are suppressed for agent
  sessions; only the stage and the eviction path may activate a tab, and neither
  ever focuses a window except eviction handing a foreign tab back to the user;
- a private protocol sentinel prevents the signed Store build with the same ID
  from silently satisfying the canary route;
- the native port is the scoped MV3 keepalive; a dead session's owned tabs are
  cleaned on service-worker restart while its lane and other sessions survive,
  popups from agent-owned openers are adopted, and reclaimed/user tabs survive;
- lane windows never create Chrome tab groups; exact owned-tab IDs provide
  per-session isolation and cleanup within a shared lane, avoiding
  retained/synced group-record accumulation;
- exact session ownership is bound to a Chrome-process lifetime and revalidated
  against current window membership for service-worker recovery; ambiguous tabs
  restored after a full Chrome restart are preserved;
- profile tokens are compared through fixed-length SHA-256 digests; and
- the upstream calls that explicitly activate a tab and focus its window are
  removed, except the lane guard's own eviction path, which is the one place
  ordinary extension code is allowed to focus a window, and only to give back a
  window Chrome itself just took.

## Future upgrade note

Replace this fork with a signed upstream release when the Chrome Web Store build
contains simultaneous clients, exclusive tab ownership, input-capable non-focused
workspace provisioning, and no explicit window-focus calls. Before replacement, rerun the
local acceptance tests against the signed upstream release; do not switch merely
because its version number is newer.
