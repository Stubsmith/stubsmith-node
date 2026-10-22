import { resolveBundle } from "./bundle.js";
import type { Bundle, BundleSource } from "./bundle.js";
import { ReplayContext } from "./context.js";
import { PassState, ReplayEngine } from "./engine.js";

export interface ReplayAllOptions {
  /** As for `replay()`: a bundle object, a path, or omitted to resolve `$STUBSMITH_BUNDLE` / `.stubsmith/bundle.json`. */
  bundle?: BundleSource;
  /**
   * Loop only recordings whose response status is in this set, e.g. `[200]` or
   * `[429, 500]`. Undefined loops every recording.
   *
   * Usually what you want: it decides what a red build means. Unfiltered, one
   * test body has to hold for successes and failures alike, and a status that
   * enters the window later breaks assertions written when only the other kind
   * existed. A shape with recordings but none of the requested status throws
   * `StubNotFound` naming the filter and the statuses it does have, rather
   * than substituting another status. Under a filter the first pass no longer
   * matches plain `replay()`, whose choice may not be in the set.
   */
  statuses?: Iterable<number>;
  /**
   * Hard ceiling on passes, as a backstop (default 64). Unfiltered, the pass
   * count is the largest recorded window among the shapes touched, roughly
   * (samples per status) x (distinct statuses), so it grows with traffic
   * without any code change; a `statuses` filter bounds it to one status's window.
   */
  maxPasses?: number;
}

/**
 * Run a block once per recorded response, to exercise the whole recorded window
 * rather than the one response plain `replay()` serves:
 *
 * ```ts
 * for await (const pass of replayAll({ statuses: [500, 502] })) {
 *   await expect(connector.syncOrders()).rejects.toThrow(UpstreamUnavailable);
 *   console.log(pass.passNumber, pass.served());
 * }
 * ```
 *
 * Each iteration yields an active `ReplayContext` (hooks installed for the loop
 * body, restored when the body finishes, throws, or `break`s). Semantics:
 *
 * - Pass one serves exactly what `replay()` serves (without a `statuses`
 *   filter); pass two serves the next recording of every shape, and so on.
 *   A shape's recordings are ordered primary status first (most frequent, then
 *   lowest status), then the other statuses ascending, samples newest first.
 * - Endpoints are never named. There is one cursor per request shape, fixed
 *   within a pass (a shape called twice in a pass serves the same recording
 *   both times) and advanced once per pass for the shapes touched in that pass.
 *   A shape first reached on a later pass is still looped from its first
 *   recording.
 * - A shape with fewer recordings than the current pass keeps serving its last
 *   one (clamped) rather than throwing; check `served()[i].exhausted` to tell.
 * - The loop stops when no touched shape has an unseen recording left, or after
 *   `maxPasses`.
 * - The body runs against a different recording each pass, so write assertions
 *   that hold for the whole range you are looping, or filter with `statuses`.
 *
 * A bundle with one recording per status (a default `stubsmith pull`) yields one
 * pass per status; for several recordings per status pull with `--samples all`.
 *
 * Misconfiguration (`maxPasses` below 1, an unreadable bundle) throws from this
 * call, before the first iteration.
 */
export function replayAll(opts: ReplayAllOptions = {}): AsyncGenerator<ReplayContext, void, undefined> {
  const maxPasses = opts.maxPasses ?? 64;
  if (!Number.isInteger(maxPasses) || maxPasses < 1) {
    throw new RangeError(`maxPasses must be a positive integer, got ${String(opts.maxPasses)}`);
  }
  // Resolve once: re-reading per pass could pick up a different bundle mid-loop.
  const { bundle, path } = resolveBundle(opts.bundle);
  const statuses = opts.statuses !== undefined ? [...opts.statuses] : undefined;
  return passes(bundle, path, statuses, maxPasses);
}

async function* passes(
  bundle: Bundle,
  bundlePath: string | null,
  statuses: number[] | undefined,
  maxPasses: number,
): AsyncGenerator<ReplayContext, void, undefined> {
  const state = new PassState();
  for (;;) {
    const engine = new ReplayEngine(bundle, { statuses, passState: state, bundlePath });
    const ctx = new ReplayContext(engine, state.passNo);
    try {
      yield ctx;
    } finally {
      ctx.restore();
    }
    const more = state.advance();
    if (!more || state.passNo >= maxPasses) return;
  }
}
