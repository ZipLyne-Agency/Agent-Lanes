/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// PRINCIPLES: max-lines-exception — service module for browser lane lifecycle orchestration.

import { boundsWithin, findAgentDisplay, isWindowOnDisplay } from './agentDisplay';
import { cleanupStalePlaywrightGroups } from './connectedTabGroup';
import { debugLog } from './relayConnection';

export const LANE_STORAGE_PREFIX = 'playwrightLane:';
export const SESSION_STORAGE_PREFIX = 'playwrightAgentSession:';
// Retired 0.3.x record families. They are recognised only so the upgrade can
// discard their metadata and close their unclaimed popup windows.
const LEGACY_WORKSPACE_STORAGE_PREFIX = 'playwrightAgentWorkspace:';
const LEGACY_PARKED_STORAGE_PREFIX = 'playwrightParkedWorkspace:';

export const LANE_CAPACITY = 16;
export const MAX_LANES = 8;
// Lane window state. 'fullscreen' gives every lane its own macOS Space: it never
// shows on the user's desktop, is never raised when Chrome activates, and by
// Chromium's FindTabbedBrowser rule (current Space only) can never receive an
// external link. 'normal' keeps the corner-stacked desktop windows. Minimized is
// never allowed: it stops animation frames and trusted input.
export type LaneWindowState = 'normal' | 'fullscreen';
// Live result 2026-09-04 (0.4.3): a fullscreen lane reports focused=true for as
// long as it exists, even after the user's window is restored, so it can never
// satisfy the unfocused contract; 'fullscreen' stays available for experiments
// only. Corner-stacked normal windows are the working mode.
export const LANE_WINDOW_STATE: LaneWindowState = 'normal';

export type Lane = {
  windowId: number;
  windowType: 'normal';
  anchorTabId: number;
  poolKey: string;
  markerUrl: string;
  // The Chrome process the lane was recorded in. Window IDs are stable only
  // within one browser session, so a record may reclaim its window after an
  // extension reload only when this matches.
  browserSessionId?: string;
};

type PersistedLane = {
  windowId: number;
  windowType: 'normal';
  anchorTabId: number;
  markerUrl: string;
  browserSessionId?: string;
};

// What an anchor tab shows once the extension that rendered it reloads: Chrome
// swaps the dead extension page for a new-tab page and keeps the window.
const RELOAD_HUSK_URLS = new Set(['chrome://newtab/', 'chrome://new-tab-page/']);

export type PersistedSession = {
  browserSessionId: string;
  windowId: number;
  ownedTabIds: number[];
  anchorTabId: number;
  poolKey: string;
  markerUrl: string;
  windowType: 'normal';
};

export type LaneHealth = {
  healthy: boolean;
  window?: chrome.windows.Window;
  tabs: chrome.tabs.Tab[];
  diagnostic: string;
};

// Removes metadata that cannot be trusted after a service-worker or Chrome
// restart, and deletes only tabs that are provably ours.
export async function cleanupStaleState(browserSessionId: string): Promise<void> {
  const stored = await chrome.storage.local.get(null);
  for (const [key, value] of Object.entries(stored)) {
    if (key.startsWith(SESSION_STORAGE_PREFIX)) {
      await recoverSessionRecord(key, value, browserSessionId);
      continue;
    }
    if (key.startsWith(LEGACY_WORKSPACE_STORAGE_PREFIX)) {
      // 0.3.x active records described popup workspaces whose relay is gone.
      // Their numeric IDs prove too little after an upgrade; preserve every
      // tab and drop only the metadata.
      await chrome.storage.local.remove(key);
      continue;
    }
    if (key.startsWith(LEGACY_PARKED_STORAGE_PREFIX)) {
      await retireLegacyParkedWorkspace(value);
      await chrome.storage.local.remove(key);
      continue;
    }
  }
  await cleanupStalePlaywrightGroups();
}

