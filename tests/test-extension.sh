#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXTENSION="$REPO/extension"
SOURCE="$EXTENSION/src/background.ts"
RELAY="$EXTENSION/src/relayConnection.ts"
GROUP="$EXTENSION/src/connectedTabGroup.ts"
WORKSPACE="$EXTENSION/src/workspaceLifecycle.ts"
STAGE="$EXTENSION/src/laneStage.ts"
GUARD="$EXTENSION/src/laneGuard.ts"
CONNECT_UI="$EXTENSION/src/ui/connect.tsx"
MANIFEST="$EXTENSION/manifest.json"
BUILD_MANIFEST="$EXTENSION/out/manifest.json"
NATIVE_BRIDGE="$REPO/bin/playwright-mcp-native-bridge"
NATIVE_MANIFEST="$REPO/native-messaging/agency.ziplyne.agent_lanes.json"
LAUNCHER_APP="$REPO/launcher/Contents/MacOS/Google Chrome Agent Safe"
MCP_SERVER="$REPO/bin/browser-mcp-server"

test -f "$SOURCE"
test -f "$RELAY"
test -f "$WORKSPACE"
test -f "$STAGE"
test -f "$GUARD"
test -f "$MANIFEST"

# Always regenerate the privileged bundle before asserting what Chrome will
# load. The build lands in extension/out/; only bin/install-extension copies it
# into the directory Chrome loads unpacked.
npm --prefix "$EXTENSION" run build --silent >/dev/null
test -f "$BUILD_MANIFEST"
relay_test_root="$(mktemp -d "${TMPDIR:-/tmp}/playwright-relay-test.XXXXXX")"
trap 'rm -rf -- "$relay_test_root"' EXIT
"$EXTENSION/node_modules/.bin/tsc" \
  --ignoreConfig \
  --target ES2022 --module commonjs --skipLibCheck \
  --types chrome --typeRoots "$EXTENSION/node_modules/@types" \
  --outDir "$relay_test_root" "$SOURCE"
node "$REPO/tests/extension-relay.test.cjs" "$relay_test_root"
node "$REPO/tests/extension-lanes.test.cjs" "$relay_test_root"
node "$REPO/tests/extension-display.test.cjs" "$relay_test_root"

grep -Fq 'd5a185a894ab3ab17ff77a44e116a1339c6bdaed' "$EXTENSION/UPSTREAM.md"
grep -Fq 'signed upstream release' "$EXTENSION/UPSTREAM.md"

# The canary must retain the upstream multi-client ownership model.
grep -Fq 'private _connections = new Map<number, ConnectedTabGroup>()' "$SOURCE"
grep -Fq "throw new Error('This tab is already connected to another client')" "$SOURCE"

# Lanes are normal-type, normal-state, unfocused windows created only by the
# foreground pool preparer. Sessions are background tabs inside existing lanes;
# ordinary connections never create windows.
grep -Fq 'prepareLanePool' "$SOURCE"
grep -Fq 'createSessionTab' "$SOURCE"
grep -Fq 'provisionLane' "$WORKSPACE"
grep -Fq "type: 'normal'" "$WORKSPACE"
grep -Fq "state: 'normal'" "$WORKSPACE"
grep -Fq 'focused: false' "$WORKSPACE"
grep -Fq "window.type === 'normal' && (window.state === 'normal' || window.state === 'fullscreen') && !window.focused" "$WORKSPACE"
grep -Fq "export const LANE_WINDOW_STATE: LaneWindowState" "$WORKSPACE"
grep -Fq 'PROTECTED INPUT/FOCUS INVARIANT' "$WORKSPACE"
grep -Fq 'PROTECTED POOL INVARIANT' "$WORKSPACE"
grep -Fq 'tests/live_browser_background_acceptance.py' "$WORKSPACE"
grep -Fq 'autoDiscardable: false' "$WORKSPACE"
grep -Fq '!userWindow.focused' "$WORKSPACE"
grep -Fq 'restoreUserSelection(restore.windowId, restore.tabId)' "$WORKSPACE"
# Background preparation exists only behind the explicit flag the fused
# native bridge sends, and only onto the agent display.
grep -Fq 'const background = !foreground && !!options.allowBackground && !!agentDisplay;' "$WORKSPACE"
grep -Fq 'chrome.windows.update(windowId, { focused: true })' "$WORKSPACE"
grep -Fq 'active: false' "$WORKSPACE"
if grep -Fq 'chrome.windows.create' "$SOURCE" "$RELAY" "$GROUP" "$STAGE"; then
  echo "ordinary browser connection code can create a Chrome window" >&2
  exit 1
