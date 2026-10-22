/// <reference lib="esnext.disposable" />
import { installReplay } from "../replayHooks.js";
import type { ReplayInstallation } from "../replayHooks.js";
import type { ReplayEngine, ServedResponse } from "./engine.js";

/**
 * An active replay: while it is not restored, outbound `http`, `https` and
 * `fetch` calls are answered from the bundle and never reach the network, and
 * capture is suppressed. Create one with `replay()` or take one from `replayAll()`.
 *
 * Restore contexts in reverse order of creation. Also usable with
 * `using` / `await using`: `[Symbol.dispose]()` and `[Symbol.asyncDispose]()`
 * call `restore()`. The methods are attached only where the runtime defines
 * the symbols, which every supported Node version does.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ReplayContext {
  private readonly installation: ReplayInstallation;

  /** @internal Use `replay()` / `replayAll()`. Installs the hooks immediately. */
  constructor(
    private readonly engine: ReplayEngine,
    /** 0-based pass index under `replayAll()`, else 0. */
    readonly passIndex = 0,
  ) {
    this.installation = installReplay(engine);
  }

  /** File the bundle was loaded from, or null for an in-memory bundle. */
  get bundlePath(): string | null {
    return this.engine.bundlePath;
  }

  /** 1-based pass number under `replayAll()`, else 1. */
  get passNumber(): number {
    return this.passIndex + 1;
  }

  /** True until `restore()` is called. */
  get active(): boolean {
    return this.installation.active;
  }

  /**
   * Every response served through this context, in call order. Repeated calls
   * to the same endpoint appear once per call. Use it to assert coverage
   * instead of trusting that the code under test reached what you expected.
   */
  served(): ServedResponse[] {
    return this.engine.served();
  }

  /** Put the original `http`, `https` and `fetch` functions back and re-enable capture. Idempotent. */
  restore(): void {
    this.installation.restore();
  }
}

// The runtime methods are attached below; this merge makes `using` / `await using` type-check.
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ReplayContext extends Disposable, AsyncDisposable {}

// Disposal protocol, defined only where the runtime has the symbols (Node >= 18.18 / 20.4).
const proto = ReplayContext.prototype as unknown as Record<symbol, unknown>;
const dispose = (Symbol as unknown as { dispose?: symbol }).dispose;
const asyncDispose = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose;
if (dispose !== undefined) {
  Object.defineProperty(proto, dispose, {
    value(this: ReplayContext): void {
      this.restore();
    },
    writable: true,
    configurable: true,
  });
}
if (asyncDispose !== undefined) {
  Object.defineProperty(proto, asyncDispose, {
    value(this: ReplayContext): Promise<void> {
      this.restore();
      return Promise.resolve();
    },
    writable: true,
    configurable: true,
  });
}
