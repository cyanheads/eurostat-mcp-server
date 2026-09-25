/**
 * @fileoverview Await a load shared between concurrent callers without letting one
 * caller's cancellation reach the others.
 * @module services/shared-load
 */

import { requestCancelled } from '@cyanheads/mcp-ts-core/errors';

/**
 * Settle with a shared load for one caller, or reject as soon as that caller's own
 * signal aborts.
 *
 * `share` returns the in-flight or settled load, started without any caller's signal,
 * so an abort here only releases this caller: the load keeps running for everyone
 * else awaiting it and for the cache it fills. A caller already aborted is refused
 * before `share` runs, so it never starts a download it will not wait for.
 */
export function awaitShared<T>(signal: AbortSignal, share: () => Promise<T>): Promise<T> {
  const cancelled = () =>
    requestCancelled('The request was cancelled while waiting on a shared Eurostat download.');
  if (signal.aborted) return Promise.reject(cancelled());
  const shared = share();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancelled());
    signal.addEventListener('abort', onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
