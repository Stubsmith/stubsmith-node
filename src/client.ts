/**
 * StubsmithClient: privacy pipeline, rules poller and the background sender.
 * Port of stubsmith/client.py (queue, enqueue size policy, flush, close,
 * sender) with a single async sender loop in place of the worker thread.
 *
 * `capture()` runs the privacy pipeline synchronously (pure CPU), applies
 * sampling AFTER it, serialises, enforces the payload ceiling and queues.
 * Nothing here ever throws into the host application.
 */
import { gzipSync } from "node:zlib";
import { DEFAULT_BACKEND_URL, DEFAULT_URL, debugLog, isDebug, readEnv, setDebug } from "./env.js";
import { PrivacyPipeline, RulesCache, templatePath } from "./privacy/index.js";
import { INGEST_ERROR_READ_BYTES, reportIngestRefusal } from "./refusals.js";
import { replayActive } from "./replayState.js";
import { RulesPoller, USER_AGENT } from "./sync.js";
import { type Transport, sendRequest } from "./transport.js";
import type { CapturedExchange, FlushOptions, StubsmithOptions } from "./types.js";

/** Largest serialised payload sent, in UTF-8 bytes. KEEP IN SYNC with ingest's MAX_PAYLOAD_BYTES. */
export const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
/** Ceiling on bytes held in the send queue (distinct from the item count). */
export const MAX_QUEUE_BYTES = 32 * 1024 * 1024;
export const QUEUE_MAXSIZE = 1000;
/** Payloads below this go uncompressed. */
export const COMPRESS_MIN_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FLUSH_MS = 5000;
const FLUSH_POLL_MS = 50;
/** How long, from client start, the sender holds a capture templated before the first rules sync. */
export const FIRST_SYNC_HOLD_MS = 5000;
const OVERSIZE_REPORTED_CAP = 1024;

interface QueueItem {
  json: string;
  /** UTF-8 byte length of `json`. */
  size: number;
  /**
   * Set only for a capture templated before the first rules sync: the wire payload (without the private
   * raw path) and that raw path, so the sender can template again once the grouping setting is known.
   */
  held?: { wire: Wire; rawPath: string };
}

type Wire = Record<string, unknown>;

/** Exchanges the capture hooks are tracking, split by phase. */
interface Counters {
  /** Observed, body not finished (and not abandoned). Never holds back the exit hook. */
  bodyInProgress: number;
  /** Body complete, capture not yet queued: the short window the exit hook does wait for. */
  finalizing: number;
}
const counters = new WeakMap<StubsmithClient, Counters>();

/** Handle returned to a capture hook for one observed exchange. */
export interface PendingHandle {
  /** The body is complete and the capture is about to be queued; idempotent, no-op once settled. */
  finalizing(): void;
  /** The capture was queued or dropped; idempotent. */
  settle(): void;
}

/**
 * Called by the capture hooks when they start observing an exchange.
 * `flush()` and `close()` wait for every outstanding handle; the beforeExit
 * hook waits only for those past `finalizing()`. Module-private: not
 * re-exported from the package entry.
 */
export function beginPending(client: StubsmithClient): PendingHandle {
  const c = counters.get(client);
  if (c === undefined) return { finalizing: () => undefined, settle: () => undefined };
  c.bodyInProgress++;
  let phase: "body" | "finalizing" | "settled" = "body";
  return {
    finalizing() {
      if (phase !== "body") return;
      phase = "finalizing";
      c.bodyInProgress = Math.max(0, c.bodyInProgress - 1);
      c.finalizing++;
    },
    settle() {
      if (phase === "settled") return;
      if (phase === "body") c.bodyInProgress = Math.max(0, c.bodyInProgress - 1);
      else c.finalizing = Math.max(0, c.finalizing - 1);
      phase = "settled";
    },
  };
}

/** Test aid: the current counters. */
export function pendingCounts(client: StubsmithClient): Readonly<Counters> {
  return { ...(counters.get(client) as Counters) };
}

