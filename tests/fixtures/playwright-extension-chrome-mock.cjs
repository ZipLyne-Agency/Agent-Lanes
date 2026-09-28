const path = require('node:path');

function installChromeMock() {
  const removedTabs = [];
  const removedWindows = [];
  const createdWindows = [];
  const updatedWindows = [];
  const createdTabs = [];
  const updatedTabs = [];
  let nextCreatedTabId = 31;
  let createdWindowType;
  const state = {
    failNextTabUpdate: false,
    failNextStorageSet: false,
    failNextWindowFocusRestore: false,
    alwaysFailWindowFocusRestore: false,
    userTabActiveReadLag: 0,
    nextUserTabActiveReadLag: 0,
    workspaceStableReadLag: 0,
    nextWorkspaceStableReadLag: 0,
    lastFocusedIsMarker: false,
    chromeAppFocused: true,
    internalFocusedWindowId: undefined,
    internalActiveUserTabId: 12,
  };
  const removedStorageKeys = [];
  const stored = {
    'playwrightAgentWorkspace:test': {
      browserSessionId: 'a'.repeat(64),
      windowId: 7,
      ownedTabIds: [10, 11],
      anchorTabId: 13,
    },
    'playwrightAgentWorkspace:prior-browser-session': {
      browserSessionId: 'b'.repeat(64),
      windowId: 8,
      ownedTabIds: [99],
    },
    'playwrightAgentWorkspace:focused': {
      browserSessionId: 'a'.repeat(64),
      windowId: 14,
      ownedTabIds: [50],
      anchorTabId: 51,
    },
    'playwrightParkedWorkspace:slot': {
      // Numeric IDs deliberately represent the prior Chrome session. Recovery
      // must use the exact extension-owned marker URL instead.
      windowId: 999,
      windowType: 'popup',
      anchorTabId: 998,
      markerUrl: 'chrome-extension://test/status.html#agent-workspace=slot',
    },
    'playwrightAgentWorkspace:active-pool-slot': {
      browserSessionId: 'a'.repeat(64),
      windowId: 18,
      ownedTabIds: [90],
      anchorTabId: 91,
      poolKey: 'playwrightParkedWorkspace:recovered',
      markerUrl: 'chrome-extension://test/status.html#agent-workspace=recovered',
      windowType: 'popup',
    },
    'playwrightAgentWorkspace:legacy-active-pool-slot': {
      browserSessionId: 'a'.repeat(64),
      windowId: 22,
      ownedTabIds: [130],
      anchorTabId: 130,
      poolKey: 'playwrightParkedWorkspace:legacy',
    },
  };
  const event = () => {
    const listeners = new Set();
    return {
      listeners,
      addListener(listener) { listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
    };
  };
  const startupEvent = event();
  const portMessages = [];
  const movedTabs = [];
  const groupedTabs = [];
  const ungroupedTabs = [];
  const tabWindows = new Map([[12, 7], [40, 7], [41, 7], [80, 17], [91, 18], [110, 20], [120, 21], [130, 22], [140, 23], [150, 24], [151, 24]]);
  const tabUrls = new Map([
    [80, 'chrome-extension://test/status.html#agent-workspace=slot'],
    [91, 'about:blank'],
    [110, 'chrome-extension://test/status.html#agent-workspace=rollback'],
    [120, 'chrome-extension://test/status.html#agent-workspace=success'],
    [130, 'https://example.com/legacy-active-task'],
    [140, 'chrome-extension://test/status.html#agent-workspace=orphan'],
    [150, 'chrome-extension://test/status.html#agent-workspace=reclaimed-orphan'],
    [151, 'https://example.com/user-kept-this-window'],
  ]);
  // Navigations requested through tabs.update commit asynchronously, exactly
  // like real Chrome: the update resolves with the OLD committed url plus
  // pendingUrl, and the commit lands on a short timer. Immediate-url
  // assertions therefore fail in this suite the same way they fail live.
  const tabPendingUrls = new Map();
  const failedMoveTabIds = new Set([41]);
  const port = { onMessage: event(), onDisconnect: event(), postMessage(message) { portMessages.push(message); } };
  
  global.chrome = {
    runtime: {
      onStartup: startupEvent,
      onMessage: event(),
      connectNative: () => port,
      getURL: path => `chrome-extension://test/${path}`,
    },
    action: {
      onClicked: event(),
      setBadgeText: async () => {},
      setTitle: async () => {},
      setBadgeBackgroundColor: async () => {},
    },
    storage: {
      local: {
        get: async () => ({ ...stored }),
        set: async value => {
          if (state.failNextStorageSet) {
            state.failNextStorageSet = false;
            throw new Error('simulated storage failure');
          }
          Object.assign(stored, value);
        },
        remove: async key => {
          removedStorageKeys.push(key);
          delete stored[key];
        },
      },
    },
    windows: {
      create: async createData => {
        createdWindows.push(createData);
        createdWindowType = createData.type;
        state.workspaceStableReadLag = state.nextWorkspaceStableReadLag;
        state.nextWorkspaceStableReadLag = 0;
        tabWindows.set(30, 9);
        tabUrls.set(30, createData.url);
        return { id: 9, type: createData.type, tabs: [{ id: 30, windowId: 9, groupId: -1 }] };
      },
    getAll: async () => [{ id: 7 }],
    getLastFocused: async () => {
      if (state.lastFocusedIsMarker)
        return {
          id: 17,
          type: 'popup',
          focused: true,
          tabs: [{
            id: 80,
            windowId: 17,
            groupId: -1,
            active: true,
            url: 'chrome-extension://test/status.html#agent-workspace=slot',
          }],
        };
      if (state.internalFocusedWindowId === 9)
        return {
          id: 9,
          type: 'popup',
          focused: true,
          tabs: [{ id: 30, windowId: 9, groupId: -1, active: true, url: tabUrls.get(30) }],
        };
      return {
        id: 7,
        type: 'normal',
        focused: state.chromeAppFocused && state.internalFocusedWindowId !== 9,
        tabs: [{
          id: 12,
          windowId: 7,
          groupId: -1,
          active: state.internalActiveUserTabId === 12 && state.userTabActiveReadLag === 0,
          url: 'https://example.com/user',
        }],
      };
    },
      update: async (windowId, updateData) => {
        updatedWindows.push([windowId, updateData]);
        if (updateData.focused === true && state.alwaysFailWindowFocusRestore)
          return { id: windowId, type: windowId === 7 ? 'normal' : 'popup', state: 'normal', focused: false };
        // Legacy normal windows could become Chrome's internal focused window.
        // Popup workspaces must not need a user-window focus restoration path.
        if (windowId === 9 && updateData.state === 'normal' && createdWindowType === 'normal')
          state.internalFocusedWindowId = 9;
        if (windowId === 9 && updateData.state === 'normal') {
          state.workspaceStableReadLag = state.nextWorkspaceStableReadLag;
          state.nextWorkspaceStableReadLag = 0;
        }
        if (updateData.focused === true)
          state.internalFocusedWindowId = windowId;
        if (updateData.focused === true && state.failNextWindowFocusRestore) {
          // Chrome accepted the focus request, but the synchronous return still
          // reports the old state. Follow-up windows.get observes convergence.
          state.failNextWindowFocusRestore = false;
          return { id: windowId, type: windowId === 7 ? 'normal' : 'popup', state: 'normal', focused: false };
        }
        return {
          id: windowId,
          type: 'popup',
          state: updateData.state ?? 'normal',
          focused: state.internalFocusedWindowId === windowId,
        };
      },
      get: async windowId => {
        const delayedWorkspaceState = windowId === 9 && state.workspaceStableReadLag > 0;
        if (delayedWorkspaceState)
          state.workspaceStableReadLag--;
        return {
          id: windowId,
          type: 'popup',
          state: delayedWorkspaceState || windowId === 15 ? 'minimized' : 'normal',
          focused: windowId === 14 || windowId === 19 || state.internalFocusedWindowId === windowId,
          left: 120,
          top: 80,
          width: 900,
          height: 700,
        };
      },
      remove: async windowId => {
        removedWindows.push(windowId);
        if (state.internalFocusedWindowId === windowId)
          state.internalFocusedWindowId = undefined;
      },
    },
    tabs: {
      query: async query => {
        if (Object.keys(query).length === 0) {
          return [...tabUrls].map(([id, url]) => ({
            id, windowId: tabWindows.get(id), groupId: -1, url,
            ...(tabPendingUrls.has(id) ? { pendingUrl: tabPendingUrls.get(id) } : {}),
          }));
        }
        if (query.windowId === 7) {
          return [
            { id: 10, windowId: 7, groupId: 4 },
            { id: 11, windowId: 7, groupId: 4 },
            // ID 12 was never agent-owned. Recovery must preserve user tabs that
            // happen to be present in the private workspace window.
            { id: 12, windowId: 7, groupId: -1 },
            { id: 13, windowId: 7, groupId: -1 },
          ];
        }
        if (query.windowId === 9)
          return [{ id: 30, windowId: 9, groupId: -1, url: tabUrls.get(30) }];
        if (query.windowId === 14)
          return [{ id: 50, windowId: 14, groupId: 5 }, { id: 51, windowId: 14, groupId: -1 }];
        if (query.windowId === 15)
          return [{ id: 60, windowId: 15, groupId: 6 }, { id: 61, windowId: 15, groupId: -1 }];
        if (query.windowId === 16)
          return [{ id: 70, windowId: 16, groupId: 7 }, { id: 71, windowId: 16, groupId: -1 }];
        if (query.windowId === 17)
          return [{ id: 80, windowId: 17, groupId: -1, url: 'chrome-extension://test/status.html#agent-workspace=slot' }];
        if (query.windowId === 18)
          return [
            { id: 90, windowId: 18, groupId: 8 },
            { id: 91, windowId: 18, groupId: -1, url: tabUrls.get(91) },
          ].filter(tab => !removedTabs.includes(tab.id));
        if (query.windowId === 19)
          return [{ id: 100, windowId: 19, groupId: 9, url: 'https://example.com/form' }];
        if (query.windowId === 20)
          return [{ id: 110, windowId: 20, groupId: -1, url: tabUrls.get(110) }];
        if (query.windowId === 21)
          return [{ id: 120, windowId: 21, groupId: -1, url: tabUrls.get(120) }];
        if (query.windowId === 22)
          return [{ id: 130, windowId: 22, groupId: -1, url: tabUrls.get(130) }];
        if (query.windowId === 23)
          return [{ id: 140, windowId: 23, groupId: -1, url: tabUrls.get(140) }];
        if (query.windowId === 24)
          return [
            { id: 150, windowId: 24, groupId: -1, url: tabUrls.get(150) },
            { id: 151, windowId: 24, groupId: -1, url: tabUrls.get(151) },
          ];
        return [];
      },
      remove: async tabIds => removedTabs.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      create: async createData => {
        createdTabs.push(createData);
        return { id: nextCreatedTabId++, windowId: createData.windowId ?? 7, groupId: -1 };
      },
      get: async tabId => {
        const active = tabId === state.internalActiveUserTabId && state.userTabActiveReadLag === 0;
        if (tabId === state.internalActiveUserTabId && state.userTabActiveReadLag > 0)
          state.userTabActiveReadLag--;
        return {
          id: tabId,
          windowId: tabWindows.get(tabId) ?? 9,
          groupId: -1,
          active,
          ...(tabUrls.has(tabId) ? { url: tabUrls.get(tabId) } : {}),
          ...(tabPendingUrls.has(tabId) ? { pendingUrl: tabPendingUrls.get(tabId) } : {}),
        };
      },
      move: async (tabId, moveProperties) => {
        if (failedMoveTabIds.has(tabId))
          throw new Error('simulated move failure');
        movedTabs.push([tabId, moveProperties]);
        tabWindows.set(tabId, moveProperties.windowId);
        return { id: tabId, windowId: moveProperties.windowId, groupId: -1 };
      },
      update: async (tabId, updateProperties = {}) => {
        updatedTabs.push([tabId, updateProperties]);
        if (state.failNextTabUpdate) {
          state.failNextTabUpdate = false;
          throw new Error('simulated tab update failure');
        }
        if (updateProperties.url) {
          const targetUrl = updateProperties.url;
          tabPendingUrls.set(tabId, targetUrl);
          setTimeout(() => {
            if (tabPendingUrls.get(tabId) === targetUrl) {
              tabPendingUrls.delete(tabId);
              tabUrls.set(tabId, targetUrl);
            }
          }, 20);
        }
        if (updateProperties.active === true) {
          state.internalActiveUserTabId = tabId;
          state.userTabActiveReadLag = state.nextUserTabActiveReadLag;
          state.nextUserTabActiveReadLag = 0;
        }
        return {
          id: tabId,
          windowId: tabWindows.get(tabId) ?? 9,
          groupId: -1,
          active: updateProperties.active === true,
          url: tabUrls.get(tabId),
          ...(tabPendingUrls.has(tabId) ? { pendingUrl: tabPendingUrls.get(tabId) } : {}),
        };
      },
      group: async options => {
        groupedTabs.push(options);
        return 1;
      },
      ungroup: async tabIds => ungroupedTabs.push(...(Array.isArray(tabIds) ? tabIds : [tabIds])),
      onUpdated: event(),
      onRemoved: event(),
      onCreated: event(),
      onDetached: event(),
    },
    tabGroups: {
      query: async query => {
        if (query.windowId === 7)
          return [{ id: 4, windowId: 7, title: 'Playwright · test-agent' }];
        if (query.windowId === 14)
          return [{ id: 5, windowId: 14, title: 'Playwright · focused-agent' }];
        if (query.windowId === 18)
          return [{ id: 8, windowId: 18, title: 'Playwright · interrupted-agent' }];
        return [];
      },
      update: async () => {},
    },
    debugger: {
      attach: async () => {},
      detach: async () => {},
      sendCommand: async () => ({}),
      onEvent: event(),
      onDetach: event(),
    },
  };
  

  return {
    state,
    removedTabs,
    removedWindows,
    createdWindows,
    updatedWindows,
    createdTabs,
    updatedTabs,
    removedStorageKeys,
    stored,
    startupEvent,
    portMessages,
    movedTabs,
    groupedTabs,
    ungroupedTabs,
    tabWindows,
    tabUrls,
    port,
  };
}

module.exports = { installChromeMock };
