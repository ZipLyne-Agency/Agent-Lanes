# Why this exists

We wanted AI coding agents to use our real, logged-in Chrome: the one with our Google
Workspace, our dashboards, our 2FA already done. We wanted many agents at once. And we
wanted to keep working on the same Mac while they did it, without Chrome jumping to the
front, tabs changing under us, or windows piling up on the screen.

Every existing route failed at least one of those. This page explains which, and then
walks through the platform walls we hit building the alternative, because most of the
design only makes sense once you have seen them.

Research for this page covers August and September 2026; the live measurements come from
Chrome 154 on macOS 27.

## What we needed

1. **Your real profile.** Your cookies, your SSO, your passkeys, your extensions. Not a
   copy.
2. **Many agents at once,** each with its own tabs, none able to touch another's.
3. **Nothing on your screen.** Chrome never comes to the front, your selected tab never
   changes, your macOS Space never switches.
4. **Reliable input.** Clicks and typing are real, trusted browser input, and they keep
   working while the agent's window is covered by other apps.
5. **Your links stay yours.** A link you click in Mail or Slack opens in your window,
   never in an agent's.
6. **No debris.** When an agent finishes, its tabs are gone. No tab-group menu that grows
   every day.
7. **No secrets in configs.** No pairing token pasted into every agent's MCP settings.

## Why not the standard tools

| Route | Your logins | Many agents | Stays off your screen | The problem |
|---|---|---|---|---|
| Chrome DevTools MCP `--autoConnect` | Yes | Awkward | No | A permission dialog for every connection; drives your own tabs |
| `--remote-debugging-port` on your profile | No | Yes | Yes | Chrome 136+ ignores it for your default profile |
| Copied profile / Chrome for Testing | Unreliable | Yes | Yes | A second copy of your cookies, and logins often break |
| Stock Playwright extension (`--extension`) | Yes | Yes* | No | Agents work in your own windows, activate their tabs, token in config |
| Isolated / headless Playwright | No | Yes | Yes | Logged out by design |
| Screen-driving agents (computer use) | Yes | No | No | They take the mouse and keyboard |

\* At the upstream revision this project forked: several clients, each as a tab group in your windows.

### Chrome DevTools MCP with auto-connect

Since Chrome 144, `chrome-devtools-mcp --autoConnect` can attach to the Chrome you are
already running, after you enable remote debugging at `chrome://inspect/#remote-debugging`.
It is excellent for what it was built for, debugging, and this project keeps it as its
debugging route.

It is the wrong tool for background agents:

- Chrome asks you to click **Allow** for every debugging connection. Several agents, or
  one that reconnects, stack several dialogs; the maintainers confirmed that each
  WebSocket connection needs its own approval by design ([issue 1794][devtools-1794]).
- While a session is active Chrome shows the "controlled by automated test software"
  banner.
- The agent works in your tabs and windows. There is no per-agent ownership: any agent
  can navigate any tab, including the one you are reading.
- Tracing and profiling domains conflict between clients, so it has to be leased to one
  client at a time.

### A debugging port on your real profile

Since Chrome 136, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored
when Chrome uses its default data directory. Chrome made that change because malware was
using the debugging port to steal cookies ([Chrome blog, March 2025][chrome-136]). You
now have to pass a separate `--user-data-dir`, which is a different, logged-out profile.
That is the point of the change, and there is no flag to undo it.

### A copied profile, or Chrome for Testing

Copying your profile into that separate data directory is the usual workaround. It
sometimes carries your logins over and sometimes does not, depending on the platform,
the Chrome version, and the site, and either way it leaves a second copy of your cookies
on disk for anything that can read the folder. Chrome for Testing and Playwright's own
browsers start logged out. They are the right tool for public pages, and this project
keeps a clean headless route (`browser-mcp-server playwright-isolated`) for exactly that.

### The stock Playwright extension

`@playwright/mcp --extension` with Microsoft's browser extension is the closest fit, and
it is what this project forks. At the revision we forked:

- Several clients can connect at once, but each works in your own windows as a tab
  group. You pick a tab on first connection, or put a pairing token in the agent's MCP
  config, where every agent process can read it.
- It activates the tab and focuses its window (`Page.bringToFront`,
  `Target.activateTarget`), which pulls Chrome to the front and can switch your Space.
- Each client got its own Chrome tab group, and Chrome keeps closed group records, so
  the tab-group menu grew with every agent task.
- Only the active tab of a window renders (see below), so an agent tab that lives in
  your window, behind the tab you are looking at, cannot receive reliable input.

### Screen-driving agents

Computer-use agents drive the visible screen with screenshots, the mouse, and the
keyboard. They use your logins, but you cannot use the machine at the same time, and
only one can run.

## The walls we hit

Each of these was found live, usually by a test that failed. The fix is in parentheses.

