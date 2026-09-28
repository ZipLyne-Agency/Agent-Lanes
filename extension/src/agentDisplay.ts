// The agent display is a virtual screen held open by agent-display/agent-lane-display.
// Nothing ever shows it, so lanes parked there never sit on the user's monitors
// and never tempt anyone to close them. Chrome still renders and accepts trusted
// input there at full frame rate (live-proven 2026-09-28 with Chrome 154).
//
// Everything here is best effort and fails soft: without the display (helper
// stopped, macOS update broke CGVirtualDisplay) lanes fall back to the corner
// of the user's window, exactly as before.

export const AGENT_DISPLAY_NAME = 'Agent Lanes';
// Must match kWidth/kHeight in agent-display/agent-lane-display.m.
export const AGENT_DISPLAY_WIDTH = 1440;
export const AGENT_DISPLAY_HEIGHT = 900;

export type Bounds = { left: number; top: number; width: number; height: number };
type DisplayUnit = chrome.system.display.DisplayUnitInfo;

function sharesAnEdge(a: Bounds, b: Bounds): boolean {
  const overlapX = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const overlapY = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return (overlapX > 0 && overlapY >= 0) || (overlapY > 0 && overlapX >= 0);
}

// Chrome fills DisplayUnitInfo.name only on ChromeOS, so on a Mac the agent
// display is recognised by what its helper controls: its exact size, and a
// position that touches the other displays at a corner only. The System
// Settings arrangement snaps real screens edge to edge, so no real monitor
// ends up placed that way.
function isAgentDisplayUnit(unit: DisplayUnit, all: DisplayUnit[]): boolean {
  if (unit.isEnabled === false || unit.mirroringSourceId)
    return false;
  if (unit.name === AGENT_DISPLAY_NAME)
    return true;
  if (unit.isPrimary || unit.bounds.width !== AGENT_DISPLAY_WIDTH || unit.bounds.height !== AGENT_DISPLAY_HEIGHT)
    return false;
  const others = all.filter(other => other.id !== unit.id && !other.mirroringSourceId);
  return others.length > 0 && others.every(other => !sharesAnEdge(unit.bounds, other.bounds));
}

async function displayUnits(): Promise<DisplayUnit[]> {
  const api = (globalThis as { chrome?: typeof chrome }).chrome?.system?.display;
  if (!api?.getInfo)
    return [];
  try {
    return await api.getInfo();
  } catch {
    return [];
  }
}

export async function findAgentDisplay(): Promise<DisplayUnit | undefined> {
  const units = await displayUnits();
  return units.find(unit => isAgentDisplayUnit(unit, units));
}

async function primaryDisplay(): Promise<DisplayUnit | undefined> {
  const all = await displayUnits();
  const units = all.filter(unit => !isAgentDisplayUnit(unit, all));
  return units.find(unit => unit.isPrimary) ?? units[0];
}

export function onDisplayChanged(listener: () => void): void {
  (globalThis as { chrome?: typeof chrome }).chrome?.system?.display?.onDisplayChanged?.addListener(listener);
}

// Centred inside the display's work area, never larger than it.
export function boundsWithin(unit: DisplayUnit, width: number, height: number): Bounds {
  const area = unit.workArea ?? unit.bounds;
  const fittedWidth = Math.min(width, area.width);
  const fittedHeight = Math.min(height, area.height);
  return {
    left: area.left + Math.floor((area.width - fittedWidth) / 2),
    top: area.top + Math.floor((area.height - fittedHeight) / 2),
    width: fittedWidth,
    height: fittedHeight,
  };
}

export function isWindowOnDisplay(window: chrome.windows.Window | undefined, unit: DisplayUnit): boolean {
  if (!window || window.left === undefined || window.top === undefined || window.width === undefined || window.height === undefined)
    return false;
  const centreX = window.left + window.width / 2;
  const centreY = window.top + window.height / 2;
  const area = unit.bounds;
  return centreX >= area.left && centreX < area.left + area.width && centreY >= area.top && centreY < area.top + area.height;
}

// Where a user window belongs when it has to come off the agent display: the
// primary display, keeping its size when that fits.
export async function userWindowBounds(window?: chrome.windows.Window): Promise<Bounds | undefined> {
  const primary = await primaryDisplay();
  if (!primary)
    return undefined;
  const area = primary.workArea ?? primary.bounds;
  return boundsWithin(primary, Math.min(window?.width ?? 1280, Math.floor(area.width * 0.9)), Math.min(window?.height ?? 900, Math.floor(area.height * 0.9)));
}

// Any window that is not a lane but sits on the agent display is invisible to
// the user: a window Chrome opened next to a lane (Cmd-N after a lane became the
// last active window, an evicted link given its own window), or a lane the user
// reclaimed. Move each one to the primary display, where they can see it. Only
// windows in the normal state are moved; nothing is focused.
export async function returnStrayWindows(keep: (window: chrome.windows.Window) => boolean): Promise<number> {
  const agentDisplay = await findAgentDisplay();
  if (!agentDisplay)
    return 0;
  let moved = 0;
  const windows = await chrome.windows.getAll({ populate: true }).catch(() => [] as chrome.windows.Window[]);
  for (const window of windows) {
    if (window.id === undefined || window.state !== 'normal' || !isWindowOnDisplay(window, agentDisplay) || keep(window))
      continue;
    const bounds = await userWindowBounds(window);
    if (!bounds)
      continue;
    await chrome.windows.update(window.id, bounds).then(() => moved++, () => {});
  }
  return moved;
}
