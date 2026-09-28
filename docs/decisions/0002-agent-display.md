# 0002: Lanes on an invisible display

Date: 2026-09-28. Status: accepted, live-proven the same day on version 0.5.1.

## Context

Lanes sat stacked in the bottom-right corner of the user's screen. Seeing windows they did
not recognise, users closed them, which emptied the pool. Agents could not refill it
without bringing Chrome forward, which the rules forbid, so they asked the user to click
into Chrome. The goal: agents keep working while the user is in other apps, with nothing on
screen to close.

## What we established

1. Rendering needs a normal, unminimized window, not a visible one. Chromium suspends a
   window's compositor when the NSWindow is not visible, and a minimized window is not
   visible. Occlusion is a separate signal that `--disable-backgrounding-occluded-windows`
   neutralises.
2. Off-screen parking is blocked: Chrome 102+ rejects extension window bounds less than
   50% on a display, and AppKit pulls titled windows back onto a screen.
3. Minimized windows are out, even though another project fixed its macOS focus problem by
   creating windows minimized.
4. `chrome.windows.create({focused: false})` should not activate Chrome: it calls
   `ShowInactive()`, which on macOS orders the window below Chrome's main window without
   activating the app. An earlier test had seen activation, so this is guarded, not
   trusted.
5. `CGVirtualDisplay` (private CoreGraphics, used by BetterDisplay and DeskPad) works on
   macOS 27.0 with no permission prompt. A lane on it rendered at 61 fps with
   `visibilityState: visible` and took trusted typing, clicks, and screenshots while
   another app was in front. macOS reports windows there as occluded, so the occlusion
   switch stays mandatory.
6. A CDP `Target.createTarget` with `hidden: true` gives a target outside the tab strip,
   but the relay drives tabs through `chrome.debugger`, and a hidden target has no window
   to render in.
7. Chrome reports no display names on macOS (`DisplayUnitInfo.name` is filled only on
   ChromeOS), so the display has to be recognised another way.

## Options

| Option | Result |
|---|---|
| Lanes on an invisible virtual display | **Chosen.** Nothing on screen to close; proven live |
| Lanes shrunk and tucked behind the user's main window, clicks handed back | Documented alternative below; no private API, but still visible in Mission Control |
| Lanes only while an agent runs, closed when idle | Needs window creation on every first connection; kept only as the fused refill path |
| Minimized or off-screen lanes | Rejected: minimized stops input, off-screen bounds are refused |
| Tab group or hidden target in the user's window | Rejected: only the active tab of a window renders |

## Decision

- `agent-lane-display` holds a 1440x900 display (vendor `0x414C`, product `0x4E45`)
  diagonally off the bottom-right corner of the rightmost screen, touching the arrangement
  at one point, with a 20 Hz cursor fence. launchd keeps it alive; a clean exit stays down.
- The extension recognises the display by size and corner-only contact, keeps lanes on it
  and everything else off it, hands focus back from hidden lanes, opens a user window when
  only lanes exist, revives reload husks it can prove are its own, and adopts marker-only
  leftovers before creating anything.
- `playwright-mcp-native-bridge --prepare-pool N --background` creates lanes on the display
  while another app is in front, watches the front app every 50 ms, and trips a permanent
  fuse the first time Chrome comes forward during a request that made a window.
- The launcher refills the pool whenever it is short, instead of once per launch.

## Result

With the user parked in one app and the front app sampled every 20 ms: 12 background lane
creations and 15 lane closes, and Chrome never came forward. A hidden lane made Chrome's
front window handed focus back to the user's window within half a second, and its session
kept typing.

Two earlier runs saw Chrome come forward while the user was switching between apps; the
clean run shows those jumps were the user's.

## The alternative, if the display ever has to go

Keep lanes on the real screens but tucked fully behind the user's main window at a small
size, treat a click on one as a mistake (hand focus back, exactly as for hidden lanes), and
rely on the continuous refill. It needs no private API and no extra display, but lanes
still appear in Mission Control and when the main window moves. To switch: stop the
helper, make the guard's `isHidden` dependency true for tucked lanes, and move
`laneBounds()` to the tucked position.

## Open

- Not run live: clicking Chrome's Dock icon with only lanes open, sleep and wake with the
  virtual display, and "Displays have separate Spaces" turned on.
- Chrome 154 crashed once on a debugger `Page.navigate` to `about:blank#<fragment>`. Not
  investigated further.

## Addendum, 2026-09-29: Spaces

The first hand-back focused the user's last-used Chrome window wherever it was. Lanes
live on whichever Space was active when they were created, so switching to that Space
with Chrome active made macOS focus a lane, the guard focused a window on another
Space, and macOS switched the user there. Version 0.5.2 reads the current Space from
the native host (`CGSGetActiveSpace`), records which Space each user window was
focused on, and hands focus only to a window on the current Space. The live
hand-back test had run on a single Space, which is why this was missed.

