/**
 * Minimal HTTP client for the SDK's own traffic (ingest POSTs and rules sync).
 *
 * It uses the ORIGINAL `http.request` / `https.request` captured at module
 * load, not `fetch`: fetch sockets are ref'd, so a stalled endpoint would hold
 * the process open at exit. Here the socket is unref'd and the timeouts are
 * explicit, so nothing of the SDK's keeps a finished application alive. The
 * request is created inside `captureGuard.run`, so the capture hooks skip it.
 *
 * Callers whose request IS the work (the `pull` CLI, `fixtures()`) set
 * `holdProcess`: the socket and the deadline timer stay ref'd so the process
 * lives until the response arrives.
 */
import type { ClientRequest, IncomingHttpHeaders } from "node:http";
import { ORIGINAL_REQUEST, captureGuard } from "./replayState.js";

export interface TransportOptions {
  method: string;
  /** Sent as given (lowercase names keep the wire form of the old fetch-based sender). */
  headers: Record<string, string>;
  body?: Buffer;
  /**
   * Overall deadline for the exchange, also applied as the socket idle timeout.
   * With `holdProcess` it is only the idle timeout (no bytes for this long);
   * the overall deadline is then {@link HOLD_TOTAL_MS} unless `totalTimeoutMs` says otherwise.
   */
  timeoutMs: number;
  /**
   * Keep the process alive until the exchange finishes (no `unref()` on the
   * socket or the deadline timer). Default false: the SDK's background sender
   * and poller must never delay exit. Only standalone callers (CLI, `fixtures`,
   * `fetchBundle`) set it.
   */
  holdProcess?: boolean;
  /** Overall deadline override; defaults to `timeoutMs`, or {@link HOLD_TOTAL_MS} with `holdProcess`. */
  totalTimeoutMs?: number;
  /** Response bytes kept; the rest of the body is dropped and the connection destroyed. */
  maxBytes: number;
}

/**
 * Total deadline for `holdProcess` callers. A large bundle on a slow link can
 * legitimately take longer than the 30 s idle timeout; Python's per-operation
 * timeout does not cap the whole transfer either.
 */
export const HOLD_TOTAL_MS = 120_000;

export interface TransportResult {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** The body was cut at `maxBytes`; `body` is a prefix. */
  truncated: boolean;
  /** The response ended normally. False when the connection closed early. */
  complete: boolean;
}

export interface Transport {
  /** Rejects on a network error, a timeout or {@link Transport.abort}. */
  promise: Promise<TransportResult>;
  /** Destroy the connection; `promise` rejects. */
  abort(): void;
}

export function sendRequest(url: string, opts: TransportOptions): Transport {
  let req: ClientRequest | null = null;
  let aborted = false;
  const abort = (): void => {
    aborted = true;
    req?.destroy(new Error("aborted"));
  };

  const promise = new Promise<TransportResult>((resolve, reject) => {
    let settled = false;
    let total: NodeJS.Timeout | null = null;
    const fail = (err: unknown): void => {
      if (settled) return;
      settled = true;
      if (total) clearTimeout(total);
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const succeed = (r: TransportResult): void => {
      if (settled) return;
      settled = true;
      if (total) clearTimeout(total);
      resolve(r);
    };

    let u: URL;
    try {
      u = new URL(url);
    } catch (err) {
      fail(err);
      return;
    }
    const request = u.protocol === "https:" ? ORIGINAL_REQUEST.https : u.protocol === "http:" ? ORIGINAL_REQUEST.http : null;
    if (request === null) {
      fail(new Error(`unsupported protocol ${u.protocol}`));
      return;
    }
    const headers = { ...opts.headers };
    if (opts.body !== undefined) headers["content-length"] = String(opts.body.length);

    try {
      captureGuard.run(true, () => {
        req = request(u, { method: opts.method, headers }, (res) => {
          const chunks: Buffer[] = [];
          let got = 0;
          let truncated = false;
          const finish = (): void => {
            if (aborted) fail(new Error("aborted"));
            else {
              succeed({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).subarray(0, opts.maxBytes),
                truncated,
                complete: !truncated && res.complete,
              });
            }
          };
          res.on("data", (c: Buffer) => {
            if (got < opts.maxBytes) chunks.push(c);
            got += c.length;
            if (got > opts.maxBytes) {
              truncated = true;
              finish();
              res.destroy();
            }
          });
          res.on("end", finish);
          // A body cut short still reports the status and what was read; `complete` says it was cut.
          res.on("error", finish);
          res.on("close", finish);
        });
      });
    } catch (err) {
      fail(err);
      return;
    }
    const r = req as unknown as ClientRequest;
    const hold = opts.holdProcess === true;
    const totalMs = opts.totalTimeoutMs ?? (hold ? HOLD_TOTAL_MS : opts.timeoutMs);
    total = setTimeout(() => r.destroy(new Error("timeout")), totalMs);
    if (!hold) {
      total.unref();
      r.on("socket", (s) => s.unref());
    }
    r.setTimeout(opts.timeoutMs, () => r.destroy(new Error("timeout")));
    r.on("error", fail);
    r.end(opts.body);
    if (aborted) r.destroy(new Error("aborted"));
  });
  return { promise, abort };
}
