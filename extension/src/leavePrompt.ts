// "Leave site? Changes you made may not be saved." Chrome asks this whenever a
// page with unsaved changes is left, and an agent leaves pages all the time:
// a navigation, a tab close, the end of its session. The prompt is a dialog
// window that takes Chrome's keyboard, so on a hidden lane nobody can see it,
// the user's typing in Chrome goes nowhere, and the agent's navigation hangs
// until it times out. The agent always means to leave, so the extension
// accepts the prompt itself and the agent never hears of it. Other dialogs
// (alert, confirm, prompt) still reach the agent, which answers them.

// How long closeAgentTabs keeps answering for a tab that has not closed yet.
export const CLOSE_TIMEOUT_MS = 5000;
// chrome.debugger.detach is not awaited on relay close, so an attach for the
// final close can briefly find the relay's debugger still on the tab.
const ATTACH_RETRY_MS = 100;
const ATTACH_ATTEMPTS = 5;

export function isLeavePrompt(method: string, params: any): boolean {
  return method === 'Page.javascriptDialogOpening' && params?.type === 'beforeunload';
}

export async function acceptLeavePrompt(source: chrome.debugger.Debuggee): Promise<void> {
  await chrome.debugger.sendCommand(source, 'Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
}

// Removes agent tabs whose relay has already detached. Without a debugger
// nothing would answer a prompt, so each tab is attached for its close with
// the Page domain on; closing the tab ends that attachment. A tab that cannot
// be attached (gone already, or a page Chrome keeps from extensions) is
// still removed.
export async function closeAgentTabs(tabIds: number[], timeoutMs = CLOSE_TIMEOUT_MS): Promise<void> {
  if (!tabIds.length)
    return;
  const watched = new Set<number>();
  const open = new Set(tabIds);
  let allClosed!: () => void;
  const closed = new Promise<void>(resolve => allClosed = resolve);
  const onEvent = (source: chrome.debugger.Debuggee, method: string, params?: object) => {
    if (source.tabId !== undefined && watched.has(source.tabId) && isLeavePrompt(method, params))
      void acceptLeavePrompt(source);
  };
  const onRemoved = (tabId: number) => {
    open.delete(tabId);
    if (!open.size)
      allClosed();
  };
  chrome.debugger.onEvent.addListener(onEvent);
  chrome.tabs.onRemoved.addListener(onRemoved);
  try {
    for (const tabId of tabIds) {
      if (await attachForClose(tabId))
        watched.add(tabId);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>(resolve => timer = setTimeout(resolve, timeoutMs));
    await chrome.tabs.remove(tabIds);
    for (const tabId of [...open]) {
      if (!await chrome.tabs.get(tabId).then(() => true, () => false))
        onRemoved(tabId);
    }
    await Promise.race([closed, timedOut]);
    clearTimeout(timer);
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
    chrome.tabs.onRemoved.removeListener(onRemoved);
    for (const tabId of watched) {
      if (open.has(tabId))
        await chrome.debugger.detach({ tabId }).catch(() => {});
    }
  }
}

async function attachForClose(tabId: number): Promise<boolean> {
  for (let attempt = 1; attempt <= ATTACH_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3');
    } catch (error: any) {
      if (attempt < ATTACH_ATTEMPTS && /already attached/i.test(String(error?.message ?? error))) {
        await new Promise(resolve => setTimeout(resolve, ATTACH_RETRY_MS));
        continue;
      }
      return false;
    }
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Page.enable');
      return true;
    } catch {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      return false;
    }
  }
  return false;
}
