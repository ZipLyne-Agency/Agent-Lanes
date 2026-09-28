#!/usr/bin/env bash
# Launcher attestation tests for bin/browser-mcp-server. Every Chrome, npx, and
# extension dependency is faked, so this runs without Chrome installed.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

launcher="$REPO/bin/browser-mcp-server"
grep -Fq "@playwright/mcp@0.0.79' --extension" "$launcher"
# Page-initiated new tabs would activate a lane window; the authenticated mode
# must always inject the same-tab containment script and refuse to start without it.
grep -Fq -- '--init-script "$lane_popups_script"' "$launcher"
grep -Fq 'lane popup containment script is missing' "$launcher"
grep -Fq -- '--timeout-action "$lane_action_timeout_ms"' "$launcher"
node --check "$REPO/mcp-runtime/lane-popups.js"
grep -Fq "anchor.setAttribute('target', '_self')" "$REPO/mcp-runtime/lane-popups.js"
export PLAYWRIGHT_MCP_LANE_POPUPS_SCRIPT="$REPO/mcp-runtime/lane-popups.js"
grep -Fq 'load_extension_token' "$launcher"
grep -Fq 'verify_native_bridge_install' "$launcher"
grep -Fq 'verify_chrome_background_safe' "$launcher"
grep -Fq -- '--disable-backgrounding-occluded-windows' "$launcher"
if grep -Fq 'read -r token' "$launcher"; then
  echo "launcher still reads the profile token into shell memory" >&2
  exit 1
fi
if grep -Eq '^[[:space:]]*export PLAYWRIGHT_MCP_EXTENSION_TOKEN([[:space:]]|$)' "$launcher"; then
  echo "authenticated token is still exported to upstream Playwright" >&2
  exit 1
fi
grep -Fq "@playwright/mcp@0.0.79' --isolated --headless" "$launcher"
grep -Fq -- '--executable-path "$isolated_executable"' "$launcher"
if grep -Fq -- '--browser chromium' "$launcher"; then
  echo "launcher still contains a Chrome for Testing route" >&2
  exit 1
fi
if grep -Fq 'DevToolsActivePort' "$launcher"; then
  echo "legacy default-profile CDP route remains in launcher" >&2
  exit 1
fi
grep -Fq "chrome-devtools-mcp@1.6.0' --autoConnect --channel stable --redactNetworkHeaders" "$launcher"

test_root="$(mktemp -d "${TMPDIR:-/tmp}/browser-mcp-test.XXXXXX")"
test_root="$(cd "$test_root" && pwd -P)"
first_pid=""
second_pid=""
orphan_pid=""
race_pids=()
cleanup() {
  touch "$test_root/release" 2>/dev/null || true
  if [ -n "$first_pid" ] && kill -0 "$first_pid" 2>/dev/null; then
    kill -TERM "$first_pid" 2>/dev/null || true
    wait "$first_pid" 2>/dev/null || true
  fi
  if [ -n "$second_pid" ] && kill -0 "$second_pid" 2>/dev/null; then
    kill -TERM "$second_pid" 2>/dev/null || true
    wait "$second_pid" 2>/dev/null || true
  fi
  for pid in "${race_pids[@]:-}"; do
    [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null || true
    [ -n "$pid" ] && wait "$pid" 2>/dev/null || true
  done
  if [ -n "$orphan_pid" ] && kill -0 "$orphan_pid" 2>/dev/null; then
    kill -TERM "$orphan_pid" 2>/dev/null || true
  fi
  rm -rf -- "$test_root"
}
trap cleanup EXIT
mkdir -p "$test_root/bin"
cp "$REPO/tests/bin/shlock" "$test_root/bin/shlock"
chmod +x "$test_root/bin/shlock"
cat > "$test_root/bin/npx" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$BROWSER_MCP_TEST_LOG"
if [ -n "${PLAYWRIGHT_MCP_EXTENSION_TOKEN:-}" ]; then
  printf 'unexpected-token\n' >> "$BROWSER_MCP_TEST_TOKEN_MARKER"
fi
if [ "${BROWSER_MCP_TEST_FAIL_EXTENSION:-0}" = "1" ] && [[ "$*" == *"--extension"* ]]; then
  exit 17
fi
touch "$BROWSER_MCP_TEST_STARTED"
while [ ! -e "$BROWSER_MCP_TEST_RELEASE" ]; do sleep 0.02; done
SH
chmod +x "$test_root/bin/npx"
isolated_browser_dir="$test_root/home/Library/Caches/ms-playwright/chromium_headless_shell-1237/chrome-headless-shell-mac-arm64"
mkdir -p "$isolated_browser_dir"
isolated_browser_dir="$(cd "$isolated_browser_dir" && pwd -P)"
isolated_browser="$isolated_browser_dir/chrome-headless-shell"
touch "$isolated_browser"
chmod +x "$isolated_browser"
cat > "$test_root/bin/chrome-background-safe" <<'SH'
#!/usr/bin/env bash
case "${1:-}" in
  --check) exit "${BROWSER_MCP_TEST_CHROME_STATUS:-0}" ;;
  *) exit 2 ;;