async function recoverSessionRecord(key: string, value: unknown, browserSessionId: string): Promise<void> {
  if (!isPersistedSession(value) || value.browserSessionId !== browserSessionId) {
    // Chrome may reuse numeric IDs after a full restart and exposes no durable
    // per-tab ownership marker. Preserve restored tabs; forget the record.
    await chrome.storage.local.remove(key);
    return;
  }
  try {
    const [window, tabs] = await Promise.all([
      chrome.windows.get(value.windowId),
      chrome.tabs.query({ windowId: value.windowId }),
    ]);
    const currentIds = new Set(tabs.map(tab => tab.id).filter((id): id is number => id !== undefined));
    const anchorPresent = currentIds.has(value.anchorTabId);
    const owned = value.ownedTabIds.filter(tabId => currentIds.has(tabId) && tabId !== value.anchorTabId);
    // A relay that died with the worker cannot be resumed. Its task tabs are
    // removed only while the lane is still an unfocused normal agent window
    // whose anchor is intact; anything else is user-reclaimed and preserved.
    if (isBackgroundedLaneWindow(window) && anchorPresent && owned.length)
      await chrome.tabs.remove(owned);
  } catch {
    // Window gone: nothing to clean.
  }
  await chrome.storage.local.remove(key);
}

async function retireLegacyParkedWorkspace(value: unknown): Promise<void> {
  if (!value || typeof value !== 'object')
    return;
  const candidate = value as { markerUrl?: unknown };
  if (typeof candidate.markerUrl !== 'string')
    return;
  const tabs = await chrome.tabs.query({});
  const marker = tabs.find(tab => effectiveTabUrl(tab) === candidate.markerUrl);
  if (marker)
    await removeUnclaimedPopupMarkerWindow(marker).catch(() => {});
}

// Re-adopts lanes by their durable marker URL. Numeric window/tab IDs are
// refreshed; a lane is dropped only when its window is no longer an unfocused
// normal agent window or its anchor cannot be found after a tolerant retry.
export async function loadLanes(browserSessionId?: string): Promise<Lane[]> {
  const stored = await chrome.storage.local.get(null);
  let currentTabs = await chrome.tabs.query({});
  const lanes: Lane[] = [];
  const recordedMarkerUrls = new Set<string>();
  for (const [key, value] of Object.entries(stored)) {
    if (!key.startsWith(LANE_STORAGE_PREFIX))
      continue;
    if (!isPersistedLane(value)) {
      await chrome.storage.local.remove(key);
      continue;
    }
    recordedMarkerUrls.add(value.markerUrl);
    try {
      let markerTabs = currentTabs.filter(tab => effectiveTabUrl(tab) === value.markerUrl);
      // A service-worker restart can race the marker navigation commit. Retry
      // generously before discarding durable lane metadata; the 0.3.x pool lost
      // slots by giving up after 300 ms.
      for (let attempt = 0; markerTabs.length !== 1 && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        currentTabs = await chrome.tabs.query({});
        markerTabs = currentTabs.filter(tab => effectiveTabUrl(tab) === value.markerUrl);
      }
      const anchor = markerTabs.length === 1 ? markerTabs[0] : undefined;
      if (anchor?.id === undefined || anchor.windowId === undefined) {
        const revived = await reviveReloadHusk(key, value, browserSessionId);
        if (!revived)
          throw new Error('Lane marker is unavailable');
        lanes.push(revived);
        continue;
      }
      const [window, windowTabs] = await Promise.all([
        chrome.windows.get(anchor.windowId),
        chrome.tabs.query({ windowId: anchor.windowId }),
      ]);
      // Dead sessions' tabs were removed before this point. Anything else in
      // the window is ambiguous (a full Chrome restart restored it, or a
      // record was lost): preserve the window for the user and let the
      // preparer create a fresh lane instead of seating sessions beside it.
      if (!isBackgroundedLaneWindow(window) || !isAnchorOnly(windowTabs, anchor.id)) {
        await chrome.storage.local.remove(key);
        continue;
      }
      const recovered: Lane = {
        windowId: anchor.windowId,
        windowType: 'normal',
        anchorTabId: anchor.id,
        poolKey: key,
        markerUrl: value.markerUrl,
        browserSessionId,
      };
      lanes.push(recovered);
      if (value.windowId !== recovered.windowId || value.anchorTabId !== recovered.anchorTabId ||
          value.browserSessionId !== browserSessionId)
        await persistLane(recovered);
    } catch {
      await chrome.storage.local.remove(key);
    }
  }
  // A marker window without a record is still ours (its record was lost, or a
  // preparation was interrupted after the window appeared). Re-adopt it when it
  // is unambiguously an unfocused normal agent window; a popup marker belongs to
  // the retired 0.3.x pool and is removed only while unclaimed.
  for (const tab of currentTabs) {
    const markerUrl = effectiveTabUrl(tab);
    if (tab.id === undefined || tab.windowId === undefined || !markerUrl || recordedMarkerUrls.has(markerUrl))
      continue;
    if (isLaneMarkerUrl(markerUrl) && lanes.length < MAX_LANES) {
      const [window, windowTabs] = await Promise.all([
        chrome.windows.get(tab.windowId).catch(() => undefined),
        chrome.tabs.query({ windowId: tab.windowId }).catch(() => []),
      ]);
      if (window && isBackgroundedLaneWindow(window) && isAnchorOnly(windowTabs, tab.id) &&
          !lanes.some(lane => lane.windowId === tab.windowId)) {
        const adopted: Lane = {
          windowId: tab.windowId,
          windowType: 'normal',
          anchorTabId: tab.id,
          poolKey: `${LANE_STORAGE_PREFIX}${crypto.randomUUID()}`,
          markerUrl,
          browserSessionId,
        };
        await persistLane(adopted);
        lanes.push(adopted);
        recordedMarkerUrls.add(markerUrl);
      }
      continue;
    }
    if (isLegacyMarkerUrl(markerUrl))
      await removeUnclaimedPopupMarkerWindow(tab).catch(() => {});
  }
  // A husk whose record is gone (lost to a crash, or never written) is taken
  // back only on the agent display, where no user window lives.
  const agentDisplay = await findAgentDisplay();
  if (agentDisplay) {
    const windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }).catch(() => [] as chrome.windows.Window[]);
    for (const window of windows) {
      if (lanes.length >= MAX_LANES)
        break;
      const huskTabId = window.tabs?.[0]?.id;
      if (window.id === undefined || huskTabId === undefined || lanes.some(lane => lane.windowId === window.id) ||
          !isBackgroundedLaneWindow(window) || !isWindowOnDisplay(window, agentDisplay) || !isReloadHusk(window.tabs ?? []))
        continue;
      const lane = await reanchorHusk(window.id, huskTabId, `${LANE_STORAGE_PREFIX}${crypto.randomUUID()}`,
          chrome.runtime.getURL(`status.html#agent-lane=${crypto.randomUUID()}`), browserSessionId);
      if (lane)
        lanes.push(lane);
    }
  }
  return lanes;
}

