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

import { userWindowBounds } from './agentDisplay';
import { debugLog } from './relayConnection';
import { isBackgroundedLaneWindow, isLaneWindowInService } from './workspaceLifecycle';

// A lane focus event this soon after an eviction is Chrome finishing the
// external-link hand-off we just reversed, not the user reclaiming the lane.
export const EVICTION_GRACE_MS = 1500;
// Chrome may activate the lane before or after it creates the tab it is
// delivering. A lane focus is therefore held undetermined this long, waiting
// for a foreign creation, before it is read as the user reclaiming the lane.
export const FOCUS_SETTLE_MS = 250;

export type LaneGuardDeps = {
  // Tabs owned by any session in this lane, plus tabs whose creation the relay
  // is currently awaiting. Page popups from owned openers are adopted by the
  // relay and never evicted.
  isOwnedTab: (tabId: number) => boolean;
  isLaneWindow: (windowId: number) => boolean;
  lastUserWindowId: () => number | undefined;
  onActiveTabChanged: (tabId: number) => void;
  onReclaimed: (reason: string) => void;
  // True while the lane sits on the invisible agent display. Nobody can see or
  // click such a lane, so focus landing there is Chrome's doing (the Dock icon,
  // Cmd-`, the Window menu), never the user taking the lane over. Absent means
  // visible, which keeps the original reclaim-on-focus behaviour.
  isHidden?: () => Promise<boolean>;
  // The user's most recent window on the macOS Space (desktop) that is showing
  // right now, or undefined when none is known. Focusing a window on another
  // Space makes macOS switch to that Space, so a hidden lane hands focus back
  // only to a window on the current one.
  userWindowOnCurrentSpace?: () => Promise<number | undefined>;
};

// Watches one lane window for the two things that must never quietly happen to
// it: a foreign tab arriving (Chrome routed an external link into the lane) and
// the user taking the window over. Foreign tabs are handed straight back to the
// user's own window; user focus, state changes, or loss of the anchor reclaim
// the lane for the user and end every session in it.
export class LaneGuard {
  private _pendingCreations = 0;
  // Tabs that appeared while a relay creation was outstanding. They are
  // classified only once every outstanding creation has reported its exact
  // tab ID, so a foreign arrival can never consume a relay tab's blessing.
  private _undetermined = new Set<number>();
  private _lastEvictionAt = 0;
  private _evicting = 0;
  private _focusUndeterminedUntil = 0;
  // Chromium Show()s the window that receives a page-initiated tab, which
  // activates it on macOS. The launcher's init script turns such opens into
  // same-tab navigations; this is the backstop for any that still get through.
  private _lastAdoptedPopupAt = 0;
  private _lastHandBackAt = 0;
  private _reclaimed = false;
  private _listeners: Array<{ remove: () => void }> = [];

  constructor(private readonly _windowId: number, private readonly _anchorTabId: number, private readonly _deps: LaneGuardDeps) {
    const onCreated = (tab: chrome.tabs.Tab) => void this._onTabCreated(tab).catch(error => debugLog('Lane guard create error:', error));
    const onActivated = (info: chrome.tabs.OnActivatedInfo) => {
      if (info.windowId === this._windowId)
        this._deps.onActiveTabChanged(info.tabId);
    };
    const onRemoved = (tabId: number) => {
      this._undetermined.delete(tabId);
      if (tabId === this._anchorTabId)
        this._reclaim('Agent lane anchor was closed');
    };
    // A tab moved into the lane by hand is the user working in it.
    const onAttached = (tabId: number, info: chrome.tabs.OnAttachedInfo) => {
      if (info.newWindowId === this._windowId && !this._deps.isOwnedTab(tabId))
        this._reclaim('Agent lane was reclaimed (user tab attached)');
    };
    const onFocusChanged = (windowId: number) => {
      if (windowId === this._windowId)
        void this._onLaneFocused();
    };
    const onBoundsChanged = (window: chrome.windows.Window) => {
      if (window.id !== this._windowId || isBackgroundedLaneWindow(window))
        return;
      // A hidden lane that macOS focused moves (placement) without being reclaimed.
      void isLaneWindowInService(window).then(inService => {
        if (!inService)
          this._reclaim(`Agent lane was reclaimed (type=${window.type};state=${window.state};focused=${Boolean(window.focused)})`);
      });
    };
    chrome.tabs.onCreated.addListener(onCreated);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    chrome.tabs.onAttached.addListener(onAttached);
    chrome.windows.onFocusChanged.addListener(onFocusChanged);
    chrome.windows.onBoundsChanged.addListener(onBoundsChanged);
    this._listeners.push(
        { remove: () => chrome.tabs.onCreated.removeListener(onCreated) },
        { remove: () => chrome.tabs.onActivated.removeListener(onActivated) },
        { remove: () => chrome.tabs.onRemoved.removeListener(onRemoved) },
        { remove: () => chrome.tabs.onAttached.removeListener(onAttached) },
        { remove: () => chrome.windows.onFocusChanged.removeListener(onFocusChanged) },
        { remove: () => chrome.windows.onBoundsChanged.removeListener(onBoundsChanged) });
  }

