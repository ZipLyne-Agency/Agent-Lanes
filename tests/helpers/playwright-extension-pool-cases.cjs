const assert = require('node:assert/strict');

async function runPoolCases(context) {
  const { extension, port, state, removedTabs, createdWindows, updatedWindows, createdTabs, updatedTabs,
    stored, portMessages, groupedTabs, tabUrls, removedWindows, leaseParkedWorkspace,
    discardParkedWorkspaces, prepareWorkspacePool, provisionAgentWorkspace } = context;
  const workspace = await provisionAgentWorkspace();
  assert.equal(workspace.windowId, 9);
  assert.equal(workspace.anchorTabId, 30);
  assert.equal(workspace.tab.id, 30);
  assert.deepEqual(createdTabs, []);
  assert.ok(updatedTabs.some(update =>
    update[0] === 30 && update[1].autoDiscardable === false));
  assert.equal(createdWindows.at(-1).url.startsWith('chrome-extension://test/status.html#agent-popup-workspace='), true);
  assert.deepEqual({ ...createdWindows.at(-1), url: '<marker>' }, {
    url: '<marker>', type: 'popup', state: 'normal', focused: false,
    left: 96, top: 72, width: 900, height: 700,
  });
  assert.equal(updatedWindows.some(update => update[0] === 9 && update[1].state === 'normal'), false,
      'popup workspace provisioning used a focus-order-changing restore transition');
  assert.equal(updatedWindows.some(([, update]) => update.focused === true), false,
      'popup workspace provisioning attempted to focus a user window');
  assert.equal(removedWindows.includes(23), true,
      'startup recovery did not remove an unambiguously orphaned marker window');
  assert.equal(removedWindows.includes(24), false,
      'startup recovery removed a marker window containing user content');

  extension._workspaceReservations = 1;
  await assert.rejects(extension._preparePool(3), /requires no active browser connections/);
  extension._workspaceReservations = 0;
  const poolBeforePrepare = await extension._workspacePoolPromise;
  poolBeforePrepare.push({
    windowId: 14,
    windowType: 'popup',
    anchorTabId: 51,
    tab: { id: 51, windowId: 14, groupId: -1 },
    poolKey: 'playwrightParkedWorkspace:stale-cached',
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=stale-cached',
  });
  stored['playwrightParkedWorkspace:stale-cached'] = {
    windowId: 14,
    windowType: 'popup',
    anchorTabId: 51,
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=stale-cached',
  };
  await extension._onNativeHostMessage(port, {
    type: 'preparePool',
    requestId: 'prepare-test',
    targetCapacity: 3,
  });
  assert.deepEqual(portMessages.at(-1), {
    type: 'preparePoolResult',
    requestId: 'prepare-test',
    ok: true,
    created: 1,
    parkedWorkspaceCount: 3,
    parkedWorkspaceIds: [17, 18, 9],
  });
  assert.equal(groupedTabs.length, 0, 'pool preparation created a Chrome tab group');
  assert.equal(extension._connections.size, 0, 'pool preparation created a relay connection');
  assert.deepEqual(updatedTabs.filter(([, update]) => update.active === true).at(-1), [12, { active: true }],
      'pool preparation did not restore the exact normal user tab');
  assert.deepEqual(updatedWindows.filter(([, update]) => update.focused === true).at(-1), [7, { focused: true }],
      'pool preparation did not restore the exact normal user window');
  assert.equal(stored['playwrightParkedWorkspace:stale-cached'], undefined,
      'pool preparation retained a stale cached workspace');

  state.lastFocusedIsMarker = true;
  const createdWindowCount = createdWindows.length;
  await assert.rejects(
      prepareWorkspacePool(await extension._workspacePoolPromise, 3),
      /normal user window/,
  );
  state.lastFocusedIsMarker = false;
  assert.equal(createdWindows.length, createdWindowCount,
      'pool preparation created a window before rejecting an agent restoration target');

  state.chromeAppFocused = false;
  await assert.rejects(
      prepareWorkspacePool(await extension._workspacePoolPromise, 4),
      /must be foreground/,
  );
  state.chromeAppFocused = true;
  assert.equal(createdWindows.length, createdWindowCount,
      'pool preparation created a window while Chrome was backgrounded');

  state.nextWorkspaceStableReadLag = 20;
  const lagTolerantPool = [];
  await prepareWorkspacePool(lagTolerantPool, 1);
  assert.equal(lagTolerantPool.length, 1,
      'pool preparation rejected Chrome focus/tab state that converged asynchronously');
  assert.notEqual(state.internalFocusedWindowId, 9,
      'popup provisioning promoted the private workspace');
  const discarded = await discardParkedWorkspaces(lagTolerantPool);
  assert.deepEqual(discarded, { removed: 1, preserved: 0 },
      'safe pool rollback did not remove its untouched marker window');
  assert.deepEqual(lagTolerantPool, [], 'safe pool rollback retained a reusable slot');

  const reclaimedPool = [{
    windowId: 24,
    windowType: 'popup',
    anchorTabId: 150,
    tab: { id: 150, windowId: 24, groupId: -1 },
    poolKey: 'playwrightParkedWorkspace:reclaimed-discard',
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=reclaimed-orphan',
  }];
  stored['playwrightParkedWorkspace:reclaimed-discard'] = {
    windowId: 24,
    windowType: 'popup',
    anchorTabId: 150,
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=reclaimed-orphan',
  };
  const reclaimedDiscard = await discardParkedWorkspaces(reclaimedPool);
  assert.deepEqual(reclaimedDiscard, { removed: 0, preserved: 1 },
      'safe pool rollback treated a user-modified workspace as disposable');
  assert.equal(removedWindows.includes(24), false,
      'safe pool rollback closed a workspace containing user content');

  state.nextWorkspaceStableReadLag = 200;
  const rollbackPool = [];
  const removedWindowCount = removedWindows.length;
  const focusUpdateCount = updatedWindows.filter(([, update]) => update.focused === true).length;
  await assert.rejects(prepareWorkspacePool(rollbackPool, 1), /stabilize the agent workspace/);
  assert.deepEqual(rollbackPool, [], 'failed user-window restoration published a pool slot');
  assert.equal(removedWindows.length, removedWindowCount + 1,
      'failed user-window restoration did not roll back the new workspace');
  assert.equal(updatedWindows.filter(([, update]) => update.focused === true).length, focusUpdateCount,
      'failed pool preparation changed focus during rollback');
  state.workspaceStableReadLag = 0;

  extension._connections.set(99, {
    clientName: 'status-agent',
    workspaceWindowId: () => 9,
  });
  await extension._onNativeHostMessage(port, { type: 'status', requestId: 'status-test' });
  assert.deepEqual(portMessages.at(-1), {
    type: 'statusResult',
    requestId: 'status-test',
    ok: true,
    connections: [{
      id: 99,
      clientName: 'status-agent',
      workspace: {
        windowId: 9,
        type: 'popup',
        state: 'normal',
        focused: false,
        left: 120,
        top: 80,
        width: 900,
        height: 700,
        tabCount: 1,
      },
    }],
    parkedWorkspaceCount: 3,
    parkedWorkspaceIds: [17, 18, 9],
    parkedWorkspaces: [
      { windowId: 17, type: 'popup', state: 'normal', focused: false, tabCount: 1 },
      { windowId: 18, type: 'popup', state: 'normal', focused: false, tabCount: 1 },
      { windowId: 9, type: 'popup', state: 'normal', focused: false, tabCount: 1 },
    ],
  });
  assert.deepEqual(stored['playwrightParkedWorkspace:slot'], {
    windowId: 17,
    windowType: 'popup',
    anchorTabId: 80,
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=slot',
  }, 'parked workspace IDs were not recovered through the durable marker URL');
  assert.deepEqual(stored['playwrightParkedWorkspace:recovered'], {
    windowId: 18,
    windowType: 'popup',
    anchorTabId: 91,
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=recovered',
  }, 'interrupted active workspace was not returned to the parked pool');
  {
    // The recovery navigation commits asynchronously, like real Chrome.
    const commitDeadline = Date.now() + 3000;
    while (Date.now() < commitDeadline &&
           tabUrls.get(91) !== 'chrome-extension://test/status.html#agent-workspace=recovered')
      await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(tabUrls.get(91), 'chrome-extension://test/status.html#agent-workspace=recovered',
      'service-worker recovery did not restore the leased anchor marker');

  state.failNextTabUpdate = true;
  const leasedCandidate = {
    windowId: 17,
    windowType: 'popup',
    anchorTabId: 80,
    tab: { id: 80, windowId: 17, groupId: -1 },
    poolKey: 'playwrightParkedWorkspace:slot',
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=slot',
  };
  await assert.rejects(leaseParkedWorkspace(leasedCandidate), /simulated tab update failure/);
  assert.ok(stored['playwrightParkedWorkspace:slot'], 'failed lease removed the durable pool record');

  stored['playwrightParkedWorkspace:reclaimed'] = {
    windowId: 14,
    windowType: 'popup',
    anchorTabId: 51,
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=reclaimed',
  };
  await assert.rejects(leaseParkedWorkspace({
    windowId: 14,
    windowType: 'popup',
    anchorTabId: 51,
    tab: { id: 51, windowId: 14, groupId: -1 },
    poolKey: 'playwrightParkedWorkspace:reclaimed',
    markerUrl: 'chrome-extension://test/status.html#agent-workspace=reclaimed',
  }), /no longer available/);
  assert.equal(stored['playwrightParkedWorkspace:reclaimed'], undefined, 'reclaimed slot retained stale pool metadata');
  assert.equal(removedTabs.includes(51), false, 'reclaimed slot anchor was modified by lease validation');

  // Later lifecycle cases reuse mock window 7 as an agent workspace rather
  // than the user window restored by the pool-management cases above.
  state.internalFocusedWindowId = undefined;

}

module.exports = { runPoolCases };