esac
SH
chmod +x "$test_root/bin/chrome-background-safe"
cp "$launcher" "$test_root/bin/browser-mcp-server"
chmod +x "$test_root/bin/browser-mcp-server"
launcher="$test_root/bin/browser-mcp-server"
printf 'test-token-value-0123456789abcdefghijklmnop\n' > "$test_root/token"
chmod 600 "$test_root/token"
mkdir -p "$test_root/canary/dist" "$test_root/chrome-profile" "$test_root/home/.config/agent-lanes"
cp "$REPO/extension/manifest.json" "$test_root/canary/dist/manifest.json"
# verify_canary_install now also checks a hash attestation manifest
# (install-playwright-canary's own output) plus an owner-only pin file
# outside dist/ that install-playwright-canary writes to pin that
# manifest's own hash; build the same shapes by hand here. The launcher
# invocations below run with HOME="$test_root/home", so the pin file's
# default location resolves under it.
/usr/bin/python3 - "$test_root/canary/dist" "$test_root/home/.config/agent-lanes/extension-pin.json" <<'PY'
import hashlib
import json
import os
import pathlib
import sys

dist = pathlib.Path(sys.argv[1])
pin_file = pathlib.Path(sys.argv[2])
manifest = json.loads((dist / "manifest.json").read_text())
digest = hashlib.sha256((dist / "manifest.json").read_bytes()).hexdigest()
(dist / ".install-manifest.json").write_text(json.dumps({
    "version": manifest.get("version"),
    "files": {"manifest.json": digest},
}))
manifest_digest = hashlib.sha256((dist / ".install-manifest.json").read_bytes()).hexdigest()
pin_file.parent.mkdir(parents=True, exist_ok=True)
fd = os.open(pin_file, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
os.write(fd, json.dumps({
    "version": manifest.get("version"),
    "dest": str(dist.resolve()),
    "manifestSha256": manifest_digest,
}).encode())
os.close(fd)
PY
/usr/bin/python3 - "$test_root/chrome-profile/Secure Preferences" "$test_root/canary/dist" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "extensions": {"settings": {
        "mmlmfjhmonkocbjadbfplnigmagldckm": {
            "path": str(pathlib.Path(sys.argv[2]).resolve()),
            "from_webstore": False,
            "location": 4,
            "disable_reasons": [],
        }
    }}
}))
PY
export PLAYWRIGHT_MCP_CANARY_DIR="$test_root/canary/dist"
export PLAYWRIGHT_MCP_CANARY_PROFILE_DIR="$test_root/chrome-profile"
cp "$REPO/bin/playwright-mcp-native-bridge" "$test_root/bin/playwright-mcp-native-bridge"
chmod +x "$test_root/bin/playwright-mcp-native-bridge"
/usr/bin/python3 - "$test_root/native-host.json" "$test_root/bin/playwright-mcp-native-bridge" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
path.write_text(json.dumps({
    "name": "agency.ziplyne.agent_lanes",
    "description": "test host",
    "path": str(pathlib.Path(sys.argv[2]).resolve()),
    "type": "stdio",
    "allowed_origins": ["chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/"],
}))
PY
export PLAYWRIGHT_MCP_NATIVE_BRIDGE="$test_root/bin/playwright-mcp-native-bridge"
export PLAYWRIGHT_MCP_NATIVE_MANIFEST="$test_root/native-host.json"

