/**
 * Rules poller: keeps a {@link RulesCache} fresh from `GET {backendUrl}/v1/sdk/sync`.
 * Port of the poll loop in stubsmith/privacy/rules_cache.py (`_poll_once`,
 * `_http_get`). Unlike the Python original there is no legacy fallback: a 404
 * from sync only warns (once per outage) and keeps whatever rules are cached.
 *
 * Requests use the ORIGINAL `http.request` / `https.request` (captured at
 * module load) inside the capture guard, so the SDK never captures its own
 * traffic and its unref'd sockets never hold the process open.
 */
import { VERSION } from "./_version.js";
import { debugLog } from "./env.js";
import { parseJson } from "./internal/json.js";
import type { RulesCache } from "./privacy/index.js";
import { type Transport, sendRequest } from "./transport.js";

const SYNC_TIMEOUT_MS = 10_000;
/** Largest rules response read; anything beyond is cut and fails to parse. */
const MAX_SYNC_BYTES = 16 * 1024 * 1024;
export const USER_AGENT = `stubsmith-node/${VERSION}`;

export interface RulesPollerOptions {
  apiKey: string;
  backendUrl: string;
  /** Poll interval in ms. */
  intervalMs: number;
}

interface HttpResult {
  /** 0 for a network-level error. */
  status: number;
  /** Parsed JSON (objects are Maps) or `null` when absent or not JSON. */
  body: unknown;
}

export class RulesPoller {
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopped = false;
  private warned404 = false;
  private inflight: Transport | null = null;
  private waiters: Array<(ok: boolean) => void> = [];

  constructor(
    private readonly cache: RulesCache,
    private readonly opts: RulesPollerOptions,
  ) {}

  /** Immediate first sync, then every `intervalMs`. Idempotent. */
  start(): void {
    if (this.timer !== null || this.stopped) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.opts.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.release(this.cache.firstSyncDone);
  }

  /**
   * Resolves true once the first sync completed, false on timeout or stop.
   * The wait timer is ref'd on purpose: the poller's own socket and interval are not, so an
   * `await` on a fast-failing backend would otherwise let the process exit mid-await.
   * `unref` drops that: the wait alone then never keeps the process alive.
   */
  waitForFirstSync(timeoutMs: number, unref = false): Promise<boolean> {
    if (this.cache.firstSyncDone) return Promise.resolve(true);
    if (this.stopped || timeoutMs <= 0) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== done);
        resolve(false);
      }, timeoutMs);
      if (unref) timer.unref();
      const done = (ok: boolean): void => {
        clearTimeout(timer);
        resolve(ok);
      };
      this.waiters.push(done);
    });
  }

  /** One poll cycle. A tick is skipped while another poll is still in flight. */
  async pollOnce(): Promise<void> {
    if (this.inFlight || this.stopped) return;
    this.inFlight = true;
    try {
      await this.cycle();
    } catch (err) {
      debugLog(`rules-cache poll error: ${errText(err)}`);
    } finally {
      this.inFlight = false;
    }
  }

  private release(ok: boolean): void {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w(ok);
  }

  private async cycle(): Promise<void> {
    const base = this.opts.backendUrl;
    const syncUrl = `${base}/v1/sdk/sync?cursor=${this.cache.cursor}`;
    const { status, body } = await this.get(syncUrl);

    if (status === 404) {
      // Not a sync: keep any rules already held and do not mark the first sync done, so unsynced captures stay fully masked.
      if (!this.warned404) {
        this.warned404 = true;
        // After an earlier successful sync the cached rules are real and stay in use, so only traffic they do not cover is masked in full.
        const consequence = this.cache.firstSyncDone
          ? "Rules from the last successful sync stay in effect; anything they do not cover is masked in full until sync succeeds again."
          : "Every captured value is masked until sync succeeds.";
        console.warn(
          `stubsmith: rules sync returned HTTP 404 from ${syncUrl} - check backendUrl (configured: '${base}'). ${consequence}`,
        );
      }
      return;
    }
    if (status === 0) return; // network error: keep the cache
    if (status !== 200 || !(body instanceof Map)) {
      debugLog(`rules-cache: unexpected sync response status=${status} url=${syncUrl}`);
      return;
    }
    this.cache.applySyncResponse(body);
    // A later 404 is a new outage, so it gets its own warning, worded for the rules this sync just delivered.
    this.warned404 = false;
    debugLog(`rules-cache: synced, cursor=${this.cache.cursor}`);
    this.release(true);
  }

  private async get(url: string): Promise<HttpResult> {
    try {
      const t = sendRequest(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.opts.apiKey}`, "user-agent": USER_AGENT },
        timeoutMs: SYNC_TIMEOUT_MS,
        maxBytes: MAX_SYNC_BYTES,
      });
      this.inflight = t;
      let res;
      try {
        res = await t.promise;
      } finally {
        if (this.inflight === t) this.inflight = null;
      }
      const text = new TextDecoder("utf-8").decode(res.body); // strips a BOM, like Response.text()
      if (res.status >= 400) {
        debugLog(`rules-cache: ${url} HTTP ${res.status}`);
        return { status: res.status, body: null };
      }
      try {
        return { status: res.status, body: parseJson(text) };
      } catch {
        debugLog(
          `rules-cache: ${url} returned non-JSON response (content-type=${String(res.headers["content-type"] ?? "")} status=${res.status})`,
        );
        return { status: res.status, body: null };
      }
    } catch (err) {
      debugLog(`rules-cache: network error fetching ${url} - ${errText(err)}`);
      return { status: 0, body: null };
    }
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}
