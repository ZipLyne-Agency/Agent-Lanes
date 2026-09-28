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

// PRINCIPLES: max-lines-exception — service worker entry that owns lane runtimes and connections.

import { debugLog } from './relayConnection';
import { openRelayConnection, PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, isNonDebuggableUrl, ungroupTabs, uniqueGroupStyle } from './connectedTabGroup';
import { isNativeConnectMessage, isNativeDiscardPoolMessage, isNativePreparePoolMessage, isNativeReadyMessage, isNativeStatusMessage } from './nativeProtocol';
import { cleanupStaleState, createSessionTab, discardLanes, isLaneMarkerUrl, isLaneOnAgentDisplay, Lane, LANE_CAPACITY, laneHealth, laneWindowState, loadLanes, moveLanesToAgentDisplay, prepareLanePool, SESSION_STORAGE_PREFIX, tombstoneReclaimedLane } from './workspaceLifecycle';
import { findAgentDisplay, onDisplayChanged, returnStrayWindows } from './agentDisplay';
import { LaneStage } from './laneStage';
import { LaneGuard, UserWindowTracker } from './laneGuard';

// Chrome fires onDisplayChanged several times while macOS settles an
// arrangement, and a new window reports its final bounds a moment after
// onCreated; placement waits for both to settle.
const PLACEMENT_SETTLE_MS = 750;

const NATIVE_HOST_NAME = 'agency.ziplyne.agent_lanes';
export const CAPACITY_WAIT_MS = 60000;

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  connectionId: number;
} | {
  type: 'keepalive';
};

type LaneRuntime = {
  lane: Lane;
  stage: LaneStage;
  guard: LaneGuard;
  sessions: Set<number>;
  dropped: boolean;
};

