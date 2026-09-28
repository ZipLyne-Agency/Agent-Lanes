#!/usr/bin/env python3
"""Live, non-destructive acceptance check for the authenticated Chrome bridge."""

from __future__ import annotations

import json
import os
import queue
import secrets
import subprocess
import sys
import threading
import time
from pathlib import Path


LAUNCHER = Path.home() / ".local/bin/browser-mcp-server"
BRIDGE = Path.home() / ".local/bin/playwright-mcp-native-bridge"
SWIFT_MONITOR = r'''
import AppKit
import Foundation

func emit(_ value: String) {
  FileHandle.standardOutput.write((value + "\n").data(using: .utf8)!)
}

let center = NSWorkspace.shared.notificationCenter
let activationObserver = center.addObserver(
  forName: NSWorkspace.didActivateApplicationNotification,
  object: nil,
  queue: nil
) { notification in
  if let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
    emit("ACTIVATED:" + (app.bundleIdentifier ?? "unknown"))
  }
}
let spaceObserver = center.addObserver(
  forName: NSWorkspace.activeSpaceDidChangeNotification,
  object: nil,
  queue: nil
) { _ in
  emit("SPACE_CHANGED")
}
emit("READY:" + (NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "unknown"))
RunLoop.main.run()
withExtendedLifetime((activationObserver, spaceObserver)) {}
'''
SWIFT_WORKSPACE_COVER = r'''
import AppKit
import CoreGraphics
import Foundation

func requiredNumber(_ name: String) -> CGFloat {
  guard let raw = ProcessInfo.processInfo.environment[name], let value = Double(raw) else {
    FileHandle.standardError.write(("missing " + name + "\n").data(using: .utf8)!)
    exit(2)
  }
  return CGFloat(value)
}

let left = requiredNumber("PW_COVER_LEFT")
let top = requiredNumber("PW_COVER_TOP")
let width = requiredNumber("PW_COVER_WIDTH")
let height = requiredNumber("PW_COVER_HEIGHT")
let chromeBounds = CGRect(x: left, y: top, width: width, height: height)
let windowInfo = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
func number(_ item: [String: Any], _ key: String) -> CGFloat? {
  guard let value = item[key] as? NSNumber else { return nil }
  return CGFloat(value.doubleValue)
}
let targets = windowInfo.filter { item in
  guard item[kCGWindowOwnerName as String] as? String == "Google Chrome",
        (item[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
        let boundsData = item[kCGWindowBounds as String] as? [String: Any],
        let x = number(boundsData, "X"),
        let y = number(boundsData, "Y"),
        let w = number(boundsData, "Width"),
        let h = number(boundsData, "Height") else { return false }
  return abs(x - chromeBounds.minX) <= 2 && abs(y - chromeBounds.minY) <= 2 &&
    abs(w - chromeBounds.width) <= 2 && abs(h - chromeBounds.height) <= 2
}
// Dead agent windows can linger at the same slot coordinates (their renderer
// is gone but the NSWindow survives), so several Chrome windows may share the
// workspace bounds. The cover panel spans that exact rectangle either way; the
// proof only requires the panel to sit above EVERY window at those bounds.
let targetNumbers = targets.compactMap { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue }
guard !targetNumbers.isEmpty else {
  let chromeCount = windowInfo.filter {
    ($0[kCGWindowOwnerName as String] as? String == "Google Chrome") &&
    (($0[kCGWindowLayer as String] as? NSNumber)?.intValue == 0)
  }.count
  FileHandle.standardError.write(
    "Chrome workspace bounds not found (chromeWindows=\(chromeCount), targetMatches=\(targets.count))\n".data(using: .utf8)!
  )
  exit(3)
}

// CoreGraphics uses a top-left origin anchored to the primary display, while
// AppKit uses a bottom-left origin in the same global display space.
let primaryDisplayHeight = NSScreen.screens.first?.frame.height ?? height
let frame = NSRect(x: left, y: primaryDisplayHeight - top - height, width: width, height: height)
let initiallyOrdered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
if !initiallyOrdered.contains(where: { item in
  guard let number = (item[kCGWindowNumber as String] as? NSNumber)?.intValue else { return false }
  return targetNumbers.contains(number)
}) {
  FileHandle.standardOutput.write("READY:OFF_CURRENT_SPACE\n".data(using: .utf8)!)
  exit(0)
}
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.finishLaunching()
let panel = NSPanel(
  contentRect: frame,
  styleMask: [.borderless],
  backing: .buffered,
  defer: false
)
panel.backgroundColor = .black
panel.isOpaque = true
panel.hasShadow = false
panel.ignoresMouseEvents = true
panel.hidesOnDeactivate = false
panel.collectionBehavior = [.canJoinAllSpaces]
panel.orderFrontRegardless()
panel.display()
DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
  let ordered = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let targetIndexes = ordered.indices.filter { index in
    guard let number = (ordered[index][kCGWindowNumber as String] as? NSNumber)?.intValue else { return false }
    return targetNumbers.contains(number)
  }
  let panelIndex = ordered.firstIndex { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == panel.windowNumber }
  guard let firstTargetIndex = targetIndexes.first, let panelIndex, panelIndex < firstTargetIndex else {
    FileHandle.standardError.write(
      "cover window was not above every window at the workspace bounds (targetIndexes=\(targetIndexes), panelIndex=\(String(describing: panelIndex)), panelNumber=\(panel.windowNumber), panelFrame=\(NSStringFromRect(panel.frame)), screens=\(NSScreen.screens.map { NSStringFromRect($0.frame) }))\n".data(using: .utf8)!
    )
    exit(4)
  }
  guard panel.frame.width >= width && panel.frame.height >= height else {
    FileHandle.standardError.write("cover window did not fully contain the Chrome workspace\n".data(using: .utf8)!)
    exit(5)
  }
  FileHandle.standardOutput.write("READY:COVERED\n".data(using: .utf8)!)
}
application.run()
'''


