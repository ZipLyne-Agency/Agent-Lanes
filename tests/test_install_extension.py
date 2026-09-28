#!/usr/bin/env python3
"""Focused tests for the extension installer's atomic swap and hash manifest."""

from __future__ import annotations

import hashlib
import importlib.machinery
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
INSTALLER = REPO / "bin/install-extension"


def load_installer_module():
    loader = importlib.machinery.SourceFileLoader("install_playwright_canary", str(INSTALLER))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def write_source(source: Path, version: str = "0.4.0") -> None:
    source.mkdir(parents=True, exist_ok=True)
    (source / "manifest.json").write_text(json.dumps({"name": "canary", "version": version}))
    (source / "connect.html").write_text("<html></html>")
    (source / "lib").mkdir(exist_ok=True)
    (source / "lib" / "background.js").write_text("// background")


def run_installer(args: list[str], pin_file: Path) -> subprocess.CompletedProcess:
    # Every successful run writes an owner-only pin file; point it at a
    # throwaway path so the test never touches the real ~/.config pin.
    env = dict(os.environ, PLAYWRIGHT_MCP_CANARY_PIN_FILE=str(pin_file))
    return subprocess.run(
        [sys.executable, str(INSTALLER), *args],
        capture_output=True,
        text=True,
        env=env,
    )


class InstallPlaywrightCanaryTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(INSTALLER.is_file(), "install-extension is missing")
        self.assertTrue(
            INSTALLER.stat().st_mode & 0o111,
            "install-extension must be executable",
        )
        self.module = load_installer_module()

    def test_refuses_a_source_without_a_built_manifest(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "out"
            dest = tmp / "dist"
            source.mkdir()
            result = subprocess.run(
                [sys.executable, str(INSTALLER), "--source", str(source), "--dest", str(dest)],
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("manifest.json", result.stderr)
            self.assertFalse(dest.exists())

    def test_installs_and_writes_a_hash_manifest_for_every_file(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "out"
            dest = tmp / "dist"
            pin_file = tmp / "config" / "agent-lanes/extension-pin.json"
            write_source(source)
            result = run_installer(["--source", str(source), "--dest", str(dest)], pin_file)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("0.4.0", result.stdout)
            self.assertIn(str(pin_file), result.stdout)

            for name in ("manifest.json", "connect.html", "lib/background.js"):
                self.assertTrue((dest / name).is_file())

            manifest = json.loads((dest / ".install-manifest.json").read_text())
            self.assertEqual(manifest["version"], "0.4.0")
            self.assertEqual(
                set(manifest["files"]),
                {"manifest.json", "connect.html", "lib/background.js"},
            )
            for relative_path, expected_hash in manifest["files"].items():
                actual_hash = hashlib.sha256((dest / relative_path).read_bytes()).hexdigest()
                self.assertEqual(actual_hash, expected_hash)
            # The manifest never hashes itself.
            self.assertNotIn(".install-manifest.json", manifest["files"])

            # The pin file lives outside dist/, is owner-only, and pins the
            # manifest's own hash plus the exact dest it belongs to.
            self.assertTrue(pin_file.is_file())
            self.assertEqual(pin_file.stat().st_mode & 0o777, 0o600)
            pin = json.loads(pin_file.read_text())
            self.assertEqual(pin["version"], "0.4.0")
            self.assertEqual(pin["dest"], str(dest.resolve()))
            self.assertEqual(
                pin["manifestSha256"],
                hashlib.sha256((dest / ".install-manifest.json").read_bytes()).hexdigest(),
            )

    def test_reinstall_atomically_replaces_a_stale_destination(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "out"
            dest = tmp / "dist"
            pin_file = tmp / "config" / "agent-lanes/extension-pin.json"
            write_source(source, version="0.4.0")
            first = run_installer(["--source", str(source), "--dest", str(dest)], pin_file)
            self.assertEqual(first.returncode, 0, first.stderr)
            # A file only the old install had must not survive the swap.
            (dest / "stale-leftover.js").write_text("// should be removed by reinstall")

            write_source(source, version="0.4.1")
            (source / "connect.html").write_text("<html>changed</html>")
            result = run_installer(["--source", str(source), "--dest", str(dest)], pin_file)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("0.4.1", result.stdout)
            self.assertFalse((dest / "stale-leftover.js").exists())
            manifest = json.loads((dest / ".install-manifest.json").read_text())
            self.assertEqual(manifest["version"], "0.4.1")

            # No .next/.prev staging directories are left behind.
            self.assertFalse((dest.parent / "dist.next").exists())
            self.assertFalse((dest.parent / "dist.prev").exists())

            # A reinstall overwrites the pin in place (mode 0600 preserved)
            # rather than leaving a stale pin from the earlier install.
            self.assertEqual(pin_file.stat().st_mode & 0o777, 0o600)
            pin = json.loads(pin_file.read_text())
            self.assertEqual(pin["version"], "0.4.1")
            self.assertEqual(
                pin["manifestSha256"],
                hashlib.sha256((dest / ".install-manifest.json").read_bytes()).hexdigest(),
            )

    def test_atomic_install_restores_the_original_dest_if_the_final_rename_fails(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "out"
            dest = tmp / "dist"
            write_source(source, version="0.4.0")
            dest.mkdir()
            (dest / "original.txt").write_text("original dest contents")

            real_rename = Path.rename
            call_count = {"n": 0}

            def flaky_rename(self, target):
                call_count["n"] += 1
                if call_count["n"] == 2:
                    raise OSError("simulated rename failure")
                return real_rename(self, target)

            with mock.patch.object(Path, "rename", flaky_rename):
                with self.assertRaises(OSError):
                    self.module.atomic_install(source, dest)

            # The original dest must be restored exactly as it was.
            self.assertTrue(dest.is_dir())
            self.assertEqual((dest / "original.txt").read_text(), "original dest contents")
            self.assertFalse((dest / "manifest.json").exists())

            # No leftover staging directories from the failed swap.
            self.assertFalse((dest.parent / "dist.next").exists())
            self.assertFalse((dest.parent / "dist.prev").exists())

    def test_write_pin_file_refuses_to_follow_a_symlink(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            source = tmp / "out"
            dest = tmp / "dist"
            write_source(source)
            first = run_installer(
                ["--source", str(source), "--dest", str(dest)],
                tmp / "config" / "agent-lanes/extension-pin.json",
            )
            self.assertEqual(first.returncode, 0, first.stderr)

            link_target = tmp / "attacker-controlled.json"
            pin_file = tmp / "config2" / "agent-lanes/extension-pin.json"
            pin_file.parent.mkdir(parents=True, exist_ok=True)
            pin_file.symlink_to(link_target)

            result = run_installer(["--source", str(source), "--dest", str(dest)], pin_file)
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(link_target.exists())
            # The symlink itself must be left exactly as it was, not replaced.
            self.assertTrue(pin_file.is_symlink())
            self.assertEqual(os.readlink(pin_file), str(link_target))

    def test_default_source_is_the_build_and_dest_is_outside_the_checkout(self):
        self.assertEqual(self.module.DEFAULT_SOURCE, REPO / "extension/out")
        self.assertEqual(
            self.module.DEFAULT_DEST,
            Path.home() / ".local/share/agent-lanes/extension",
        )


if __name__ == "__main__":
    unittest.main()