  get reclaimed(): boolean {
    return this._reclaimed;
  }

  // The relay brackets its own chrome.tabs.create so the resulting onCreated is
  // recognised as ours; tabs.create resolves (with the exact tab ID) only after
  // the event fires, so classification of anything that arrived meanwhile is
  // deferred until the bracket closes.
  beginTabCreation(): void {
    this._pendingCreations++;
  }

  endTabCreation(createdTabId?: number): void {
    this._pendingCreations = Math.max(0, this._pendingCreations - 1);
    if (createdTabId !== undefined)
      this._undetermined.delete(createdTabId);
    if (this._pendingCreations > 0)
      return;
    const foreign = [...this._undetermined];
    this._undetermined.clear();
    for (const tabId of foreign)
      void this._evict(tabId).catch(error => debugLog('Lane guard eviction error:', error));
  }

  recentlyEvicted(): boolean {
    return this._evicting > 0 || Date.now() - this._lastEvictionAt < EVICTION_GRACE_MS ||
      Date.now() - this._lastAdoptedPopupAt < EVICTION_GRACE_MS ||
      Date.now() - this._lastHandBackAt < EVICTION_GRACE_MS ||
      Date.now() < this._focusUndeterminedUntil;
  }

  dispose(): void {
    for (const listener of this._listeners)
      listener.remove();
    this._listeners = [];
  }

  private _reclaim(reason: string): void {
    if (this._reclaimed)
      return;
    this._reclaimed = true;
    this._deps.onReclaimed(reason);
  }

  private async _onTabCreated(tab: chrome.tabs.Tab): Promise<void> {
    if (tab.windowId !== this._windowId || tab.id === undefined || tab.id === this._anchorTabId || this._reclaimed)
      return;
    if (tab.openerTabId !== undefined && this._deps.isOwnedTab(tab.openerTabId)) {
      this._lastAdoptedPopupAt = Date.now();
      return;
    }
    if (this._pendingCreations > 0) {
      this._undetermined.add(tab.id);
      return;
    }
    await this._evict(tab.id);
  }

  // Chrome opened something in this lane that no agent asked for: an external
  // link, a bookmark, a restored tab. Give it to the user's own window. Focus is
  // handed there only when Chrome focused the lane to deliver it, so this path
  // returns a window Chrome itself just took and never activates Chrome on its
  // own; a background arrival is moved quietly. This is the only place ordinary
  // extension code may focus a window.
  private async _evict(tabId: number): Promise<void> {
    this._evicting++;
    this._lastEvictionAt = Date.now();
    try {
      const tab = await chrome.tabs.get(tabId).catch(() => undefined);
      if (tab?.windowId !== this._windowId)
        return;
      const lane = await chrome.windows.get(this._windowId).catch(() => undefined);
      const chromeTookFocus = Boolean(lane?.focused);
      const userWindowId = this._deps.lastUserWindowId();
      const userWindow = userWindowId === undefined ? undefined : await chrome.windows.get(userWindowId).catch(() => undefined);
      if (userWindow?.id !== undefined && userWindow.type === 'normal' && !this._deps.isLaneWindow(userWindow.id)) {
        await chrome.tabs.move(tabId, { windowId: userWindow.id, index: -1 });
        if (chromeTookFocus) {
          await chrome.tabs.update(tabId, { active: true });
          await chrome.windows.update(userWindow.id, { focused: true });
        }
      } else {
        // Without explicit bounds Chrome places the window beside the lane,
        // which may be on the invisible agent display.
        await chrome.windows.create({ tabId, focused: chromeTookFocus, ...(await userWindowBounds() ?? {}) });
      }
      debugLog(`Evicted foreign tab ${tabId} from lane ${this._windowId} (focusReturned=${chromeTookFocus})`);
    } finally {
      this._lastEvictionAt = Date.now();
      this._evicting--;
    }
  }

  private async _onLaneFocused(): Promise<void> {
    if (this._reclaimed)
      return;
    if (!this.recentlyEvicted()) {
      // The foreign tab Chrome is delivering may not have been created yet.
      this._focusUndeterminedUntil = Date.now() + FOCUS_SETTLE_MS;
      await new Promise(resolve => setTimeout(resolve, FOCUS_SETTLE_MS));
      this._focusUndeterminedUntil = 0;
      if (this._reclaimed)
        return;
      if (!this.recentlyEvicted()) {
        await this._reclaimOrHandBack();
        return;
      }
    }
    // Chrome focused the lane to deliver a link we are handing back, or to
    // show a page popup an agent tab opened. Give the key window back to the
    // user's own window, then reclaim only if the lane is still focused once
    // that settles.
    if (Date.now() - this._lastAdoptedPopupAt < EVICTION_GRACE_MS)
      await this._returnFocusToUser();
    await new Promise(resolve => setTimeout(resolve, EVICTION_GRACE_MS));
    const window = await chrome.windows.get(this._windowId).catch(() => undefined);
    if (window?.focused && !this._reclaimed)
      await this._reclaimOrHandBack();
  }