fi
# The only ordinary-path focus call is the lane guard returning a window Chrome
# itself just took for an external link. Nothing else may focus a window.
if grep -Fq 'focused: true' "$SOURCE" "$GROUP" "$RELAY" "$STAGE"; then
  echo "ordinary browser connection code can explicitly focus Chrome" >&2
  exit 1
fi
grep -Fq 'lastUserWindowId' "$GUARD"
grep -Fq 'EVICTION_GRACE_MS' "$GUARD"
grep -Fq 'chrome.tabs.move(tabId, { windowId: userWindow.id, index: -1 })' "$GUARD"
if grep -Fq 'state: ' "$STAGE" "$GUARD" "$RELAY" "$GROUP"; then
  echo "ordinary browser connection code can change a window state" >&2
  exit 1
fi
if grep -Fq "'minimized'" "$WORKSPACE" "$STAGE" "$GUARD" "$RELAY" "$GROUP" "$SOURCE"; then
  echo "canary references the minimized workspace state that stops trusted input" >&2
  exit 1
fi
grep -Fq 'LANE_STORAGE_PREFIX' "$WORKSPACE"
grep -Fq 'SESSION_STORAGE_PREFIX' "$WORKSPACE"
grep -Fq 'discardLanes' "$WORKSPACE"
grep -Fq "No pre-positioned authenticated browser workspace is available" "$SOURCE"
grep -Fq "Authenticated browser pool is at capacity" "$SOURCE"
grep -Fq "type: 'preparePool'" "$EXTENSION/src/nativeProtocol.ts"
grep -Fq '"preparePool": target_capacity' "$NATIVE_BRIDGE"
grep -Fq '"discardPool": True' "$NATIVE_BRIDGE"
if grep -Rq 'allowProvision\|PLAYWRIGHT_MCP_POOL_PROVISION' "$SOURCE" "$NATIVE_BRIDGE"; then
  echo "pool preparation is still coupled to an ordinary MCP connection" >&2
  exit 1
fi
grep -Fq 'tests/live/prepare_browser_workspace_pool.py' "$REPO/docs/operations.md"
grep -Fq 'one-time pool preparation requires regular Chrome to remain frontmost' "$REPO/tests/live/prepare_browser_workspace_pool.py"
grep -Fq 'prepare_pool_if_possible' "$LAUNCHER_APP"
grep -Fq '"$native_bridge" --prepare-pool 4' "$LAUNCHER_APP"
grep -Fq 'frontmostApplication?.bundleIdentifier' "$REPO/tests/live/live_browser_background_acceptance.py"
if grep -Fq 'keepaliveTabId' "$WORKSPACE"; then
  echo "canary still uses the leaking inactive keepalive design" >&2
  exit 1
fi
grep -Fq 'anchorTabId' "$WORKSPACE"

# The stage is the only thing that activates tabs, and it never preempts an
# in-flight command.
grep -Fq 'STAGE_HARD_CAP_MS' "$STAGE"
grep -Fq 'an in-flight command is never preempted' "$STAGE"
grep -Fq 'chrome.tabs.update(tabId, { active: true })' "$STAGE"
if grep -Fq 'active: true' "$RELAY" "$GROUP"; then
  echo "relay or connection code activates tabs outside the stage" >&2
  exit 1
fi
# The service worker's only tab activation is the user clicking the toolbar
# icon to open the status page.
if [ "$(grep -c 'active: true' "$SOURCE")" != "1" ] || ! grep -B2 'active: true' "$SOURCE" | grep -Fq "status.html"; then
  echo "service worker activates tabs outside the stage" >&2
  exit 1
