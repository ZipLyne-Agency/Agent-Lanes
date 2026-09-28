// Relay, stage, and guard suite: command gating and ownership, the per-lane
// rendering scheduler, foreign-tab eviction, and user reclaim detection.
const assert = require('node:assert/strict');
const path = require('node:path');

const compiledDir = process.argv[2];
if (!compiledDir)
  throw new Error('compiled module directory is required');

const { createChromeFake } = require('./fixtures/playwright-extension-chrome-fake.cjs');

const fake = createChromeFake();
global.chrome = fake.chrome;

const { RelayConnection } = require(path.join(compiledDir, 'relayConnection.js'));
const { LaneStage, STAGE_IDLE_MS, STAGE_PARK_MS } = require(path.join(compiledDir, 'laneStage.js'));
const { LaneGuard, UserWindowTracker, EVICTION_GRACE_MS, FOCUS_SETTLE_MS } = require(path.join(compiledDir, 'laneGuard.js'));

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const marker = name => `chrome-extension://test/status.html#agent-lane=${name}`;

function socket() {
  const closes = [];
  return { closes, send() {}, close(...args) { closes.push(args); }, onmessage: undefined, onclose: undefined };
}

async function testStage() {
  const lane = fake.addWindow({ type: 'normal', url: marker('stage') });
  const anchor = fake.windowTabs(lane.id)[0];
  const tabA = fake.addTab(lane.id, { active: false });
  const tabB = fake.addTab(lane.id, { active: false });
  const stage = new LaneStage(lane.id, () => anchor.id);
  const activationsAt = () => fake.log.activations.length;

  let releaseA;
  const aRunning = new Promise(resolve => releaseA = resolve);
  const before = activationsAt();
  const commandA = stage.run(1, tabA.id, () => aRunning.then(() => 'a'));
  await sleep(10);
  assert.deepEqual(fake.log.activations.slice(before), [[lane.id, tabA.id]], 'first command did not activate its tab');
  let bStarted = false;
  const commandB = stage.run(2, tabB.id, async () => { bStarted = true; return 'b'; });
  await sleep(30);
  assert.equal(bStarted, false, 'a waiting session ran while another command was in flight');
  releaseA();
  assert.equal(await commandA, 'a');
  assert.equal(await commandB, 'b');
  assert.deepEqual(fake.log.activations.slice(before), [[lane.id, tabA.id], [lane.id, tabB.id]], 'hand-over did not activate the waiter');
  assert.ok(fake.tabs.get(tabB.id).active, 'stage holder tab is not the active tab');

  // Same session, same tab: no re-activation while it already holds the stage.
  const again = activationsAt();
  assert.equal(await stage.run(2, tabB.id, async () => 'again'), 'again');
  assert.equal(activationsAt(), again, 'holder re-activated its own tab');

  // A waiter whose session closes is rejected instead of leaking.
  let releaseB;
  const bBusy = new Promise(resolve => releaseB = resolve);
  const busy = stage.run(2, tabB.id, () => bBusy);
  const doomed = stage.run(3, tabA.id, async () => 'never');
  stage.releaseSession(3);
  await assert.rejects(doomed, /closed while waiting/);
  releaseB();
  await busy;

  // Idle lane parks back on the inert anchor.
  await sleep(STAGE_IDLE_MS + STAGE_PARK_MS + 200);
  assert.ok(fake.tabs.get(anchor.id).active, 'idle lane did not park on its anchor');
  stage.dispose();
}