export class StubsmithClient {
  readonly enabled: boolean;
  readonly url: string;
  readonly backendUrl: string;
  readonly timeoutMs: number;
  readonly sampleRate: number;
  readonly compress: boolean;
  readonly debug: boolean;
  /** Present only when enabled and the pipeline initialised. */
  readonly pipeline: PrivacyPipeline | null = null;
  readonly rulesCache: RulesCache | null = null;

  /** Hold, in ms from client start, for the first rules sync (see `resolveHeld`). Test aid: lower it to run fast. */
  static firstSyncHoldMs = FIRST_SYNC_HOLD_MS;

  /** Failed sends so far (network error or HTTP status >= 400). */
  sendFailures = 0;
  /** Captures dropped by the queue caps. */
  droppedCount = 0;

  private readonly apiKey: string;
  private readonly poller: RulesPoller | null = null;
  private startedAt = Date.now();
  /** waitIdle() calls in progress; while non-zero the sender does not hold captures for the first sync. */
  private flushing = 0;
  /** Releases a capture the sender is holding for the first sync (see `resolveHeld`). */
  private releaseHold: (() => void) | null = null;
  private readonly maxPayloadBytes: number;
  private readonly maxQueueBytes: number;
  private readonly maxQueueItems: number;
  private readonly exitFlushMs: number;
  private readonly setsDebug: boolean;
  private readonly queue: QueueItem[] = [];
  private queueBytes = 0;
  private pumping = false;
  private _stopped = false;
  private readonly counts: Counters = { bodyInProgress: 0, finalizing: 0 };
  private inflight: Transport | null = null;
  private closing: Promise<void> | null = null;
  /** Origin and path prefix of the ingest and backend URLs; exchanges under them are never captured. */
  private readonly ownPrefixes: UrlPrefix[];
  private readonly oversizeReported = new Set<string>();
  private closeHooks: Array<() => void> = [];
  private readonly exitHook: (() => void) | null = null;

  constructor(options: StubsmithOptions = {}) {
    counters.set(this, this.counts);
    const env = readEnv();
    this.apiKey = options.apiKey || env.apiKey;
    this.enabled = Boolean(this.apiKey);
    this.url = options.url || env.url || DEFAULT_URL;
    this.backendUrl = options.backendUrl || env.backendUrl || DEFAULT_BACKEND_URL;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sr = options.sampleRate ?? 1;
    this.sampleRate = Number.isNaN(sr) ? 1 : Math.max(0, Math.min(1, sr));
    this.compress = options.compress ?? true;
    this.setsDebug = options.debug !== undefined;
    if (options.debug !== undefined) setDebug(options.debug);
    this.debug = isDebug();
    this.maxPayloadBytes = options.limits?.maxPayloadBytes ?? MAX_PAYLOAD_BYTES;
    this.maxQueueBytes = options.limits?.maxQueueBytes ?? MAX_QUEUE_BYTES;
    this.maxQueueItems = options.limits?.maxQueueItems ?? QUEUE_MAXSIZE;
    this.exitFlushMs = env.flushTimeoutS * 1000;
    this.ownPrefixes = [this.url, this.backendUrl].map(urlPrefix).filter((p): p is UrlPrefix => p !== null);

    if (!this.enabled) return;

    try {
      const cache = new RulesCache();
      this.rulesCache = cache;
      this.pipeline = new PrivacyPipeline(cache, options.maskSalt === undefined ? {} : { salt: options.maskSalt });
      this.poller = new RulesPoller(cache, {
        apiKey: this.apiKey,
        backendUrl: this.backendUrl.replace(/\/+$/, ""),
        intervalMs: options.rulesPollInterval ?? 60_000,
      });
      this.poller.start();
      this.startedAt = Date.now();
    } catch (err) {
      // Fail closed: with the pipeline missing, capture() drops everything.
      this.pipeline = null;
      this.rulesCache = null;
      this.poller = null;
      debugLog(`privacy pipeline init failed: ${String(err)}`);
    }

    // The exit budget applies here only (not to close()). Once it ran out with work still queued, later
    // beforeExit rounds do not start another budget: that would hold the process open indefinitely.
    let gaveUp = false;
    this.exitHook = () => {
      if (this.exitFlushMs <= 0 || gaveUp || this.idle(false)) return;
      void this.waitIdle(this.exitFlushMs, false).then(() => {
        if (!this.idle(false)) gaveUp = true;
      });
    };
    process.on("beforeExit", this.exitHook);
  }