# Authenticated mode fails before starting Playwright when regular Chrome lacks
# the occlusion switch that keeps fully covered workspaces input-capable.
set +e
BROWSER_MCP_TEST_CHROME_STATUS=1 \
  PATH="$test_root/bin:$PATH" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/unsafe-started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/unsafe-chrome.err"
unsafe_chrome_status="$?"
set -e
test "$unsafe_chrome_status" = "4"
grep -Fq -- '--disable-backgrounding-occluded-windows' "$test_root/unsafe-chrome.err"
test ! -e "$test_root/unsafe-started"

PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright &
first_pid="$!"
for _ in $(seq 1 100); do
  [ -e "$test_root/started" ] && break
  sleep 0.02
done
test -e "$test_root/started"

PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started-2" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" chrome-devtools &
second_pid="$!"
for _ in $(seq 1 100); do
  [ -e "$test_root/started-2" ] && break
  sleep 0.02
done
test -e "$test_root/started-2"
touch "$test_root/release"
wait "$first_pid"
first_pid=""
wait "$second_pid"
second_pid=""
grep -Fq -- '-y @playwright/mcp@0.0.79 --extension' "$test_root/args"
test ! -e "$test_root/token-marker"


rm -f "$test_root/release" "$test_root/started" "$test_root/token-marker"
# HOME is isolated here (and below) so this test never sees a real vendored
# runtime under $HOME/.local/lib/agent-lanes and always exercises the npx
# fallback path against the fake npx above.
PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN=preset-token-value-0123456789abcdefghijklmn \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" chrome-devtools &
first_pid="$!"
for _ in $(seq 1 100); do
  [ -e "$test_root/started" ] && break
  sleep 0.02
done
test -e "$test_root/started"
touch "$test_root/release"
wait "$first_pid"
first_pid=""
grep -Fq -- '-y chrome-devtools-mcp@1.6.0 --autoConnect --channel stable --redactNetworkHeaders' "$test_root/args"
test ! -e "$test_root/token-marker"

# An inherited environment token is ignored; a missing private token file fails
# closed before opening an approval tab in the user's browser.
rm -f "$test_root/release" "$test_root/started" "$test_root/token-marker"
set +e
PATH="$test_root/bin:$PATH" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN=preset-token-value-0123456789abcdefghijklmn \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/missing-token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/missing-token.err"
missing_token_status="$?"
set -e
test "$missing_token_status" = "4"
grep -Fq 'owner-only extension token file' "$test_root/missing-token.err"
test ! -e "$test_root/started"
test ! -e "$test_root/token-marker"

# A readable token with broader filesystem permissions is still rejected.
chmod 644 "$test_root/token"
set +e
PATH="$test_root/bin:$PATH" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/token-mode.err"
token_mode_status="$?"
set -e
test "$token_mode_status" = "4"
grep -Fq 'mode 0600' "$test_root/token-mode.err"
chmod 600 "$test_root/token"

# The Web Store build has the same extension ID. It must not satisfy the canary
# route unless Chrome's record points at the exact unpacked directory.
cp "$test_root/chrome-profile/Secure Preferences" "$test_root/chrome-profile/canary-preferences"
/usr/bin/python3 - "$test_root/chrome-profile/Secure Preferences" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
data = json.loads(path.read_text())
record = data["extensions"]["settings"]["mmlmfjhmonkocbjadbfplnigmagldckm"]
record["from_webstore"] = True
path.write_text(json.dumps(data))
PY
set +e
PATH="$test_root/bin:$PATH" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/store-extension.err"
store_extension_status="$?"
set -e
test "$store_extension_status" = "4"
grep -Fq 'the Agent Lanes extension is not loaded unpacked' "$test_root/store-extension.err"
cp "$test_root/chrome-profile/canary-preferences" "$test_root/chrome-profile/Secure Preferences"