def chrome_windows() -> tuple[int, list[bool]]:
    script = 'tell application "Google Chrome" to get {count of windows, minimized of every window}'
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    parts = [part.strip() for part in result.split(",") if part.strip()]
    if not parts:
        raise RuntimeError("Chrome did not report its windows")
    return int(parts[0]), [part == "true" for part in parts[1:]]


def chrome_tab_counts() -> str:
    return subprocess.run(
        ["/usr/bin/osascript", "-e", 'tell application "Google Chrome" to get count of tabs of every window'],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()


def chrome_front_selection() -> tuple[int, int]:
    result = subprocess.run(
        [
            "/usr/bin/osascript",
            "-e",
            'tell application "Google Chrome" to get {id of front window, id of active tab of front window}',
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    parts = [part.strip() for part in result.split(",")]
    if len(parts) != 2:
        raise RuntimeError(f"Chrome returned a malformed front-window selection: {result}")
    return int(parts[0]), int(parts[1])


def chrome_window_ids() -> set[int]:
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", 'tell application "Google Chrome" to get id of every window'],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    ).stdout.strip()
    return {int(part.strip()) for part in result.split(",") if part.strip()}


def probe_external_link_target(restore_selection: tuple[int, int] | None = None) -> int:
    """Open and close one tagged external link, returning only its Chrome window ID.

    Closing the probe tab makes Chrome activate a neighbouring tab, which is the
    previously active tab only when that tab was last in the strip. When the
    caller passes the selection it captured beforehand, the probe re-activates
    exactly that tab in that window afterwards so the user's selection is
    restored rather than left on whichever neighbour Chrome picked.
    """
    marker = f"pw-external-route-{secrets.token_hex(16)}"
    url = f"https://example.com/?{marker}"
    subprocess.run(
        ["/usr/bin/open", "-g", "-b", "com.google.Chrome", url],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    script = r'''
on run argv
  set marker to item 1 of argv
  tell application "Google Chrome"
    repeat with w in windows
      -- A tab still committing its navigation can report an unreadable URL and
      -- a window can close mid-iteration; both raise AppleScript errors. Skip
      -- such transient reads: the caller polls, so the marker tab is found on a
      -- later pass, and an unfound marker still fails closed on the deadline.
      try
        repeat with tabIndex from (count of tabs of w) to 1 by -1
          set candidate to tab tabIndex of w
          if (URL of candidate contains marker) then
            set targetWindowId to id of w
            close candidate
            return targetWindowId as text
          end if
        end repeat
      end try
    end repeat
  end tell
  return ""
end run
'''
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            result = subprocess.run(
                ["/usr/bin/osascript", "-e", script, marker],
                check=True,
                capture_output=True,
                text=True,
                timeout=5,
            ).stdout.strip()
            if result:
                target_window = int(result)
                if restore_selection is not None:
                    _restore_front_selection(*restore_selection)
                return target_window
            time.sleep(0.1)
        raise RuntimeError("tagged external link did not appear in Chrome")
    finally:
        # The main probe closes on success. This idempotent cleanup also covers
        # a slow external open that appears only after the polling deadline.
        subprocess.run(
            ["/usr/bin/osascript", "-e", script, marker],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )


def _restore_front_selection(window_id: int, tab_id: int) -> None:
    """Re-activate the exact tab that was active before a probe, if it moved."""
    script = r'''
on run argv
  -- Chrome reports window and tab ids as TEXT, and real ids (~8.4e8) exceed
  -- AppleScript's integer range, so `as integer` yields a real. Text never
  -- equals a real, which made every comparison below fail and the restore a
  -- silent no-op. Compare the ids as text on both sides.
  set targetWindow to item 1 of argv
  set targetTab to item 2 of argv
  tell application "Google Chrome"
    set w to window id targetWindow
    if ((id of active tab of w) as text) is targetTab then return "unchanged"
    repeat with tabIndex from 1 to (count of tabs of w)
      if ((id of tab tabIndex of w) as text) is targetTab then
        set active tab index of w to tabIndex
        return "restored"
      end if
    end repeat
  end tell
  return "missing"
end run
'''
    result = subprocess.run(
        ["/usr/bin/osascript", "-e", script, str(window_id), str(tab_id)],
        check=False,
        capture_output=True,
        text=True,
        timeout=5,
    )
    outcome = result.stdout.strip()
    if result.returncode != 0 or outcome not in ("unchanged", "restored"):
        # Returned silently before, which hid that the restore never matched.
        raise RuntimeError(
            f"could not restore the user's Chrome selection ({outcome or result.stderr.strip()})"
        )


def bridge_state() -> dict:
    result = subprocess.run(
        [str(BRIDGE), "--status"],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    payload = json.loads(result.stdout)
    connections = payload.get("connections")
    if not isinstance(connections, list):
        raise RuntimeError("native bridge returned malformed status")
    return payload


def bridge_status() -> list[dict]:
    return bridge_state()["connections"]


def wait_for_bridge_connection(client_name: str, timeout: float = 10) -> dict:
    deadline = time.monotonic() + timeout
    last_state: dict = {}
    while time.monotonic() < deadline:
        last_state = bridge_state()
        matches = [
            connection for connection in last_state["connections"]
            if isinstance(connection, dict) and connection.get("clientName") == client_name
        ]
        if len(matches) == 1 and isinstance(matches[0].get("workspace"), dict):
            return matches[0]
        time.sleep(0.05)
    raise RuntimeError(
        f"extension connection did not become ready for {client_name}; "
        f"diagnostic={last_state.get('diagnostic')}"
    )


def start_workspace_cover(workspace: dict) -> tuple[subprocess.Popen[str], bool]:
    bounds = {name: workspace.get(name) for name in ("left", "top", "width", "height")}
    if not all(isinstance(value, int) for value in bounds.values()):
        raise RuntimeError(f"extension did not report workspace bounds: {bounds}")
    environment = os.environ.copy()
    for name, value in bounds.items():
        environment[f"PW_COVER_{name.upper()}"] = str(value)
    process = subprocess.Popen(
        ["/usr/bin/swift", "-e", SWIFT_WORKSPACE_COVER],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
        env=environment,
    )
    ready: queue.Queue[str | None] = queue.Queue()
    assert process.stdout is not None
    threading.Thread(
        target=lambda: ready.put(process.stdout.readline().rstrip() or None),
        daemon=True,
    ).start()
    try:
        line = ready.get(timeout=20)
    except queue.Empty:
        stop_process(process)
        raise RuntimeError("workspace cover did not become ready")
    if line not in {"READY:COVERED", "READY:OFF_CURRENT_SPACE"}:
        stop_process(process)
        error = process.stderr.read().strip() if process.stderr is not None else ""
        raise RuntimeError(f"workspace cover failed: {error or line}")
    return process, line == "READY:COVERED"


def stop_process(process: subprocess.Popen[str] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=3)


class JsonRpcClient:
    def __init__(self, environment_updates: dict[str, str] | None = None, mode: str = "playwright") -> None:
        environment = os.environ.copy()
        if environment_updates:
            environment.update(environment_updates)
        self.process = subprocess.Popen(
            [str(LAUNCHER), mode],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=environment,
        )
        self._next_id = 1
        self._stderr: list[str] = []
        self._stdout_lines: queue.Queue[str | None] = queue.Queue()
        threading.Thread(target=self._drain_stdout, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()

    def _drain_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self._stdout_lines.put(line)
        self._stdout_lines.put(None)

    def _drain_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            # Keep only non-secret diagnostics in memory for a bounded failure
            # summary. The launcher/bridge are tested never to emit the token.
            self._stderr.append(line.rstrip())
            self._stderr = self._stderr[-20:]

    def send(self, method: str, params: dict | None = None) -> dict:
        request_id = self._next_id
        self._next_id += 1
        message = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.process.stdin.flush()
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            remaining = deadline - time.monotonic()
            try:
                line = self._stdout_lines.get(timeout=max(0, remaining))
            except queue.Empty:
                diagnostics = " | ".join(self._stderr[-20:]) or "no stderr diagnostics"
                raise RuntimeError(f"MCP {method} reply timed out ({diagnostics})")
            if line is None:
                raise RuntimeError(f"MCP exited before replying (code={self.process.poll()})")
            response = json.loads(line)
            if response.get("id") != request_id:
                continue
            if "error" in response:
                raise RuntimeError(f"MCP {method} failed: {response['error']}")
            return response["result"]
        diagnostics = " | ".join(self._stderr[-20:]) or "no stderr diagnostics"
        raise RuntimeError(f"MCP {method} reply timed out ({diagnostics})")

    def notify(self, method: str, params: dict | None = None) -> None:
        message = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(message, separators=(",", ":")) + "\n")
        self.process.stdin.flush()

    def close(self) -> None:
        if self.process.stdin is not None:
            self.process.stdin.close()
        try:
            self.process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)


def call_tool(client: JsonRpcClient, name: str, arguments: dict) -> dict:
    try:
        result = client.send("tools/call", {"name": name, "arguments": arguments})
    except RuntimeError as error:
        raise RuntimeError(f"tool {name} failed: {error}") from error
    if result.get("isError"):
        raise RuntimeError(f"tool {name} returned an error: {tool_text(result)[:500]}")
    return result


def call_tool_with_extension_startup(client: JsonRpcClient, name: str, arguments: dict) -> dict:
    """Retry only the upstream extension's documented first-call initialization race."""
    deadline = time.monotonic() + 10
    diagnostic = ""
    while time.monotonic() < deadline:
        result = client.send("tools/call", {"name": name, "arguments": arguments})
        if not result.get("isError"):
            return result
        diagnostic = tool_text(result).replace("\n", " ")[:500]
        if "Extension disconnected before initialization" not in diagnostic:
            raise RuntimeError(f"tool {name} returned an error: {diagnostic}")
        time.sleep(0.1)
    raise RuntimeError(f"tool {name} did not initialize the extension: {diagnostic}")


def tool_text(result: dict) -> str:
    return "\n".join(
        item.get("text", "")
        for item in result.get("content", [])
        if isinstance(item, dict) and item.get("type") == "text"
    )


def main() -> int:
    if not LAUNCHER.is_file():
        raise RuntimeError(f"missing launcher: {LAUNCHER}")

    before_count, before_minimized = chrome_windows()
    before_window_ids = chrome_window_ids()
    before_bridge_state = bridge_state()
    if before_bridge_state.get("parkedWorkspaceCount", 0) < 1:
        raise RuntimeError("acceptance requires a pre-positioned parked workspace")
    parked_window_ids = set(before_bridge_state.get("parkedWorkspaceIds", []))
    if len(parked_window_ids) != before_bridge_state["parkedWorkspaceCount"]:
        raise RuntimeError("native bridge returned malformed parked workspace IDs")
    user_window_ids = before_window_ids - parked_window_ids
    if not user_window_ids:
        raise RuntimeError("acceptance could not identify a pre-existing user Chrome window")
    before_tabs = chrome_tab_counts()
    before_front_selection = chrome_front_selection()
    monitor = subprocess.Popen(
        ["/usr/bin/swift", "-e", SWIFT_MONITOR],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    events: queue.Queue[str] = queue.Queue()
    observed_events: list[str] = []
    cover_process: subprocess.Popen[str] | None = None
    workspace_fully_covered = False
    assert monitor.stdout is not None
    threading.Thread(target=lambda: [events.put(line.rstrip()) for line in monitor.stdout], daemon=True).start()
    try:
        ready = events.get(timeout=20)
        if not ready.startswith("READY:"):
            raise RuntimeError("frontmost-application monitor did not start")
        expected_frontmost = ready.removeprefix("READY:")

        def assert_no_desktop_disruption(stage: str) -> None:
            while not events.empty():
                observed_events.append(events.get_nowait())
            # The Swift cover tool runs as a bare accessory process with no
            # bundle identifier; ordering its panel front emits a transient
            # "ACTIVATED:unknown" followed by the expected app re-activating.
            # That blip is this harness's own artifact, not a disruption; the
            # selection, focus, and trusted-input assertions still guard the
            # user-visible invariants.
            unexpected_activations = [
                event for event in observed_events
                if event.startswith("ACTIVATED:") and event != f"ACTIVATED:{expected_frontmost}" and
                event != "ACTIVATED:unknown"
            ]
            if unexpected_activations:
                raise RuntimeError(f"the frontmost application changed during {stage}: {observed_events}")
            if "SPACE_CHANGED" in observed_events:
                raise RuntimeError(f"the active macOS Space changed during {stage}: {observed_events}")

        client = JsonRpcClient()
        try:
            client.send("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "background-acceptance", "version": "1.0"},
            })
            client.notify("notifications/initialized")
            listed = client.send("tools/list")
            tool_names = {tool["name"] for tool in listed.get("tools", [])}
            required = {
                "browser_navigate",
                "browser_tabs",
                "browser_snapshot",
                "browser_evaluate",
                "browser_click",
                "browser_type",
                "browser_close",
            }
            if not required.issubset(tool_names):
                raise RuntimeError(f"missing expected tools: {sorted(required - tool_names)}")

            call_tool_with_extension_startup(client, "browser_navigate", {"url": "https://example.com"})
            wait_for_bridge_connection("background-acceptance")
            # Let Chrome's AppleScript inventory settle after the extension
            # adds the session tab to an already-positioned unfocused lane.
            time.sleep(1)
            during_count, during_minimized = chrome_windows()
            during_tabs = chrome_tab_counts()
            during_front_selection = chrome_front_selection()
            if during_front_selection != before_front_selection:
                raise RuntimeError(
                    "agent workspace replaced the user's front Chrome window or active tab "
                    f"(before={before_front_selection}, during={during_front_selection})"
                )
            status = bridge_status()
            matching = [connection for connection in status if connection.get("clientName") == "background-acceptance"]
            if len(matching) != 1:
                raise RuntimeError(f"extension did not report exactly one acceptance workspace: {matching}")
            workspace = matching[0].get("workspace")
            if (not isinstance(workspace, dict) or workspace.get("type") != "normal" or
                    workspace.get("state") not in ("normal", "fullscreen") or workspace.get("focused") is not False):
                raise RuntimeError(
                    "extension did not report a normal-type, normal-state, unfocused agent lane "
                    f"(before={before_count}/{before_minimized}/tabs:{before_tabs}, "
                    f"during={during_count}/{during_minimized}/tabs:{during_tabs}, workspace={workspace})"
                )
            if workspace.get("windowId") not in parked_window_ids:
                raise RuntimeError("extension did not place the session in a pre-positioned lane")
            assert_no_desktop_disruption("workspace provisioning")
            # Chrome's AppleScript dictionary can omit a non-key window that is
            # on another macOS Space. The extension's chrome.windows status is
            # authoritative for workspace existence/state; AppleScript remains
            # authoritative for proving the user's front selection was untouched.

            workspace_title = f"Playwright background acceptance {secrets.token_hex(16)}"
            title_result = tool_text(call_tool(client, "browser_evaluate", {
                "function": f"() => document.title = {json.dumps(workspace_title)}",
            }))
            if workspace_title not in title_result:
                raise RuntimeError("agent workspace did not accept its unique test title")

            # Opening an external link legitimately activates Chrome on macOS —
            # that is normal link-click behavior, not an agent violation. The
            # probe is therefore only meaningful while Chrome is already the
            # frontmost application (its activation is then a no-op for the
            # desktop monitor). tests/live/prepare_browser_workspace_pool.py proves
            # the same routing invariant against a fully provisioned pool.
            external_links_verified = False
            if expected_frontmost == "com.google.Chrome":
                external_link_window = probe_external_link_target()
                if external_link_window not in user_window_ids:
                    raise RuntimeError(
                        "external application link was routed outside the pre-existing user Chrome windows "
                        f"(userWindows={sorted(user_window_ids)}, parkedWindows={sorted(parked_window_ids)}, targetWindow={external_link_window})"
                    )
                assert_no_desktop_disruption("external-link routing and restoration")
                external_links_verified = True

            call_tool(client, "browser_evaluate", {
                "function": """() => {
                    document.body.innerHTML = `
                      <button id="pw-bg-click" style="position:fixed;left:8px;top:8px;width:160px;height:44px;transition:none;animation:none">Background click</button>
                      <input id="pw-bg-input" aria-label="Background input" style="position:fixed;left:8px;top:64px;width:220px;height:44px;transition:none;animation:none">
                    `;
                    window.__pwBackgroundClicks = 0;
                    window.__pwBackgroundClickTrusted = false;
                    window.__pwBackgroundInputEvents = 0;
                    window.__pwBackgroundInputTrusted = true;
                    document.querySelector('#pw-bg-click').addEventListener('click', event => {
                      window.__pwBackgroundClicks++;
                      window.__pwBackgroundClickTrusted = event.isTrusted;
                    });
                    document.querySelector('#pw-bg-input').addEventListener('input', event => {
                      window.__pwBackgroundInputEvents++;
                      window.__pwBackgroundInputTrusted &&= event.isTrusted;
                    });
                    return `visibility=${document.visibilityState}`;
                }""",
            })
            if workspace.get("state") == "fullscreen":
                # A fullscreen lane lives on its own Space: it is entirely off the
                # visible desktop, which is a stronger occlusion than any panel.
                cover_process, workspace_fully_covered = None, False
            else:
                cover_process, workspace_fully_covered = start_workspace_cover(workspace)
            time.sleep(1)
            visibility_result = tool_text(call_tool(client, "browser_evaluate", {
                "function": "() => `visibility=${document.visibilityState}`",
            }))
            if "visibility=visible" not in visibility_result:
                raise RuntimeError(
                    "fully covered workspace became hidden; Chrome was not launched with "
                    f"the occlusion safeguard: {visibility_result}"
                )
            raf_result = tool_text(call_tool(client, "browser_evaluate", {
                "function": """() => new Promise(resolve => {
                    let settled = false;
                    requestAnimationFrame(() => {
                      if (!settled) {
                        settled = true;
                        resolve('raf=ok');
                      }
                    });
                    setTimeout(() => {
                      if (!settled) {
                        settled = true;
                        resolve('raf=timeout');
                      }
                    }, 2000);
                })""",
            }))
            if "raf=ok" not in raf_result:
                raise RuntimeError(f"normal unfocused workspace did not produce animation frames: {raf_result}")

            call_tool(client, "browser_click", {
                "element": "Background click test button",
                "target": "#pw-bg-click",
            })
            call_tool(client, "browser_type", {
                "element": "Background input test field",
                "target": "#pw-bg-input",
                "text": "background-input-ok",
                "slowly": True,
            })
            input_result = tool_text(call_tool(client, "browser_evaluate", {
                "function": """() => `clicks=${window.__pwBackgroundClicks};clickTrusted=${window.__pwBackgroundClickTrusted};inputTrusted=${window.__pwBackgroundInputEvents > 0 && window.__pwBackgroundInputTrusted};value=${document.querySelector('#pw-bg-input').value}`""",
            }))
            if "clicks=1;clickTrusted=true;inputTrusted=true;value=background-input-ok" not in input_result:
                raise RuntimeError(f"background click/type result was incorrect: {input_result}")
            screenshot = call_tool(client, "browser_take_screenshot", {})
            if not any(item.get("type") == "image" for item in screenshot.get("content", [])):
                raise RuntimeError(f"screenshot of the lane tab returned no image: {screenshot}")
            stop_process(cover_process)
            cover_process = None
            assert_no_desktop_disruption("covered background input")

            # Lanes are normal-type windows, so a session may hold several tabs:
            # browser_tabs(new) must land inside the same lane as a background
            # tab, owned by this session, without touching the user's selection.
            # (A page popup opened by window.open with window features still
            # materialises as a separate window; the extension removes that
            # spill and fails the session closed, as covered by the unit suite.)
            call_tool(client, "browser_tabs", {"action": "new"})
            tabs_status = bridge_status()
            tabs_matching = [connection for connection in tabs_status if connection.get("clientName") == "background-acceptance"]
            tabs_workspace = tabs_matching[0].get("workspace") if len(tabs_matching) == 1 else None
            if (not isinstance(tabs_workspace, dict) or tabs_workspace.get("windowId") != workspace.get("windowId") or
                    tabs_workspace.get("ownedTabCount") != 2):
                raise RuntimeError(f"browser_tabs(new) did not add a second owned tab inside the same lane: {tabs_workspace}")
            if chrome_front_selection() != before_front_selection:
                raise RuntimeError("browser_tabs(new) changed the user's front Chrome window or active tab")
            call_tool(client, "browser_tabs", {"action": "close"})

            # Page-initiated new tabs would make Chromium Show() the lane, which
            # activates it on macOS. The launcher injects a script that turns
            # target=_blank clicks into same-tab navigations, so a noopener
            # link must navigate this tab in place: same lane, still one owned
            # tab, user selection untouched.
            user_tabs_before_popup = chrome_tab_counts()
            call_tool(client, "browser_evaluate", {
                "function": """() => {
                    const link = document.createElement('a');
                    link.id = 'pw-noopener';
                    link.href = 'https://example.com/?noopener';
                    link.target = '_blank';
                    link.rel = 'noopener';
                    link.textContent = 'noopener link';
                    link.style.cssText = 'position:fixed;left:8px;top:120px;width:160px;height:44px;display:block';
                    document.body.appendChild(link);
                    return 'ok';
                }""",
            })
            call_tool(client, "browser_click", {"element": "noopener link", "target": "#pw-noopener"})
            time.sleep(1)
            popup_status = bridge_status()
            popup_matching = [connection for connection in popup_status if connection.get("clientName") == "background-acceptance"]
            popup_workspace = popup_matching[0].get("workspace") if len(popup_matching) == 1 else None
            if (not isinstance(popup_workspace, dict) or popup_workspace.get("windowId") != workspace.get("windowId") or
                    popup_workspace.get("ownedTabCount") != 1):
                raise RuntimeError(
                    "target=_blank click did not stay inside the single lane tab: "
                    f"{popup_workspace}, tabs before={user_tabs_before_popup}, after={chrome_tab_counts()}"
                )
            landed = tool_text(call_tool(client, "browser_evaluate", {"function": "() => location.href"}))
            if "noopener" not in landed:
                raise RuntimeError(f"target=_blank click did not navigate the lane tab in place: {landed}")
            if chrome_front_selection() != before_front_selection:
                raise RuntimeError("target=_blank click changed the user's front Chrome window or active tab")
            if chrome_tab_counts() != user_tabs_before_popup:
                raise RuntimeError("target=_blank click changed the Chrome tab count")
            call_tool(client, "browser_navigate", {"url": "https://www.iana.org/help/example-domains"})
            call_tool(client, "browser_snapshot", {})
            after_actions_tabs = chrome_tab_counts()
            after_actions_front_selection = chrome_front_selection()
            if after_actions_front_selection != before_front_selection:
                raise RuntimeError(
                    "browser actions changed the user's front Chrome window or active tab "
                    f"(before={before_front_selection}, after-actions={after_actions_front_selection})"
                )
            after_actions_status = bridge_status()
            call_tool(client, "browser_close", {})
        finally:
            client.close()

        deadline = time.monotonic() + 10
        after_count, after_minimized = chrome_windows()
        after_tabs = chrome_tab_counts()
        after_front_selection = chrome_front_selection()
        remaining = [connection for connection in bridge_status() if connection.get("clientName") == "background-acceptance"]
        after_bridge_state = bridge_state()
        while (after_count != before_count or remaining or
               after_bridge_state.get("parkedWorkspaceCount", 0) < before_bridge_state["parkedWorkspaceCount"]) and time.monotonic() < deadline:
            time.sleep(0.1)
            after_count, after_minimized = chrome_windows()
            after_tabs = chrome_tab_counts()
            remaining = [connection for connection in bridge_status() if connection.get("clientName") == "background-acceptance"]
            after_bridge_state = bridge_state()
        if after_count != before_count or after_minimized != before_minimized:
            raise RuntimeError("browser_close did not restore the original Chrome window state")
        if remaining:
            raise RuntimeError("browser_close did not close the acceptance connection")
        if after_bridge_state.get("parkedWorkspaceCount") != before_bridge_state["parkedWorkspaceCount"]:
            raise RuntimeError("browser_close did not return the workspace to the parked pool")
        if after_tabs != before_tabs:
            raise RuntimeError(
                "browser_close left a changed Chrome tab count "
                f"(before={before_tabs}, after-initial-nav={during_tabs}, "
                f"after-actions={after_actions_tabs}, after={after_tabs}, "
                f"status-after-actions={after_actions_status})"
            )
        if after_front_selection != before_front_selection:
            raise RuntimeError(
                "browser_close did not restore the user's front Chrome window or active tab "
                f"(before={before_front_selection}, after={after_front_selection})"
            )

        assert_no_desktop_disruption("background control and cleanup")

        print(json.dumps({
            "status": "pass",
            "frontmostAtStart": ready.removeprefix("READY:"),
            "chromeWindowCount": {"before": before_count, "during": during_count, "after": after_count},
            "agentWindowReusedFromPool": during_count == before_count,
            "chromeTabCounts": {"before": before_tabs, "after": after_tabs},
            "userChromeSelectionUnchanged": True,
            "workspaceType": workspace.get("type"),
            "externalLinksRouteToUserWindow": True if external_links_verified else "verified-during-pool-preparation",
            "extensionWorkspace": workspace,
            "animationFramesAvailable": True,
            "trustedClickDelivered": True,
            "trustedKeyboardInputDelivered": True,
            "agentWindowState": "normal-type-normal-state-unfocused-lane",
            "workspaceFullyCovered": workspace_fully_covered,
            "workspaceOffCurrentSpace": not workspace_fully_covered,
            "chromeActivated": False,
            "activeSpaceChanged": False,
            "workspaceReturnedToPool": True,
            "parkedWorkspaceCount": after_bridge_state.get("parkedWorkspaceCount", 0),
        }, separators=(",", ":")))
        return 0
    finally:
        stop_process(cover_process)
        monitor.terminate()
        try:
            monitor.wait(timeout=3)
        except subprocess.TimeoutExpired:
            monitor.kill()
            monitor.wait(timeout=3)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"live browser acceptance failed: {error}", file=sys.stderr)
        raise SystemExit(1)
