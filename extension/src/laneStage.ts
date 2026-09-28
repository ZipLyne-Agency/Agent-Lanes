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

// The stage is the per-lane rendering scheduler. Chrome renders, fires
// requestAnimationFrame, and delivers trusted CDP input only to the active tab
// of a normal-state window, so a lane that hosts many agent tabs can serve one
// of them at a time. Every debugger command for a tab must run while that tab
// holds the stage; acquiring the stage activates the tab with
// chrome.tabs.update({active: true}), which changes the tab strip only and never
// activates the window, Chrome, or the macOS Space (tabs_api.cc,
// TabsUpdateFunction -> TabList::ActivateTab).
//
// PROTECTED INVARIANT: an in-flight command is never preempted. Playwright's
// actionability gate awaits animation frames inside the page; backgrounding that
// tab mid-command stalls the command until Playwright's own timeout. Hand-over
// happens only between commands, after a short idle. A holder whose command has
// produced no completion for STAGE_HARD_CAP_MS (a page-controlled promise that
// never settles) is not preempted either: its whole session is closed through
// `onWedged`, which detaches its debugger and thereby ends the command, and the
// lane hands over only once that release arrives.

export const STAGE_IDLE_MS = 300;
// Playwright types "slowly" with ~100 ms between keystrokes; a contended idle
// shorter than that hands the lane over between every key and spreads latency
// across all sessions, so more of them hit their action timeout. Bursts are
// bounded by STAGE_MAX_SLICE_MS regardless.
export const STAGE_IDLE_CONTENDED_MS = 250;
// A holder that keeps issuing commands while others wait hands over at its
// next command boundary once it has held the stage this long.
export const STAGE_MAX_SLICE_MS = 5000;
export const STAGE_PARK_MS = 3000;
// A holder whose command has produced no completion for this long is wedged
// (a hung page, a detached target); only then is it force-released.
export const STAGE_HARD_CAP_MS = 30000;

type Holder = {
  sessionId: number;
  tabId: number;
  inFlight: number;
  lastActivity: number;
  acquiredAt: number;
};

type Waiter = {
  sessionId: number;
  tabId: number;
  resolve: () => void;
  reject: (error: Error) => void;
};

export class LaneStage {
  private _holder: Holder | undefined;
  private _waiters: Waiter[] = [];
  private _timer: ReturnType<typeof setTimeout> | undefined;
  private _activeTabId: number | undefined;
  private _activatingTabId: number | undefined;
  private _activation: Promise<void> = Promise.resolve();
  private _disposed = false;

  constructor(
      private readonly _windowId: number,
      private readonly _anchorTabId: () => number | undefined,
      private readonly _onWedged?: (sessionId: number) => void) {}

  get windowId(): number {
    return this._windowId;
  }

  get holderSessionId(): number | undefined {
    return this._holder?.sessionId;
  }

  get waiterCount(): number {
    return this._waiters.length;
  }

  // Runs `work` while `tabId` (owned by `sessionId`) is the lane's active tab.
  async run<T>(sessionId: number, tabId: number, work: () => Promise<T>): Promise<T> {
    if (this._disposed)
      throw new Error('Agent lane stage is disposed');
    // A hand-over can legitimately land between acquisition and execution
    // (the idle timer fires while the fast path awaits an activation); queue
    // again rather than fail the command.
    let holder = this._holder;
    for (let attempt = 0; ; attempt++) {
      await this._acquire(sessionId, tabId);
      holder = this._holder;
      if (holder && holder.sessionId === sessionId)
        break;
      if (this._disposed || attempt >= 50)
        throw new Error('Agent lane stage could not be acquired');
    }
    holder.inFlight++;
    try {
      return await work();
    } finally {
      holder.inFlight--;
      holder.lastActivity = Date.now();
      this._schedule();
    }
  }

  // Chrome changed the active tab behind our back (for example a page popup
  // opened as a foreground tab). The next command re-activates its own tab.
  activeTabChanged(tabId: number | undefined): void {
    // Chrome echoes our own activation back through tabs.onActivated before
    // chrome.tabs.update resolves; that echo is not a foreign change.
    if (tabId === this._activeTabId || tabId === this._activatingTabId)
      return;
    this._activeTabId = undefined;
  }

  // Ensures the current holder's tab is active again after Chrome activated a
  // different tab in this lane (page popups open in the foreground).
  async reassertHolder(): Promise<void> {
    const holder = this._holder;
    if (!holder || this._disposed)
      return;
    this._activeTabId = undefined;
    await this._activate(holder.tabId).catch(() => {});
  }

  releaseSession(sessionId: number): void {
    const dropped = this._waiters.filter(waiter => waiter.sessionId === sessionId);
    this._waiters = this._waiters.filter(waiter => waiter.sessionId !== sessionId);
    for (const waiter of dropped)
      waiter.reject(new Error('Agent session closed while waiting for its lane'));
    if (this._holder?.sessionId === sessionId)
      this._holder = undefined;
    this._schedule();
  }