async function testRelay() {
  const user = fake.addWindow({ type: 'normal', url: 'https://example.com/user' }, { focus: true });
  const lane = fake.addWindow({ type: 'normal', url: marker('relay') });
  const anchor = fake.windowTabs(lane.id)[0];
  const stage = new LaneStage(lane.id, () => anchor.id);
  let pending = 0;
  const reclaimReasons = [];
  const owned = new Set();
  const guard = new LaneGuard(lane.id, anchor.id, {
    isOwnedTab: tabId => owned.has(tabId),
    isLaneWindow: windowId => windowId === lane.id,
    lastUserWindowId: () => user.id,
    onActiveTabChanged: () => {},
    onReclaimed: reason => reclaimReasons.push(reason),
  });
  const ws = socket();
  const connection = new RelayConnection(ws);
  // Tabs the relay creates are bracketed so the guard knows they are ours.
  guard.beginTabCreation();
  const sessionTab = fake.addTab(lane.id, { active: false });
  guard.endTabCreation(sessionTab.id);
  owned.add(sessionTab.id);
  connection.setLane({
    sessionId: 7,
    windowId: lane.id,
    anchorTabId: anchor.id,
    stage,
    beginTabCreation: () => { pending++; guard.beginTabCreation(); },
    endTabCreation: createdTabId => { pending--; guard.endTabCreation(createdTabId); },
    isBackgrounded: async () => {
      const window = await chrome.windows.get(lane.id);
      return { ok: window.type === 'normal' && window.state === 'normal' && !window.focused, diagnostic: `focused=${window.focused}` };
    },
  });
  connection.markOwnedTab(sessionTab.id);
  const send = message => connection._handleCommand(message);
  const command = (tabId, method) => ({ id: 1, method: 'chrome.debugger.sendCommand', params: [{ tabId }, method, {}] });

  const commandsBefore = fake.log.debuggerCommands.length;
  assert.deepEqual(await send(command(sessionTab.id, 'Page.bringToFront')), {});
  assert.deepEqual(await send(command(sessionTab.id, 'Target.activateTarget')), {});
  assert.equal(fake.log.debuggerCommands.length, commandsBefore, 'focus commands reached chrome.debugger');
  assert.deepEqual(await send(command(sessionTab.id, 'Input.dispatchMouseEvent')), { forwarded: true });
  assert.ok(fake.tabs.get(sessionTab.id).active, 'command ran without the session tab on stage');
  assert.equal(fake.focusedWindowId, user.id, 'driving a lane tab changed window focus');
  await assert.rejects(send(command(anchor.id, 'Runtime.evaluate')), /does not own/);
  await assert.rejects(send({ id: 2, method: 'chrome.debugger.attach', params: [{ tabId: anchor.id }, '1.3'] }), /does not own/);
  await assert.rejects(send({ id: 2, method: 'chrome.debugger.detach', params: [{ tabId: anchor.id }] }), /does not own/);
  assert.equal(fake.log.debuggerDetaches.length, 0, 'detach of an unowned tab reached chrome.debugger');

  const createdTab = await send({ id: 3, method: 'chrome.tabs.create', params: [{ url: 'about:blank', active: true, windowId: user.id }] });
  assert.equal(createdTab.windowId, lane.id, 'agent tab escaped its lane');
  assert.equal(fake.log.createdTabs.at(-1).active, false, 'agent tab was created active');
  assert.ok(connection.ownedTabIds.has(createdTab.id));
  assert.equal(fake.tabs.get(createdTab.id).autoDiscardable, false);
  assert.equal(pending, 0, 'creation bracket was not closed');
  assert.ok(!fake.log.movedTabs.some(([tabId]) => tabId === createdTab.id), 'relay-created tab was evicted as foreign');
  owned.add(createdTab.id);

  const originalCreate = chrome.tabs.create;
  chrome.tabs.create = async createData => originalCreate({ ...createData, windowId: user.id });
  try {
    await assert.rejects(send({ id: 4, method: 'chrome.tabs.create', params: [{ url: 'about:blank' }] }), /outside its lane/);
  } finally {
    chrome.tabs.create = originalCreate;
  }
  const stray = fake.log.createdTabs.at(-1);
  assert.ok(stray, 'stray creation was not attempted');
  assert.equal(fake.windowTabs(user.id).length, 1, 'stray tab was not removed from the user window');

  await assert.rejects(send({ id: 5, method: 'chrome.tabs.remove', params: [anchor.id] }), /does not own/);
  assert.ok(fake.tabs.has(anchor.id), 'anchor was removed');

  // A page popup from an owned opener inside the lane is adopted.
  await connection._notifyTabAttached(sessionTab.id);
  const popup = fake.addTab(lane.id, { openerTabId: sessionTab.id, url: 'https://example.com/popup' });
  await sleep(5);
  assert.ok(connection.ownedTabIds.has(popup.id), 'in-lane page popup was not adopted');
  assert.ok(!fake.log.movedTabs.some(([tabId]) => tabId === popup.id), 'adopted popup was evicted');

  // A page popup materialised as a separate window is removed and the session fails closed.
  const spillWindow = fake.addWindow({ type: 'popup', url: 'about:blank' });
  const spillTab = fake.windowTabs(spillWindow.id)[0];
  fake.tabs.get(spillTab.id).openerTabId = sessionTab.id;
  fake.events.tabsCreated.emit({ ...spillTab, openerTabId: sessionTab.id });
  await sleep(5);
  assert.ok(fake.log.removedTabs.includes(spillTab.id), 'spill popup tab was not removed');
  assert.equal(ws.closes.at(-1)?.[1], 'Page popup opened outside its private agent lane');

  // Reclaimed lanes reject every command.
  const reclaimedWs = socket();
  const reclaimed = new RelayConnection(reclaimedWs);
  reclaimed.setLane({
    sessionId: 8, windowId: lane.id, anchorTabId: anchor.id, stage,
    beginTabCreation() {}, endTabCreation() {},
    isBackgrounded: async () => ({ ok: false, diagnostic: 'focused=true' }),
  });
  guard.beginTabCreation();
  const reclaimedTab = fake.addTab(lane.id, { active: false });
  guard.endTabCreation(reclaimedTab.id);
  reclaimed.markOwnedTab(reclaimedTab.id);
  await assert.rejects(reclaimed._handleCommand(command(reclaimedTab.id, 'Runtime.evaluate')), /no longer safely backgrounded/);
  assert.equal(reclaimed.workspaceReclaimed, true, 'command against a taken lane did not latch reclaim');
  assert.match(reclaimedWs.closes.at(-1)?.[1] ?? '', /no longer safely backgrounded/);

  assert.deepEqual(reclaimReasons, [], 'relay activity reclaimed the lane');
  guard.dispose();
  stage.dispose();
}

