#!/usr/bin/env python3
"""Provision reusable authenticated Chrome workspaces without opening an MCP session."""

from __future__ import annotations

import importlib.util
import json
import queue
import subprocess
import threading
import time
from pathlib import Path


REPO = Path(__file__).resolve().parents[2]
ACCEPTANCE = REPO / "tests/live/live_browser_background_acceptance.py"
BRIDGE = Path.home() / ".local/bin/playwright-mcp-native-bridge"
TARGET_CAPACITY = 4


def load_acceptance_module():
    spec = importlib.util.spec_from_file_location("browser_acceptance", ACCEPTANCE)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load browser acceptance client")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def bridge_state() -> dict:
    result = subprocess.run(
        [str(BRIDGE), "--status"],
        check=True,
        capture_output=True,
        text=True,
        timeout=5,
    )
    payload = json.loads(result.stdout)
    if not isinstance(payload, dict) or not isinstance(payload.get("connections"), list):
        raise RuntimeError("native bridge returned malformed status")
    return payload


def main() -> int:
    import argparse
    parser = argparse.ArgumentParser(description="Provision reusable authenticated Chrome lanes.")
    parser.add_argument("--lane-state", choices=("normal", "fullscreen"), default=None,
                        help="lane window state the loaded extension creates; defaults to the broker's reported laneWindowState, else normal")
    args = parser.parse_args()
    acceptance = load_acceptance_module()
    initial = bridge_state()
    parked = initial.get("parkedWorkspaceCount", 0)
    if not isinstance(parked, int) or parked < 0:
        raise RuntimeError("native bridge returned malformed parked workspace count")
    if initial["connections"]:
        raise RuntimeError("pool preparation requires no active browser connections")
    before_window_ids = acceptance.chrome_window_ids()
    before_front_selection = acceptance.chrome_front_selection()
    monitor = subprocess.Popen(
        ["/usr/bin/swift", "-e", acceptance.SWIFT_MONITOR],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        bufsize=1,
    )
    events: queue.Queue[str] = queue.Queue()
    assert monitor.stdout is not None
    threading.Thread(target=lambda: [events.put(line.rstrip()) for line in monitor.stdout], daemon=True).start()
    preparation_succeeded = False
    try:
        ready = events.get(timeout=20)
        if not ready.startswith("READY:"):
            raise RuntimeError("frontmost-application monitor did not start")
        expected_frontmost = ready.removeprefix("READY:")
        if expected_frontmost != "com.google.Chrome":
            raise RuntimeError(
                "one-time pool preparation requires regular Chrome to remain frontmost"
            )
        result = subprocess.run(
            [str(BRIDGE), "--prepare-pool", str(TARGET_CAPACITY)],
            check=False,
            capture_output=True,
            text=True,
            timeout=95,
        )
        if result.returncode != 0:
            diagnostic = result.stderr.strip()
            try:
                diagnostic = bridge_state().get("diagnostic") or diagnostic
            except (OSError, RuntimeError, subprocess.SubprocessError, json.JSONDecodeError):
                pass
            raise RuntimeError(diagnostic or "workspace pool preparation was rejected")
        preparation_succeeded = True
        prepared = json.loads(result.stdout)
        final = bridge_state()
        if final.get("connections"):
            raise RuntimeError("pool preparation created an agent connection")
        if final.get("parkedWorkspaceCount") != TARGET_CAPACITY:
            raise RuntimeError(f"workspace pool did not reach target capacity: {final}")
        parked_workspaces = final.get("parkedWorkspaces")
        if (not isinstance(parked_workspaces, list) or len(parked_workspaces) != TARGET_CAPACITY or
                any(not isinstance(workspace, dict) or workspace.get("type") != "normal" or
                    workspace.get("state") not in ("normal", "fullscreen") or workspace.get("focused") is not False or
                    workspace.get("tabCount") != 1 for workspace in parked_workspaces)):
            raise RuntimeError(f"lane pool is not entirely normal-type, normal-state, unfocused, single-tab: {final}")
        created = prepared.get("created")
        if not isinstance(created, int) or isinstance(created, bool) or not 0 <= created <= TARGET_CAPACITY:
            raise RuntimeError(f"workspace pool reported a malformed created count: {prepared}")
        after_front_selection = acceptance.chrome_front_selection()
        if after_front_selection != before_front_selection:
            raise RuntimeError(
                "pool preparation changed the user's front Chrome selection "
                f"(before={before_front_selection}, after={after_front_selection})"
            )
        target_window = acceptance.probe_external_link_target(before_front_selection)
        if target_window not in before_window_ids:
            raise RuntimeError(
                "pool preparation changed external-link routing "
                f"(userWindows={sorted(before_window_ids)}, targetWindow={target_window})"
            )
        after_probe_front_selection = acceptance.chrome_front_selection()
        if after_probe_front_selection != before_front_selection:
            raise RuntimeError(
                "external-link routing probe changed the user's front Chrome selection "
                f"(before={before_front_selection}, after={after_probe_front_selection})"
            )
        observed = []
        while not events.empty():
            observed.append(events.get_nowait())
        unexpected_activations = [
            event for event in observed
            if event.startswith("ACTIVATED:") and event != f"ACTIVATED:{expected_frontmost}"
        ]
        lane_state = args.lane_state or final.get("laneWindowState", "normal")
        space_changes = observed.count("SPACE_CHANGED")
        # Fullscreen lanes are created on their own Space, so macOS switches away
        # and back once per lane; the desktop must still end where it started.
        space_ok = space_changes == 0 if lane_state != "fullscreen" else space_changes % 2 == 0
        if unexpected_activations or not space_ok:
            raise RuntimeError(f"pool preparation disrupted the desktop: {observed}")
        print(json.dumps({
            "status": "pass",
            "targetCapacity": TARGET_CAPACITY,
            "created": created,
            "parkedWorkspaceCount": final["parkedWorkspaceCount"],
            "workspaceType": "normal",
            "frontSelectionUnchanged": True,
            "externalLinksRouteToUserWindow": True,
            "frontmostAppChanged": False,
            "activeSpaceChanged": False,
            "laneWindowState": lane_state,
            "transientSpaceSwitches": space_changes,
        }, separators=(",", ":")))
        return 0
    except Exception as error:
        if preparation_succeeded:
            cleanup = subprocess.run(
                [str(BRIDGE), "--discard-pool"],
                check=False,
                capture_output=True,
                text=True,
                timeout=95,
            )
            try:
                cleanup_payload = json.loads(cleanup.stdout) if cleanup.stdout else {}
            except json.JSONDecodeError:
                cleanup_payload = {}
            final_after_cleanup = bridge_state()
            if cleanup.returncode != 0 or final_after_cleanup.get("parkedWorkspaceCount") != 0:
                raise RuntimeError(
                    "pool validation failed and automatic safe rollback was incomplete: "
                    f"validation={error}; cleanup={cleanup.stderr.strip() or cleanup_payload}; "
                    f"status={final_after_cleanup}"
                ) from error
        raise
    finally:
        monitor.terminate()
        try:
            monitor.wait(timeout=3)
        except subprocess.TimeoutExpired:
            monitor.kill()
            monitor.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