function isReloadHusk(tabs: chrome.tabs.Tab[]): boolean {
  return tabs.length === 1 && tabs[0]?.id !== undefined && RELOAD_HUSK_URLS.has(effectiveTabUrl(tabs[0]!) ?? '');
}

// An extension reload replaces each anchor page with a new-tab page but keeps
// the lane window. A record may take its window back while that window is a
// backgrounded normal window holding nothing but the husk, and only when the
// record comes from this same Chrome process or the window sits on the agent
// display. After a Chrome restart numeric window IDs can point at a user's
// window, so an unproven record never touches a window the user can see.
async function reviveReloadHusk(poolKey: string, record: PersistedLane, browserSessionId: string | undefined): Promise<Lane | undefined> {
  const [window, tabs] = await Promise.all([
    chrome.windows.get(record.windowId).catch(() => undefined),
    chrome.tabs.query({ windowId: record.windowId }).catch(() => [] as chrome.tabs.Tab[]),
  ]);
  const huskTabId = tabs[0]?.id;
  if (!window || huskTabId === undefined || !isBackgroundedLaneWindow(window) || !isReloadHusk(tabs))
    return undefined;
  const sameBrowserSession = browserSessionId !== undefined && record.browserSessionId === browserSessionId;
  const agentDisplay = sameBrowserSession ? undefined : await findAgentDisplay();
  if (!sameBrowserSession && !(agentDisplay && isWindowOnDisplay(window, agentDisplay)))
    return undefined;
  return await reanchorHusk(record.windowId, huskTabId, poolKey, record.markerUrl, browserSessionId);
}

async function reanchorHusk(windowId: number, tabId: number, poolKey: string, markerUrl: string, browserSessionId: string | undefined): Promise<Lane | undefined> {
  await chrome.tabs.update(tabId, { url: markerUrl, autoDiscardable: false }).catch(() => undefined);
  const anchorTabId = await waitForStableLane(windowId, tabId, markerUrl).catch(() => undefined);
  if (anchorTabId === undefined)
    return undefined;
  const lane: Lane = { windowId, windowType: 'normal', anchorTabId, poolKey, markerUrl, browserSessionId };
  await persistLane(lane);
  debugLog(`Re-anchored lane ${windowId} after an extension reload`);
  return lane;
}

