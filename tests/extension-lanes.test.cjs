// Lane lifecycle suite for the canary service worker: restart recovery,
// foreground-only pool preparation, silent session leasing, exact cleanup,
// user reclaim, capacity waiting, and pool discard.
const assert = require('node:assert/strict');
const path = require('node:path');

const compiledDir = process.argv[2];
if (!compiledDir)
  throw new Error('compiled module directory is required');

const { createChromeFake } = require('./fixtures/playwright-extension-chrome-fake.cjs');

const BROWSER_SESSION = 'a'.repeat(64);
const marker = name => `chrome-extension://test/status.html#agent-lane=${name}`;

function fakeConnection(name) {
  const connection = {
    name,
    attachedTabs: new Set(),
    ownedTabIds: new Set(),
    workspaceReclaimed: false,
    lane: undefined,
    closeReasons: [],
    initialized: 0,
    setLane(lane) { this.lane = lane; },
    markOwnedTab(tabId) { this.ownedTabIds.add(tabId); this.onownershipchange?.([...this.ownedTabIds]); },
    markTabReclaimed(tabId) { this.ownedTabIds.delete(tabId); },
    markWorkspaceReclaimed(reason) { this.workspaceReclaimed = true; this.close(reason); },
    attachTab(tab) { this.attachedTabs.add(tab.id); void this.ontabattached?.(tab.id); },
    detachTab(tabId) { this.attachedTabs.delete(tabId); },
    didInitialize() { this.initialized += 1; },
    close(reason) {
      this.closeReasons.push(reason);
      if (this._closed)
        return;
      this._closed = true;
      this.onclose?.();
    },
  };
  return connection;
}

