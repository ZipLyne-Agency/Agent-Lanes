// Agent display suite for the canary service worker: lanes live on the
// invisible "Agent Lanes" display, everything else stays off it, reload husks
// are revived only when provably ours, background preparation needs the
// display, and focus that lands on a hidden lane is handed back instead of
// ending the agents' sessions.
const assert = require('node:assert/strict');
const path = require('node:path');

const compiledDir = process.argv[2];
if (!compiledDir)
  throw new Error('compiled module directory is required');

const { createChromeFake } = require('./fixtures/playwright-extension-chrome-fake.cjs');

const BROWSER_SESSION = 'c'.repeat(64);
const OLD_SESSION = 'd'.repeat(64);
const marker = name => `chrome-extension://test/status.html#agent-lane=${name}`;
// Chrome on macOS reports every display name as empty, exactly as here; the
// agent display is recognised by its size and corner-only position.
const PRIMARY = { id: '1', name: '', isPrimary: true, isEnabled: true,
  bounds: { left: 0, top: 0, width: 2048, height: 1152 }, workArea: { left: 0, top: 25, width: 2048, height: 1127 } };
const SECOND = { id: '2', name: '', isPrimary: false, isEnabled: true,
  bounds: { left: 2048, top: 0, width: 2048, height: 1152 }, workArea: { left: 2048, top: 25, width: 2048, height: 1127 } };
const AGENT = { id: '9', name: '', isPrimary: false, isEnabled: true,
  bounds: { left: 4096, top: 1152, width: 1440, height: 900 }, workArea: { left: 4096, top: 1152, width: 1440, height: 900 } };
// A real monitor with the same size, snapped edge to edge below the primary.
const LOOKALIKE = { id: '3', name: '', isPrimary: false, isEnabled: true,
  bounds: { left: 0, top: 1152, width: 1440, height: 900 }, workArea: { left: 0, top: 1152, width: 1440, height: 900 } };
const onDisplay = (window, unit) => {
  const x = window.left + window.width / 2;
  const y = window.top + window.height / 2;
  return x >= unit.bounds.left && x < unit.bounds.left + unit.bounds.width &&
    y >= unit.bounds.top && y < unit.bounds.top + unit.bounds.height;
};
const corner = { left: 1148, top: 452, width: 900, height: 700 };
const hidden = { left: 4400, top: 1300, width: 900, height: 700 };

function fakeConnection(name) {
  return {
    name,
    ownedTabIds: new Set(),
    workspaceReclaimed: false,
    closeReasons: [],
    setLane(lane) { this.lane = lane; },
    markOwnedTab(tabId) { this.ownedTabIds.add(tabId); this.onownershipchange?.([...this.ownedTabIds]); },
    markTabReclaimed(tabId) { this.ownedTabIds.delete(tabId); },
    markWorkspaceReclaimed(reason) { this.workspaceReclaimed = true; this.close(reason); },
    attachTab() {},
    detachTab() {},
    didInitialize() {},
    close(reason) {
      this.closeReasons.push(reason);
      if (this._closed)
        return;
      this._closed = true;
      this.onclose?.();
    },
  };
}