  /** True once `close()` completed. */
  get stopped(): boolean {
    return this._stopped;
  }

  /** True when the first rules sync has completed. */
  get rulesSynced(): boolean {
    return this.rulesCache?.firstSyncDone ?? false;
  }

  /**
   * Resolves true once rules are loaded, false on timeout or when disabled.
   * The wait holds the process open until it settles, even when the backend fails fast.
   */
  waitForRules(timeoutMs: number): Promise<boolean> {
    return this.poller ? this.poller.waitForFirstSync(timeoutMs) : Promise.resolve(false);
  }

  /** Run `fn` from `close()` (the instrumentation uses this to unpatch). */
  onClose(fn: () => void): void {
    this.closeHooks.push(fn);
  }

  /**
   * Mask one exchange and queue it. Synchronous and never throws. Cost is the
   * privacy pipeline plus one `JSON.stringify` of the payload.
   */
  capture(ex: CapturedExchange): void {
    if (!this.enabled || this._stopped || this.pipeline === null) return;
    if (replayActive()) return;
    // Backstop independent of the async guard: the SDK's own endpoints are never captured.
    if (this.isOwnUrl(ex.url)) return;
    try {
      const payload = this.pipeline.process({
        method: ex.method,
        url: ex.url,
        reqHeaders: ex.reqHeaders,
        reqBody: ex.reqBody,
        status: ex.status,
        respHeaders: ex.respHeaders,
        respBody: ex.respBody,
      });
      if (payload === null) return; // catastrophic pipeline failure: drop, never send raw
      const wire: Wire = { ...payload, source: ex.source, duration: Math.max(0, Math.round(ex.durationMs)) };
      if (this.sampleRate < 1 && Math.random() > this.sampleRate) return;
      this.enqueue(wire);
    } catch (err) {
      debugLog(`capture failed: ${String(err)}`);
    }
  }

  private enqueue(input: Wire): void {
    // The private raw path never reaches the serialised payload.
    const { _raw_path: rawPath, ...rest } = input;
    let payload: Wire = rest;
    let json = JSON.stringify(payload);
    let size = Buffer.byteLength(json, "utf8");
    if (size > this.maxPayloadBytes) {
      payload = this.omitBodies(payload, size);
      json = JSON.stringify(payload);
      size = Buffer.byteLength(json, "utf8");
    }
    if (this.queueBytes + size > this.maxQueueBytes) {
      this.droppedCount++;
      debugLog(`queue byte budget reached (${this.maxQueueBytes} bytes); capture dropped`);
      return;
    }
    if (this.queue.length >= this.maxQueueItems) {
      this.droppedCount++;
      debugLog(`queue full (${this.maxQueueItems} items); capture dropped`);
      return;
    }
    this.queueBytes += size;
    const item: QueueItem = { json, size };
    if (typeof rawPath === "string") item.held = { wire: payload, rawPath };
    this.queue.push(item);
    this.kick();
  }

