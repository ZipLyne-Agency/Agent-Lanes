#!/usr/bin/env python3
import importlib.machinery
import importlib.util
import io
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest
from unittest import mock


REPO = Path(__file__).resolve().parents[1]
BRIDGE = REPO / "bin/playwright-mcp-native-bridge"
EXTENSION_ID = "mmlmfjhmonkocbjadbfplnigmagldckm"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}/"
TOKEN = "test-token-value-0123456789abcdefghijklmnop"


def load_bridge_module():
    loader = importlib.machinery.SourceFileLoader("playwright_mcp_native_bridge", str(BRIDGE))
    spec = importlib.util.spec_from_loader(loader.name, loader)
    module = importlib.util.module_from_spec(spec)
    loader.exec_module(module)
    return module


def connect_url(relay="ws://127.0.0.1:43123/relay", token=None):
    client = json.dumps({"name": "test-agent"}, separators=(",", ":"))
    from urllib.parse import urlencode
    params = {
        "mcpRelayUrl": relay,
        "protocolVersion": "91031",
        "client": client,
    }
    if token is not None:
        params["token"] = token
    query = urlencode(params)
    return f"chrome-extension://{EXTENSION_ID}/connect.html?{query}"


class NativeBridgeTests(unittest.TestCase):
    def setUp(self):
        self.assertTrue(BRIDGE.exists(), "native bridge executable is missing")
        self.bridge = load_bridge_module()

    def test_validates_and_redacts_connect_request(self):
        request = self.bridge.validate_connect_url(connect_url())
        self.assertEqual(request["relayUrl"], "ws://127.0.0.1:43123/relay")
        self.assertEqual(request["clientName"], "test-agent")
        self.assertNotIn("token", request)
        self.assertNotIn(TOKEN, json.dumps(request))

    def test_rejects_token_in_url_and_non_loopback_relay(self):
        with self.assertRaisesRegex(ValueError, "token"):
            self.bridge.validate_connect_url(connect_url(token=TOKEN))
        with self.assertRaisesRegex(ValueError, "loopback"):
            self.bridge.validate_connect_url(connect_url(relay="ws://example.com/relay"))
        with self.assertRaisesRegex(ValueError, "unexpected"):
            self.bridge.validate_connect_url(connect_url() + "&extra=value")

    def test_validates_popup_workspace_status_shape(self):
        valid = [{
            "windowId": 17,
            "type": "popup",
            "state": "normal",
            "focused": False,
            "tabCount": 1,
            "ignored": "not forwarded",
        }]
        self.assertEqual(self.bridge.validate_parked_workspace_summaries(valid), [{
            "windowId": 17,
            "type": "popup",
            "state": "normal",
            "focused": False,
            "tabCount": 1,
        }])
        self.assertEqual(self.bridge.validate_parked_workspace_summaries([
            {"windowId": True, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
        ]), [])

        # Optional lane telemetry (sessionCount, capacity): valid values pass through.
        with_lane_telemetry = [{
            "windowId": 17,
            "type": "normal",
            "state": "normal",
            "focused": False,
            "tabCount": 3,
            "sessionCount": 5,
            "capacity": 16,
        }]
        self.assertEqual(self.bridge.validate_parked_workspace_summaries(with_lane_telemetry), [{
            "windowId": 17,
            "type": "normal",
            "state": "normal",
            "focused": False,
            "tabCount": 3,
            "sessionCount": 5,
            "capacity": 16,
        }])
        # Malformed sessionCount or capacity rejects the whole list.
        self.assertEqual(self.bridge.validate_parked_workspace_summaries([{
            "windowId": 17, "type": "normal", "state": "normal", "focused": False, "tabCount": 3,
            "sessionCount": 257,
        }]), [])
        self.assertEqual(self.bridge.validate_parked_workspace_summaries([{
            "windowId": 17, "type": "normal", "state": "normal", "focused": False, "tabCount": 3,
            "sessionCount": -1,
        }]), [])
        self.assertEqual(self.bridge.validate_parked_workspace_summaries([{
            "windowId": 17, "type": "normal", "state": "normal", "focused": False, "tabCount": 3,
            "capacity": 0,
        }]), [])
        self.assertEqual(self.bridge.validate_parked_workspace_summaries([{
            "windowId": 17, "type": "normal", "state": "normal", "focused": False, "tabCount": 3,
            "capacity": "16",
        }]), [])

    def test_validates_pool_capacity_summary(self):
        self.assertEqual(
            self.bridge.validate_pool_capacity_summary({"lanes": 4, "perLane": 16, "total": 64, "inUse": 23}),
            {"lanes": 4, "perLane": 16, "total": 64, "inUse": 23},
        )
        # Malformed fields are individually dropped, not rejected wholesale.
        self.assertEqual(
            self.bridge.validate_pool_capacity_summary({"lanes": 4, "perLane": -1, "total": "64", "extra": 1}),
            {"lanes": 4},
        )
        self.assertEqual(self.bridge.validate_pool_capacity_summary(None), {})
        self.assertEqual(self.bridge.validate_pool_capacity_summary("not a dict"), {})
        self.assertEqual(self.bridge.validate_pool_capacity_summary({"lanes": True}), {})

    def test_connect_request_uses_extended_acknowledgement_timeout(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            native_output = io.BytesIO()
            host = self.bridge.NativeHost(
                tmp / "bridge.sock",
                token_file,
                native_output=native_output,
            )
            server, client = socket.socketpair()
            recorded_timeouts = []
            original_wait = threading.Event.wait

            def recording_wait(event, timeout=None):
                recorded_timeouts.append(timeout)
                return original_wait(event, 0.01)  # fail fast; no extension reply is sent

            with mock.patch.object(threading.Event, "wait", recording_wait):
                thread = threading.Thread(target=host._handle_client, args=(server,))
                thread.start()
                client.sendall(json.dumps({"url": connect_url(), "auth": TOKEN}).encode() + b"\n")
                response = json.loads(self.bridge.read_socket_line(client, 2))
                client.close()
                thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(response["ok"], False)
            self.assertIn(self.bridge.CONNECT_ACK_TIMEOUT, recorded_timeouts)
            self.assertEqual(self.bridge.CONNECT_ACK_TIMEOUT, 75)

    def test_native_host_rejects_requests_beyond_the_pending_cap(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            native_output = io.BytesIO()
            host = self.bridge.NativeHost(
                tmp / "bridge.sock",
                token_file,
                native_output=native_output,
            )
            # Fill pending to the cap with dummy entries so the next request
            # is rejected before it's ever forwarded to the extension.
            host.pending = {
                f"dummy-{i}": (threading.Event(), {})
                for i in range(self.bridge.MAX_PENDING_REQUESTS)
            }
            server, client = socket.socketpair()
            thread = threading.Thread(target=host._handle_client, args=(server,))
            thread.start()
            client.sendall(json.dumps({"url": connect_url(), "auth": TOKEN}).encode() + b"\n")
            response = json.loads(self.bridge.read_socket_line(client, 2))
            client.close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(response, {"ok": False, "error": "native bridge is busy"})
            # The rejected request must never be forwarded to the extension.
            self.assertEqual(native_output.getvalue(), b"")
            # The dummy entries are untouched and nothing extra was added.
            self.assertEqual(len(host.pending), self.bridge.MAX_PENDING_REQUESTS)

    def test_rejects_unsafe_token_files_and_oversized_native_messages(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o644)
            with self.assertRaisesRegex(ValueError, "0600"):
                self.bridge.read_token_file(token_file)
            token_file.chmod(0o600)
            token_link = tmp / "token-link"
            token_link.symlink_to(token_file)
            with self.assertRaisesRegex(ValueError, "regular file"):
                self.bridge.read_token_file(token_link)

        oversized = io.BytesIO(struct.pack("=I", self.bridge.MAX_NATIVE_MESSAGE + 1))
        with self.assertRaisesRegex(ValueError, "size limit"):
            self.bridge.read_native_message(oversized)

    def test_partial_socket_line_has_a_hard_deadline(self):
        reader, writer = socket.socketpair()
        try:
            writer.sendall(b'{"ok":')
            started = time.monotonic()
            with self.assertRaises(TimeoutError):
                self.bridge.read_socket_line(reader, 0.05)
            self.assertLess(time.monotonic() - started, 0.5)
        finally:
            reader.close()
            writer.close()

    def test_native_host_round_trip_uses_private_socket(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            socket_path = tmp / "bridge.sock"
            env = os.environ.copy()
            env.update({
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
                "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            })
            process = subprocess.Popen(
                [str(BRIDGE), EXTENSION_ORIGIN],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            self.addCleanup(self._stop_process, process)
            for _ in range(100):
                if socket_path.exists():
                    break
                if process.poll() is not None:
                    self.fail(process.stderr.read().decode("utf-8", "replace"))
                time.sleep(0.01)
            self.assertTrue(socket_path.exists(), "native bridge socket was not created")
            self.assertEqual(socket_path.stat().st_mode & 0o777, 0o600)
            ready = self.bridge.read_native_message(process.stdout)
            self.assertEqual(ready["type"], "hostReady")
            self.assertRegex(ready["browserSessionId"], r"^[a-f0-9]{64}$")

            status_response = {}

            def request_status():
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(socket_path))
                    client.sendall(json.dumps({"status": True, "auth": TOKEN}).encode() + b"\n")
                    with client.makefile("rb") as stream:
                        status_response.update(json.loads(stream.readline()))

            status_thread = threading.Thread(target=request_status)
            status_thread.start()
            forwarded_status = self.bridge.read_native_message(process.stdout)
            self.assertEqual(forwarded_status["type"], "status")
            self.assertNotIn(TOKEN, json.dumps(forwarded_status))
            self.bridge.write_native_message(process.stdin, {
                "type": "statusResult",
                "requestId": forwarded_status["requestId"],
                "ok": True,
                "connections": [{"clientName": "test-agent", "workspace": {"state": "normal", "focused": False}}],
                "diagnostic": "prior connection failed safely",
                "parkedWorkspaceCount": 3,
                "parkedWorkspaceIds": [17, 18, 19],
                "parkedWorkspaces": [
                    {"windowId": 17, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                    {"windowId": 18, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                    {"windowId": 19, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                ],
            })
            status_thread.join(timeout=2)
            self.assertFalse(status_thread.is_alive())
            self.assertEqual(status_response, {
                "ok": True,
                "connections": [{"clientName": "test-agent", "workspace": {"state": "normal", "focused": False}}],
                "diagnostic": "prior connection failed safely",
                "parkedWorkspaceCount": 3,
                "parkedWorkspaceIds": [17, 18, 19],
                "parkedWorkspaces": [
                    {"windowId": 17, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                    {"windowId": 18, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                    {"windowId": 19, "type": "popup", "state": "normal", "focused": False, "tabCount": 1},
                ],
            })

            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                client.connect(str(socket_path))
                client.sendall(json.dumps({"url": connect_url(), "auth": "wrong"}).encode() + b"\n")
                with client.makefile("rb") as stream:
                    rejected = json.loads(stream.readline())
            self.assertEqual(rejected["ok"], False)

    def test_native_host_forwards_background_pool_preparation(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            native_output = io.BytesIO()
            host = self.bridge.NativeHost(
                tmp / "bridge.sock",
                token_file,
                native_output=native_output,
            )
            server, client = socket.socketpair()
            thread = threading.Thread(target=host._handle_client, args=(server,))
            thread.start()
            try:
                client.sendall(json.dumps({"preparePool": 4, "auth": TOKEN}).encode() + b"\n")
                payload = b""
                for _ in range(100):
                    payload = native_output.getvalue()
                    if len(payload) >= 4:
                        break
                    time.sleep(0.01)
                length = struct.unpack("=I", payload[:4])[0]
                forwarded = json.loads(payload[4:4 + length])
                self.assertEqual(forwarded["type"], "preparePool")
                self.assertEqual(forwarded["targetCapacity"], 4)
                host._receive_extension_message({
                    "type": "preparePoolResult",
                    "requestId": forwarded["requestId"],
                    "ok": True,
                    "created": 4,
                    "parkedWorkspaceCount": 4,
                    "parkedWorkspaceIds": [17, 18, 19, 20],
                })
                response = json.loads(self.bridge.read_socket_line(client, 2))
            finally:
                client.close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(response, {
                "ok": True,
                "created": 4,
                "parkedWorkspaceCount": 4,
                "parkedWorkspaceIds": [17, 18, 19, 20],
            })

    def test_native_host_keeps_concurrent_clients_separate(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            socket_path = tmp / "bridge.sock"
            env = os.environ.copy()
            env.update({
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
                "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            })
            process = subprocess.Popen(
                [str(BRIDGE), EXTENSION_ORIGIN],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                env=env,
            )
            self.addCleanup(self._stop_process, process)
            for _ in range(100):
                if socket_path.exists():
                    break
                time.sleep(0.01)
            ready = self.bridge.read_native_message(process.stdout)
            self.assertEqual(ready["type"], "hostReady")

            responses = [{} for _ in range(20)]

            def request_connection(index):
                with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
                    client.connect(str(socket_path))
                    envelope = {"url": connect_url(), "auth": TOKEN}
                    client.sendall(json.dumps(envelope).encode() + b"\n")
                    with client.makefile("rb") as stream:
                        responses[index].update(json.loads(stream.readline()))

            threads = [threading.Thread(target=request_connection, args=(index,)) for index in range(20)]
            for thread in threads:
                thread.start()

            request_ids = set()
            for _ in threads:
                forwarded = self.bridge.read_native_message(process.stdout)
                self.assertNotIn(TOKEN, json.dumps(forwarded))
                request_ids.add(forwarded["requestId"])
                self.bridge.write_native_message(process.stdin, {
                    "type": "connectResult",
                    "requestId": forwarded["requestId"],
                    "ok": True,
                })

            for thread in threads:
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
            self.assertEqual(len(request_ids), 20)
            self.assertEqual(responses, [{"ok": True}] * 20)

    def test_client_keeps_token_out_of_argv_environment_and_output(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            socket_path = tmp / "bridge.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)
            received = {}

            def answer_client():
                connection, _ = server.accept()
                with connection:
                    with connection.makefile("rb") as stream:
                        received.update(json.loads(stream.readline()))
                    connection.sendall(b'{"ok":true}\n')

            thread = threading.Thread(target=answer_client)
            thread.start()
            env = os.environ.copy()
            env.pop("PLAYWRIGHT_MCP_EXTENSION_TOKEN", None)
            env.update({
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
                "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            })
            process = subprocess.run(
                [str(BRIDGE), connect_url()],
                capture_output=True,
                env=env,
                timeout=2,
            )
            thread.join(timeout=2)
            server.close()

            self.assertEqual(process.returncode, 0)
            self.assertNotIn(TOKEN, " ".join(map(str, process.args)))
            self.assertNotIn(TOKEN.encode(), process.stdout + process.stderr)
            self.assertEqual(received, {"url": connect_url(), "auth": TOKEN})

    def test_prepare_pool_cli_uses_management_request(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            socket_path = tmp / "bridge.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)
            received = {}

            def answer_client():
                connection, _ = server.accept()
                with connection:
                    with connection.makefile("rb") as stream:
                        received.update(json.loads(stream.readline()))
                    connection.sendall(
                        b'{"ok":true,"created":4,"parkedWorkspaceCount":4,"parkedWorkspaceIds":[17,18,19,20]}\n'
                    )

            thread = threading.Thread(target=answer_client)
            thread.start()
            env = os.environ.copy()
            env.update({
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
                "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            })
            process = subprocess.run(
                [str(BRIDGE), "--prepare-pool", "4"],
                capture_output=True,
                text=True,
                env=env,
                timeout=2,
            )
            thread.join(timeout=2)
            server.close()

            self.assertEqual(process.returncode, 0)
            self.assertEqual(received, {"preparePool": 4, "auth": TOKEN})
            self.assertEqual(json.loads(process.stdout), {
                "created": 4,
                "parkedWorkspaceCount": 4,
                "parkedWorkspaceIds": [17, 18, 19, 20],
                "background": False,
            })

    def _run_background_prepare(self, tmp, frontmost_sequence, reply, fuse_exists=False):
        """Runs --prepare-pool 4 --background against a fake host. The frontmost
        app follows frontmost_sequence, one value per sample, the last repeating."""
        token_file = tmp / "token"
        token_file.write_text(TOKEN + "\n")
        token_file.chmod(0o600)
        socket_path = tmp / "bridge.sock"
        fuse = tmp / "fuse.json"
        if fuse_exists:
            fuse.write_text("{}\n")
        sequence = tmp / "frontmost"
        sequence.write_text("\n".join(frontmost_sequence) + "\n")
        counter = tmp / "counter"
        counter.write_text("0")
        frontmost = tmp / "frontmost.sh"
        frontmost.write_text(
            "#!/bin/bash\n"
            f'n=$(cat "{counter}"); echo $((n + 1)) > "{counter}"\n'
            f'total=$(wc -l < "{sequence}"); line=$((n + 1)); [ "$line" -le "$total" ] || line=$total\n'
            f'sed -n "${{line}}p" "{sequence}"\n')
        frontmost.chmod(0o700)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        server.bind(str(socket_path))
        server.listen(1)
        received = {}

        def answer_client():
            connection, _ = server.accept()
            with connection:
                with connection.makefile("rb") as stream:
                    received.update(json.loads(stream.readline()))
                time.sleep(0.2)
                connection.sendall(json.dumps(reply).encode() + b"\n")

        thread = threading.Thread(target=answer_client)
        thread.start()
        env = os.environ.copy()
        env.update({
            "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
            "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            "PLAYWRIGHT_MCP_BACKGROUND_FUSE": str(fuse),
            "PLAYWRIGHT_MCP_FRONTMOST_COMMAND": str(frontmost),
        })
        process = subprocess.run(
            [str(BRIDGE), "--prepare-pool", "4", "--background"],
            capture_output=True, text=True, env=env, timeout=10)
        thread.join(timeout=5)
        server.close()
        return process, received, fuse

    def test_background_prepare_runs_while_another_app_is_in_front(self):
        reply = {"ok": True, "created": 2, "parkedWorkspaceCount": 4, "parkedWorkspaceIds": [1, 2, 3, 4]}
        with tempfile.TemporaryDirectory() as raw_tmp:
            process, received, fuse = self._run_background_prepare(Path(raw_tmp), ["dev.zed.Zed"], reply)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(received, {"preparePool": 4, "auth": TOKEN, "background": True})
            self.assertTrue(json.loads(process.stdout)["background"])
            self.assertFalse(fuse.exists())

    def test_background_prepare_is_ordinary_when_chrome_is_in_front(self):
        reply = {"ok": True, "created": 0, "parkedWorkspaceCount": 4, "parkedWorkspaceIds": [1, 2, 3, 4]}
        with tempfile.TemporaryDirectory() as raw_tmp:
            process, received, _ = self._run_background_prepare(Path(raw_tmp), ["com.google.Chrome"], reply)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(received, {"preparePool": 4, "auth": TOKEN})

    def test_background_prepare_trips_the_fuse_when_chrome_comes_forward(self):
        reply = {"ok": True, "created": 1, "parkedWorkspaceCount": 4, "parkedWorkspaceIds": [1, 2, 3, 4]}
        with tempfile.TemporaryDirectory() as raw_tmp:
            process, received, fuse = self._run_background_prepare(
                Path(raw_tmp), ["dev.zed.Zed", "dev.zed.Zed", "com.google.Chrome"], reply)
            self.assertEqual(process.returncode, 4)
            self.assertEqual(received.get("background"), True)
            self.assertTrue(fuse.exists(), "Chrome came forward but the fuse did not trip")
            record = json.loads(fuse.read_text())
            self.assertEqual(record["frontmostBefore"], "dev.zed.Zed")
            self.assertIn("com.google.Chrome", record["frontmostSeen"])

    def test_tripped_fuse_keeps_preparation_foreground_only(self):
        reply = {"ok": False, "error": "Regular Chrome must be foreground on its normal user window during one-time pool preparation"}
        with tempfile.TemporaryDirectory() as raw_tmp:
            process, received, _ = self._run_background_prepare(Path(raw_tmp), ["dev.zed.Zed"], reply, fuse_exists=True)
            self.assertEqual(process.returncode, 3)
            self.assertEqual(received, {"preparePool": 4, "auth": TOKEN})
            self.assertIn("must be foreground", process.stderr)

    def test_native_host_answers_the_active_space_request(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            native_output = io.BytesIO()
            host = self.bridge.NativeHost(tmp / "bridge.sock", token_file, native_output=native_output)
            with mock.patch.object(self.bridge, "active_space_id", return_value=7):
                host._receive_extension_message({"type": "activeSpaceRequest", "requestId": "req-1"})
                host._receive_extension_message({"type": "activeSpaceRequest", "requestId": ""})
                host._receive_extension_message({"type": "activeSpaceRequest", "requestId": "x" * 200})
            payload = native_output.getvalue()
            length = struct.unpack("=I", payload[:4])[0]
            self.assertEqual(json.loads(payload[4:4 + length]),
                             {"type": "activeSpaceResult", "requestId": "req-1", "spaceId": 7})
            self.assertEqual(len(payload), 4 + length, "malformed requests must get no answer")

    def test_active_space_override_and_failure_are_safe(self):
        with mock.patch.dict(os.environ, {"PLAYWRIGHT_MCP_ACTIVE_SPACE": "12"}):
            self.assertEqual(self.bridge.active_space_id(), 12)
        with mock.patch.dict(os.environ, {"PLAYWRIGHT_MCP_ACTIVE_SPACE": "not-a-space"}):
            self.assertIsNone(self.bridge.active_space_id())

    def test_native_host_forwards_only_a_true_background_flag(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            for flag, expect_forwarded in ((True, True), (False, False), ("yes", False)):
                native_output = io.BytesIO()
                host = self.bridge.NativeHost(tmp / "bridge.sock", token_file, native_output=native_output)
                server, client = socket.socketpair()
                thread = threading.Thread(target=host._handle_client, args=(server,))
                thread.start()
                try:
                    client.sendall(json.dumps({"preparePool": 4, "auth": TOKEN, "background": flag}).encode() + b"\n")
                    if expect_forwarded:
                        for _ in range(100):
                            if len(native_output.getvalue()) >= 4:
                                break
                            time.sleep(0.01)
                        payload = native_output.getvalue()
                        forwarded = json.loads(payload[4:4 + struct.unpack("=I", payload[:4])[0]])
                        self.assertEqual(forwarded["background"], True)
                        host._receive_extension_message({"type": "preparePoolResult", "requestId": forwarded["requestId"], "ok": True, "created": 0})
                    response = json.loads(self.bridge.read_socket_line(client, 2))
                finally:
                    client.close()
                thread.join(timeout=2)
                self.assertEqual(response["ok"], expect_forwarded, f"background={flag!r}")
                if not expect_forwarded:
                    self.assertEqual(native_output.getvalue(), b"", f"background={flag!r} reached the extension")

    def test_discard_pool_cli_uses_management_request(self):
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            token_file = tmp / "token"
            token_file.write_text(TOKEN + "\n")
            token_file.chmod(0o600)
            socket_path = tmp / "bridge.sock"
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(str(socket_path))
            server.listen(1)
            received = {}

            def answer_client():
                connection, _ = server.accept()
                with connection:
                    with connection.makefile("rb") as stream:
                        received.update(json.loads(stream.readline()))
                    connection.sendall(b'{"ok":true,"removed":4,"preserved":0,"parkedWorkspaceCount":0}\n')

            thread = threading.Thread(target=answer_client)
            thread.start()
            env = os.environ.copy()
            env.update({
                "PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE": str(token_file),
                "PLAYWRIGHT_MCP_NATIVE_SOCKET": str(socket_path),
            })
            process = subprocess.run(
                [str(BRIDGE), "--discard-pool"],
                capture_output=True,
                text=True,
                env=env,
                timeout=2,
            )
            thread.join(timeout=2)
            server.close()

            self.assertEqual(process.returncode, 0)
            self.assertEqual(received, {"discardPool": True, "auth": TOKEN})
            self.assertEqual(json.loads(process.stdout), {
                "removed": 4,
                "preserved": 0,
                "parkedWorkspaceCount": 0,
            })

    @staticmethod
    def _stop_process(process):
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)
        for stream in (process.stdin, process.stdout, process.stderr):
            if stream is not None:
                stream.close()


if __name__ == "__main__":
    unittest.main()