export async function laneHealth(lane: Lane): Promise<LaneHealth> {
  try {
    const [window, anchor, tabs] = await Promise.all([
      chrome.windows.get(lane.windowId),
      chrome.tabs.get(lane.anchorTabId),
      chrome.tabs.query({ windowId: lane.windowId }),
    ]);
    const anchorUrl = effectiveTabUrl(anchor);
    const backgrounded = await isLaneWindowInService(window);
    const anchored = anchor.windowId === lane.windowId && anchorUrl === lane.markerUrl;
    return {
      healthy: backgrounded && anchored,
      window,
      tabs,
      diagnostic: `type=${window.type};state=${window.state};focused=${Boolean(window.focused)};anchored=${anchored}`,
    };
  } catch {
    return { healthy: false, tabs: [], diagnostic: 'type=missing;state=missing;focused=unknown' };
  }
}

// Creates one task tab for a session inside its lane. Background creation adds
// a NEW_BACKGROUND_TAB with no window show/activate action, so the lane, Chrome,
// and the macOS Space stay exactly where they were.
export async function createSessionTab(lane: Lane): Promise<chrome.tabs.Tab & { id: number }> {
  const created = await chrome.tabs.create({
    windowId: lane.windowId,
    url: 'about:blank',
    active: false,
  });
  if (created?.id === undefined)
    throw new Error('Chrome did not create an agent session tab');
  if (created.windowId !== lane.windowId) {
    await chrome.tabs.remove(created.id).catch(() => {});
    throw new Error('Chrome created the agent session tab outside its lane');
  }
  const updated = await chrome.tabs.update(created.id, { autoDiscardable: false });
  return (updated ?? created) as chrome.tabs.Tab & { id: number };
}

export async function persistLane(lane: Lane): Promise<void> {
  await chrome.storage.local.set({
    [lane.poolKey]: {
      windowId: lane.windowId,
      windowType: 'normal',
      anchorTabId: lane.anchorTabId,
      markerUrl: lane.markerUrl,
      ...(lane.browserSessionId ? { browserSessionId: lane.browserSessionId } : {}),
    } satisfies PersistedLane,
  });
}

// Lanes belong on the agent display whenever it exists: after it first
// appears, and again when it returns after its helper restarted (macOS moves a
// vanished display's windows onto a real one). Only a lane that is still a
// backgrounded normal window is moved. Moving changes bounds alone, never
// focus or state, and the lane guard treats a pure move as harmless.
export async function moveLanesToAgentDisplay(lanes: Lane[]): Promise<number> {
  const agentDisplay = await findAgentDisplay();
  if (!agentDisplay)
    return 0;
  const bounds = boundsWithin(agentDisplay, LANE_WIDTH, LANE_HEIGHT);
  let moved = 0;
  for (const lane of lanes) {
    const window = await chrome.windows.get(lane.windowId).catch(() => undefined);
    if (!isBackgroundedLaneWindow(window) || isWindowOnDisplay(window, agentDisplay))
      continue;
    await chrome.windows.update(lane.windowId, bounds).then(() => moved++, () => {});
  }
  return moved;
}

// A lane on the agent display cannot be seen, so it cannot be the user's.
export async function isLaneOnAgentDisplay(windowId: number): Promise<boolean> {
  const agentDisplay = await findAgentDisplay();
  if (!agentDisplay)
    return false;
  return isWindowOnDisplay(await chrome.windows.get(windowId).catch(() => undefined), agentDisplay);
}

// PROTECTED POOL INVARIANT: ordinary agent connections never call this path.
// Only the explicit pool preparer may create missing lanes. With Chrome in
// front it creates them and restores the exact normal user window/tab. With
// another app in front it may create them only on the agent display, and only
// when the native bridge asks for background preparation; the bridge watches
// the frontmost app during that request and permanently disables background
// preparation the first time Chrome comes forward (see
// playwright-mcp-native-bridge). Sessions scale by creating background tabs
// inside existing lanes, which is silent; do not replace lanes with per-task
// window creation.
export const LANE_WIDTH = 900;
export const LANE_HEIGHT = 700;