  // A visible lane the user focuses is theirs. A hidden one cannot be, so its
  // sessions keep running and focus goes back to a window the user can see.
  // Chrome is already the active app here, so this moves focus between
  // Chrome's own windows and never takes it from another app.
  private async _reclaimOrHandBack(): Promise<void> {
    if (await (this._deps.isHidden?.() ?? Promise.resolve(false)).catch(() => false)) {
      this._lastHandBackAt = Date.now();
      await this._handBackFromHiddenLane();
      this._lastHandBackAt = Date.now();
      return;
    }
    this._reclaim('Agent lane was reclaimed (state=unknown;focused=true)');
  }

  // macOS focuses a hidden lane when the user switches to a Space where the lane
  // is Chrome's frontmost window, or through Cmd-`, the Window menu, or the
  // Dock icon. Focus goes to the user's window on the Space they are on. When
  // no such window is known it stays where it is: focusing a window on another
  // Space would drag the user to that Space, which is worse than an idle lane
  // holding focus until they click elsewhere. Only when Chrome has no window of
  // the user's at all is one opened, on the current Space.
  private async _handBackFromHiddenLane(): Promise<void> {
    const target = await (this._deps.userWindowOnCurrentSpace?.() ?? Promise.resolve(undefined)).catch(() => undefined);
    if (target !== undefined) {
      await chrome.windows.update(target, { focused: true }).catch(() => {});
      debugLog(`Handed focus from hidden lane ${this._windowId} to window ${target} on the current Space`);
      return;
    }
    const userWindows = (await chrome.windows.getAll({ windowTypes: ['normal'] }).catch(() => [] as chrome.windows.Window[]))
        .filter(window => window.id !== undefined && !this._deps.isLaneWindow(window.id));
    if (!userWindows.length) {
      await chrome.windows.create({ focused: true, ...(await userWindowBounds() ?? {}) }).catch(() => {});
      debugLog(`Opened a window for the user after hidden lane ${this._windowId} took focus`);
      return;
    }
    debugLog(`Hidden lane ${this._windowId} keeps focus: no user window known on the current Space`);
  }

  // After an adopted page popup. Same Space rule as the hidden-lane hand-back.
  private async _returnFocusToUser(): Promise<void> {
    if (this._deps.userWindowOnCurrentSpace) {
      const target = await this._deps.userWindowOnCurrentSpace().catch(() => undefined);
      if (target !== undefined)
        await chrome.windows.update(target, { focused: true }).catch(() => {});
      return;
    }
    const userWindowId = this._deps.lastUserWindowId();
    const userWindow = userWindowId === undefined || this._deps.isLaneWindow(userWindowId)
      ? undefined
      : await chrome.windows.get(userWindowId).catch(() => undefined);
    if (userWindow?.id !== undefined && userWindow.type === 'normal')
      await chrome.windows.update(userWindow.id, { focused: true }).catch(() => {});
  }
}

// Remembers the user's most recently focused normal window that is not a lane,
// so an evicted tab lands where the user actually works, and the macOS Space
// each of their windows was on when they last used it.
export class UserWindowTracker {
  private _lastUserWindowId: number | undefined;
  private _listener: (windowId: number) => void;
  // windowId -> the Space it was focused on, most recently used last.
  private _spaceByWindow = new Map<number, number>();

  constructor(private readonly _isLaneWindow: (windowId: number) => boolean,
    private readonly _activeSpace: () => Promise<number | undefined> = async () => undefined) {
    this._listener = windowId => {
      if (windowId === chrome.windows.WINDOW_ID_NONE || this._isLaneWindow(windowId))
        return;
      void chrome.windows.get(windowId).then(async window => {
        if (window.type !== 'normal' || this._isLaneWindow(windowId))
          return;
        this._lastUserWindowId = windowId;
        const space = await this._activeSpace().catch(() => undefined);
        if (space !== undefined) {
          this._spaceByWindow.delete(windowId);
          this._spaceByWindow.set(windowId, space);
        }
      }).catch(() => {});
    };
    chrome.windows.onFocusChanged.addListener(this._listener);
    void chrome.windows.getLastFocused({ windowTypes: ['normal'] }).then(window => {
      if (window?.id !== undefined && !this._isLaneWindow(window.id))
        this._lastUserWindowId = window.id;
    }).catch(() => {});
  }

  get lastUserWindowId(): number | undefined {
    return this._lastUserWindowId;
  }

  // The most recently used user window that was last focused on this Space
  // and still exists, or undefined.
  async lastUserWindowOnSpace(space: number): Promise<number | undefined> {
    for (const [windowId, windowSpace] of [...this._spaceByWindow].reverse()) {
      if (windowSpace !== space || this._isLaneWindow(windowId))
        continue;
      const window = await chrome.windows.get(windowId).catch(() => undefined);
      if (window?.type === 'normal')
        return windowId;
      this._spaceByWindow.delete(windowId);
    }
    return undefined;
  }

  // A window recorded before it was registered as a lane (creation focuses it
  // briefly) must never be treated as the user's window afterwards.
  forget(windowId: number): void {
    if (this._lastUserWindowId === windowId)
      this._lastUserWindowId = undefined;
    this._spaceByWindow.delete(windowId);
  }
}
