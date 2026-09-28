#!/usr/bin/env python3
"""Live multi-client concurrency acceptance for the authenticated Chrome lanes.

Usage: python3 tests/live/live_browser_multi_client_acceptance.py [--clients N]  (default 4)
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import queue
import subprocess
import threading
import time
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
ACCEPTANCE = REPO / "tests/live/live_browser_background_acceptance.py"
CLIENT_COUNT = 4
EXPECTED_TAB_COUNT_PER_LANE = 1


def load_acceptance_module():
    spec = importlib.util.spec_from_file_location("browser_acceptance", ACCEPTANCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load browser acceptance client")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    global CLIENT_COUNT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--clients", type=int, default=CLIENT_COUNT, help="simultaneous MCP clients to run")
    CLIENT_COUNT = parser.parse_args().clients
    if CLIENT_COUNT < 1:
        raise RuntimeError("--clients must be at least 1")
    acceptance = load_acceptance_module()
    before_state = acceptance.bridge_state()
    parked_before = before_state.get("parkedWorkspaceCount", 0)
    capacity = before_state.get("capacity") if isinstance(before_state.get("capacity"), dict) else {}
    total_capacity = capacity.get("total", parked_before)
    if parked_before < 1 or total_capacity < CLIENT_COUNT:
        raise RuntimeError(
            f"multi-client acceptance requires lane capacity for {CLIENT_COUNT} clients, found {parked_before} lanes / {total_capacity} sessions"
        )
    if before_state["connections"]:
        raise RuntimeError("multi-client acceptance requires no active browser connections")
    parked_window_ids = set(before_state.get("parkedWorkspaceIds", []))
    if len(parked_window_ids) != parked_before:
        raise RuntimeError("native bridge returned malformed parked workspace IDs")
    before_count, before_minimized = acceptance.chrome_windows()
    before_tabs = acceptance.chrome_tab_counts()
    before_front_selection = acceptance.chrome_front_selection()

    monitor = subprocess.Popen(
        ["/usr/bin/swift", "-e", acceptance.SWIFT_MONITOR],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    events: queue.Queue[str] = queue.Queue()
    observed_events: list[str] = []
    assert monitor.stdout is not None
    threading.Thread(target=lambda: [events.put(line.rstrip()) for line in monitor.stdout], daemon=True).start()
    clients: list = []
    try:
        ready = events.get(timeout=20)
        if not ready.startswith("READY:"):
            raise RuntimeError("frontmost-application monitor did not start")
        expected_frontmost = ready.removeprefix("READY:")

        def assert_no_desktop_disruption(stage: str) -> None:
            while not events.empty():
                observed_events.append(events.get_nowait())
            unexpected = [
                event for event in observed_events
                if event.startswith("ACTIVATED:") and event != f"ACTIVATED:{expected_frontmost}"
            ]
            if unexpected:
                raise RuntimeError(f"the frontmost application changed during {stage}: {observed_events}")
            if "SPACE_CHANGED" in observed_events:
                raise RuntimeError(f"the active macOS Space changed during {stage}: {observed_events}")

        for index in range(CLIENT_COUNT):
            client = acceptance.JsonRpcClient()
            clients.append(client)
            client.send("initialize", {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": f"multi-client-{index + 1}", "version": "1.0"},
            })
            client.notify("notifications/initialized")

        barrier = threading.Barrier(CLIENT_COUNT)
        results: list[dict | None] = [None] * CLIENT_COUNT
        errors: list[BaseException | None] = [None] * CLIENT_COUNT

        def run_client(index: int) -> None:
            client = clients[index]
            name = f"multi-client-{index + 1}"
            try:
                barrier.wait(timeout=30)
                acceptance.call_tool_with_extension_startup(client, "browser_navigate", {"url": "https://example.com"})
                connection = acceptance.wait_for_bridge_connection(name, timeout=30)
                workspace = connection.get("workspace")
                acceptance.call_tool(client, "browser_evaluate", {
                    "function": """() => {
                        document.body.innerHTML = `
                          <button id="pw-mc-click" style="position:fixed;left:8px;top:8px;width:160px;height:44px;transition:none;animation:none">Concurrent click</button>
                          <input id="pw-mc-input" aria-label="Concurrent input" style="position:fixed;left:8px;top:64px;width:220px;height:44px;transition:none;animation:none">
                        `;
                        window.__pwMcClicks = 0;
                        window.__pwMcClickTrusted = false;
                        window.__pwMcInputEvents = 0;
                        window.__pwMcInputTrusted = true;
                        document.querySelector('#pw-mc-click').addEventListener('click', event => {
                          window.__pwMcClicks++;
                          window.__pwMcClickTrusted = event.isTrusted;
                        });
                        document.querySelector('#pw-mc-input').addEventListener('input', event => {
                          window.__pwMcInputEvents++;
                          window.__pwMcInputTrusted &&= event.isTrusted;
                        });
                        return 'installed';
                    }""",
                })
                acceptance.call_tool(client, "browser_click", {
                    "element": "Concurrent click test button",
                    "target": "#pw-mc-click",
                })
                acceptance.call_tool(client, "browser_type", {
                    "element": "Concurrent input test field",
                    "target": "#pw-mc-input",
                    "text": f"multi-{index + 1}-ok",
                    "slowly": True,
                })
                verdict = acceptance.tool_text(acceptance.call_tool(client, "browser_evaluate", {
                    "function": """() => `clicks=${window.__pwMcClicks};clickTrusted=${window.__pwMcClickTrusted};inputTrusted=${window.__pwMcInputEvents > 0 && window.__pwMcInputTrusted};value=${document.querySelector('#pw-mc-input').value}`""",
                }))
                results[index] = {"workspace": workspace, "verdict": verdict}
            except BaseException as error:  # noqa: BLE001 - reported per client below
                errors[index] = error

        threads = [threading.Thread(target=run_client, args=(index,), daemon=True) for index in range(CLIENT_COUNT)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=150)
        stuck = [index + 1 for index, thread in enumerate(threads) if thread.is_alive()]
        if stuck:
            raise RuntimeError(f"multi-client workers did not finish: clients {stuck}")
        failed = {index + 1: repr(error) for index, error in enumerate(errors) if error is not None}
        if failed:
            raise RuntimeError(f"multi-client workers failed: {failed}")

        window_ids: list[int] = []
        for index, outcome in enumerate(results):
            assert outcome is not None
            workspace = outcome["workspace"]
            if (not isinstance(workspace, dict) or workspace.get("type") != "normal" or
                    workspace.get("state") not in ("normal", "fullscreen") or workspace.get("focused") is not False):
                raise RuntimeError(
                    f"client {index + 1} lane is not normal-type, normal-state, unfocused: {workspace}"
                )
            if workspace.get("windowId") not in parked_window_ids:
                raise RuntimeError(
                    f"client {index + 1} was not placed in a pre-positioned lane: {workspace}"
                )
            window_ids.append(workspace["windowId"])
            expected = f"clicks=1;clickTrusted=true;inputTrusted=true;value=multi-{index + 1}-ok"
            if expected not in outcome["verdict"]:
                raise RuntimeError(
                    f"client {index + 1} trusted-input verdict was incorrect: {outcome['verdict']}"
                )
        # Sessions spread across lanes: with more clients than lanes, every lane
        # is used; with fewer, every client gets its own lane.
        expected_distinct = min(CLIENT_COUNT, parked_before)
        if len(set(window_ids)) != expected_distinct:
            raise RuntimeError(f"clients were not spread across lanes (expected {expected_distinct} distinct): {window_ids}")

        during_front_selection = acceptance.chrome_front_selection()
        if during_front_selection != before_front_selection:
            raise RuntimeError(
                "concurrent agent work changed the user's front Chrome selection "
                f"(before={before_front_selection}, during={during_front_selection})"
            )
        assert_no_desktop_disruption("concurrent leasing and trusted input")

        for client in clients:
            acceptance.call_tool(client, "browser_close", {})
        for client in clients:
            client.close()
        clients = []

        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            after_state = acceptance.bridge_state()
            remaining = [
                connection for connection in after_state["connections"]
                if isinstance(connection, dict) and str(connection.get("clientName", "")).startswith("multi-client-")
            ]
            after_count, after_minimized = acceptance.chrome_windows()
            if (not remaining and after_state.get("parkedWorkspaceCount") == parked_before and
                    after_count == before_count):
                break
            time.sleep(0.2)
        else:
            raise RuntimeError(
                "browser_close did not settle back to the parked pool "
                f"(state={acceptance.bridge_state()})"
            )
        after_tabs = acceptance.chrome_tab_counts()
        after_front_selection = acceptance.chrome_front_selection()
        if after_count != before_count or after_minimized != before_minimized:
            raise RuntimeError("browser_close did not restore the original Chrome window state")
        if after_tabs != before_tabs:
            raise RuntimeError(
                f"browser_close left a changed Chrome tab count (before={before_tabs}, after={after_tabs})"
            )
        if after_front_selection != before_front_selection:
            raise RuntimeError(
                "browser_close did not restore the user's front Chrome selection "
                f"(before={before_front_selection}, after={after_front_selection})"
            )
        after_parked = acceptance.bridge_state()
        parked_workspaces = after_parked.get("parkedWorkspaces")
        if (not isinstance(parked_workspaces, list) or len(parked_workspaces) != parked_before or
                any(not isinstance(workspace, dict) or workspace.get("type") != "normal" or
                    workspace.get("state") not in ("normal", "fullscreen") or workspace.get("focused") is not False or
                    workspace.get("tabCount") != EXPECTED_TAB_COUNT_PER_LANE or workspace.get("sessionCount") != 0
                    for workspace in parked_workspaces)):
            raise RuntimeError(
                f"lane pool did not return to normal-type, normal-state, unfocused, anchor-only lanes: {after_parked}"
            )
        assert_no_desktop_disruption("multi-client cleanup")

        print(json.dumps({
            "status": "pass",
            "frontmostAtStart": expected_frontmost,
            "clients": CLIENT_COUNT,
            "laneWindowIds": sorted(set(window_ids)),
            "sessionsPerLane": {str(window_id): window_ids.count(window_id) for window_id in sorted(set(window_ids))},
            "trustedClickDeliveredPerClient": True,
            "trustedKeyboardInputDeliveredPerClient": True,
            "userChromeSelectionUnchanged": True,
            "frontmostAppChanged": False,
            "activeSpaceChanged": False,
            "parkedWorkspaceCount": after_parked.get("parkedWorkspaceCount", 0),
            "poolRestored": True,
        }, separators=(",", ":")))
        return 0
    finally:
        for client in clients:
            try:
                client.close()
            except Exception:
                pass
        monitor.terminate()
        try:
            monitor.wait(timeout=3)
        except subprocess.TimeoutExpired:
            monitor.kill()
            monitor.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