// Fallback position when the agent display is absent. All lanes share one
// position: stacked exactly on top of each other in the bottom-right corner of
// the user's window, they read as a single small window instead of a cascade.
// Rendering is unaffected because regular Chrome runs with
// --disable-backgrounding-occluded-windows.
export function laneBounds(userWindow: chrome.windows.Window): { left: number; top: number; width: number; height: number } {
  const left = (userWindow.left ?? 0) + Math.max(0, (userWindow.width ?? LANE_WIDTH) - LANE_WIDTH);
  const top = (userWindow.top ?? 0) + Math.max(0, (userWindow.height ?? LANE_HEIGHT) - LANE_HEIGHT);
  return { left, top, width: LANE_WIDTH, height: LANE_HEIGHT };
}

export function laneWindowState(): LaneWindowState {
  return LANE_WINDOW_STATE;
}

export type PreparePoolOptions = {
  // A lane that hosts live sessions, or that Chrome momentarily focused to
  // deliver a link the guard is handing back, is kept even when unhealthy.
  isVouchedFor?: (lane: Lane) => boolean;
  // Set only by the background preparer once a live check has proved that
  // creating a window on the agent display leaves the frontmost app alone.
  allowBackground?: boolean;
  browserSessionId?: string;
};

export async function prepareLanePool(pool: Lane[], targetCapacity: number, options: PreparePoolOptions = {}): Promise<number> {
  if (!Number.isInteger(targetCapacity) || targetCapacity < 1 || targetCapacity > MAX_LANES)
    throw new Error('Agent lane pool capacity is invalid');
  const isVouchedFor = options.isVouchedFor ?? (() => false);
  const valid: Lane[] = [];
  for (const lane of pool) {
    // Preparation must never end sessions or orphan a lane over a transient
    // observation.
    if (isVouchedFor(lane) || (await laneHealth(lane)).healthy)
      valid.push(lane);
    else
      await chrome.storage.local.remove(lane.poolKey).catch(() => {});
  }
  pool.splice(0, pool.length, ...valid);
  await adoptUnpooledLanes(pool, targetCapacity, options.browserSessionId);
  if (pool.length >= targetCapacity)
    return 0;
  const agentDisplay = await findAgentDisplay();
  const userWindow = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] }).catch(() => undefined);
  const userTab = userWindow?.tabs?.find(tab => tab.active);
  const foreground = userWindow?.id !== undefined && userWindow.type === 'normal' && !!userWindow.focused &&
    userTab?.id !== undefined && !pool.some(lane => lane.windowId === userWindow.id);
  const background = !foreground && !!options.allowBackground && !!agentDisplay;
  if (!foreground && !background)
    throw new Error('Regular Chrome must be foreground on its normal user window during one-time pool preparation');
  const created: Lane[] = [];
  try {
    const bounds = agentDisplay ? boundsWithin(agentDisplay, LANE_WIDTH, LANE_HEIGHT) : laneBounds(userWindow!);
    // In the background nobody is using Chrome, so there is no selection to
    // restore; the preparer's own check is that the frontmost app never moved.
    const restore = foreground ? { windowId: userWindow!.id!, tabId: userTab!.id! } : undefined;
    while (pool.length < targetCapacity) {
      const lane = await provisionLane(pool.length, bounds, restore, options.browserSessionId);
      created.push(lane);
      await persistLane(lane);
      pool.push(lane);
    }
    if (created.length && restore)
      await restoreUserSelection(restore.windowId, restore.tabId);
    return created.length;
  } catch (error) {
    // These windows were created by this exact management request and have
    // never hosted a session. Roll all of them back if user-window restoration
    // or any lane creation fails; previously parked/user windows are untouched.
    for (const lane of created) {
      const index = pool.findIndex(candidate => candidate.poolKey === lane.poolKey);
      if (index >= 0)
        pool.splice(index, 1);
      await chrome.storage.local.remove(lane.poolKey).catch(() => {});
      await chrome.windows.remove(lane.windowId).catch(() => {});
    }
    throw error;
  }
}