# A file added to dist/ but never recorded in the install manifest must not be
# silently trusted, even though it isn't individually hash-checked.
printf 'not tracked by the manifest\n' > "$test_root/canary/dist/unlisted.js"
set +e
PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/unlisted-file.err"
unlisted_file_status="$?"
set -e
test "$unlisted_file_status" = "4"
grep -Fq 'canary install contains unlisted files' "$test_root/unlisted-file.err"
test ! -e "$test_root/started"
rm -f "$test_root/canary/dist/unlisted.js"

# The pin binds a version too: pin["version"], the install manifest's
# version, and dist/manifest.json's version must all agree. A pin left over
# from an older (or newer) install must be refused rather than trusted.
cp "$test_root/home/.config/agent-lanes/extension-pin.json" "$test_root/pin-good-version.json"
/usr/bin/python3 - "$test_root/home/.config/agent-lanes/extension-pin.json" <<'PY'
import json
import os
import pathlib
import sys

pin_file = pathlib.Path(sys.argv[1])
pin = json.loads(pin_file.read_text())
pin["version"] = "0.0.0-mismatch"
fd = os.open(pin_file, os.O_WRONLY | os.O_TRUNC, 0o600)
os.write(fd, json.dumps(pin).encode())
os.close(fd)
PY
set +e
PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright 2> "$test_root/version-mismatch.err"
version_mismatch_status="$?"
set -e
test "$version_mismatch_status" = "4"
grep -Fq 'canary install version mismatch' "$test_root/version-mismatch.err"
test ! -e "$test_root/started"
cp "$test_root/pin-good-version.json" "$test_root/home/.config/agent-lanes/extension-pin.json"
rm -f "$test_root/pin-good-version.json"

# Concurrency stress: every caller gets its own extension connection. The local
# canary allocates one normal, unfocused private window with exact tab ownership per connection.
rm -rf -- "$test_root/state"
rm -f "$test_root/release" "$test_root/started" "$test_root/args"
for _ in $(seq 1 20); do
  PATH="$test_root/bin:$PATH" \
    HOME="$test_root/home" \
    BROWSER_MCP_STATE_ROOT="$test_root/state" \
    AGENT_RESOURCE_REAPER=/usr/bin/true \
    PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
    BROWSER_MCP_TEST_LOG="$test_root/args" \
    BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
    BROWSER_MCP_TEST_STARTED="$test_root/started" \
    BROWSER_MCP_TEST_RELEASE="$test_root/release" \
    "$launcher" playwright >/dev/null 2>&1 &
  race_pids+=("$!")
done
for _ in $(seq 1 100); do
  [ -f "$test_root/args" ] && \
    [ "$(wc -l < "$test_root/args" | tr -d ' ')" = "20" ] && break
  sleep 0.02
done
test "$(grep -c -- '--extension' "$test_root/args")" = "20"
test "$(grep -c -- '--isolated --headless' "$test_root/args" || true)" = "0"
touch "$test_root/release"
for pid in "${race_pids[@]}"; do wait "$pid" 2>/dev/null || true; done

# Once the extension child starts, its exit status is preserved. Switching transports
# after reading MCP stdin would lose the initialize request.
race_pids=()
rm -rf -- "$test_root/state"
rm -f "$test_root/release" "$test_root/started" "$test_root/args"
PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  BROWSER_MCP_TEST_FAIL_EXTENSION=1 \
  PLAYWRIGHT_MCP_EXTENSION_TOKEN_FILE="$test_root/token" \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_TOKEN_MARKER="$test_root/token-marker" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright &
first_pid="$!"
set +e
wait "$first_pid"
extension_child_status="$?"
set -e
first_pid=""
test "$extension_child_status" = "17"
test "$(grep -c -- '--extension' "$test_root/args")" = "1"
test "$(grep -c -- '--isolated --headless' "$test_root/args" || true)" = "0"

# Isolated mode starts independently without inspecting authenticated Chrome.
rm -rf -- "$test_root/state"
rm -f "$test_root/release" "$test_root/started" "$test_root/args" "$test_root/token-marker"
PATH="$test_root/bin:$PATH" \
  HOME="$test_root/home" \
  BROWSER_MCP_STATE_ROOT="$test_root/state" \
  AGENT_RESOURCE_REAPER=/usr/bin/true \
  BROWSER_MCP_TEST_LOG="$test_root/args" \
  BROWSER_MCP_TEST_STARTED="$test_root/started" \
  BROWSER_MCP_TEST_RELEASE="$test_root/release" \
  "$launcher" playwright-isolated &
first_pid="$!"
for _ in $(seq 1 100); do
  [ -e "$test_root/started" ] && break
  sleep 0.02
done
test -e "$test_root/started"
if ! grep -Fq -- "-y @playwright/mcp@0.0.79 --isolated --headless --executable-path $isolated_browser" "$test_root/args"; then
  echo "isolated launcher did not use the expected headless-shell path" >&2
  sed 's/^/  /' "$test_root/args" >&2
  exit 1
fi
test ! -e "$test_root/token-marker"
touch "$test_root/release"
wait "$first_pid"
first_pid=""

# Explicit Playwright cache roots and PLAYWRIGHT_BROWSERS_PATH=0 with a custom
# npm cache must resolve independently of the default user cache.
for cache_mode in custom zero; do
  rm -rf -- "$test_root/state"
  rm -f "$test_root/release" "$test_root/started" "$test_root/args"
  if [ "$cache_mode" = "custom" ]; then
    case_root="$test_root/custom-playwright-cache"
  else
    case_root="$test_root/custom-npm-cache/_npx/hash/node_modules/playwright-core/.local-browsers"
  fi
  case_browser="$case_root/chromium_headless_shell-1240/chrome-headless-shell-mac-arm64/chrome-headless-shell"
  mkdir -p "$(dirname "$case_browser")"
  touch "$case_browser"
  chmod +x "$case_browser"
  if [ "$cache_mode" = "custom" ]; then
    PLAYWRIGHT_BROWSERS_PATH="$case_root" \
      PATH="$test_root/bin:$PATH" HOME="$test_root/home" \
      BROWSER_MCP_STATE_ROOT="$test_root/state" AGENT_RESOURCE_REAPER=/usr/bin/true \
      BROWSER_MCP_TEST_LOG="$test_root/args" BROWSER_MCP_TEST_STARTED="$test_root/started" \
      BROWSER_MCP_TEST_RELEASE="$test_root/release" "$launcher" playwright-isolated &
  else
    PLAYWRIGHT_BROWSERS_PATH=0 npm_config_cache="$test_root/custom-npm-cache" \
      PATH="$test_root/bin:$PATH" HOME="$test_root/home" \
      BROWSER_MCP_STATE_ROOT="$test_root/state" AGENT_RESOURCE_REAPER=/usr/bin/true \
      BROWSER_MCP_TEST_LOG="$test_root/args" BROWSER_MCP_TEST_STARTED="$test_root/started" \
      BROWSER_MCP_TEST_RELEASE="$test_root/release" "$launcher" playwright-isolated &
  fi
  first_pid="$!"
  for _ in $(seq 1 100); do
    [ -e "$test_root/started" ] && break
    sleep 0.02
  done
  test -e "$test_root/started"
  grep -Fq -- "--executable-path $case_browser" "$test_root/args"
  touch "$test_root/release"
  wait "$first_pid"
  first_pid=""
done


printf 'browser-mcp-server tests passed\n'