async function main() {
  const fake = createChromeFake();
  global.chrome = fake.chrome;

  // ── Pre-existing browser state before the worker starts ──────────────────
  const user = fake.addWindow({ type: 'normal', url: 'https://example.com/user' }, { focus: true });
  const userTab = fake.windowTabs(user.id)[0];
  const laneOne = fake.addWindow({ type: 'normal', url: marker('one') });
  const laneOneAnchor = fake.windowTabs(laneOne.id)[0];
  const deadSessionTab = fake.addTab(laneOne.id, { url: 'https://example.com/dead-session', active: false });
  // A lane whose tabs Chrome restored after a full restart is ambiguous: it is
  // preserved for the user and never re-adopted, so no session is seated next
  // to content nobody can vouch for.
  const staleLane = fake.addWindow({ type: 'normal', url: marker('stale') });
  const staleLaneAnchor = fake.windowTabs(staleLane.id)[0];
  const otherBrowserSessionTab = fake.addTab(staleLane.id, { url: 'https://example.com/restored-by-chrome', active: false });
  const minimizedLane = fake.addWindow({ type: 'normal', url: marker('minimized') });
  fake.windows.get(minimizedLane.id).state = 'minimized';
  const orphanLane = fake.addWindow({ type: 'normal', url: marker('orphan') });
  const legacyPopup = fake.addWindow({ type: 'popup', url: 'chrome-extension://test/status.html#agent-popup-workspace=old' });
  const legacyActiveWindow = fake.addWindow({ type: 'popup', url: 'https://example.com/legacy-task' });
  await fake.settle();

  Object.assign(fake.storage, {
    'playwrightLane:one': { windowId: 999, windowType: 'normal', anchorTabId: 998, markerUrl: marker('one') },
    'playwrightLane:minimized': { windowId: minimizedLane.id, windowType: 'normal', anchorTabId: fake.windowTabs(minimizedLane.id)[0].id, markerUrl: marker('minimized') },
    'playwrightAgentSession:dead': {
      browserSessionId: BROWSER_SESSION, windowId: laneOne.id, ownedTabIds: [deadSessionTab.id],
      anchorTabId: laneOneAnchor.id, poolKey: 'playwrightLane:one', markerUrl: marker('one'), windowType: 'normal',
    },
    'playwrightLane:stale': { windowId: staleLane.id, windowType: 'normal', anchorTabId: staleLaneAnchor.id, markerUrl: marker('stale') },
    'playwrightAgentSession:other-browser': {
      browserSessionId: 'b'.repeat(64), windowId: staleLane.id, ownedTabIds: [otherBrowserSessionTab.id],
      anchorTabId: staleLaneAnchor.id, poolKey: 'playwrightLane:stale', markerUrl: marker('stale'), windowType: 'normal',
    },
    'playwrightParkedWorkspace:legacy': {
      windowId: legacyPopup.id, windowType: 'popup', anchorTabId: fake.windowTabs(legacyPopup.id)[0].id,
      markerUrl: 'chrome-extension://test/status.html#agent-popup-workspace=old',
    },
    'playwrightAgentWorkspace:legacy-active': {
      browserSessionId: BROWSER_SESSION, windowId: legacyActiveWindow.id,
      ownedTabIds: [fake.windowTabs(legacyActiveWindow.id)[0].id], anchorTabId: fake.windowTabs(legacyActiveWindow.id)[0].id,
    },
  });

  // The service-worker entry instantiates the extension at load, exactly as
  // Chrome does; drive that instance instead of racing a second one.
  const { playwrightExtension: extension } = require(path.join(compiledDir, 'background.js'));
  const { LANE_CAPACITY } = require(path.join(compiledDir, 'workspaceLifecycle.js'));
  await extension._onNativeHostMessage(fake.port, { type: 'hostReady', browserSessionId: BROWSER_SESSION });
  assert.equal(fake.events.runtimeStartup.listeners.size, 1, 'extension did not register the browser-startup wake listener');
  const pool = await extension._workspacePoolPromise;

  // ── Recovery ─────────────────────────────────────────────────────────────
  assert.deepEqual(pool.map(lane => lane.windowId), [laneOne.id, orphanLane.id],
      'recovery did not re-adopt the recorded lane and the orphan marker lane');
  assert.equal(pool[0].anchorTabId, laneOneAnchor.id, 'lane IDs were not refreshed from the marker URL');
  assert.ok(fake.log.removedTabs.includes(deadSessionTab.id), 'dead session tab was not removed');
  assert.ok(!fake.log.removedTabs.includes(otherBrowserSessionTab.id), 'tab from another Chrome session was removed');
  assert.ok(fake.log.removedWindows.includes(legacyPopup.id), 'legacy popup marker window was not retired');
  assert.ok(!fake.log.removedWindows.includes(legacyActiveWindow.id), 'legacy active workspace window was closed');
  assert.ok(!fake.log.removedWindows.includes(minimizedLane.id), 'minimized lane window was closed instead of preserved');
  assert.ok(!fake.log.removedWindows.includes(staleLane.id), 'lane with restored tabs was closed instead of preserved');
  assert.equal(fake.storage['playwrightLane:stale'], undefined, 'lane with restored tabs kept its pool record');
  assert.equal(fake.storage['playwrightLane:minimized'], undefined, 'minimized lane kept its pool record');
  assert.equal(fake.storage['playwrightAgentSession:dead'], undefined);
  assert.equal(fake.storage['playwrightAgentSession:other-browser'], undefined);
  assert.equal(fake.storage['playwrightParkedWorkspace:legacy'], undefined);
  assert.equal(fake.storage['playwrightAgentWorkspace:legacy-active'], undefined);
  assert.equal(Object.keys(fake.storage).filter(key => key.startsWith('playwrightLane:')).length, 2, 'orphan lane was not persisted');
  assert.equal(fake.focusedWindowId, user.id, 'recovery changed the focused window');

  // ── Pool preparation ─────────────────────────────────────────────────────
  fake.focusWindow(undefined);
  await assert.rejects(extension._preparePool(4), /must be foreground/);
  assert.equal(fake.log.createdWindows.length, 7, 'preparation created a window while Chrome was backgrounded');
  fake.focusWindow(user.id);
  const focusUpdatesBefore = fake.log.focusUpdates.length;
  await extension._onNativeHostMessage(fake.port, { type: 'preparePool', requestId: 'prep', targetCapacity: 4 });
  const prepared = fake.log.portMessages.at(-1);
  assert.equal(prepared.ok, true, `preparation failed: ${prepared.diagnostic}`);
  assert.equal(prepared.created, 2);
  assert.equal(prepared.parkedWorkspaceCount, 4);
  const createdLanes = fake.log.createdWindows.slice(-2);
  const { LANE_WINDOW_STATE } = require(path.join(compiledDir, 'workspaceLifecycle.js'));
  for (const created of createdLanes) {
    assert.equal(created.type, 'normal', 'lane was not created as a normal-type window');
    assert.equal(created.state, 'normal', 'lane must be created normal and only then enter its configured state');
    assert.equal(created.focused, false);
    assert.ok(created.url.startsWith(marker('')), 'lane anchor is not the inert marker page');
    assert.equal(fake.windows.get(created.id).state, LANE_WINDOW_STATE, 'lane did not settle in the configured window state');
  }
  assert.equal(fake.focusedWindowId, user.id, 'preparation did not restore the user window');
  assert.ok(fake.log.focusUpdates.slice(focusUpdatesBefore).includes(user.id), 'preparation did not explicitly restore the user window');
  assert.ok(fake.windowTabs(user.id).find(tab => tab.id === userTab.id).active, 'preparation did not restore the user tab');
  await extension._onNativeHostMessage(fake.port, { type: 'preparePool', requestId: 'prep-again', targetCapacity: 4 });
  assert.equal(fake.log.portMessages.at(-1).created, 0, 'a full pool was extended');

  // ── Status shape ─────────────────────────────────────────────────────────
  await extension._onNativeHostMessage(fake.port, { type: 'status', requestId: 'status' });
  const status = fake.log.portMessages.at(-1);
  assert.equal(status.parkedWorkspaceCount, 4);
  assert.deepEqual(status.capacity, { lanes: 4, perLane: LANE_CAPACITY, total: 4 * LANE_CAPACITY, inUse: 0 });
  assert.equal(status.laneWindowState, LANE_WINDOW_STATE);
  for (const lane of status.parkedWorkspaces) {
    assert.equal(lane.type, 'normal');
    assert.ok(['normal', 'fullscreen'].includes(lane.state), `unexpected lane state ${lane.state}`);
    assert.equal(lane.focused, false);
    assert.equal(lane.sessionCount, 0);
    assert.equal(lane.capacity, LANE_CAPACITY);
  }

  // ── Silent session leasing ───────────────────────────────────────────────
  const windowsBeforeConnect = fake.log.createdWindows.length;
  const focusBeforeConnect = fake.log.focusUpdates.length;
  const activationsBeforeConnect = fake.log.activations.length;
  const connA = fakeConnection('agent-a');
  await extension._establishConnection(connA, undefined, 'agent-a');
  assert.equal(fake.log.createdWindows.length, windowsBeforeConnect, 'ordinary connection created a window');
  assert.equal(fake.log.focusUpdates.length, focusBeforeConnect, 'ordinary connection focused a window');
  assert.equal(fake.log.activations.length, activationsBeforeConnect, 'ordinary connection activated a tab');
  assert.equal(connA.lane.windowId, laneOne.id, 'first session did not land in the least-loaded lane');
  const created = fake.log.createdTabs.at(-1);
  assert.equal(created.windowId, laneOne.id);
  assert.equal(created.active, false, 'session tab was created active');
  const [sessionTabA] = [...connA.ownedTabIds];
  assert.equal(fake.tabs.get(sessionTabA).windowId, laneOne.id);
  assert.equal(fake.tabs.get(sessionTabA).autoDiscardable, false, 'session tab is discardable');
  assert.equal(connA.initialized, 1, 'relay did not initialize after tab placement');
  assert.equal(fake.focusedWindowId, user.id);
  const sessionRecords = Object.entries(fake.storage).filter(([key]) => key.startsWith('playwrightAgentSession:'));
  assert.equal(sessionRecords.length, 1, 'session record was not persisted');
  assert.deepEqual(sessionRecords[0][1].ownedTabIds, [sessionTabA]);
  assert.equal(sessionRecords[0][1].windowType, 'normal');

  const connB = fakeConnection('agent-b');
  await extension._establishConnection(connB, undefined, 'agent-b');
  assert.notEqual(connB.lane.windowId, laneOne.id, 'second session did not spread to an empty lane');
  await extension._onNativeHostMessage(fake.port, { type: 'status', requestId: 'status-2' });
  const busy = fake.log.portMessages.at(-1);
  assert.equal(busy.capacity.inUse, 2);
  assert.equal(busy.connections.length, 2);
  assert.equal(busy.connections[0].workspace.type, 'normal');
  assert.equal(busy.connections[0].workspace.tabCount, 2, 'lane one should hold anchor + session tab');
  assert.equal(busy.connections[0].workspace.ownedTabCount, 1);

  // ── Exact cleanup keeps the lane parked ──────────────────────────────────
  connA.close('browser_close');
  await fake.settle();
  assert.ok(fake.log.removedTabs.includes(sessionTabA), 'browser_close did not remove the session tab');
  assert.ok(!fake.log.removedTabs.includes(laneOneAnchor.id), 'browser_close removed the lane anchor');
  assert.ok(!fake.log.removedTabs.includes(otherBrowserSessionTab.id), 'browser_close removed a tab it did not own');
  assert.ok(pool.some(lane => lane.windowId === laneOne.id), 'lane left the pool after a normal close');
  assert.equal(Object.keys(fake.storage).filter(key => key.startsWith('playwrightAgentSession:')).length, 1, 'closed session record lingered');
  assert.equal(extension._laneRuntimes.get(laneOne.id).sessions.size, 0);

  // ── User reclaim ends every session in that lane and preserves tabs ─────
  // Preparation while sessions run must neither end them nor touch their lanes.
  const runtimeBefore = extension._laneRuntimes.get(connB.lane.windowId);
  await extension._onNativeHostMessage(fake.port, { type: 'preparePool', requestId: 'prep-live', targetCapacity: 4 });
  assert.equal(fake.log.portMessages.at(-1).created, 0, 'preparation with live sessions created lanes');
  assert.equal(connB.workspaceReclaimed, false, 'preparation reclaimed a lane with a live session');
  assert.equal(extension._laneRuntimes.get(connB.lane.windowId), runtimeBefore, 'preparation replaced a live lane runtime');

  const laneB = connB.lane.windowId;
  const [sessionTabB] = [...connB.ownedTabIds];
  fake.focusWindow(laneB);
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(connB.workspaceReclaimed, true, 'focus did not reclaim the lane for the user');
  assert.match(connB.closeReasons[0], /reclaimed/);
  assert.ok(!fake.log.removedTabs.includes(sessionTabB), 'reclaimed lane lost the user-visible session tab');
  assert.ok(!pool.some(lane => lane.windowId === laneB), 'reclaimed lane stayed in the pool');
  assert.equal(extension._laneRuntimes.has(laneB), false, 'reclaimed lane runtime lingered');
  assert.equal(Object.values(fake.storage).some(record => record?.windowId === laneB && record.markerUrl), false, 'reclaimed lane kept its record');
  await fake.settle();
  const laneBAnchor = fake.windowTabs(laneB).find(tab => tab.url.includes('agent-lane'));
  assert.ok(laneBAnchor && laneBAnchor.url.includes('#agent-lane-reclaimed='), 'reclaimed lane anchor was not tombstoned');
  assert.ok(fake.tabs.has(sessionTabB), 'tombstoning touched a preserved tab');
  fake.focusWindow(user.id);

  // ── Capacity: full pool waits, freed slot is granted ────────────────────
  const clients = [];
  const total = pool.length * LANE_CAPACITY;
  for (let index = 0; index < total; index++) {
    const connection = fakeConnection(`bulk-${index}`);
    await extension._establishConnection(connection, undefined, connection.name);
    clients.push(connection);
  }
  const perLane = pool.map(lane => extension._laneRuntimes.get(lane.windowId).sessions.size);
  assert.deepEqual(perLane, pool.map(() => LANE_CAPACITY), 'sessions were not spread evenly to full capacity');
  assert.equal(fake.log.createdWindows.length, windowsBeforeConnect, 'scaling to full capacity created a window');
  const overflow = fakeConnection('overflow');
  let overflowSettled = false;
  const overflowPromise = extension._establishConnection(overflow, undefined, 'overflow').then(() => overflowSettled = true);
  await fake.settle();
  assert.equal(overflowSettled, false, 'overflow session was admitted beyond capacity');
  clients[0].close('browser_close');
  await overflowPromise;
  assert.equal(overflowSettled, true, 'overflow session was not admitted after a slot freed');
  assert.equal(overflow.lane.windowId, clients[0].lane.windowId, 'freed slot was not reused');

  // ── Discard refuses while sessions run, then removes anchor-only lanes ──
  await assert.rejects(extension._discardPool(), /requires no active browser connections/);
  for (const connection of [...clients.slice(1), overflow])
    connection.close('browser_close');
  await fake.settle();
  assert.equal(fake.windowTabs(laneOne.id).length, 1, 'lane one should hold only its anchor after cleanup');
  // A foreign tab that lands in a pooled lane is handed to the user by the
  // guard, so pooled lanes are anchor-only by construction; a lane the user
  // took over (like staleLane) is outside the pool and untouched by discard.
  const keptLane = pool[pool.length - 1].windowId;
  fake.focusWindow(user.id);
  const arrival = fake.addTab(keptLane, { url: 'https://example.com/arrival', active: false });
  await fake.settle();
  assert.equal(fake.tabs.get(arrival.id).windowId, user.id, 'foreign arrival in a pooled lane was not handed to the user');
  await extension._onNativeHostMessage(fake.port, { type: 'discardPool', requestId: 'discard' });
  const discarded = fake.log.portMessages.at(-1);
  assert.equal(discarded.ok, true, discarded.diagnostic);
  assert.deepEqual({ removed: discarded.removed, preserved: discarded.preserved }, { removed: 3, preserved: 0 },
      'discard did not remove exactly the anchor-only lanes');
  assert.ok(fake.log.removedWindows.includes(laneOne.id), 'discard did not remove an anchor-only lane');
  assert.ok(!fake.log.removedWindows.includes(staleLane.id), 'discard closed a window outside the pool');
  assert.ok(fake.tabs.has(otherBrowserSessionTab.id), 'discard removed a restored user tab');
  assert.equal(pool.length, 0);
  assert.equal(fake.focusedWindowId, user.id, 'lifecycle changed the focused window');
  assert.equal(fake.log.focusUpdates.length, focusBeforeConnect, 'ordinary lifecycle focused a window');

  console.log('Playwright extension lane lifecycle tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
