/**
 * Process-global shared state. Everything lives on `globalThis` under
 * `Symbol.for(...)` keys so duplicate copies of the package (ESM and CJS both
 * loaded, or two versions) see the same replay depth, capture guard, install
 * singleton and original `http.request`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import https from "node:https";

const DEPTH_KEY = Symbol.for("stubsmith.replayDepth");
const GUARD_KEY = Symbol.for("stubsmith.captureGuard");
const REQUEST_KEY = Symbol.for("stubsmith.originalRequest");

type Shared = Record<symbol, unknown>;
const g = globalThis as unknown as Shared;

/** Shared slot with a lazily created value. */
export function sharedSlot<T>(key: symbol, init: () => T): T {
  if (g[key] === undefined) g[key] = init();
  return g[key] as T;
}

interface Depth {
  n: number;
}
const depth = sharedSlot<Depth>(DEPTH_KEY, () => ({ n: 0 }));

/** True while at least one replay context is active (capture is suppressed). */
export function replayActive(): boolean {
  return depth.n > 0;
}

export function enterReplay(): void {
  depth.n += 1;
}

export function exitReplay(): void {
  if (depth.n > 0) depth.n -= 1;
}

/**
 * Outermost-frame guard. A hook that finds a store set does not capture; the
 * fetch hook and every SDK-internal request run inside `captureGuard.run(true, ...)`.
 */
export const captureGuard = sharedSlot<AsyncLocalStorage<true>>(GUARD_KEY, () => new AsyncLocalStorage<true>());

/**
 * The `http.request` / `https.request` that existed when the first copy of
 * the SDK loaded. The sender and the rules poller use these (not `fetch`), so
 * their sockets can be unref'd and they bypass the capture hooks.
 */
export const ORIGINAL_REQUEST = sharedSlot<{ http: typeof http.request; https: typeof https.request }>(REQUEST_KEY, () => ({
  http: http.request,
  https: https.request,
}));