// A lane window left out of the pool while it still shows nothing but its live
// marker is unclaimed (a crash restored it beside tabs that have since closed,
// or its record was dropped). Taking it back needs no new window. Reclaimed
// lanes carry a tombstone marker and are never matched here.
async function adoptUnpooledLanes(pool: Lane[], targetCapacity: number, browserSessionId?: string): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]);
  for (const tab of tabs) {
    if (pool.length >= targetCapacity)
      return;
    const markerUrl = tab.url;
    if (tab.id === undefined || tab.windowId === undefined || !markerUrl || !isLaneMarkerUrl(markerUrl) ||
        pool.some(lane => lane.windowId === tab.windowId || lane.markerUrl === markerUrl))
      continue;
    const [window, windowTabs] = await Promise.all([
      chrome.windows.get(tab.windowId).catch(() => undefined),
      chrome.tabs.query({ windowId: tab.windowId }).catch(() => [] as chrome.tabs.Tab[]),
    ]);
    if (!isBackgroundedLaneWindow(window) || !isAnchorOnly(windowTabs, tab.id))
      continue;
    const stored = await chrome.storage.local.get(null);
    const staleKeys = Object.entries(stored)
        .filter(([key, value]) => key.startsWith(LANE_STORAGE_PREFIX) && (value as Partial<PersistedLane>)?.markerUrl === markerUrl)
        .map(([key]) => key);
    if (staleKeys.length)
      await chrome.storage.local.remove(staleKeys);
    const lane: Lane = {
      windowId: tab.windowId,
      windowType: 'normal',
      anchorTabId: tab.id,
      poolKey: `${LANE_STORAGE_PREFIX}${crypto.randomUUID()}`,
      markerUrl,
      browserSessionId,
    };
    await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => undefined);
    await persistLane(lane);
    pool.push(lane);
    debugLog(`Adopted unpooled lane ${tab.windowId}`);
  }
}

async function restoreUserSelection(windowId: number, tabId: number): Promise<void> {
  await chrome.tabs.update(tabId, { active: true });
  await chrome.windows.update(windowId, { focused: true });
  for (let attempt = 0; attempt < 50; attempt++) {
    const selected = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    if (selected.id === windowId && selected.focused && selected.tabs?.some(tab => tab.id === tabId && tab.active))
      return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Chrome did not restore the normal user window after pool preparation');
}

// Removes lanes that hold nothing but their anchor. A lane with any other tab
// or a changed window state is user-visible content and is preserved.
export async function discardLanes(pool: Lane[], sessionCount: (lane: Lane) => number): Promise<{ removed: number; preserved: number }> {
  let removed = 0;
  let preserved = 0;
  for (const lane of [...pool]) {
    await chrome.storage.local.remove(lane.poolKey).catch(() => {});
    const health = await laneHealth(lane);
    const anchorOnly = health.tabs.length === 1 && health.tabs[0]?.id === lane.anchorTabId;
    if (health.healthy && anchorOnly && sessionCount(lane) === 0) {
      await chrome.windows.remove(lane.windowId).catch(() => {});
      removed++;
    } else {
      preserved++;
    }
  }
  pool.splice(0, pool.length);
  return { removed, preserved };
}

async function removeUnclaimedPopupMarkerWindow(tab: chrome.tabs.Tab): Promise<boolean> {
  const markerUrl = effectiveTabUrl(tab);
  if (tab.id === undefined || tab.windowId === undefined || !markerUrl || !isLegacyMarkerUrl(markerUrl))
    return false;
  const [window, tabs] = await Promise.all([
    chrome.windows.get(tab.windowId),
    chrome.tabs.query({ windowId: tab.windowId }),
  ]);
  if (window.type !== 'popup' || window.state !== 'normal' || window.focused ||
      tabs.length !== 1 || tabs[0]?.id !== tab.id || effectiveTabUrl(tabs[0]!) !== markerUrl)
    return false;
  await chrome.windows.remove(tab.windowId);
  return true;
}

function isAnchorOnly(tabs: chrome.tabs.Tab[], anchorTabId: number): boolean {
  return tabs.length === 1 && tabs[0]?.id === anchorTabId;
}

export function effectiveTabUrl(tab: chrome.tabs.Tab): string | undefined {
  return tab.url ?? tab.pendingUrl;
}

// PROTECTED INPUT/FOCUS INVARIANT: a lane must remain normal-type, `normal`
// state, and `focused: false`. Do not minimize it: minimized Chrome windows stop
// producing requestAnimationFrame callbacks and reject trusted CDP mouse/keyboard
// input, which makes Playwright actions appear to hang. Normal type is required
// because popup windows cannot hold a second tab (Chromium retargets every
// navigation into a tabbed browser); external-link containment for normal-type
// lanes is handled by laneGuard.ts eviction plus never activating a lane. Any
// lifecycle change must pass tests/live_browser_background_acceptance.py,
// including trusted input, front-app/window selection, macOS Space, and
// browser_close cleanup assertions. macOS can also occlude a normal unfocused
// window when another app fully covers it, so regular Chrome must retain
// --disable-backgrounding-occluded-windows; browser-mcp-server attests that
// process-level invariant before connecting.
export function isBackgroundedLaneWindow(window: chrome.windows.Window | undefined): boolean {
  return !!window && window.type === 'normal' && (window.state === 'normal' || window.state === 'fullscreen') && !window.focused;
}

// A lane can serve sessions when it is a backgrounded lane window, or when it is
// a normal lane on the invisible agent display that macOS happened to focus
// (a Space switch, Cmd-`). Nobody can see or use a hidden lane, so focus there
// is not the user taking it; it passes as soon as the user clicks elsewhere.
export async function isLaneWindowInService(window: chrome.windows.Window | undefined): Promise<boolean> {
  if (isBackgroundedLaneWindow(window))
    return true;
  if (!window || window.type !== 'normal' || window.state !== 'normal')
    return false;
  const agentDisplay = await findAgentDisplay();
  return !!agentDisplay && isWindowOnDisplay(window, agentDisplay);
}

function isPersistedLane(value: unknown): value is PersistedLane {
  if (!value || typeof value !== 'object')
    return false;
  const candidate = value as Partial<PersistedLane>;
  return Number.isInteger(candidate.windowId) && Number.isInteger(candidate.anchorTabId) &&
    candidate.windowType === 'normal' &&
    typeof candidate.markerUrl === 'string' && isLaneMarkerUrl(candidate.markerUrl) &&
    (candidate.browserSessionId === undefined ||
      (typeof candidate.browserSessionId === 'string' && /^[a-f0-9]{64}$/.test(candidate.browserSessionId)));
}

export function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== 'object')
    return false;
  const candidate = value as Partial<PersistedSession>;
  return typeof candidate.browserSessionId === 'string' && /^[a-f0-9]{64}$/.test(candidate.browserSessionId) &&
    Number.isInteger(candidate.windowId) && Number.isInteger(candidate.anchorTabId) && Array.isArray(candidate.ownedTabIds) &&
    candidate.ownedTabIds.every(tabId => Number.isInteger(tabId)) &&
    typeof candidate.poolKey === 'string' && candidate.poolKey.startsWith(LANE_STORAGE_PREFIX) && candidate.poolKey.length <= 256 &&
    typeof candidate.markerUrl === 'string' && isLaneMarkerUrl(candidate.markerUrl) &&
    candidate.windowType === 'normal';
}

