# Operations

How to check that the route is healthy, refill it, recover it, and read its errors.
Run the checks in order: each one assumes the ones before it passed.

## 1. Is the broker alive?

```bash
~/.local/bin/playwright-mcp-native-bridge --status
```

Any JSON answer means the native host, socket, token, and extension service worker
are all alive. No output or a non-zero exit means the extension's service worker is
not running or the native host died: open `chrome://extensions`, confirm the Agent
Lanes for Chrome card is enabled, and run it again.

## 2. Is the pool healthy?

A healthy pool looks like this:

```json
{"connections":[],"extensionVersion":"0.5.1","parkedWorkspaceCount":4,
 "parkedWorkspaces":[{"windowId":1,"type":"normal","state":"normal","focused":false,
   "tabCount":1,"sessionCount":0,"capacity":16}, "..."],
 "capacity":{"lanes":4,"perLane":16,"total":64,"inUse":0},
 "agentDisplay":{"present":true,"lanesOnDisplay":4},
 "backgroundPreparation":"enabled"}
```

- `parkedWorkspaceCount` is 0 or short: see [Refill](#refill).
- A lane with `focused: true`, a state other than `normal`, or fewer tabs than
  `sessionCount + 1` was reclaimed or is broken: see [Full reset](#full-reset).
- `connections` is non-empty while no agent is working: a client never called
  `browser_close`. It clears when that MCP process exits.
- `agentDisplay.present: false` while `agent-lane-display status` says the display
  is online means the loaded extension build cannot recognise it. Reload the
  extension from the installed path.

## 3. Is Chrome background-safe?

```bash
~/.local/bin/chrome-background-safe --status     # expect: ready
```

`not-ready` means Chrome is missing `--disable-backgrounding-occluded-windows`, or
more than one regular Chrome is running. Quit Chrome with Command-Q and open it with
`~/Applications/Google Chrome (Agent Safe).app`. Check this after any Chrome crash:
a crash relaunch comes back without the switch.

## 4. Is the display up?

```bash
~/.local/bin/agent-lane-display status          # exit 0 and "present": 1
launchctl print gui/$(id -u)/agency.ziplyne.agent-lane-display | grep state
tail ~/.cache/agent-lanes-display.log
```

`cornerContactOnly: true` means the display touches your screens at one point only.

## 5. Does a real session work?

From any agent, call `browser_navigate` and then `browser_close`, and watch
`--status` in between: one lane shows `sessionCount: 1`, then every lane returns to
0 with the pool unchanged.

## Refill

The launcher app checks the pool every second while Chrome runs and refills it
whenever it is short. With Agent Lanes present it does so in the background, while
another app is in front. By hand:

```bash
~/.local/bin/playwright-mcp-native-bridge --prepare-pool 4 --background
```

If that answers `must be foreground`, background preparation is off (no display,
or its fuse tripped) and the refill needs Chrome in front for a moment: click into
Chrome and wait a few seconds.

**The fuse.** During a background preparation the bridge samples the frontmost app
every 50 ms, and for 3 seconds after. The first time Chrome comes to the front
during a background preparation that made a window, it writes
`~/.local/state/agent-lanes/background-prep-disabled.json` and background
preparation stays off until you delete that file. Read the file first: it records
which apps were in front. If you were switching apps at that moment, the trip was
probably you.

The full acceptance version of a foreground refill, which also proves your
selection, external-link routing, and Space are unaffected and rolls itself back on
any violation, is `python3 tests/live/prepare_browser_workspace_pool.py`. Run it
with Chrome in front.

## After an extension reload

Reloading replaces every anchor page with a new-tab page but keeps the windows. The
loader re-anchors the husks it can prove are its own, so the pool normally survives.
If `--status` shows husks were left out, list single-tab windows and close them by
their exact ID:

```bash
osascript -e 'tell application "Google Chrome"
  set r to ""
  repeat with w in windows
    if (count of tabs of w) is 1 then set r to r & (id of w) & " " & (URL of tab 1 of w) & linefeed
  end repeat
  return r
end tell'
osascript -e 'tell application "Google Chrome" to close (window id WINDOW_ID)'
```

Never close windows by title or pattern.

## Full reset

```bash
~/.local/bin/playwright-mcp-native-bridge --discard-pool   # removes only unclaimed lanes
~/.local/bin/playwright-mcp-native-bridge --prepare-pool 4 --background
```

`--discard-pool` refuses while any agent is connected and never closes a window you
have touched.

## Rotate the bridge token

The token is defense in depth behind an owner-only socket. Both the broker and the
clients read it per request, so rotation takes effect at once:

```bash
/usr/bin/python3 - <<'PY'
import os, secrets, pathlib
path = pathlib.Path.home() / ".config/agent-lanes/token"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, secrets.token_urlsafe(32).encode() + b"\n"); os.close(fd)
PY
~/.local/bin/playwright-mcp-native-bridge --check-token && echo ok
```

## Error dictionary

| Message | Meaning | Action |
|---|---|---|
| `No pre-positioned authenticated browser workspace is available` | The pool is empty | [Refill](#refill) |
| `Authenticated browser pool is at capacity` | Every lane is full and the 60 s wait for a free slot expired | Retry, or look for sessions that never called `browser_close` |
| `Regular Chrome must be foreground on its normal user window during one-time pool preparation` | Preparation ran while another app was in front, and background preparation was not possible | Click into Chrome, or check the display and the fuse file |
| `background lane creation brought Chrome forward; background preparation is now disabled` | The fuse tripped | Read the fuse file; delete it once you know why |
| `regular Chrome is missing --disable-backgrounding-occluded-windows` | Chrome was opened some other way, or relaunched itself after a crash | Command-Q, reopen with the launcher app |
| `the Agent Lanes extension is not loaded unpacked in Chrome from ...` | Chrome loaded the extension from another folder, or the Web Store build is installed | Load unpacked from `~/.local/share/agent-lanes/extension` |
| `canary install pin missing or unsafe` / `manifest mismatch` / `version mismatch` | The installed extension files do not match their recorded hashes | Run `scripts/install.sh` again, then reload the extension |
| `Agent lane was reclaimed (...)` | You focused, moved, resized, minimized, or maximized a visible lane | Expected: that window is yours now |
| `Agent lane anchor was closed` | A lane's anchor tab was closed | Expected reclaim; the launcher replaces the lane |
| `Page popup opened outside its private agent lane` | A page called `window.open` with window features | Expected: the session fails closed |
| `Agent lane is unavailable or no longer safely backgrounded (...)` | The lane changed state mid-command | Retry once the pool settles |
| `Extension disconnected before initialization` | The upstream first-call race | Retry |
| `another native bridge host is active` | A second native host tried to bind the socket | Normal: only one may hold it |

## Tests

| Command | Proves |
|---|---|
| `npm --prefix extension run typecheck` | Sources compile |
| `bash tests/test-extension.sh` | Relay, stage, and guard unit suite; lane lifecycle suite; agent display suite (placement, husk revival rules, background preparation, focus hand-back, display loss and return), all against a stateful Chrome fake |
| `python3 -m unittest tests/test_native_bridge.py` | Token boundary, URL validation, concurrent clients, background preparation and its fuse |
| `python3 -m unittest tests/test_install_extension.py` | Atomic extension install, hashes, and pin |
| `python3 -m unittest tests/test_chrome_background_safe.py` | Chrome process checks and the launcher app |
| `bash tests/test-browser-mcp-server.sh` | Launcher attestation: occlusion switch, token, native host, unpacked install, hashes |
| `python3 tests/live/prepare_browser_workspace_pool.py` | **Live.** Foreground pool creation without disturbing your selection, routing, or Space |
| `python3 tests/live/live_browser_background_acceptance.py` | **Live.** A covered lane, trusted click and type, in-lane tabs, exact cleanup |
| `python3 tests/live/live_browser_multi_client_acceptance.py --clients 24` | **Live.** 24 simultaneous clients across four lanes |

The live tests assert that the frontmost app never changes. Run them while you are
**not** working in Chrome, or they fail on your own activity.

## Bug classes locked out

**Asserting a tab URL right after `chrome.tabs.update`.** The call resolves before
the navigation commits. The fake commits URLs asynchronously through `pendingUrl`
exactly like Chrome, so this class fails the unit suite.

**Rendering the token.** Lane anchor pages render an inert notice with no secrets;
the status page masks the token.

**Preempting an in-flight stage command.** Swapping a lane's active tab mid-command
stalls Playwright's action until its own timeout. The stage never does it, and the
unit suite asserts it.

## Known issues

- A debugger `Page.navigate` to `about:blank#<fragment>` crashed Chrome 154 once
  during development. Not investigated further. Agents should not do it.
- Cmd-\` can land on a hidden lane; the guard hands focus to your window on the same
  Space, so cycling Chrome's windows with Cmd-\` may skip back to it.
- On a Space (desktop) that holds lanes but none of your Chrome windows, switching
  there with Chrome active leaves focus on an invisible lane until you click another
  app. Keystrokes in that moment go to the lane's active tab (its inert anchor page
  unless an agent command is running). Chrome does not tell extensions which Space a
  window is on, so this is the cost of never switching Spaces for you.
- The rejected `window.open`-with-features path briefly shows a window before the
  guard removes it.
- Not yet run live: clicking Chrome's Dock icon while only lanes are open, sleep and
  wake with the virtual display, and "Displays have separate Spaces" turned on.