async function testGuard() {
  const user = fake.addWindow({ type: 'normal', url: 'https://example.com/work' }, { focus: true });
  let laneId;
  const tracker = new UserWindowTracker(windowId => windowId === laneId);
  await sleep(5);
  const lane = fake.addWindow({ type: 'normal', url: marker('guard') });
  laneId = lane.id;
  const anchor = fake.windowTabs(lane.id)[0];
  assert.equal(tracker.lastUserWindowId, user.id, 'tracker did not capture the focused user window');
  fake.focusWindow(lane.id);
  await sleep(5);
  assert.equal(tracker.lastUserWindowId, user.id, 'tracker recorded a lane as a user window');
  fake.focusWindow(user.id);

  const ownedTab = fake.addTab(lane.id, { active: false });
  const owned = new Set([ownedTab.id]);
  const reclaims = [];
  const activeChanges = [];
  const guard = new LaneGuard(lane.id, anchor.id, {
    isOwnedTab: tabId => owned.has(tabId),
    isLaneWindow: windowId => windowId === lane.id,
    lastUserWindowId: () => tracker.lastUserWindowId,
    onActiveTabChanged: tabId => activeChanges.push(tabId),
    onReclaimed: reason => reclaims.push(reason),
  });

  // Chrome routed an external link into the lane: it is handed back to the
  // user's window and the transient lane focus is not a reclaim.
  const focusBefore = fake.log.focusUpdates.length;
  const foreign = fake.openExternalLink(lane.id, 'https://example.com/from-mail');
  await sleep(20);
  assert.equal(fake.tabs.get(foreign.id).windowId, user.id, 'foreign tab was not evicted to the user window');
  assert.ok(fake.tabs.get(foreign.id).active, 'evicted tab was not activated for the user');
  assert.deepEqual(fake.log.focusUpdates.slice(focusBefore), [user.id], 'focus was not returned to the user window');
  assert.equal(fake.focusedWindowId, user.id);
  await sleep(EVICTION_GRACE_MS + 100);
  assert.deepEqual(reclaims, [], 'link hand-back was treated as user reclaim');
  assert.ok(fake.tabs.has(ownedTab.id), 'eviction touched an owned tab');

  // A foreign tab that arrives in the background (no Chrome focus change) is
  // moved quietly: nothing is activated or focused.
  const quietFocusBefore = fake.log.focusUpdates.length;
  const quietActivationsBefore = fake.log.activations.length;
  const quiet = fake.addTab(lane.id, { url: 'https://example.com/background-arrival', active: false });
  await sleep(20);
  assert.equal(fake.tabs.get(quiet.id).windowId, user.id, 'background foreign tab was not moved to the user window');
  assert.equal(fake.log.focusUpdates.length, quietFocusBefore, 'quiet eviction focused a window');
  assert.equal(fake.log.activations.filter(([windowId]) => windowId === user.id).length,
      fake.log.activations.slice(0, quietActivationsBefore).filter(([windowId]) => windowId === user.id).length,
      'quiet eviction activated a tab in the user window');

  // Relay-created tabs and owned-opener popups are never evicted, even when a
  // foreign tab arrives while the relay creation is outstanding: classification
  // waits for the exact created tab ID.
  guard.beginTabCreation();
  const interloper = fake.addTab(lane.id, { url: 'https://example.com/interloper', active: false });
  const ours = fake.addTab(lane.id, { active: false });
  await sleep(5);
  assert.equal(fake.tabs.get(interloper.id).windowId, lane.id, 'classification ran before the creation resolved');
  guard.endTabCreation(ours.id);
  await sleep(20);
  assert.equal(fake.tabs.get(ours.id).windowId, lane.id, 'relay-created tab was evicted');
  assert.equal(fake.tabs.get(interloper.id).windowId, user.id, 'foreign tab consumed the relay tab\'s creation bracket');
  const popup = fake.addTab(lane.id, { openerTabId: ownedTab.id });
  await sleep(5);
  assert.equal(fake.tabs.get(popup.id).windowId, lane.id, 'owned-opener popup was evicted');
  assert.ok(activeChanges.includes(popup.id), 'foreground popup activation was not reported to the stage');

  // Chrome may activate the lane before it creates the delivered tab. That
  // ordering must also read as a hand-back, not a reclaim.
  await sleep(EVICTION_GRACE_MS + 100);
  const orderFocusBefore = fake.log.focusUpdates.length;
  fake.focusWindow(lane.id);
  await sleep(FOCUS_SETTLE_MS / 2);
  const lateArrival = fake.addTab(lane.id, { url: 'https://example.com/late-arrival', active: true });
  await sleep(FOCUS_SETTLE_MS + 50);
  assert.equal(fake.tabs.get(lateArrival.id).windowId, user.id, 'focus-first external link was not evicted');
  assert.deepEqual(fake.log.focusUpdates.slice(orderFocusBefore), [user.id], 'focus-first hand-back did not return focus');
  await sleep(EVICTION_GRACE_MS + 100);
  assert.deepEqual(reclaims, [], 'focus-first external link was treated as user reclaim');

  // An adopted page popup that made the lane Chrome's key window hands focus
  // back to the user's window instead of reclaiming the lane.
  await sleep(EVICTION_GRACE_MS + 100);
  const popupFocusBefore = fake.log.focusUpdates.length;
  const popup2 = fake.addTab(lane.id, { openerTabId: ownedTab.id, url: 'https://example.com/popup-2' });
  fake.focusWindow(lane.id);
  await sleep(FOCUS_SETTLE_MS / 2);
  assert.deepEqual(fake.log.focusUpdates.slice(popupFocusBefore), [user.id], 'popup focus was not handed back to the user window');
  assert.equal(fake.focusedWindowId, user.id);
  await sleep(EVICTION_GRACE_MS + 200);
  assert.deepEqual(reclaims, [], 'adopted popup focus was treated as user reclaim');
  assert.equal(fake.tabs.get(popup2.id).windowId, lane.id, 'adopted popup was evicted');

  // Plain user focus is a reclaim (once no eviction hand-back is in progress).
  await sleep(EVICTION_GRACE_MS + 100);
  fake.focusWindow(lane.id);
  await sleep(FOCUS_SETTLE_MS + 50);
  assert.equal(reclaims.length, 1, 'user focus did not reclaim the lane');
  assert.match(reclaims[0], /reclaimed/);
  fake.focusWindow(user.id);
  guard.dispose();

  // A tab the user drags into a lane is a reclaim.
  const lane4 = fake.addWindow({ type: 'normal', url: marker('guard-4') });
  const reclaims4 = [];
  const guard4 = new LaneGuard(lane4.id, fake.windowTabs(lane4.id)[0].id, {
    isOwnedTab: () => false, isLaneWindow: windowId => windowId === lane4.id, lastUserWindowId: () => user.id,
    onActiveTabChanged() {}, onReclaimed: reason => reclaims4.push(reason),
  });
  const dragged = fake.addTab(user.id, { url: 'https://example.com/dragged', active: false });
  await chrome.tabs.move(dragged.id, { windowId: lane4.id, index: -1 });
  await sleep(5);
  assert.deepEqual(reclaims4, ['Agent lane was reclaimed (user tab attached)']);
  assert.equal(fake.tabs.get(dragged.id).windowId, lane4.id, 'dragged-in user tab was evicted instead of reclaiming the lane');
  guard4.dispose();

  // Losing the anchor is a reclaim.
  const lane2 = fake.addWindow({ type: 'normal', url: marker('guard-2') });
  const anchor2 = fake.windowTabs(lane2.id)[0];
  fake.addTab(lane2.id, { active: false });
  const reclaims2 = [];
  const guard2 = new LaneGuard(lane2.id, anchor2.id, {
    isOwnedTab: () => false, isLaneWindow: windowId => windowId === lane2.id, lastUserWindowId: () => user.id,
    onActiveTabChanged() {}, onReclaimed: reason => reclaims2.push(reason),
  });
  await chrome.tabs.remove(anchor2.id);
  assert.deepEqual(reclaims2, ['Agent lane anchor was closed']);
  guard2.dispose();

  // A minimized lane is a reclaim; the guard must never re-focus it.
  const lane3 = fake.addWindow({ type: 'normal', url: marker('guard-3') });
  const reclaims3 = [];
  const guard3 = new LaneGuard(lane3.id, fake.windowTabs(lane3.id)[0].id, {
    isOwnedTab: () => false, isLaneWindow: windowId => windowId === lane3.id, lastUserWindowId: () => user.id,
    onActiveTabChanged() {}, onReclaimed: reason => reclaims3.push(reason),
  });
  await chrome.windows.update(lane3.id, { state: 'minimized' });
  assert.match(reclaims3[0] ?? '', /state=minimized/);
  guard3.dispose();
}

async function main() {
  process.on('unhandledRejection', error => { console.error('UNHANDLED', error?.stack ?? error); process.exit(1); });
  console.log('phase: stage');
  await testStage();
  console.log('phase: relay');
  await testRelay();
  console.log('phase: guard');
  await testGuard();
  console.log('Playwright extension relay/stage/guard tests passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