**Only the active tab of a window renders and takes trusted input.** Chrome produces
animation frames and delivers trusted mouse and keyboard input only to the active tab of
a non-minimized window. A background tab, a tab group, or a tab behind yours cannot be
driven reliably. (Each agent session is a tab in a *lane* window, and a per-lane
scheduler, the *stage*, makes one session's tab active at a time, only while that
session has a command running.)

**Minimized windows stop rendering.** Live on version 0.3.16, a minimized agent window
reported `visibilityState: hidden`, fired no `requestAnimationFrame`, and never
delivered trusted input, so Playwright waited forever at its actionability check.
Chromium suspends a window's compositor when the NSWindow is not visible, and a
miniaturized window is not visible. (Lanes are never minimized.)

**Covered windows get throttled on macOS.** Chrome marks a fully covered window as
occluded and backgrounds it. (Chrome must run with
`--disable-backgrounding-occluded-windows`. The launcher app adds it, and the MCP
launcher refuses to connect without it.)

**Popup windows hold exactly one tab.** Chrome retargets any navigation into a
popup-type window to a normal window, so the 0.3.x design needed one window per agent.
(Lanes are normal-type windows that hold up to 16 session tabs.)

**Normal windows receive your links.** Chrome sends an external link to the most
recently *activated* normal window. (Lanes are never activated, so they are never first
in that order, and a guard moves any tab that lands in a lane anyway straight to your
window.)

**Window state transitions misbehave.** On 0.3.16, creating a window minimized and then
restoring it promoted it to Chrome's front window. On 0.3.17, a window created normal
inherited a maximized state. (Lanes are created directly in their final state with
explicit bounds.)

**Fullscreen does not hide a window.** We tried giving every lane its own macOS Space by
making it fullscreen. A fullscreen Chrome window reports `focused: true` for as long as
it exists, so it can never satisfy "unfocused". Dead end.

**Visible windows get closed.** Parked lanes used to sit stacked in a corner of the
screen. People close windows they do not recognise, which emptied the pool, and then
every agent failed until someone clicked into Chrome. (Lanes now live on an invisible
virtual display. You cannot see them, so you cannot close them.)

**Chrome does not tell you display names on macOS.** `chrome.system.display` fills in
`name` only on ChromeOS. (The extension recognises the agent display by its exact size
and by touching the other screens at a single corner, a position the System Settings
arrangement never produces for a real monitor.)

**Windows on an invisible display count as covered.** macOS reports every window on the
virtual display as occluded. (The same occlusion switch keeps them rendering: measured
at 61 frames per second with trusted typing and clicks while another app was in front.)

**Does creating a window pull Chrome forward?** An early test (0.3.18) concluded that
`chrome.windows.create({focused: false})` activated Chrome while another app was in
front. Chromium's source says it should not: an unfocused create calls `ShowInactive()`,
which on macOS orders the window behind Chrome's main window without activating the
app. A clean test on 2026-09-28, with the user parked in one app and the front app
sampled every 20 ms, saw no activation in 12 window creations and 15 window closes. Two
earlier runs that day did see Chrome come forward, but the user was switching apps at
those moments. We could not isolate why 0.3.18 differed, so background lane creation
runs behind a fuse that disables it permanently the first time Chrome comes forward.

**Page-opened windows activate the window that receives them.** A page calling
`window.open` makes Chromium show the receiving window. (An init script,
`mcp-runtime/lane-popups.js`, turns page-opened tabs into same-tab navigations, and
`window.open` with window features ends the session.)

**Tab groups pile up.** Chrome keeps and can sync closed tab-group records. (Lanes never
create tab groups; exact owned-tab IDs give each session isolation and cleanup.)

**Tokens in configs leak.** (The MCP server reaches the extension through a native
messaging host that only this extension may call, over an owner-only Unix socket; the
token lives in one `0600` file that only the broker reads.)

**Extension reloads orphan windows.** Reloading an unpacked extension turns every lane's
anchor page into a new-tab page while keeping the window. (The loader re-anchors those
windows when it can prove they are its own.)

**A Chrome restart does not load a new extension build.** Only the Reload button on
`chrome://extensions` does.

**A Chrome crash relaunch drops the occlusion switch.** Chrome came back from a crash
without its launch flags. (Check `chrome-background-safe --status` after any crash and
reopen with the launcher app.)

## What we would still like

- Microsoft shipping per-client ownership, background workspaces, and no focus calls in
  the signed extension, so this fork can go away. [`extension/UPSTREAM.md`](../extension/UPSTREAM.md)
  lists what the fork would need from upstream.
- A public macOS API for a headless display. The helper uses `CGVirtualDisplay`, a
  private CoreGraphics class that BetterDisplay and DeskPad also rely on.

[devtools-1794]: https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/1794
[chrome-136]: https://developer.chrome.com/blog/remote-debugging-port
