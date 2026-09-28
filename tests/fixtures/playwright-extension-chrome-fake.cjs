// A small stateful fake of the chrome.* surface the canary uses. It models the
// behaviours the lane design depends on so the unit suites fail the way live
// Chrome fails: navigations commit asynchronously through pendingUrl, only one
// tab per window is active, window creation activates the new window, focus
// and activation fire their events, and moving a tab across windows fires
// onDetached/onAttached.

function createEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    emit(...args) {
      for (const listener of [...listeners])
        listener(...args);
    },
  };
}

function createChromeFake(options = {}) {
  const commitDelayMs = options.commitDelayMs ?? 15;
  // chrome.system.display units. Absent by default so the original suites
  // keep exercising the no-agent-display fallback.
  let displays = options.displays;
  const windows = new Map();
  const tabs = new Map();
  const storage = {};
  let nextWindowId = options.nextWindowId ?? 100;
  let nextTabId = options.nextTabId ?? 1000;
  let focusedWindowId = undefined;
  const log = {
    createdWindows: [],
    removedWindows: [],
    createdTabs: [],
    removedTabs: [],
    updatedTabs: [],
    movedTabs: [],
    focusUpdates: [],
    activations: [],
    debuggerCommands: [],
    debuggerAttaches: [],
    debuggerDetaches: [],
    removedStorageKeys: [],
    portMessages: [],
  };
  const events = {
    tabsCreated: createEvent(),
    tabsRemoved: createEvent(),
    tabsUpdated: createEvent(),
    tabsActivated: createEvent(),
    tabsDetached: createEvent(),
    tabsAttached: createEvent(),
    windowsFocusChanged: createEvent(),
    windowsBoundsChanged: createEvent(),
    windowsRemoved: createEvent(),
    windowsCreated: createEvent(),
    displayChanged: createEvent(),
    runtimeStartup: createEvent(),
    runtimeMessage: createEvent(),
    actionClicked: createEvent(),
    debuggerEvent: createEvent(),
    debuggerDetach: createEvent(),
  };
  const port = {
    onMessage: createEvent(),
    onDisconnect: createEvent(),
    postMessage(message) { log.portMessages.push(message); },
  };
  let sendCommandHook = async () => ({ forwarded: true });

  const tabView = tab => ({ ...tab, ...(tab.pendingUrl === undefined ? {} : { pendingUrl: tab.pendingUrl }) });
  const windowView = window => ({ ...window, focused: focusedWindowId === window.id });
  const windowTabs = windowId => [...tabs.values()].filter(tab => tab.windowId === windowId).sort((a, b) => a.index - b.index);

  function commitUrl(tab, url) {
    tab.pendingUrl = url;
    setTimeout(() => {
      if (tab.pendingUrl === url && tabs.has(tab.id)) {
        tab.pendingUrl = undefined;
        tab.url = url;
        events.tabsUpdated.emit(tab.id, { url }, tabView(tab));
      }
    }, commitDelayMs);
  }

  function activateTab(tab) {
    for (const other of windowTabs(tab.windowId))
      other.active = other.id === tab.id;
    log.activations.push([tab.windowId, tab.id]);
    events.tabsActivated.emit({ tabId: tab.id, windowId: tab.windowId });
  }

  function setFocusedWindow(windowId) {
    if (focusedWindowId === windowId)
      return;
    focusedWindowId = windowId;
    events.windowsFocusChanged.emit(windowId ?? -1);
  }

  function addTab(windowId, { url = 'about:blank', active = true, openerTabId } = {}) {
    const existing = windowTabs(windowId);
    const tab = {
      id: nextTabId++,
      windowId,
      index: existing.length,
      url: 'about:blank',
      pendingUrl: undefined,
      active: false,
      groupId: -1,
      autoDiscardable: true,
      ...(openerTabId === undefined ? {} : { openerTabId }),
    };
    tabs.set(tab.id, tab);
    if (url !== 'about:blank')
      commitUrl(tab, url);
    events.tabsCreated.emit(tabView(tab));
    if (active || !existing.length)
      activateTab(tab);
    return tab;
  }

  function removeTab(tabId) {
    const tab = tabs.get(tabId);
    if (!tab)
      return;
    tabs.delete(tabId);
    log.removedTabs.push(tabId);
    events.tabsRemoved.emit(tabId, { windowId: tab.windowId, isWindowClosing: false });
    const remaining = windowTabs(tab.windowId);
    if (!remaining.length) {
      if (windows.has(tab.windowId))
        removeWindow(tab.windowId);
    } else if (tab.active) {
      activateTab(remaining[Math.min(tab.index, remaining.length - 1)]);
    }
  }

  function removeWindow(windowId) {
    if (!windows.has(windowId))
      return;
    windows.delete(windowId);
    log.removedWindows.push(windowId);
    for (const tab of windowTabs(windowId)) {
      tabs.delete(tab.id);
      log.removedTabs.push(tab.id);
      events.tabsRemoved.emit(tab.id, { windowId, isWindowClosing: true });
    }
    if (focusedWindowId === windowId)
      setFocusedWindow(undefined);
    events.windowsRemoved.emit(windowId);
  }

  function createWindow(createData = {}, { activate } = {}) {
    const window = {
      id: nextWindowId++,
      type: createData.type ?? 'normal',
      state: createData.state ?? 'normal',
      left: createData.left ?? 0,
      top: createData.top ?? 0,
      width: createData.width ?? 1200,
      height: createData.height ?? 800,
    };
    windows.set(window.id, window);
    log.createdWindows.push({ ...createData, id: window.id });
    events.windowsCreated.emit(windowView(window));
    let tab;
    if (createData.tabId !== undefined && tabs.has(createData.tabId)) {
      // chrome.windows.create({tabId}) moves an existing tab into the new window.
      tab = tabs.get(createData.tabId);
      const oldWindowId = tab.windowId;
      tab.windowId = window.id;
      tab.index = 0;
      const remaining = windowTabs(oldWindowId);
      if (!remaining.length)
        removeWindow(oldWindowId);
      activateTab(tab);
    } else {
      tab = addTab(window.id, { url: createData.url ?? 'about:blank', active: true });
    }
    if (activate)
      setFocusedWindow(window.id);
    return { ...windowView(window), tabs: [tabView(tab)] };
  }

  const chrome = {
    runtime: {
      onStartup: events.runtimeStartup,
      onMessage: events.runtimeMessage,
      connectNative: () => port,
      getURL: path => `chrome-extension://test/${path}`,
    },
    action: {
      onClicked: events.actionClicked,
      setBadgeText: async () => {},
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    storage: {
      local: {
        get: async key => {
          if (key === null || key === undefined)
            return { ...storage };
          const keys = Array.isArray(key) ? key : [key];
          const result = {};
          for (const name of keys) {
            if (name in storage)
              result[name] = storage[name];
          }
          return result;
        },
        set: async value => { Object.assign(storage, JSON.parse(JSON.stringify(value))); },
        remove: async key => {
          for (const name of Array.isArray(key) ? key : [key]) {
            log.removedStorageKeys.push(name);
            delete storage[name];
          }
        },
      },
    },
    windows: {
      WINDOW_ID_NONE: -1,
      // macOS Chrome activates a newly created window even with focused:false
      // when the fake is built with activateOnCreate; the extension must cope.
      create: async createData => createWindow(createData, {
        activate: createData.focused !== false || Boolean(options.activateOnCreate),
      }),
      get: async (windowId, getInfo) => {
        const window = windows.get(windowId);
        if (!window)
          throw new Error(`No window with id: ${windowId}`);
        const view = windowView(window);
        if (getInfo?.populate)
          view.tabs = windowTabs(windowId).map(tabView);
        return view;
      },
      getAll: async getInfo => [...windows.values()]
          .filter(window => !getInfo?.windowTypes || getInfo.windowTypes.includes(window.type))
          .map(window => {
            const view = windowView(window);
            if (getInfo?.populate)
              view.tabs = windowTabs(window.id).map(tabView);
            return view;
          }),
      getLastFocused: async getInfo => {
        const candidates = [...windows.values()].filter(window => !getInfo?.windowTypes || getInfo.windowTypes.includes(window.type));
        const window = candidates.find(candidate => candidate.id === focusedWindowId) ?? candidates[0];
        if (!window)
          throw new Error('No window');
        const view = windowView(window);
        if (getInfo?.populate)
          view.tabs = windowTabs(window.id).map(tabView);
        return view;
      },
      update: async (windowId, updateInfo) => {
        const window = windows.get(windowId);
        if (!window)
          throw new Error(`No window with id: ${windowId}`);
        if (updateInfo.state)
          window.state = updateInfo.state;
        for (const key of ['left', 'top', 'width', 'height']) {
          if (updateInfo[key] !== undefined)
            window[key] = updateInfo[key];
        }
        if (updateInfo.focused === true) {
          log.focusUpdates.push(windowId);
          setFocusedWindow(windowId);
        }
        if (updateInfo.state !== undefined || updateInfo.left !== undefined || updateInfo.width !== undefined)
          events.windowsBoundsChanged.emit(windowView(window));
        return windowView(window);
      },
      remove: async windowId => removeWindow(windowId),
      onFocusChanged: events.windowsFocusChanged,
      onBoundsChanged: events.windowsBoundsChanged,
      onRemoved: events.windowsRemoved,
      onCreated: events.windowsCreated,
    },
    system: displays === undefined ? undefined : {
      display: {
        getInfo: async () => JSON.parse(JSON.stringify(displays)),
        onDisplayChanged: events.displayChanged,
      },
    },
    tabs: {
      create: async createData => {
        const windowId = createData.windowId ?? focusedWindowId ?? [...windows.keys()][0];
        const window = windows.get(windowId);
        if (!window)
          throw new Error(`No window with id: ${windowId}`);
        log.createdTabs.push(createData);
        // Chromium retargets any navigation into a popup browser to a tabbed
        // browser (WindowCanOpenTabs); model that by landing in the focused
        // or first normal window instead.
        let targetWindowId = windowId;
        if (window.type === 'popup') {
          const normal = [...windows.values()].find(candidate => candidate.type === 'normal');
          if (!normal)
            throw new Error('No tabbed window');
          targetWindowId = normal.id;
        }
        const tab = addTab(targetWindowId, { url: createData.url, active: createData.active !== false, openerTabId: createData.openerTabId });
        return tabView(tab);
      },
      get: async tabId => {
        const tab = tabs.get(tabId);
        if (!tab)
          throw new Error(`No tab with id: ${tabId}`);
        return tabView(tab);
      },
      query: async query => {
        let result = [...tabs.values()];
        if (query.windowId !== undefined)
          result = result.filter(tab => tab.windowId === query.windowId);
        if (query.active !== undefined)
          result = result.filter(tab => tab.active === query.active);
        return result.sort((a, b) => a.windowId - b.windowId || a.index - b.index).map(tabView);
      },
      update: async (tabId, updateProperties = {}) => {
        const tab = tabs.get(tabId);
        if (!tab)
          throw new Error(`No tab with id: ${tabId}`);
        log.updatedTabs.push([tabId, updateProperties]);
        if (updateProperties.url)
          commitUrl(tab, updateProperties.url);
        if (updateProperties.autoDiscardable !== undefined)
          tab.autoDiscardable = updateProperties.autoDiscardable;
        if (updateProperties.active === true && !tab.active)
          activateTab(tab);
        return tabView(tab);
      },
      remove: async tabIds => {
        for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds])
          removeTab(tabId);
      },
      move: async (tabId, moveProperties) => {
        const tab = tabs.get(tabId);
        if (!tab)
          throw new Error(`No tab with id: ${tabId}`);
        const source = windows.get(tab.windowId);
        const target = windows.get(moveProperties.windowId);
        if (!target)
          throw new Error(`No window with id: ${moveProperties.windowId}`);
        if (source.type !== 'normal' || target.type !== 'normal')
          throw new Error('Tabs can only be moved to and from normal windows.');
        log.movedTabs.push([tabId, moveProperties]);
        const oldWindowId = tab.windowId;
        const oldPosition = tab.index;
        const wasActive = tab.active;
        tab.windowId = target.id;
        tab.active = false;
        tab.index = windowTabs(target.id).length;
        events.tabsDetached.emit(tabId, { oldWindowId, oldPosition });
        const remaining = windowTabs(oldWindowId);
        if (!remaining.length)
          removeWindow(oldWindowId);
        else if (wasActive)
          activateTab(remaining[Math.min(oldPosition, remaining.length - 1)]);
        events.tabsAttached.emit(tabId, { newWindowId: target.id, newPosition: tab.index });
        return tabView(tab);
      },
      group: async () => { throw new Error('tab groups are not used by lanes'); },
      ungroup: async () => {},
      onCreated: events.tabsCreated,
      onRemoved: events.tabsRemoved,
      onUpdated: events.tabsUpdated,
      onActivated: events.tabsActivated,
      onDetached: events.tabsDetached,
      onAttached: events.tabsAttached,
    },
    tabGroups: {
      query: async () => [],
      update: async () => {},
    },
    debugger: {
      attach: async target => { log.debuggerAttaches.push(target); },
      detach: async target => { log.debuggerDetaches.push(target); },
      sendCommand: async (...args) => {
        log.debuggerCommands.push(args);
        return await sendCommandHook(...args);
      },
      onEvent: events.debuggerEvent,
      onDetach: events.debuggerDetach,
    },
  };

  return {
    chrome,
    events,
    log,
    port,
    storage,
    windows,
    tabs,
    get focusedWindowId() { return focusedWindowId; },
    // Test-side manipulations that model user or Chrome behaviour.
    focusWindow: windowId => setFocusedWindow(windowId),
    addWindow: (createData, { focus = false } = {}) => createWindow({ ...createData, focused: false }, { activate: focus }),
    addTab: (windowId, options) => tabView(addTab(windowId, options)),
    windowTabs: windowId => windowTabs(windowId).map(tabView),
    setSendCommandHook: hook => { sendCommandHook = hook; },
    // macOS adding or removing a display; Chrome reports it after the fact.
    setDisplays: next => {
      displays = next;
      events.displayChanged.emit();
    },
    // What an extension reload leaves behind: every tab showing one of this
    // extension's pages becomes a new-tab page, and the windows stay.
    reloadExtensionPages: () => {
      for (const tab of tabs.values()) {
        if ((tab.url ?? '').startsWith('chrome-extension://test/')) {
          tab.url = 'chrome://newtab/';
          tab.pendingUrl = undefined;
        }
      }
    },
    // Chrome delivering an external link: a tab appears in the target window
    // with no opener and the window is activated.
    openExternalLink: (windowId, url) => {
      const tab = addTab(windowId, { url, active: true });
      setFocusedWindow(windowId);
      return tabView(tab);
    },
    settle: (ms = commitDelayMs * 3) => new Promise(resolve => setTimeout(resolve, ms)),
  };
}

module.exports = { createChromeFake, createEvent };