  dispose(): void {
    this._disposed = true;
    if (this._timer !== undefined)
      clearTimeout(this._timer);
    this._timer = undefined;
    const waiters = this._waiters;
    this._waiters = [];
    this._holder = undefined;
    for (const waiter of waiters)
      waiter.reject(new Error('Agent lane is no longer available'));
  }

  private async _acquire(sessionId: number, tabId: number): Promise<void> {
    const holder = this._holder;
    if (holder && holder.sessionId === sessionId && holder.tabId === tabId) {
      // Re-asserting the active tab is part of the command: keep the holder
      // marked busy so an armed idle timer cannot hand the lane over meanwhile.
      holder.inFlight++;
      try {
        await this._activation;
        if (this._activeTabId !== tabId)
          await this._activate(tabId);
      } finally {
        holder.inFlight--;
        holder.lastActivity = Date.now();
      }
      return;
    }
    if (holder && holder.sessionId === sessionId && holder.inFlight === 0 && !this._waiters.length) {
      holder.tabId = tabId;
      await this._activate(tabId);
      return;
    }
    if (!holder && !this._waiters.length) {
      this._holder = { sessionId, tabId, inFlight: 0, lastActivity: Date.now(), acquiredAt: Date.now() };
      try {
        await this._activate(tabId);
      } catch (error) {
        this._holder = undefined;
        this._schedule();
        throw error;
      }
      return;
    }
    await new Promise<void>((resolve, reject) => {
      this._waiters.push({ sessionId, tabId, resolve, reject });
      this._schedule();
    });
  }

  private _grantNext(): void {
    const next = this._waiters.shift();
    if (!next)
      return;
    this._holder = {
      sessionId: next.sessionId,
      tabId: next.tabId,
      inFlight: 0,
      lastActivity: Date.now(),
      acquiredAt: Date.now(),
    };
    this._activate(next.tabId).then(
        () => next.resolve(),
        error => {
          if (this._holder?.sessionId === next.sessionId)
            this._holder = undefined;
          next.reject(error instanceof Error ? error : new Error(String(error)));
          this._schedule();
        });
  }

  private _activate(tabId: number): Promise<void> {
    if (this._activeTabId === tabId)
      return this._activation;
    this._activation = this._activation
        .catch(() => {})
        .then(async () => {
          this._activatingTabId = tabId;
          try {
            const updated = await chrome.tabs.update(tabId, { active: true });
            if (updated?.windowId !== undefined && updated.windowId !== this._windowId)
              throw new Error('Agent tab is no longer inside its lane');
            this._activeTabId = tabId;
          } finally {
            if (this._activatingTabId === tabId)
              this._activatingTabId = undefined;
          }
        });
    return this._activation;
  }

  private _schedule(): void {
    if (this._disposed)
      return;
    if (this._timer !== undefined)
      clearTimeout(this._timer);
    this._timer = undefined;
    const holder = this._holder;
    if (!holder) {
      if (this._waiters.length) {
        this._grantNext();
        return;
      }
      this._timer = setTimeout(() => {
        this._timer = undefined;
        if (this._holder || this._waiters.length || this._disposed)
          return;
        const anchor = this._anchorTabId();
        if (anchor !== undefined)
          void this._activate(anchor).catch(() => {});
      }, STAGE_PARK_MS);
      return;
    }
    if (holder.inFlight > 0) {
      if (!this._waiters.length)
        return;
      // lastActivity advances at every command completion, so a healthy burst
      // keeps pushing this deadline out; only a wedged command reaches it.
      const remaining = holder.lastActivity + STAGE_HARD_CAP_MS - Date.now();
      this._timer = setTimeout(() => {
        this._timer = undefined;
        if (this._holder !== holder || !this._waiters.length)
          return;
        if (holder.inFlight > 0 && Date.now() - holder.lastActivity < STAGE_HARD_CAP_MS) {
          this._schedule();
          return;
        }
        if (holder.inFlight > 0 && this._onWedged) {
          // Close the wedged session; its releaseSession() performs the hand-over.
          this._onWedged(holder.sessionId);
          return;
        }
        this._holder = undefined;
        this._schedule();
      }, Math.max(0, remaining));
      return;
    }
    const exhaustedSlice = this._waiters.length > 0 && Date.now() - holder.acquiredAt >= STAGE_MAX_SLICE_MS;
    const idle = exhaustedSlice ? 0 : this._waiters.length ? STAGE_IDLE_CONTENDED_MS : STAGE_IDLE_MS;
    const remaining = holder.lastActivity + idle - Date.now();
    this._timer = setTimeout(() => {
      this._timer = undefined;
      if (this._holder !== holder || holder.inFlight > 0)
        return;
      this._holder = undefined;
      this._schedule();
    }, Math.max(0, remaining));
  }
}
