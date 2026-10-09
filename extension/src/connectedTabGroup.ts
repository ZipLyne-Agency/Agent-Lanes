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

import { RelayConnection, debugLog } from './relayConnection';
import { closeAgentTabs } from './leavePrompt';
import { isBackgroundedLaneWindow } from './workspaceLifecycle';

const PLAYWRIGHT_GROUP_TITLE = 'Playwright';
const PLAYWRIGHT_GROUP_TITLE_PREFIX = `${PLAYWRIGHT_GROUP_TITLE} · `;
// Green first, so a lone connection keeps the familiar look.
const PLAYWRIGHT_GROUP_COLORS: GroupColor[] = ['green', 'blue', 'purple', 'orange', 'pink', 'cyan', 'yellow', 'red'];
const NON_DEBUGGABLE_SCHEMES = ['chrome:', 'edge:', 'devtools:'];
const CONNECTED_BADGE = { text: '✓', color: '#4CAF50', title: 'Connected to Playwright client' };

export function isNonDebuggableUrl(url: string | undefined): boolean {
  return !!url && NON_DEBUGGABLE_SCHEMES.some(s => url.startsWith(s));
}

type GroupColor = `${chrome.tabGroups.Color}`;

export type GroupStyle = {
  title: string;
  color: GroupColor;
};

type ManagedWorkspace = {
  windowId: number;
  anchorTabId: number;
  anchorIsTaskTab: boolean;
};

export function uniqueGroupStyle(clientName: string | undefined, taken: readonly GroupStyle[]): GroupStyle {
  const titles = new Set(taken.map(style => style.title));
  const base = PLAYWRIGHT_GROUP_TITLE_PREFIX + (clientName || 'unknown');
  let title = base;
  for (let i = 2; titles.has(title); i++)
    title = `${base} (${i})`;

  const colors = new Set(taken.map(style => style.color));
  const color = PLAYWRIGHT_GROUP_COLORS.find(candidate => !colors.has(candidate)) ?? PLAYWRIGHT_GROUP_COLORS[0];
  return { title, color };
}

// Ungroups any Playwright-titled groups left behind by a prior service worker.
export async function cleanupStalePlaywrightGroups(): Promise<void> {
  try {
    const groups = await chrome.tabGroups.query({});
    // The bare title comes from versions that predate per-client groups.
    const stale = groups.filter(g => g.title === PLAYWRIGHT_GROUP_TITLE || g.title?.startsWith(PLAYWRIGHT_GROUP_TITLE_PREFIX));
    const tabsPerGroup = await Promise.all(stale.map(g => chrome.tabs.query({ groupId: g.id })));
    const tabIds = tabsPerGroup.flat().map(t => t.id).filter((id): id is number => id !== undefined);
    if (tabIds.length)
      await ungroupTabs(tabIds);
  } catch (error: any) {
    debugLog('Error cleaning up stale groups:', error);
  }
}