  /**
   * Both bodies go, together, when the payload is over the ceiling: a partial
   * body is a sample that looks captured and is not. The shape is still
   * recorded server-side. Warned once per `METHOD path_template`.
   */
  private omitBodies(payload: Wire, size: number): Wire {
    const reqSize = Buffer.byteLength(String(payload["req_body"] || ""), "utf8");
    const respSize = Buffer.byteLength(String(payload["resp_body"] || ""), "utf8");
    const key = `${String(payload["method"] ?? "")} ${String(payload["path_template"] ?? "")}`;
    if (!this.oversizeReported.has(key) && this.oversizeReported.size < OVERSIZE_REPORTED_CAP) {
      this.oversizeReported.add(key);
      console.warn(
        `stubsmith: ${key} payload is ${size} bytes, over the ${this.maxPayloadBytes} byte limit; ` +
          `request ${reqSize} bytes, response ${respSize} bytes. The request shape is still ` +
          `recorded, but no sample is stored for this endpoint.`,
      );
    }
    return {
      ...payload,
      req_body: null,
      resp_body: null,
      bodies_omitted: true,
      omitted_reason: "payload_too_large",
      omitted_req_body_bytes: reqSize,
      omitted_resp_body_bytes: respSize,
    };
  }

  private isOwnUrl(url: string): boolean {
    if (this.ownPrefixes.length === 0) return false;
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return false;
    }
    return this.ownPrefixes.some(
      (p) => u.origin === p.origin && (p.path === "" || u.pathname === p.path || u.pathname.startsWith(`${p.path}/`)),
    );
  }

  /** `bodies`: also wait for exchanges whose body is still being read (explicit flush/close only). */
  private idle(bodies: boolean): boolean {
    return (!bodies || this.counts.bodyInProgress === 0) && this.counts.finalizing === 0 && this.queue.length === 0 && !this.pumping;
  }

  /** Start the single sender loop on the next macrotask when it is not running. */
  private kick(): void {
    if (this.pumping || this.queue.length === 0 || this._stopped) return;
    this.pumping = true;
    setImmediate(() => void this.pump());
  }

  private async pump(): Promise<void> {
    try {
      while (this.queue.length > 0 && !this._stopped) {
        const item = this.queue.shift() as QueueItem;
        try {
          await this.send(item.held ? await this.resolveHeld(item.held, item.json) : item.json);
        } finally {
          // Release the byte reservation whether or not the send worked.
          this.queueBytes = Math.max(0, this.queueBytes - item.size);
        }
      }
    } finally {
      this.pumping = false;
      if (this._stopped) this.clearQueue();
    }
  }

  /**
   * A capture processed before the first rules sync was templated with ID grouping on, because the
   * project's "Group IDs in paths automatically" setting was not yet known. The sender (never the
   * capturing call) waits for the first sync, at most `StubsmithClient.firstSyncHoldMs` from client start, then templates
   * the raw path again with the synced curated templates and setting. If the bound runs out the
   * capture-time values stand. The wait ends when a flush starts (`flush()`, `close()` or the exit hook: a
   * flush means send now, as before the hold existed) or `close()` stops the poller, and its timer is
   * unref'd.
   */
  private async resolveHeld(held: { wire: Wire; rawPath: string }, json: string): Promise<string> {
    const cache = this.rulesCache;
    if (cache === null || this.poller === null) return json;
    try {
      let synced = cache.firstSyncDone;
      if (!synced && !this._stopped && this.flushing === 0) {
        const released = new Promise<boolean>((resolve) => {
          this.releaseHold = () => resolve(cache.firstSyncDone);
        });
        try {
          synced = await Promise.race([
            this.poller.waitForFirstSync(this.startedAt + StubsmithClient.firstSyncHoldMs - Date.now(), true),
            released,
          ]);
        } finally {
          this.releaseHold = null;
        }
      }
      if (!synced) return json;
      const query = String(held.wire["path"] ?? "").split("?").slice(1).join("?");
      const pathTemplate = templatePath(held.rawPath, cache.pathTemplates, cache.groupIdsInPaths);
      return JSON.stringify({ ...held.wire, path_template: pathTemplate, path: pathTemplate + (query ? `?${query}` : "") });
    } catch {
      return json;
    }
  }

  private clearQueue(): void {
    this.queue.length = 0;
    this.queueBytes = 0;
  }

  /** POST one serialised capture. Failures are counted, never thrown. */
  private async send(json: string): Promise<void> {
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
        "user-agent": USER_AGENT,
      };
      let body: Buffer = Buffer.from(json, "utf8");
      // Only use gzip when it is actually smaller; below the threshold it costs
      // CPU and a header to save nothing.
      if (this.compress && body.length >= COMPRESS_MIN_BYTES) {
        try {
          const gz = gzipSync(body, { level: 6 });
          if (gz.length < body.length) {
            body = gz;
            headers["content-encoding"] = "gzip";
          }
        } catch {
          // ship uncompressed
        }
      }
      const t = sendRequest(this.url, {
        method: "POST",
        headers,
        body,
        timeoutMs: this.timeoutMs,
        maxBytes: INGEST_ERROR_READ_BYTES,
      });
      this.inflight = t;
      let res;
      try {
        res = await t.promise;
      } finally {
        if (this.inflight === t) this.inflight = null;
      }
      reportIngestRefusal(res.body, res.status, this.debug);
      if (res.status >= 400) {
        this.sendFailures++;
        debugLog(`send failed - status=${res.status} url=${this.url}`);
      }
    } catch (err) {
      // close() aborting the last send is not a failure of the endpoint.
      if (!this._stopped) this.sendFailures++;
      debugLog(`send failed - ${err instanceof Error ? err.name : "error"} url=${this.url}`);
    }
  }

  /**
   * Resolve when no capture is pending, the queue and the in-flight send are
   * empty, the timeout elapses, or a new send failure happened since the call
   * started (the endpoint is unreachable, so waiting longer only costs the
   * application). The poll timer is ref'd: the sender's sockets are not, so
   * this is what keeps the process alive while it waits.
   */
  async flush(opts: FlushOptions = {}): Promise<void> {
    const t = opts.timeoutMs ?? DEFAULT_FLUSH_MS;
    return this.waitIdle(Number.isFinite(t) ? Math.max(0, t) : DEFAULT_FLUSH_MS, true);
  }

  private async waitIdle(timeoutMs: number, bodies: boolean): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const failuresAtEntry = this.sendFailures;
    // A flush means "send now": stop holding captures for the first rules sync, so a short script's
    // exit flush is not spent waiting for a sync that may never come.
    this.flushing++;
    this.releaseHold?.();
    try {
      this.kick();
      for (;;) {
        if (this.idle(bodies)) return;
        if (this.sendFailures > failuresAtEntry) return;
        const left = deadline - Date.now();
        if (left <= 0) return;
        await new Promise<void>((resolve) => setTimeout(resolve, Math.min(FLUSH_POLL_MS, left)));
      }
    } finally {
      this.flushing--;
    }
  }

  /**
   * Stop the poller, flush (default 5 s, or `timeoutMs`; `STUBSMITH_FLUSH_TIMEOUT`
   * is the exit-hook budget and does not apply here), abort a send still in
   * flight, un-patch and mark stopped. Idempotent.
   */
  close(opts: FlushOptions = {}): Promise<void> {
    if (this._stopped) return Promise.resolve();
    this.closing ??= this.doClose(opts);
    return this.closing;
  }

  private async doClose(opts: FlushOptions): Promise<void> {
    this.poller?.stop();
    if (this.exitHook) process.off("beforeExit", this.exitHook);
    try {
      await this.flush({ timeoutMs: opts.timeoutMs ?? DEFAULT_FLUSH_MS });
    } finally {
      this._stopped = true;
      this.inflight?.abort();
      this.clearQueue();
      if (this.setsDebug) setDebug(undefined);
      const hooks = this.closeHooks;
      this.closeHooks = [];
      for (const h of hooks) {
        try {
          h();
        } catch {
          // un-patching must not throw
        }
      }
    }
  }
}

interface UrlPrefix {
  origin: string;
  /** Pathname without a trailing slash; empty means the whole origin. */
  path: string;
}

function urlPrefix(url: string): UrlPrefix | null {
  try {
    const u = new URL(url);
    return { origin: u.origin, path: u.pathname.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}