export function isLaneMarkerUrl(value: string): boolean {
  return value.startsWith(chrome.runtime.getURL('status.html#agent-lane='));
}

// A reclaimed lane belongs to the user. Its anchor is renavigated to a
// tombstone marker so no later worker start can mistake the window for an
// unclaimed lane, whatever tabs the user keeps or closes in it.
export async function tombstoneReclaimedLane(lane: Lane): Promise<void> {
  const tombstone = lane.markerUrl.replace('status.html#agent-lane=', 'status.html#agent-lane-reclaimed=');
  if (tombstone === lane.markerUrl)
    return;
  await chrome.tabs.update(lane.anchorTabId, { url: tombstone, autoDiscardable: true }).catch(() => {});
}

function isLegacyMarkerUrl(value: string): boolean {
  return value.startsWith(chrome.runtime.getURL('status.html#agent-popup-workspace=')) ||
    value.startsWith(chrome.runtime.getURL('status.html#agent-workspace='));
}

export async function provisionLane(slotOrdinal = 0, bounds?: { left: number; top: number; width: number; height: number }, restore?: { windowId: number; tabId: number }, browserSessionId?: string): Promise<Lane> {
  if (!Number.isInteger(slotOrdinal) || slotOrdinal < 0 || slotOrdinal >= MAX_LANES)
    throw new Error('Agent lane slot ordinal is invalid');
  const existingWindowIds = new Set((await chrome.windows.getAll()).map(window => window.id));
  const poolKey = `${LANE_STORAGE_PREFIX}${crypto.randomUUID()}`;
  const markerUrl = chrome.runtime.getURL(`status.html#agent-lane=${crypto.randomUUID()}`);
  let createdWindowId: number | undefined;
  try {
    const created = await chrome.windows.create({
      url: markerUrl,
      type: 'normal',
      // Create directly in the steady state. A minimized -> normal transition
      // promotes the window to Chrome's internal front window on macOS even
      // when focused:false is preserved. Explicit bounds prevent Chrome from
      // inheriting a maximized state; every lane uses the same bounds so the
      // pool shows as one small window in the corner of the user's window.
      state: 'normal',
      focused: false,
      left: bounds?.left ?? 96 + slotOrdinal * 36,
      top: bounds?.top ?? 72 + slotOrdinal * 28,
      width: bounds?.width ?? LANE_WIDTH,
      height: bounds?.height ?? LANE_HEIGHT,
    });
    if (created?.id === undefined || existingWindowIds.has(created.id))
      throw new Error('Chrome did not create a separate agent lane window');
    createdWindowId = created.id;
    const initialTabs = created.tabs?.length ? created.tabs : await chrome.tabs.query({ windowId: created.id });
    const anchorTabId = initialTabs[0]?.id;
    if (anchorTabId === undefined)
      throw new Error('Chrome did not create an agent lane anchor tab');
    await chrome.tabs.update(anchorTabId, { autoDiscardable: false });
    let anchor = await waitForStableLane(created.id, anchorTabId, markerUrl);
    if (LANE_WINDOW_STATE === 'fullscreen') {
      // Enter fullscreen only after the window is stable and unfocused. macOS
      // moves it into its own Space and keeps it key while that Space shows,
      // so the user's window is restored right away (which switches the
      // desktop back) and only then is the lane required to settle unfocused.
      // A lane that cannot settle in fullscreen falls back to a normal window
      // at the same bounds rather than failing the whole pool; status reports
      // each lane's actual state.
      try {
        await chrome.windows.update(created.id, { state: 'fullscreen' });
        await waitForWindowState(created.id, 'fullscreen');
        if (restore)
          await restoreUserSelection(restore.windowId, restore.tabId);
        anchor = await waitForStableLane(created.id, anchor, markerUrl, 'fullscreen');
      } catch (error) {
        debugLog(`Lane ${created.id} could not settle in fullscreen, falling back to a normal window: ${(error as Error).message}`);
        await chrome.windows.update(created.id, { state: 'normal', ...(bounds ?? {}) }).catch(() => {});
        await waitForWindowState(created.id, 'normal');
        if (restore)
          await restoreUserSelection(restore.windowId, restore.tabId);
        anchor = await waitForStableLane(created.id, anchor, markerUrl);
      }
    }
    return { windowId: created.id, windowType: 'normal', anchorTabId: anchor, poolKey, markerUrl, browserSessionId };
  } catch (error) {
    if (createdWindowId !== undefined)
      await chrome.windows.remove(createdWindowId).catch(() => {});
    throw error;
  }
}

