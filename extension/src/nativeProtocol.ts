/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 */

export type NativeHostMessage = {
  type: 'connect';
  requestId: string;
  relayUrl: string;
  clientName: string;
} | {
  type: 'hostReady';
  browserSessionId: string;
} | {
  type: 'status';
  requestId: string;
} | {
  type: 'preparePool';
  requestId: string;
  targetCapacity: number;
  // Create missing lanes on the agent display even though Chrome is not in
  // front. Sent only by the native bridge's fused background preparer.
  background?: boolean;
} | {
  type: 'discardPool';
  requestId: string;
};

export function isNativeReadyMessage(message: unknown): message is Extract<NativeHostMessage, { type: 'hostReady' }> {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as Partial<Extract<NativeHostMessage, { type: 'hostReady' }>>;
  return candidate.type === 'hostReady' && typeof candidate.browserSessionId === 'string' &&
    /^[a-f0-9]{64}$/.test(candidate.browserSessionId);
}

export function isNativeConnectMessage(message: unknown): message is Extract<NativeHostMessage, { type: 'connect' }> {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as Partial<Extract<NativeHostMessage, { type: 'connect' }>>;
  if (candidate.type !== 'connect' || typeof candidate.requestId !== 'string' ||
      typeof candidate.relayUrl !== 'string' || typeof candidate.clientName !== 'string' ||
      candidate.requestId.length > 128 || candidate.clientName.length > 128)
    return false;
  try {
    const relay = new URL(candidate.relayUrl);
    return relay.protocol === 'ws:' && (relay.hostname === '127.0.0.1' || relay.hostname === '[::1]' || relay.hostname === '::1');
  } catch {
    return false;
  }
}

export function isNativeStatusMessage(message: unknown): message is Extract<NativeHostMessage, { type: 'status' }> {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as Partial<Extract<NativeHostMessage, { type: 'status' }>>;
  return candidate.type === 'status' && typeof candidate.requestId === 'string' && candidate.requestId.length <= 128;
}

export function isNativePreparePoolMessage(message: unknown): message is Extract<NativeHostMessage, { type: 'preparePool' }> {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as Partial<Extract<NativeHostMessage, { type: 'preparePool' }>>;
  return candidate.type === 'preparePool' && typeof candidate.requestId === 'string' &&
    candidate.requestId.length <= 128 && Number.isInteger(candidate.targetCapacity) &&
    candidate.targetCapacity! >= 1 && candidate.targetCapacity! <= 8 &&
    (candidate.background === undefined || typeof candidate.background === 'boolean');
}

export function isNativeDiscardPoolMessage(message: unknown): message is Extract<NativeHostMessage, { type: 'discardPool' }> {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as Partial<Extract<NativeHostMessage, { type: 'discardPool' }>>;
  return candidate.type === 'discardPool' && typeof candidate.requestId === 'string' && candidate.requestId.length <= 128;
}

// The host's answer to an extension-initiated activeSpaceRequest. spaceId is
// the macOS Space the user is on, or null when it could not be read.
export function isNativeActiveSpaceResult(message: unknown): message is { type: 'activeSpaceResult'; requestId: string; spaceId: number | null } {
  if (!message || typeof message !== 'object')
    return false;
  const candidate = message as { type?: unknown; requestId?: unknown; spaceId?: unknown };
  return candidate.type === 'activeSpaceResult' && typeof candidate.requestId === 'string' && candidate.requestId.length <= 128 &&
    (candidate.spaceId === null || (typeof candidate.spaceId === 'number' && Number.isSafeInteger(candidate.spaceId) && candidate.spaceId > 0));
}