fi
grep -Fq 'lane.stage.run(lane.sessionId, tabId' "$RELAY"
grep -Fq "cdpMethod === 'Page.bringToFront' || cdpMethod === 'Target.activateTarget'" "$RELAY"
grep -Fq 'does not own' "$RELAY"
grep -Fq 'this._ownedTabIds.has(tab.openerTabId)' "$RELAY"
grep -Fq 'markOwnedTab' "$RELAY"
grep -Fq 'markTabReclaimed' "$RELAY"
grep -Fq 'cleanupWorkspace' "$GROUP"
grep -Fq 'await this._cleanupWorkspace()' "$GROUP"
grep -Fq 'Owned tab opened outside its private agent lane' "$GROUP"
grep -Fq 'Private pool workspaces intentionally create **no Chrome tab groups**' "$EXTENSION/README.md"
if grep -Fq 'chrome.tabs.group(' "$WORKSPACE" "$STAGE" "$GUARD"; then
  echo "lane code creates Chrome tab groups" >&2
  exit 1
fi

# A private protocol sentinel prevents the signed Store build with the same ID
# from silently satisfying the local canary route. Token checks use fixed-length
# Web Crypto digests rather than ordinary string equality.
grep -Fq 'LANES_PROTOCOL_VERSION = 91031' "$CONNECT_UI"
grep -Fq 'constantTimeTokenEqual' "$CONNECT_UI"
if grep -Fq 'token === expectedToken' "$CONNECT_UI"; then
  echo "canary still compares the bearer token with ordinary equality" >&2
  exit 1
fi
grep -Fq 'PLAYWRIGHT_EXTENSION_PROTOCOL=91031' "$MCP_SERVER"
grep -Fq 'verify_canary_install' "$MCP_SERVER"

# The unpacked build intentionally retains Microsoft's public manifest key so
# @playwright/mcp resolves the same stable extension ID.
ruby -rjson -e '
  manifest = JSON.parse(File.read(ARGV.fetch(0)))
  abort "wrong name" unless manifest.fetch("name") == "Agent Lanes for Chrome"
  abort "missing stable id key" unless manifest.fetch("key").start_with?("MIIBIjAN")
  abort "missing debugger permission" unless manifest.fetch("permissions").include?("debugger")
  abort "missing native messaging permission" unless manifest.fetch("permissions").include?("nativeMessaging")
  abort "missing crash-recovery storage permission" unless manifest.fetch("permissions").include?("storage")
  abort "unsafe fixed idle reaper remains" if manifest.fetch("permissions").include?("alarms")
  description = manifest.fetch("description")
  abort "manifest does not describe input-capable lane windows" unless
    description.include?("input-capable") && description.include?("normal-type") && description.include?("non-focused")
  abort "version_name does not identify the installed build" unless manifest.fetch("version_name").start_with?(manifest.fetch("version") + " ")
' "$MANIFEST"
cmp -s "$MANIFEST" "$BUILD_MANIFEST"
grep -Fq '91031' "$EXTENSION/out/lib/ui/connect.js"
grep -Fq 'agent-lane=' "$EXTENSION/out/lib/ui/status.js"
if grep -Rq 'PLAYWRIGHT_MCP_EXTENSION_TOKEN=' "$EXTENSION/out"; then
  echo "extension UI still instructs users to export the broker token" >&2
  exit 1
fi

# Automated connections travel through an extension-allowlisted native host;
# no Chrome tab or macOS application-open call is allowed in the handshake.
test -x "$NATIVE_BRIDGE"
test -f "$NATIVE_MANIFEST"
grep -Fq "const NATIVE_HOST_NAME = 'agency.ziplyne.agent_lanes'" "$SOURCE"
grep -Fq 'chrome.runtime.connectNative(NATIVE_HOST_NAME)' "$SOURCE"
grep -Fq 'playwright-mcp-native-bridge' "$MCP_SERVER"
if grep -Rq '/usr/bin/open.*Google Chrome' "$NATIVE_BRIDGE" "$MCP_SERVER"; then
  echo "authenticated handshake still opens Chrome" >&2
  exit 1
fi
ruby -rjson -e '
  manifest = JSON.parse(File.read(ARGV.fetch(0)))
  abort "wrong native host name" unless manifest.fetch("name") == "agency.ziplyne.agent_lanes"
  abort "native host path is not portable" unless manifest.fetch("path") == "__HOME__/.local/bin/playwright-mcp-native-bridge"
  origins = manifest.fetch("allowed_origins")
  abort "native host origin scope drift" unless origins == ["chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/"]
' "$NATIVE_MANIFEST"

printf 'Extension tests passed\n'