// The tab scope for an active RelayConnection. Manually selected connections
// retain upstream Chrome-group behavior. Private agent workspaces deliberately
// do not create Chrome tab groups: the exclusive window plus exact owned-tab IDs
// are the source of truth, which prevents Chrome from retaining one saved group
// record per agent task.
//
// For manual connections, the Chrome tab group is the source of truth:
//  - User drags a tab in/out → `_onTabGroupChanged` attaches/detaches.
//  - Relay attaches on its own (initial tab, popup, Target.createTarget) →
//    `_onTabAttached` pulls the new tab into the group, whose onUpdated event
//    flows back through `_onTabGroupChanged` for consistency.
// `_groupTabIds` caches the connected scope. For manual connections it mirrors
// Chrome group membership; for private workspaces it contains exact workspace tabs.
export class ConnectedTabGroup {
  readonly clientName: string | undefined;
  readonly groupStyle: GroupStyle;
  private _connection: RelayConnection;
  private _isTabReserved: (tabId: number) => boolean;
  private _groupId: number | null = null;
  private _groupTabIds: Set<number> = new Set();
  private _onTabUpdatedListener: (tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab) => void;
  private _onTabRemovedListener: (tabId: number) => void;
  private _onTabDetachedListener: (tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }) => void;
  private _workspace: ManagedWorkspace | undefined;

  onclose?: (workspaceCleaned: boolean) => void;

  constructor(connection: RelayConnection, clientName: string | undefined, groupStyle: GroupStyle, isTabReserved: (tabId: number) => boolean, workspace?: ManagedWorkspace) {
    this.clientName = clientName;
    this.groupStyle = groupStyle;
    this._isTabReserved = isTabReserved;
    this._connection = connection;
    this._workspace = workspace;
    this._connection.onclose = () => void this._onConnectionClose();
    this._connection.ontabattached = (tabId: number) => this._onTabAttached(tabId);
    this._connection.ontabdetached = (tabId: number) => this._onTabDetached(tabId);
    this._onTabUpdatedListener = this._onTabUpdated.bind(this);
    this._onTabRemovedListener = this._onTabRemoved.bind(this);
    this._onTabDetachedListener = this._onTabMovedOut.bind(this);
    chrome.tabs.onUpdated.addListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.addListener(this._onTabRemovedListener);
    chrome.tabs.onDetached.addListener(this._onTabDetachedListener);
  }

  async initialize(selectedTab: chrome.tabs.Tab): Promise<void> {
    try {
      // Place and group the initial tab before announcing it. The relay does
      // not issue its debugger attach until `didInitialize`, so waiting for an
      // attach callback here would deadlock the handshake.
      await this._placeTabInScope(selectedTab.id!);
      this._connection.attachTab(selectedTab);
      this._connection.didInitialize();
    } catch (error) {
      this._connection.close('Owned tab escaped its background workspace');
      throw error;
    }
  }

  connectedTabIds(): number[] {
    return [...this._groupTabIds];
  }

  ownsTab(tabId: number): boolean {
    return this._connection.ownedTabIds.has(tabId);
  }

  markReclaimed(reason: string): void {
    this._connection.markWorkspaceReclaimed(reason);
  }

  workspaceWindowId(): number | undefined {
    return this._workspace?.windowId;
  }

  close(reason: string): void {
    this._connection.close(reason);
  }

  releaseTab(tabId: number): void {
    if (!this._groupTabIds.has(tabId))
      return;
    this._groupTabIds.delete(tabId);
    this._connection.markTabReclaimed(tabId);
    this._connection.detachTab(tabId);
  }

  private _onTabUpdated(tabId: number, changeInfo: chrome.tabs.OnUpdatedInfo, tab: chrome.tabs.Tab): void {
    if (changeInfo.groupId !== undefined)
      this._onTabGroupChanged(tabId, tab);
    if (changeInfo.url === undefined)
      return;
    // Chrome resets per-tab badge state on navigation, so re-apply it.
    if (this._connection.attachedTabs.has(tabId))
      void this._updateBadge(tabId, CONNECTED_BADGE);
    else if (this._groupTabIds.has(tabId) && !isNonDebuggableUrl(changeInfo.url))
      this._connection.attachTab(tab);
  }

  // Single entry point for group membership changes, whether the user dragged
  // or we grouped the tab ourselves. Attaches on entry (if debuggable) and
  // detaches on exit; a chrome:// tab stays in the group until it navigates
  // (handled in _onTabUpdated).
  private _onTabGroupChanged(tabId: number, tab: chrome.tabs.Tab): void {
    const inOurGroup = this._groupId !== null && tab.groupId === this._groupId;
    const wasInGroup = this._groupTabIds.has(tabId);
    if (inOurGroup === wasInGroup)
      return;
    if (inOurGroup) {
      // Chrome may drop the connect page of a client that is still connecting
      // into our group; that tab is spoken for.
      if (this._isTabReserved(tabId)) {
        void ungroupTabs([tabId]);
        return;
      }
      this._groupTabIds.add(tabId);
      if (!isNonDebuggableUrl(tab.url))
        this._connection.attachTab(tab);
    } else {
      this._groupTabIds.delete(tabId);
      this._connection.markTabReclaimed(tabId);
      if (this._connection.attachedTabs.has(tabId))
        this._connection.detachTab(tabId);
    }
  }

  private _onTabRemoved(tabId: number): void {
    this._groupTabIds.delete(tabId);
  }

  private _onTabMovedOut(tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }): void {
    if (!this._workspace || detachInfo.oldWindowId !== this._workspace.windowId || !this._groupTabIds.has(tabId))
      return;
    // Moving a controlled tab out of its private window is an explicit reclaim.
    // Revoke access immediately; never continue driving it in a user window.
    this.releaseTab(tabId);
    this._connection.close('Owned tab left its private agent workspace');
  }

  private async _onTabAttached(tabId: number): Promise<void> {
    void this._updateBadge(tabId, CONNECTED_BADGE);
    try {
      await this._placeTabInScope(tabId);
    } catch (error) {
      this._connection.close('Owned tab escaped its background workspace');
      throw error;
    }
  }

  // The debugger detached (tab close, manual drag-out, or external action).
  // Clear the badge. Manual group membership can re-attach after navigation;
  // private workspace movement is handled separately by `_onTabMovedOut`.
  private _onTabDetached(tabId: number): void {
    void this._updateBadge(tabId, { text: '' });
  }

  private async _onConnectionClose(): Promise<void> {
    chrome.tabs.onUpdated.removeListener(this._onTabUpdatedListener);
    chrome.tabs.onRemoved.removeListener(this._onTabRemovedListener);
    chrome.tabs.onDetached.removeListener(this._onTabDetachedListener);
    const connectedTabs = [...this._groupTabIds];
    this._groupTabIds.clear();
    let workspaceCleaned = true;
    if (this._workspace)
      workspaceCleaned = await this._cleanupWorkspace();
    else if (connectedTabs.length)
      await ungroupTabs(connectedTabs);
    this.onclose?.(workspaceCleaned);
  }

  // Returns whether cleanup completed; the lane itself always stays with its
  // anchor, so there is no separate "parked" outcome any more.
  private async _cleanupWorkspace(): Promise<boolean> {
    const workspace = this._workspace!;
    try {
      const [window, tabs] = await Promise.all([
        chrome.windows.get(workspace.windowId),
        chrome.tabs.query({ windowId: workspace.windowId }),
      ]);
      if (this._connection.workspaceReclaimed || !isBackgroundedLaneWindow(window)) {
        // Focusing or changing the state of a lane is an explicit user reclaim.
        // The relay latches that signal so a rapid focus-then-unfocus cannot
        // race this asynchronous cleanup. Preserve every tab, including the
        // anchor and the other sessions' pages; the lane is the user's now.
        return true;
      }
      // Remove exactly this session's tabs. The anchor and every other
      // session's tabs stay; the lane remains parked for the next client.
      const owned = this._connection.ownedTabIds;
      const managedIds = tabs
          .map(tab => tab.id)
          .filter((tabId): tabId is number => tabId !== undefined && tabId !== workspace.anchorTabId && owned.has(tabId));
      // The relay has detached by now, so closeAgentTabs answers any "Leave
      // site?" prompt a page with unsaved changes raises on its way out.
      if (managedIds.length)
        await closeAgentTabs(managedIds);
      return true;
    } catch (error: any) {
      debugLog('Error cleaning up agent lane:', error);
      return false;
    }
  }

  private async _updateBadge(tabId: number, { text, color, title }: { text: string; color?: string, title?: string }): Promise<void> {
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text }),
        chrome.action.setTitle({ tabId, title: title || '' }),
        color ? chrome.action.setBadgeBackgroundColor({ tabId, color }) : Promise.resolve(),
      ]);
    } catch (error: any) {
      // Ignore errors as the tab may be closed already.
    }
  }

  // Moves an already-attached tab into its private workspace. Manual selected-tab
  // connections still create an upstream Chrome group. `_groupTabIds` is updated
  // after the await so an onUpdated event
  // that arrives concurrently (`_groupId` still null, wasInGroup still false)
  // becomes a harmless no-op rather than taking the drag-out branch.
  private async _placeTabInScope(tabId: number): Promise<void> {
    if (this._groupTabIds.has(tabId))
      return;
    try {
      if (this._workspace) {
        const workspace = await chrome.windows.get(this._workspace.windowId);
        if (!isBackgroundedLaneWindow(workspace))
          throw new Error(
              `Agent lane is no longer safely backgrounded (type=${workspace.type};state=${workspace.state};focused=${Boolean(workspace.focused)})`);
        const tab = await chrome.tabs.get(tabId);
        if (tab.windowId !== this._workspace.windowId)
          throw new Error('Owned tab opened outside its private agent lane');
        this._groupTabIds.add(tabId);
        return;
      }
      await retryOnDrag(async () => {
        if (this._groupId === null) {
          this._groupId = await chrome.tabs.group({
            tabIds: [tabId],
            ...(this._workspace ? { createProperties: { windowId: this._workspace.windowId } } : {}),
          });
          await chrome.tabGroups.update(this._groupId, this.groupStyle);
        } else {
          await chrome.tabs.group({ groupId: this._groupId, tabIds: [tabId] });
        }
      });
      this._groupTabIds.add(tabId);
    } catch (error: any) {
      debugLog('Error adding tab to group:', error);
      if (this._workspace && this._connection.ownedTabIds.has(tabId))
        throw error;
    }
  }

}

export async function ungroupTabs(tabIds: number[]): Promise<void> {
  if (!tabIds.length)
    return;
  try {
    await retryOnDrag(() => chrome.tabs.ungroup(tabIds as [number, ...number[]]));
  } catch (error: any) {
    debugLog('Error ungrouping tabs:', error);
  }
}

// Chrome throws "user may be dragging a tab" while a drag is in progress.
// Retry with backoff until it clears (or we give up).
async function retryOnDrag(fn: () => Promise<void>): Promise<void> {
  const delays = [0, 100, 200, 400, 800];
  let lastError: unknown;
  for (const delay of delays) {
    if (delay)
      await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await fn();
      return;
    } catch (error: any) {
      if (!error?.message?.includes('user may be dragging a tab'))
        throw error;
      lastError = error;
    }
  }
  throw lastError;
}