async function waitForWindowState(windowId: number, state: LaneWindowState): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const window = await chrome.windows.get(windowId);
    if (window.state === state)
      return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not enter the ${state} window state for the agent lane`);
}

// Resolves when the lane has been observed stable three times in a row and
// returns the anchor tab ID, re-resolved by marker URL on every read so a tab
// Chrome replaced during a state transition is still recognised.
async function waitForStableLane(windowId: number, anchorTabId: number, expectedUrl: string, expectedState: LaneWindowState = 'normal'): Promise<number> {
  let stableObservations = 0;
  let lastObservation = 'unobserved';
  let resolvedAnchor = anchorTabId;
  for (let attempt = 0; attempt < 100; attempt++) {
    const [window, tabs] = await Promise.all([
      chrome.windows.get(windowId),
      chrome.tabs.query({ windowId }),
    ]);
    // chrome.tabs.update/windows.create resolve before navigation commits; judge
    // only the committed url, never the returned snapshot.
    const marker = tabs.find(tab => tab.url === expectedUrl);
    const stable = isBackgroundedLaneWindow(window) && window.state === expectedState &&
      tabs.length === 1 && marker?.id !== undefined;
    lastObservation = `type=${window.type},state=${window.state},focused=${Boolean(window.focused)},` +
      `tabCount=${tabs.length},marker=${marker?.id ?? 'none'},expectedAnchor=${anchorTabId},tabs=${tabs.map(tab => `${tab.id}:${(tab.url ?? tab.pendingUrl ?? '').slice(0, 40)}`).join('|')}`;
    if (stable && marker?.id !== undefined)
      resolvedAnchor = marker.id;
    stableObservations = stable ? stableObservations + 1 : 0;
    if (stableObservations === 3)
      return resolvedAnchor;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Chrome did not stabilize the agent lane (${lastObservation})`);
}
