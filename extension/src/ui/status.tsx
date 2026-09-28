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

import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, TabItem  } from './tabItem';
import { AuthTokenSection } from './authToken';

type ConnectionStatus = {
  id: number;
  clientName?: string;
  connectedTabIds: number[];
};

type Connection = {
  id: number;
  clientName?: string;
  tabs: chrome.tabs.Tab[];
};

// Parked pool anchors load status.html with a workspace-marker fragment. That
// view must stay inert and secret-free: it sits in a visible background window,
// so it must never render the broker token, and it should tell the user that
// interacting with the window hands it back to them (focus = reclaim).
const isParkedWorkspaceMarker = (): boolean =>
  window.location.hash.startsWith('#agent-lane=') ||
  window.location.hash.startsWith('#agent-lane-reclaimed=') ||
  window.location.hash.startsWith('#agent-popup-workspace=') ||
  window.location.hash.startsWith('#agent-workspace=');

const ParkedWorkspaceApp: React.FC = () => (
  <div className='app-container'>
    <div className='content-wrapper'>
      <div className='status-banner'>
        <strong>{window.location.hash.startsWith('#agent-lane-reclaimed=') ? 'Agent browser lane (reclaimed by you)' : 'Agent browser lane (parked)'}</strong>
        <div style={{ marginTop: '8px' }}>
          This background window hosts automated agent tabs in your regular
          Chrome profile. Leave it open and ignore it: it stays behind your
          windows, agents add and remove their own tabs next to this one, and
          only one of them is shown at a time.
        </div>
        <div style={{ marginTop: '8px' }}>
          Clicking, focusing, moving, or resizing this window reclaims it for
          you and removes it from the agent pool. Closing it is always safe.
        </div>
      </div>
    </div>
  </div>
);

const StatusApp: React.FC = () => {
  const [connections, setConnections] = useState<Connection[]>([]);

  const loadStatus = async () => {
    const response = await chrome.runtime.sendMessage({ type: 'getConnectionStatus' });
    const statuses = (response.connections ?? []) as ConnectionStatus[];
    const loaded = await Promise.all(statuses.map(async ({ id, clientName, connectedTabIds }) => {
      const tabs = await Promise.all(connectedTabIds.map(tabId => chrome.tabs.get(tabId).catch(() => undefined)));
      return { id, clientName, tabs: tabs.filter(tab => !!tab) };
    }));
    setConnections(loaded);
  };

  useEffect(() => {
    void loadStatus();
  }, []);

  const openTab = async (tabId: number) => {
    await chrome.tabs.update(tabId, { active: true });
    window.close();
  };

  const disconnect = async (connectionId: number) => {
    await chrome.runtime.sendMessage({ type: 'disconnect', connectionId });
    await loadStatus();
  };

  return (
    <div className='app-container'>
      <div className='content-wrapper'>
        {connections.length > 0 ? (
          connections.map(connection => (
            <div className='connection' key={connection.id}>
              <div className='connection-header'>
                <div className='client-info'>
                  Connected to <strong>"{connection.clientName || 'unknown'}"</strong>
                </div>
                <Button variant='primary' onClick={() => disconnect(connection.id)}>
                  Disconnect
                </Button>
              </div>
              <div className='tab-section-title'>
                {connection.tabs.length === 1 ? 'Accessible page:' : 'Accessible pages:'}
              </div>
              <div>
                {connection.tabs.map(tab => (
                  <TabItem
                    key={tab.id}
                    tab={tab}
                    onClick={() => openTab(tab.id!)}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className='status-banner'>
            No clients are currently connected. You can connect from the Playwright CLI or MCP server by passing the --extension flag.
          </div>
        )}
        <AuthTokenSection />
      </div>
    </div>
  );
};

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(isParkedWorkspaceMarker() ? <ParkedWorkspaceApp /> : <StatusApp />);
}