async function main() {
  const fake = createChromeFake({ displays: [PRIMARY, SECOND, AGENT] });
  global.chrome = fake.chrome;

  // ── Recognition: size plus corner-only contact, never a look-alike ──────
  const { findAgentDisplay } = require(path.join(compiledDir, 'agentDisplay.js'));
  assert.equal((await findAgentDisplay())?.id, AGENT.id, 'the agent display was not recognised without a name');
  fake.setDisplays([PRIMARY, SECOND, LOOKALIKE]);
  assert.equal(await findAgentDisplay(), undefined, 'an edge-snapped monitor of the same size was taken for the agent display');
  fake.setDisplays([PRIMARY, SECOND, AGENT]);

  // ── Browser state before the worker starts ───────────────────────────────
  const user = fake.addWindow({ type: 'normal', url: 'https://example.com/user', left: 0, top: 31, width: 2048, height: 1121 }, { focus: true });
  const cornerLane = fake.addWindow({ type: 'normal', url: marker('corner'), ...corner });
  // Reload husks: the anchor page became a new-tab page.
  const hiddenHuskOldSession = fake.addWindow({ type: 'normal', url: marker('hidden-husk'), ...hidden });
  const visibleHuskSameSession = fake.addWindow({ type: 'normal', url: marker('visible-husk'), ...corner });
  const visibleHuskOldSession = fake.addWindow({ type: 'normal', url: marker('old-visible'), ...corner });
  // A window Chrome opened on the agent display that is not a lane.
  const stray = fake.addWindow({ type: 'normal', url: 'https://example.com/opened-beside-a-lane', ...hidden });
  // A lane Chrome restored beside a dead session's tab: preserved for the user,
  // so it must not stay where they cannot see it.
  const restoredBusyLane = fake.addWindow({ type: 'normal', url: marker('restored-busy'), ...hidden });
  fake.addTab(restoredBusyLane.id, { url: 'https://example.com/restored-session-tab', active: false });
  await fake.settle();
  fake.reloadExtensionPages();
  // The corner lane's anchor survived (it was re-rendered before the reload).
  fake.tabs.get(fake.windowTabs(cornerLane.id)[0].id).url = marker('corner');
  const record = (window, name, browserSessionId) => ({
    windowId: window.id, windowType: 'normal', anchorTabId: fake.windowTabs(window.id)[0].id, markerUrl: marker(name),
    ...(browserSessionId ? { browserSessionId } : {}),
  });
  Object.assign(fake.storage, {
    'playwrightLane:corner': record(cornerLane, 'corner', BROWSER_SESSION),
    'playwrightLane:hidden-husk': record(hiddenHuskOldSession, 'hidden-husk', OLD_SESSION),
    'playwrightLane:visible-husk': record(visibleHuskSameSession, 'visible-husk', BROWSER_SESSION),
    'playwrightLane:old-visible': record(visibleHuskOldSession, 'old-visible', OLD_SESSION),
    'playwrightLane:restored-busy': record(restoredBusyLane, 'restored-busy', OLD_SESSION),
  });

  const { playwrightExtension: extension } = require(path.join(compiledDir, 'background.js'));
  await extension._onNativeHostMessage(fake.port, { type: 'hostReady', browserSessionId: BROWSER_SESSION });
  const pool = await extension._workspacePoolPromise;
  await fake.settle(200);

  // ── Reload husks are revived only when provably ours ────────────────────
  const poolIds = pool.map(lane => lane.windowId);
  assert.ok(poolIds.includes(cornerLane.id), 'intact lane was not loaded');
  assert.ok(poolIds.includes(hiddenHuskOldSession.id), 'husk on the agent display was not revived');
  assert.ok(poolIds.includes(visibleHuskSameSession.id), 'same-session husk was not revived');
  assert.ok(!poolIds.includes(visibleHuskOldSession.id), 'an old-session husk on a visible display was taken over');
  assert.equal(fake.windowTabs(visibleHuskOldSession.id)[0].url, 'chrome://newtab/', 'an unproven husk was navigated');
  assert.equal(fake.windowTabs(hiddenHuskOldSession.id)[0].url, marker('hidden-husk'), 'revived husk was not re-anchored');
  assert.equal(fake.storage['playwrightLane:hidden-husk'].browserSessionId, BROWSER_SESSION, 'revived lane kept the old session id');

  // ── Placement: lanes onto the agent display, strays off it ──────────────
  for (const lane of pool)
    assert.ok(onDisplay(fake.windows.get(lane.windowId), AGENT), `lane ${lane.windowId} was not moved to the agent display`);
  assert.ok(onDisplay(fake.windows.get(stray.id), PRIMARY), 'a non-lane window was left on the agent display');
  assert.ok(!poolIds.includes(restoredBusyLane.id), 'a lane restored beside another tab was pooled');
  assert.ok(onDisplay(fake.windows.get(restoredBusyLane.id), PRIMARY), 'a preserved lane with user-visible tabs was stranded on the agent display');
  assert.equal(fake.windowTabs(restoredBusyLane.id).length, 2, 'placement touched the preserved lane\'s tabs');
  assert.ok(onDisplay(fake.windows.get(visibleHuskOldSession.id), PRIMARY), 'an unproven husk was moved away from the user');
  assert.equal(fake.focusedWindowId, user.id, 'placement changed the focused window');
  assert.equal(fake.log.focusUpdates.length, 0, 'placement focused a window');

  // ── Status reports the display ───────────────────────────────────────────
  await extension._onNativeHostMessage(fake.port, { type: 'status', requestId: 'status' });
  const status = fake.log.portMessages.at(-1);
  assert.deepEqual(status.agentDisplay, { present: true, lanesOnDisplay: pool.length });

  // ── Background preparation needs the flag, never focuses anything ───────
  fake.focusWindow(undefined); // another app is in front
  const windowsBefore = fake.log.createdWindows.length;
  await assert.rejects(extension._preparePool(5), /must be foreground/, 'preparation ran in the background without the flag');
  assert.equal(fake.log.createdWindows.length, windowsBefore);
  const focusBefore = fake.log.focusUpdates.length;
  const background = await extension._preparePool(5, true);
  assert.equal(background.created, 2, 'background preparation did not fill the pool');
  for (const created of fake.log.createdWindows.slice(windowsBefore)) {
    assert.equal(created.focused, false);
    assert.equal(created.state, 'normal');
    assert.ok(onDisplay(created, AGENT), 'background lane was created off the agent display');
  }
  assert.equal(fake.log.focusUpdates.length, focusBefore, 'background preparation focused a window');
  assert.equal(fake.focusedWindowId, undefined, 'background preparation activated Chrome');
  fake.focusWindow(user.id);

  // ── Focus on a hidden lane goes back only to a window on the same Space ──
  // Two user windows on two Spaces (desktops), each used there.
  const deskOne = fake.addWindow({ type: 'normal', url: 'https://example.com/desk-one', left: 0, top: 31, width: 2048, height: 1121 });
  fake.setActiveSpace(1);
  fake.focusWindow(deskOne.id);
  await fake.settle(60);
  fake.setActiveSpace(2);
  fake.focusWindow(user.id);
  await fake.settle(60);
  const conn = fakeConnection('agent');
  await extension._establishConnection(conn, undefined, 'agent');
  const busyLane = conn.lane.windowId;
  // The user switches to Desktop 1 with Chrome active; macOS focuses a hidden lane there.
  fake.setActiveSpace(1);
  fake.focusWindow(busyLane);
  await fake.settle(450);
  assert.equal(fake.focusedWindowId, deskOne.id,
      'focus went to a window on another Space, which makes macOS switch Spaces');
  assert.equal(conn.workspaceReclaimed, false, 'focus on a hidden lane ended its sessions');
  assert.ok(pool.some(lane => lane.windowId === busyLane), 'a hidden lane left the pool on focus');
  await fake.settle(1600);

  // A Space with none of the user's windows: focus stays on the lane rather
  // than dragging the user to another Space, and the lane keeps working.
  const focusCallsBefore = fake.log.focusUpdates.length;
  fake.setActiveSpace(3);
  fake.focusWindow(busyLane);
  await fake.settle(450);
  assert.equal(fake.log.focusUpdates.length, focusCallsBefore, 'a window on another Space was focused');
  assert.equal(fake.focusedWindowId, busyLane);
  const backgrounded = await conn.lane.isBackgrounded();
  assert.equal(backgrounded.ok, true, `a focused hidden lane stopped serving its session (${backgrounded.diagnostic})`);
  assert.equal(conn.workspaceReclaimed, false);
  // Placement moving a focused hidden lane is not a reclaim either.
  await chrome.windows.update(busyLane, { left: AGENT.bounds.left + 10 });
  await fake.settle(60);
  assert.equal(conn.workspaceReclaimed, false, 'moving a focused hidden lane reclaimed it');
  fake.focusWindow(user.id);
  conn.close('browser_close');
  await fake.settle(1600);

  // ── Dock icon with only lanes open gives the user a window ──────────────
  // Close every window that is not a lane, so only lanes are open.
  for (const windowId of [...fake.windows.keys()]) {
    if (extension._laneRuntimes.has(windowId))
      continue;
    for (const tab of fake.windowTabs(windowId))
      fake.tabs.delete(tab.id);
    fake.windows.delete(windowId);
    fake.events.windowsRemoved.emit(windowId);
  }
  fake.setActiveSpace(2);
  fake.focusWindow(pool[0].windowId);
  await fake.settle(450);
  const opened = fake.log.createdWindows.at(-1);
  assert.equal(opened.focused, true, 'no window was opened for the user');
  assert.ok(onDisplay(opened, PRIMARY), 'the user window was opened on the agent display');
  assert.equal(extension._laneRuntimes.has(pool[0].windowId), true, 'the focused hidden lane was reclaimed');
  const newUser = opened.id;
  await fake.settle(900);

  // ── Display lost and regained: lanes go back to it ──────────────────────
  fake.setDisplays([PRIMARY, SECOND]);
  for (const lane of pool)
    Object.assign(fake.windows.get(lane.windowId), corner); // macOS rescues the windows
  await fake.settle(900);
  assert.ok(pool.every(lane => onDisplay(fake.windows.get(lane.windowId), PRIMARY)), 'lanes moved while no agent display existed');
  fake.setDisplays([PRIMARY, SECOND, AGENT]);
  await fake.settle(900);
  for (const lane of pool)
    assert.ok(onDisplay(fake.windows.get(lane.windowId), AGENT), `lane ${lane.windowId} did not return to the agent display`);

  // ── A reclaimed lane comes to the user's screen ─────────────────────────
  const reclaimConn = fakeConnection('reclaimed');
  await extension._establishConnection(reclaimConn, undefined, 'reclaimed');
  const reclaimedLane = reclaimConn.lane.windowId;
  const reclaimedAnchor = pool.find(lane => lane.windowId === reclaimedLane).anchorTabId;
  await chrome.tabs.remove(reclaimedAnchor); // user closed the anchor
  await fake.settle(900);
  assert.equal(reclaimConn.workspaceReclaimed, true);
  assert.ok(onDisplay(fake.windows.get(reclaimedLane), PRIMARY), 'the reclaimed lane stayed on the invisible display');

  // ── Unpooled marker-only lanes are adopted without a new window ─────────
  const leftover = fake.addWindow({ type: 'normal', url: marker('leftover'), ...hidden });
  await fake.settle(900);
  assert.ok(onDisplay(fake.windows.get(leftover.id), AGENT), 'a marker-only lane window was pushed off the agent display');
  fake.focusWindow(newUser);
  const createdBeforeAdopt = fake.log.createdWindows.length;
  const adopted = await extension._preparePool(pool.length + 1);
  assert.equal(adopted.created, 0);
  assert.ok(adopted.parkedWorkspaceIds.includes(leftover.id), 'the leftover lane was not adopted');
  assert.equal(fake.log.createdWindows.length, createdBeforeAdopt, 'adoption created a window');

  console.log('Playwright extension agent display tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
