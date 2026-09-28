#!/usr/bin/env python3
"""Focused tests for the authenticated Chrome launch invariant."""

from __future__ import annotations

import importlib.machinery
import importlib.util
import copy
import plistlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
HELPER = REPO / "bin/chrome-background-safe"
DOCK_INSTALLER = REPO / "bin/install-chrome-background-safe"
APP_SOURCE = REPO / "launcher/Contents"


class ChromeBackgroundSafeTests(unittest.TestCase):
    def test_only_regular_chrome_with_occlusion_switch_is_ready(self) -> None:
        self.assertTrue(HELPER.is_file(), "background-safe Chrome helper is missing")
        loader = importlib.machinery.SourceFileLoader("chrome_background_safe", str(HELPER))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        regular = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
        safe = f"{regular} --disable-backgrounding-occluded-windows"
        headless = (
            f"{regular} --headless --user-data-dir=/tmp/playwright-profile "
            "--disable-backgrounding-occluded-windows"
        )
        remote_debugging = f"{safe} --remote-debugging-port=9222"
        test_type = f"{safe} --test-type"
        automated = f"{safe} --enable-automation"
        # A non-regular Chrome without --user-data-dir (e.g. remote debugging
        # attached to the Default profile itself) is not a foreign-profile
        # instance and must still block the safety check.
        debug_default_profile = f"{regular} --remote-debugging-port=9222"

        self.assertTrue(module.is_background_safe_regular_chrome(safe))
        self.assertFalse(module.is_background_safe_regular_chrome(regular))
        self.assertFalse(module.is_background_safe_regular_chrome(headless))
        self.assertFalse(module.is_background_safe_regular_chrome(remote_debugging))
        self.assertFalse(module.is_background_safe_regular_chrome(test_type))
        self.assertFalse(module.is_background_safe_regular_chrome(automated))
        self.assertFalse(module.is_background_safe_regular_chrome(f"sh -c {safe}"))
        self.assertFalse(module.is_foreign_profile_chrome(safe))
        self.assertFalse(module.is_foreign_profile_chrome(regular))
        self.assertFalse(module.is_foreign_profile_chrome(debug_default_profile))
        self.assertTrue(module.is_foreign_profile_chrome(headless))
        # A single regular, safe Chrome plus any number of foreign-profile
        # Chrome instances (headless, copied-profile) is still safe: those
        # instances are ignored rather than counted as ambiguity.
        self.assertTrue(module.commands_are_background_safe([safe, headless]))
        self.assertTrue(module.commands_are_background_safe([safe, headless, headless]))
        self.assertFalse(module.commands_are_background_safe([safe, regular]))
        self.assertFalse(module.commands_are_background_safe([safe, debug_default_profile]))
        self.assertFalse(module.commands_are_background_safe([headless]))
        self.assertFalse(module.commands_are_background_safe([]))
        self.assertEqual(module.launch_decision([]), "start")
        self.assertEqual(module.launch_decision([safe]), "activate")
        self.assertEqual(module.launch_decision([regular]), "refuse")
        self.assertEqual(module.launch_decision([safe, regular]), "refuse")
        # No regular Chrome at all: a lone foreign-profile Chrome (e.g. a
        # copied-profile headless instance from another tool) is invisible to
        # this decision, so it's treated the same as no Chrome running.
        self.assertEqual(module.launch_decision([headless]), "start")
        self.assertEqual(module.launch_decision([safe, headless]), "activate")
        self.assertEqual(module.launch_decision([safe, debug_default_profile]), "refuse")

        with mock.patch.object(module, "_process_commands", return_value=[debug_default_profile]), \
                mock.patch.object(module.subprocess, "run") as run:
            self.assertEqual(module.launch(), 1)
            run.assert_not_called()

        with mock.patch.object(module, "_process_commands", side_effect=[[], [safe]]), \
                mock.patch.object(module.subprocess, "run") as run:
            self.assertEqual(module.launch(), 0)
            run.assert_called_once_with(
                ["/usr/bin/open", "-a", module.CHROME_APP, "--args", module.REQUIRED_SWITCH],
                check=True,
                timeout=10,
            )

    def test_user_data_dir_pointed_at_the_real_default_is_not_foreign(self) -> None:
        self.assertTrue(HELPER.is_file(), "background-safe Chrome helper is missing")
        loader = importlib.machinery.SourceFileLoader(
            "chrome_background_safe_default_udd", str(HELPER)
        )
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        regular = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

        with tempfile.TemporaryDirectory() as home:
            # The command-line tokenizer here (like the rest of this module)
            # splits on whitespace, so exercise it with a directory name that
            # has no spaces rather than the real "Application Support" path;
            # the comparison logic under test is identical either way.
            default_dir = Path(home) / "DefaultChromeUserDataDir"
            default_dir.mkdir(parents=True)
            # A symlinked path that resolves (via realpath) to the same real
            # default directory must also be treated as the default, not a
            # distinct foreign profile.
            alias_parent = Path(home) / "alias"
            alias_parent.mkdir()
            alias_dir = alias_parent / "Chrome"
            alias_dir.symlink_to(default_dir, target_is_directory=True)

            # Override the module's default-directory constant (an env-style
            # override, not the real home directory or DEFAULT_USER_DATA_DIR)
            # so this test never touches the real filesystem default.
            with mock.patch.object(module, "DEFAULT_USER_DATA_DIR", str(default_dir)):
                default_profile = f"{regular} --user-data-dir={default_dir}"
                aliased_profile = f"{regular} --user-data-dir={alias_dir}"
                other_profile = f"{regular} --user-data-dir={home}/elsewhere"

                self.assertFalse(module.is_foreign_profile_chrome(default_profile))
                self.assertFalse(module.is_foreign_profile_chrome(aliased_profile))
                self.assertTrue(module.is_foreign_profile_chrome(other_profile))

                # Not foreign, but still not "regular" (it carries
                # --user-data-dir), so a debug/headless Chrome explicitly
                # pointed at the default directory still fails the safety
                # check and refuses launch rather than being ignored.
                self.assertFalse(module.commands_are_background_safe([default_profile]))
                self.assertFalse(module.commands_are_background_safe([aliased_profile]))
                self.assertEqual(module.launch_decision([default_profile]), "refuse")
                self.assertEqual(module.launch_decision([aliased_profile]), "refuse")
                # A genuinely foreign profile is unaffected by this change.
                self.assertEqual(module.launch_decision([other_profile]), "start")

    def test_dock_app_routes_through_the_checked_launcher(self) -> None:
        info_path = APP_SOURCE / "Info.plist"
        executable_path = APP_SOURCE / "MacOS/Google Chrome Agent Safe"
        self.assertTrue(info_path.is_file())
        self.assertTrue(executable_path.is_file())

        with info_path.open("rb") as stream:
            info = plistlib.load(stream)
        self.assertEqual(info["CFBundleIdentifier"], "agency.ziplyne.ChromeAgentSafe")
        self.assertEqual(info["CFBundleExecutable"], "Google Chrome Agent Safe")
        self.assertTrue(info["LSUIElement"])

        executable = executable_path.read_text()
        self.assertIn("$HOME/.local/bin/chrome-background-safe", executable)
        self.assertIn("--launch", executable)
        self.assertIn('--dock-mode "$1"', executable)
        self.assertIn("sync_dock running", executable)
        # Dock integration is opt-in through a marker the installer writes.
        self.assertIn(".config/agent-lanes/dock", executable)
        self.assertIn("sync_dock launcher", executable)
        self.assertNotIn("Google Chrome.app/Contents/MacOS", executable)

    def test_authenticated_browser_fails_closed_without_the_switch(self) -> None:
        server = (REPO / "bin/browser-mcp-server").read_text()
        self.assertIn("verify_chrome_background_safe", server)
        self.assertIn("chrome-background-safe", server)
        self.assertIn("--disable-backgrounding-occluded-windows", server)
        self.assertNotIn("CHROME_BACKGROUND_SAFE_HELPER", server)

    def test_browser_installer_manages_the_launcher_and_dock_replacement(self) -> None:
        installer = (REPO / "scripts/install.sh").read_text()
        self.assertIn("install_launcher", installer)
        self.assertIn("install-chrome-background-safe", installer)
        self.assertIn("--preserve-running-chrome", installer)
        self.assertIn("--dock", installer)

        self.assertTrue(DOCK_INSTALLER.is_file())
        loader = importlib.machinery.SourceFileLoader("install_chrome_background_safe", str(DOCK_INSTALLER))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)

        dock = {
            "persistent-apps": [
                {
                    "GUID": 123,
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "book": b"stale-bookmark",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                        "file-label": "Google Chrome",
                    },
                    "tile-type": "file-tile",
                },
                {"GUID": 456, "tile-data": {"bundle-identifier": "dev.zed.Zed"}},
            ]
        }
        changed = module.replace_chrome_dock_item(dock, "file:///Users/test/Google%20Chrome%20%28Agent%20Safe%29.app/")
        self.assertTrue(changed)
        self.assertEqual(dock["persistent-apps"][0]["GUID"], 123)
        self.assertEqual(
            dock["persistent-apps"][0]["tile-data"]["bundle-identifier"],
            "agency.ziplyne.ChromeAgentSafe",
        )
        self.assertNotIn("book", dock["persistent-apps"][0]["tile-data"])
        self.assertEqual(dock["persistent-apps"][1]["GUID"], 456)
        self.assertFalse(module.replace_chrome_dock_item(
            dock,
            "file:///Users/test/Google%20Chrome%20%28Agent%20Safe%29.app/",
        ))
        duplicate = {
            "persistent-apps": [
                {
                    "GUID": 789,
                    "tile-data": {
                        "bundle-identifier": "agency.ziplyne.ChromeAgentSafe",
                        "file-data": {"_CFURLString": "file:///safe.app/"},
                    },
                },
                {"GUID": 987, "tile-data": {"bundle-identifier": "com.google.Chrome"}},
            ]
        }
        self.assertTrue(module.replace_chrome_dock_item(duplicate, "file:///safe.app/"))
        self.assertEqual(len(duplicate["persistent-apps"]), 1)
        self.assertEqual(duplicate["persistent-apps"][0]["GUID"], 789)

        normalized_duplicate = {
            "persistent-apps": [
                {
                    "GUID": 790,
                    "tile-data": {
                        "bundle-identifier": "agency.ziplyne.ChromeAgentSafe",
                        "file-data": {
                            "_CFURLString": "file:///Users/test/Google%20Chrome%20(Agent%20Safe).app/"
                        },
                    },
                },
                {"GUID": 988, "tile-data": {"bundle-identifier": "com.google.Chrome"}},
            ]
        }
        self.assertTrue(module.replace_chrome_dock_item(
            normalized_duplicate,
            "file:///Users/test/Google%20Chrome%20%28Agent%20Safe%29.app/",
        ))
        self.assertEqual(len(normalized_duplicate["persistent-apps"]), 1)

        duplicate_regular = {
            "persistent-apps": [
                {
                    "GUID": 991,
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    },
                },
                {
                    "GUID": 992,
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    },
                },
            ]
        }
        self.assertTrue(module.replace_chrome_dock_item(duplicate_regular, "file:///safe.app/"))
        self.assertEqual(len(duplicate_regular["persistent-apps"]), 1)
        self.assertEqual(duplicate_regular["persistent-apps"][0]["GUID"], 991)
        self.assertEqual(
            duplicate_regular["persistent-apps"][0]["tile-data"]["bundle-identifier"],
            module.SAFE_BUNDLE_ID,
        )

        ambiguous = {
            "persistent-apps": [
                {
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    }
                },
                {
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Another%20Chrome.app/"},
                    }
                },
            ]
        }
        with self.assertRaisesRegex(RuntimeError, "ambiguous"):
            module.replace_chrome_dock_item(ambiguous, "file:///safe.app/")

        retired = [
            {"GUID": 1, "tile-data": {"bundle-identifier": "com.google.Chrome.dev"}},
            {"GUID": 2, "tile-data": {"bundle-identifier": "com.google.chrome.for.testing"}},
            {"GUID": 3, "tile-data": {"bundle-identifier": "agency.ziplyne.ChromeAgentSafe"}},
            {"GUID": 4, "tile-data": {"bundle-identifier": "dev.zed.Zed"}},
        ]
        # The public installer removes no other browser's Dock tile.
        self.assertEqual(
            [item["GUID"] for item in module.remove_retired_browser_tiles(retired)],
            [1, 2, 3, 4],
        )
        running_dock = {"persistent-apps": [retired[2], retired[3]]}
        self.assertTrue(module.replace_safe_dock_item_with_regular(running_dock))
        self.assertEqual(
            running_dock["persistent-apps"][0]["tile-data"]["bundle-identifier"],
            module.CHROME_BUNDLE_ID,
        )
        self.assertFalse(module.replace_safe_dock_item_with_regular(running_dock))

        running_duplicate = {
            "persistent-apps": [
                {
                    "GUID": 993,
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    },
                },
                {
                    "GUID": 994,
                    "tile-data": {
                        "bundle-identifier": "com.google.Chrome",
                        "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    },
                },
            ]
        }
        self.assertTrue(module.replace_safe_dock_item_with_regular(running_duplicate))
        self.assertEqual([item["GUID"] for item in running_duplicate["persistent-apps"]], [993])

        source = [
            {
                "GUID": 123,
                "tile-data": {
                    "bundle-identifier": "com.google.Chrome",
                    "book": b"stale-bookmark",
                    "file-data": {"_CFURLString": "file:///Applications/Google%20Chrome.app/"},
                    "file-label": "Google Chrome",
                },
                "tile-type": "file-tile",
            },
            {"GUID": 456, "tile-data": {"bundle-identifier": "dev.zed.Zed"}},
        ]
        stored = copy.deepcopy(source)

        def read_apps() -> list[dict]:
            return copy.deepcopy(stored)

        def write_apps(apps: list[dict]) -> None:
            stored[:] = copy.deepcopy(apps)

        with tempfile.TemporaryDirectory() as temporary, \
                mock.patch.object(module, "_read_persistent_apps", side_effect=read_apps), \
                mock.patch.object(module, "_write_persistent_apps", side_effect=write_apps), \
                mock.patch.object(module, "_dock_pid", return_value=None):
            destination = Path("/Users/test/Applications/Google Chrome (Agent Safe).app")
            self.assertTrue(module._replace_dock(destination, Path(temporary)))
            self.assertEqual(stored[0]["tile-data"]["bundle-identifier"], module.SAFE_BUNDLE_ID)
            self.assertEqual(stored[1], source[1])
            backup = Path(temporary) / "Library/Preferences/com.apple.dock.persistent-apps.plist"
            self.assertEqual(plistlib.loads(backup.read_bytes()), source)

        installer_source = DOCK_INSTALLER.read_text()
        self.assertIn("CFPreferencesSetAppValue", installer_source)
        self.assertNotIn('defaults\", \"import', installer_source)
        with mock.patch.object(module, "_copy_app"), \
                mock.patch.object(module, "sync_dock_mode") as sync_mode, \
                mock.patch.object(module, "_replace_dock") as replace_dock:
            module.install(APP_SOURCE, Path("/tmp/browser-test-backup"), preserve_running_chrome=True)
            sync_mode.assert_called_once_with("running")
            replace_dock.assert_not_called()

    def test_live_acceptance_covers_the_workspace_before_trusted_input(self) -> None:
        acceptance = (REPO / "tests/live/live_browser_background_acceptance.py").read_text()
        self.assertIn("SWIFT_WORKSPACE_COVER", acceptance)
        self.assertIn("workspaceFullyCovered", acceptance)
        self.assertIn("visibility=visible", acceptance)
        self.assertIn("READY:COVERED", acceptance)
        self.assertIn("PW_COVER_LEFT", acceptance)
        self.assertIn("PW_COVER_WIDTH", acceptance)
        self.assertIn("secrets.token_hex", acceptance)
        self.assertIn("kCGWindowOwnerName", acceptance)
        self.assertIn("kCGWindowNumber", acceptance)
        self.assertNotIn("PW_COVER_TITLE", acceptance)
        self.assertIn("cover_process", acceptance)


if __name__ == "__main__":
    unittest.main()