export class PlaywrightExtension {
  private _connections = new Map<number, ConnectedTabGroup>();
  private _lastConnectionId = 0;
  private _pendingConnections = new PendingConnections();
  private _nativePort: chrome.runtime.Port | undefined;
  private _nativeReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _browserSessionId: string | undefined;
  private _lastDiagnostic: string | undefined;
  private _resolveBrowserSession!: (browserSessionId: string) => void;
  private _browserSessionPromise: Promise<string>;
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;
  private _workspacePoolPromise: Promise<Lane[]>;
  private _workspaceManagement: Promise<void> = Promise.resolve();
  private _laneRuntimes = new Map<number, LaneRuntime>();
  private _reclaimedWindowIds = new Set<number>();
  private _capacityWaiters: Array<() => void> = [];
  private _userWindows: UserWindowTracker;
  private _placementTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    this._browserSessionPromise = new Promise(resolve => this._resolveBrowserSession = resolve);
    // Registering this event is load-bearing even though connection setup happens
    // in the constructor. Chrome only wakes an idle MV3 service worker after a
    // browser restart for events it has registered. Without onStartup, the native
    // host can remain absent until some unrelated extension UI wakes the worker,
    // which makes the first authenticated Playwright command appear to hang.
    chrome.runtime.onStartup.addListener(() => {});
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    this._userWindows = new UserWindowTracker(windowId => this._laneRuntimes.has(windowId));
    this._cleanupPromise = this._browserSessionPromise.then(browserSessionId => cleanupStaleState(browserSessionId));
    this._workspacePoolPromise = this._cleanupPromise.then(() => loadLanes(this._browserSessionId)).then(lanes => {
      for (const lane of lanes)
        this._ensureLaneRuntime(lane);
      return lanes;
    });
    void this._workspacePoolPromise.then(() => this._schedulePlacement(0));
    onDisplayChanged(() => this._schedulePlacement());
    chrome.windows.onCreated?.addListener(() => this._schedulePlacement());
    this._connectNativeHost();
  }

  // Keeps lanes on the invisible agent display and everything else off it.
  // Runs after load, when displays change, and when any window appears.
  private _schedulePlacement(delayMs = PLACEMENT_SETTLE_MS): void {
    if (this._placementTimer !== undefined)
      clearTimeout(this._placementTimer);
    this._placementTimer = setTimeout(() => {
      this._placementTimer = undefined;
      void this._placeWindows().catch(error => debugLog('Window placement failed:', error?.message));
    }, delayMs);
  }

  private async _placeWindows(): Promise<void> {
    await this._withWorkspaceManagement(async () => {
      const pool = await this._workspacePoolPromise;
      const moved = await moveLanesToAgentDisplay(pool);
      // Kept on the agent display: pooled lanes, and unpooled windows that hold
      // nothing but a live marker (a lane being provisioned, or a leftover the
      // preparer will adopt). A marker window with any other tab is preserved
      // for the user, so it has to come back where they can see it.
      const returned = await returnStrayWindows(window => this._laneRuntimes.has(window.id!) ||
        ((window.tabs ?? []).length === 1 && isLaneMarkerUrl(window.tabs![0]!.url ?? window.tabs![0]!.pendingUrl ?? '')));
      if (moved || returned)
        debugLog(`Placed windows: ${moved} lane(s) to the agent display, ${returned} window(s) back to the user`);
    });
  }

  private _connectNativeHost(): void {
    if (this._nativeReconnectTimer !== undefined)
      clearTimeout(this._nativeReconnectTimer);
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    this._nativePort = port;
    port.onMessage.addListener(message => {
      void this._onNativeHostMessage(port, message);
    });
    port.onDisconnect.addListener(() => {
      if (this._nativePort !== port)
        return;
      this._nativePort = undefined;
      this._nativeReconnectTimer = setTimeout(() => this._connectNativeHost(), 1000);
    });
  }

  private async _onNativeHostMessage(port: chrome.runtime.Port, message: unknown): Promise<void> {
    if (isNativeReadyMessage(message)) {
      if (this._browserSessionId === undefined) {
        this._browserSessionId = message.browserSessionId;
        this._resolveBrowserSession(message.browserSessionId);
      }
      return;
    }
    if (isNativeStatusMessage(message)) {
      port.postMessage({
        type: 'statusResult',
        requestId: message.requestId,
        ok: true,
        ...(await this._status()),
        ...(this._lastDiagnostic ? { diagnostic: this._lastDiagnostic } : {}),
      });
      return;
    }
    if (isNativePreparePoolMessage(message)) {
      try {
        const result = await this._preparePool(message.targetCapacity, message.background === true);
        this._lastDiagnostic = undefined;
        port.postMessage({ type: 'preparePoolResult', requestId: message.requestId, ok: true, ...result });
      } catch (error: any) {
        this._lastDiagnostic = String(error?.message ?? 'unknown workspace preparation failure').slice(0, 256);
        port.postMessage({
          type: 'preparePoolResult',
          requestId: message.requestId,
          ok: false,
          diagnostic: this._lastDiagnostic,
        });
      }
      return;
    }
    if (isNativeDiscardPoolMessage(message)) {
      try {
        const result = await this._discardPool();
        this._lastDiagnostic = undefined;
        port.postMessage({ type: 'discardPoolResult', requestId: message.requestId, ok: true, ...result });
      } catch (error: any) {
        this._lastDiagnostic = String(error?.message ?? 'unknown workspace discard failure').slice(0, 256);
        port.postMessage({
          type: 'discardPoolResult',
          requestId: message.requestId,
          ok: false,
          diagnostic: this._lastDiagnostic,
        });
      }
      return;
    }
    if (!isNativeConnectMessage(message))
      return;
    try {
      await this._connectNative(message.relayUrl, message.clientName);
      this._lastDiagnostic = undefined;
      port.postMessage({ type: 'connectResult', requestId: message.requestId, ok: true });
    } catch (error: any) {
      this._lastDiagnostic = String(error?.message ?? 'unknown extension connection failure').slice(0, 256);
      debugLog('Native connection failed:', error.message);
      port.postMessage({ type: 'connectResult', requestId: message.requestId, ok: false });
    }
  }

  private async _status() {
    const lanes = await this._workspacePoolPromise;
    const laneDetails = await Promise.all(lanes.map(async lane => {
      const runtime = this._laneRuntimes.get(lane.windowId);
      try {
        const [window, tabs] = await Promise.all([
          chrome.windows.get(lane.windowId),
          chrome.tabs.query({ windowId: lane.windowId }),
        ]);
        return {
          windowId: lane.windowId,
          type: window.type,
          state: window.state,
          focused: window.focused,
          tabCount: tabs.length,
          sessionCount: runtime?.sessions.size ?? 0,
          capacity: LANE_CAPACITY,
        };
      } catch {
        return { windowId: lane.windowId, type: 'missing', state: 'missing', focused: null, tabCount: -1, sessionCount: runtime?.sessions.size ?? 0, capacity: LANE_CAPACITY };
      }
    }));
    const connections = await Promise.all([...this._connections].map(async ([id, group]) => {
      const windowId = group.workspaceWindowId();
      if (windowId === undefined)
        return { id, clientName: group.clientName, workspace: null };
      try {
        const [window, tabs] = await Promise.all([
          chrome.windows.get(windowId),
          chrome.tabs.query({ windowId }),
        ]);
        return {
          id,
          clientName: group.clientName,
          workspace: {
            windowId,
            type: window.type,
            state: window.state,
            focused: window.focused,
            left: window.left,
            top: window.top,
            width: window.width,
            height: window.height,
            tabCount: tabs.length,
            ownedTabCount: group.connectedTabIds().length,
          },
        };
      } catch {
        return { id, clientName: group.clientName, workspace: null };
      }
    }));
    const inUse = [...this._laneRuntimes.values()].reduce((sum, runtime) => sum + runtime.sessions.size, 0);
    const agentDisplay = await findAgentDisplay();
    return {
      connections,
      extensionVersion: chrome.runtime.getManifest?.().version,
      laneWindowState: laneWindowState(),
      agentDisplay: agentDisplay ? { present: true, lanesOnDisplay: (await Promise.all(lanes.map(lane => isLaneOnAgentDisplay(lane.windowId)))).filter(Boolean).length } : { present: false, lanesOnDisplay: 0 },
      // parkedWorkspace* names are retained for existing operator tooling; a
      // parked workspace is now a healthy lane with free capacity.
      parkedWorkspaceCount: lanes.length,
      parkedWorkspaceIds: lanes.map(lane => lane.windowId),
      parkedWorkspaces: laneDetails,
      capacity: { lanes: lanes.length, perLane: LANE_CAPACITY, total: lanes.length * LANE_CAPACITY, inUse },
    };
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        this._releaseConnectPage(selectorTabId).then(() => {
          this._pendingConnections.create(selectorTabId, message.mcpRelayUrl);
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // A token-bypassed connection intentionally has no selected tab. Give it
        // a private unfocused lane tab instead of attaching the connect page in
        // the user's foreground window.
        const selectedTab = message.tab as (chrome.tabs.Tab & { id: number }) | undefined;
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections].map(([id, group]) => ({
            id,
            clientName: group.clientName,
            connectedTabIds: group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        this._connections.get(message.connectionId)?.close('User disconnected');
        sendResponse({ success: true });
        return false;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: (chrome.tabs.Tab & { id: number }) | undefined, clientName: string | undefined): Promise<void> {
    try {
      await this._cleanupPromise;
      this._releaseTab(selectorTabId);
      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');
      await this._establishConnection(connection, tab, clientName, selectorTabId);
    } catch (error: any) {
      debugLog(`Failed to connect from selector tab ${selectorTabId}:`, error.message);
      throw error;
    }
  }

  private async _connectNative(relayUrl: string, clientName: string): Promise<void> {
    await this._cleanupPromise;
    const connection = await openRelayConnection(relayUrl);
    await this._establishConnection(connection, undefined, clientName);
  }

  private async _preparePool(targetCapacity: number, background = false): Promise<{ created: number; parkedWorkspaceCount: number; parkedWorkspaceIds: number[] }> {
    const result = await this._withWorkspaceManagement(async () => {
      const pool = await this._workspacePoolPromise;
      const before = new Set(pool.map(lane => lane.windowId));
      const created = await prepareLanePool(pool, targetCapacity, {
        isVouchedFor: lane => {
          const runtime = this._laneRuntimes.get(lane.windowId);
          return !!runtime && !runtime.guard.reclaimed && (runtime.sessions.size > 0 || runtime.guard.recentlyEvicted());
        },
        allowBackground: background,
        browserSessionId: this._browserSessionId,
      });
      for (const lane of pool) {
        if (!before.has(lane.windowId)) {
          this._reclaimedWindowIds.delete(lane.windowId);
          this._ensureLaneRuntime(lane);
        }
      }
      for (const [windowId, runtime] of [...this._laneRuntimes]) {
        if (!pool.some(lane => lane.windowId === windowId))
          this._dropLaneRuntime(runtime, 'Agent lane was removed during pool preparation');
      }
      this._notifyCapacity();
      return {
        created,
        parkedWorkspaceCount: pool.length,
        parkedWorkspaceIds: pool.map(lane => lane.windowId),
      };
    });
    this._schedulePlacement(0);
    return result;
  }

  private async _discardPool(): Promise<{ removed: number; preserved: number; parkedWorkspaceCount: number }> {
    return await this._withWorkspaceManagement(async () => {
      if (this._connections.size || [...this._laneRuntimes.values()].some(runtime => runtime.sessions.size))
        throw new Error('Pool discard requires no active browser connections');
      const pool = await this._workspacePoolPromise;
      const result = await discardLanes(pool, lane => this._laneRuntimes.get(lane.windowId)?.sessions.size ?? 0);
      for (const runtime of [...this._laneRuntimes.values()])
        this._dropLaneRuntime(runtime, 'Agent lane pool was discarded');
      return { ...result, parkedWorkspaceCount: pool.length };
    });
  }

  private _withWorkspaceManagement<T>(callback: () => Promise<T>): Promise<T> {
    const operation = this._workspaceManagement.then(callback);
    this._workspaceManagement = operation.then(() => {}, () => {});
    return operation;
  }

  private _ensureLaneRuntime(lane: Lane): LaneRuntime | undefined {
    const existing = this._laneRuntimes.get(lane.windowId);
    if (existing)
      return existing;
    if (this._reclaimedWindowIds.has(lane.windowId))
      return undefined;
    this._userWindows.forget(lane.windowId);
    const stage = new LaneStage(
        lane.windowId,
        () => this._laneRuntimes.has(lane.windowId) ? lane.anchorTabId : undefined,
        // A session whose command never completes is closed, never preempted;
        // closing it detaches its debugger, which ends the command and releases
        // the stage through the normal close path.
        sessionId => this._connections.get(sessionId)?.close('Agent session held its lane stage without completing a command and was closed'));
    const runtime: LaneRuntime = { lane, stage, sessions: new Set(), guard: undefined as unknown as LaneGuard, dropped: false };
    runtime.guard = new LaneGuard(lane.windowId, lane.anchorTabId, {
      isOwnedTab: tabId => [...runtime.sessions].some(id => this._connections.get(id)?.ownsTab(tabId) ?? false),
      isLaneWindow: windowId => this._laneRuntimes.has(windowId),
      lastUserWindowId: () => this._userWindows.lastUserWindowId,
      onActiveTabChanged: tabId => {
        stage.activeTabChanged(tabId);
        if (stage.holderSessionId !== undefined)
          void stage.reassertHolder();
      },
      onReclaimed: reason => void this._reclaimLane(runtime, reason),
      isHidden: () => isLaneOnAgentDisplay(lane.windowId),
    });
    this._laneRuntimes.set(lane.windowId, runtime);
    return runtime;
  }

  private _dropLaneRuntime(runtime: LaneRuntime, reason: string): void {
    runtime.dropped = true;
    for (const id of [...runtime.sessions])
      this._connections.get(id)?.markReclaimed(reason);
    runtime.stage.dispose();
    runtime.guard.dispose();
    this._laneRuntimes.delete(runtime.lane.windowId);
    this._notifyCapacity();
  }

  // The user took the lane (focus, state change, closed anchor). Every session
  // in it ends with its tabs preserved, and the lane leaves the pool so the
  // preparer can replace it at the next foreground moment.
  private async _reclaimLane(runtime: LaneRuntime, reason: string): Promise<void> {
    debugLog(`Lane ${runtime.lane.windowId} reclaimed: ${reason}`);
    // Mark synchronously so a concurrent lease can neither pick this lane nor
    // rebuild a runtime for it while the asynchronous bookkeeping runs.
    this._reclaimedWindowIds.add(runtime.lane.windowId);
    this._dropLaneRuntime(runtime, reason);
    await chrome.storage.local.remove(runtime.lane.poolKey).catch(() => {});
    await tombstoneReclaimedLane(runtime.lane);
    await this._withWorkspaceManagement(async () => {
      const pool = await this._workspacePoolPromise;
      const index = pool.findIndex(lane => lane.windowId === runtime.lane.windowId);
      if (index >= 0)
        pool.splice(index, 1);
    });
    this._notifyCapacity();
    // A reclaimed lane is the user's now; if it sits on the agent display the
    // placement pass brings it to a screen they can see.
    this._schedulePlacement(0);
  }

  private _notifyCapacity(): void {
    const waiters = this._capacityWaiters;
    this._capacityWaiters = [];
    for (const waiter of waiters)
      waiter();
  }

  private _waitForCapacity(deadline: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error('Authenticated browser pool is at capacity'));
        return;
      }
      const timer = setTimeout(() => {
        this._capacityWaiters = this._capacityWaiters.filter(waiter => waiter !== wake);
        reject(new Error('Authenticated browser pool is at capacity'));
      }, remaining);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      this._capacityWaiters.push(wake);
    });
  }

  // Picks the healthy lane with the most free capacity and reserves a session
  // slot in it. Unhealthy lanes leave the pool here; a full pool waits for a
  // session to end rather than failing the client immediately.
  private async _leaseLane(sessionId: number): Promise<LaneRuntime> {
    const deadline = Date.now() + CAPACITY_WAIT_MS;
    for (;;) {
      let transientSkip = false;
      const leased = await this._withWorkspaceManagement(async () => {
        const pool = await this._workspacePoolPromise;
        const candidates = pool
            .map(lane => this._ensureLaneRuntime(lane))
            .filter((runtime): runtime is LaneRuntime => !!runtime && runtime.sessions.size < LANE_CAPACITY && !runtime.guard.reclaimed)
            .sort((left, right) => left.sessions.size - right.sessions.size);
        for (const runtime of candidates) {
          const health = await laneHealth(runtime.lane);
          if (!health.healthy && runtime.guard.recentlyEvicted()) {
            transientSkip = true; // link hand-back in progress; retry shortly
            continue;
          }
          if (!health.healthy) {
            this._dropLaneRuntime(runtime, `Agent lane is unavailable (${health.diagnostic})`);
            await chrome.storage.local.remove(runtime.lane.poolKey).catch(() => {});
            const index = pool.findIndex(lane => lane.windowId === runtime.lane.windowId);
            if (index >= 0)
              pool.splice(index, 1);
            continue;
          }
          runtime.sessions.add(sessionId);
          return runtime;
        }
        if (!pool.length)
          throw new Error('No pre-positioned authenticated browser workspace is available');
        return undefined;
      });
      if (leased)
        return leased;
      // A lane skipped for a transient hand-back frees itself on its own; poll
      // it briefly instead of waiting for a session to end.
      await this._waitForCapacity(transientSkip ? Math.min(deadline, Date.now() + 250) : deadline);
    }
  }

  private _releaseSession(runtime: LaneRuntime, sessionId: number): void {
    runtime.sessions.delete(sessionId);
    runtime.stage.releaseSession(sessionId);
    this._notifyCapacity();
  }

  private async _establishConnection(connection: Awaited<ReturnType<typeof openRelayConnection>>, tab: (chrome.tabs.Tab & { id: number }) | undefined, clientName: string | undefined, selectorTabId?: number): Promise<void> {
    const id = ++this._lastConnectionId;
    let runtime: LaneRuntime | undefined;
    let sessionTab: (chrome.tabs.Tab & { id: number }) | undefined;
    let group: ConnectedTabGroup | undefined;
    try {
      if (!tab) {
        runtime = await this._leaseLane(id);
        // Bracket the creation so the lane guard recognises the new tab as
        // ours; an unbracketed tab in a lane is treated as a foreign arrival.
        runtime.guard.beginTabCreation();
        try {
          sessionTab = await createSessionTab(runtime.lane);
        } finally {
          runtime.guard.endTabCreation(sessionTab?.id);
        }
      }
      const selectedTab = tab ?? sessionTab!;
      if (selectorTabId !== undefined && selectedTab.id !== selectorTabId && this._connectedTabIds().has(selectedTab.id))
        throw new Error('This tab is already connected to another client');

      const sessionStorageKey = runtime ? `${SESSION_STORAGE_PREFIX}${crypto.randomUUID()}` : undefined;
      const taken = [...this._connections.values()].map(group => group.groupStyle);
      const groupStyle = uniqueGroupStyle(clientName, taken);
      if (runtime) {
        const lane = runtime.lane;
        const laneRuntime = runtime;
        const guard = runtime.guard;
        connection.setLane({
          sessionId: id,
          windowId: lane.windowId,
          anchorTabId: lane.anchorTabId,
          stage: runtime.stage,
          beginTabCreation: () => guard.beginTabCreation(),
          endTabCreation: createdTabId => guard.endTabCreation(createdTabId),
          isBackgrounded: async () => {
            if (guard.reclaimed || !this._laneRuntimes.has(lane.windowId))
              return { ok: false, diagnostic: 'lane=reclaimed' };
            const health = await laneHealth(laneRuntime.lane);
            // Chrome focuses a lane for a moment while the guard hands an
            // external link back to the user; that is not a reclaim.
            if (!health.healthy && health.window?.type === 'normal' && health.window.state === 'normal' && guard.recentlyEvicted())
              return { ok: true, diagnostic: `${health.diagnostic};evicting=true` };
            return { ok: health.healthy, diagnostic: health.diagnostic };
          },
        });
        connection.markOwnedTab(selectedTab.id);
      }
      if (runtime && sessionStorageKey) {
        const lane = runtime.lane;
        const persistSession = (ownedTabIds: number[]) => chrome.storage.local.set({
          [sessionStorageKey]: {
            browserSessionId: this._browserSessionId!,
            windowId: lane.windowId,
            ownedTabIds,
            anchorTabId: lane.anchorTabId,
            poolKey: lane.poolKey,
            markerUrl: lane.markerUrl,
            windowType: lane.windowType,
          },
        });
        await persistSession([...connection.ownedTabIds]);
        connection.onownershipchange = ownedTabIds => void persistSession(ownedTabIds);
      }
      group = new ConnectedTabGroup(
          connection,
          clientName,
          groupStyle,
          tabId => this._pendingConnections.has(tabId),
          runtime && {
            windowId: runtime.lane.windowId,
            anchorTabId: runtime.lane.anchorTabId,
            anchorIsTaskTab: false,
          });
      const laneRuntime = runtime;
      group.onclose = workspaceCleaned => {
        this._connections.delete(id);
        connection.onownershipchange = undefined;
        if (sessionStorageKey && workspaceCleaned)
          void chrome.storage.local.remove(sessionStorageKey);
        if (laneRuntime)
          this._releaseSession(laneRuntime, id);
      };
      if (runtime?.dropped)
        throw new Error('Agent lane was reclaimed while the session was being established');
      this._connections.set(id, group);
      await group.initialize(selectedTab);
      if (runtime?.dropped) {
        group.markReclaimed('Agent lane was reclaimed while the session was being established');
        throw new Error('Agent lane was reclaimed while the session was being established');
      }

      if (!runtime && selectorTabId !== undefined && selectedTab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error) {
      connection.close('Workspace provisioning failed');
      if (runtime && !group) {
        // The relay never attached, so the session tab is ours alone and the
        // lane keeps its anchor. Never touch other sessions' tabs here.
        if (sessionTab)
          await chrome.tabs.remove(sessionTab.id).catch(() => {});
        this._releaseSession(runtime, id);
      } else if (runtime?.dropped && sessionTab && !this._connections.has(id)) {
        // The lane was taken over mid-establishment: the only tab we can
        // vouch for is the one this session created moments ago.
        await chrome.tabs.remove(sessionTab.id).catch(() => {});
      }
      throw error;
    }
  }

  // Chrome may create the connect page inside the active client's group.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    this._releaseTab(tabId);
    await ungroupTabs([tabId]);
  }

  private _releaseTab(tabId: number): void {
    for (const group of this._connections.values())
      group.releaseTab(tabId);
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    const connectedTabIds = this._connectedTabIds();
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url) && (tab.id === selectorTabId || !connectedTabIds.has(tab.id!)));
  }

  private _connectedTabIds(): Set<number> {
    return new Set([...this._connections.values()].flatMap(group => group.connectedTabIds()));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
}

export const playwrightExtension = new PlaywrightExtension();
