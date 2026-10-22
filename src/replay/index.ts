import { resolveBundle } from "./bundle.js";
import type { BundleSource } from "./bundle.js";
import { ReplayContext } from "./context.js";
import { ReplayEngine } from "./engine.js";
import type { SelectFn } from "./engine.js";

export { loadBundle, resolveBundle, findBundleUpward } from "./bundle.js";
export type {
  Bundle,
  BundleEndpoint,
  BundleSample,
  BundleStub,
  BundleTruncated,
  BundleVariant,
  BundleSource,
  ResolvedBundle,
} from "./bundle.js";
export { ReplayContext } from "./context.js";
export { ReplayEngine, ServedResponse, StubNotFound, byStatus } from "./engine.js";
export type { RecordedResponse, ReplayRequest, SelectFn, ServedPayload } from "./engine.js";
export { replayAll } from "./replayAll.js";
export type { ReplayAllOptions } from "./replayAll.js";

export interface ReplayOptions {
  /** A bundle object, a path, or omitted to resolve `$STUBSMITH_BUNDLE` / `.stubsmith/bundle.json` upward from the cwd. */
  bundle?: BundleSource;
  /**
   * Chooses which recorded response to serve. Receives the shape's recordings,
   * newest first within each status and ordered so the default choice is first;
   * return one of them, or null to force a `StubNotFound`. The default serves
   * the first: the newest recording of the most frequent status. `byStatus(n)`
   * covers the common case; to loop every recording use `replayAll()`.
   */
  select?: SelectFn;
  /** Only `"strict"` exists: every miss throws `StubNotFound`. */
  onMiss?: "strict";
}

/**
 * Answer outbound `http`, `https` and `fetch` calls from the recorded bundle,
 * without touching the network, until `restore()` is called. Capture is
 * suppressed while any replay is active.
 *
 * ```ts
 * const r = replay();
 * try { await checkout(cart); } finally { r.restore(); }
 * ```
 *
 * Throws when the bundle cannot be located or parsed, before any hook is installed.
 */
export function replay(opts: ReplayOptions = {}): ReplayContext {
  if (opts.onMiss !== undefined && opts.onMiss !== "strict") {
    throw new TypeError(`onMiss=${JSON.stringify(opts.onMiss)} is not supported. Currently only "strict" is accepted.`);
  }
  const { bundle, path } = resolveBundle(opts.bundle);
  return new ReplayContext(new ReplayEngine(bundle, { select: opts.select, bundlePath: path }));
}
