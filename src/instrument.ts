/**
 * Capture hooks and the install singleton.
 *
 * Two hooks feed {@link StubsmithClient.capture}:
 *  - `http.request` / `http.get` / `https.request` / `https.get` (the module
 *    exports are patched; the returned ClientRequest and its IncomingMessage are
 *    observed by wrapping `write`/`end`/`emit` on the instances, without adding
 *    listeners, so the caller's consumption and Node's own "dump an unlistened
 *    response" behaviour are unchanged);
 *  - `globalThis.fetch` (the caller gets a new Response whose body is a
 *    pass-through stream that records the chunks the caller pulls; there is no
 *    `clone()` tee, so a caller that cancels or stops reading releases the
 *    connection at once).
 *
 * Only the outermost frame captures: the fetch hook and the SDK's own requests
 * run inside `captureGuard.run`, which makes any http request issued beneath
 * them (a fetch polyfilled over http) skip capture. The http hook deliberately
 * does NOT use the async guard for its own request: async context would leak
 * into the caller's response callbacks and silence chained requests.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
import { brotliDecompressSync, gunzipSync, inflateRawSync, inflateSync } from "node:zlib";
import { debugLog, isDebug, warnOnce } from "./env.js";
import { utf8Decode } from "./internal/utf8.js";
import { type PendingHandle, StubsmithClient, beginPending } from "./client.js";
import { captureGuard, replayActive, sharedSlot } from "./replayState.js";
import type { HeaderRecord, StubsmithOptions } from "./types.js";

const CLIENT_KEY = Symbol.for("stubsmith.client");

/**
 * Per-body buffering cap. A body above it is not captured (nothing
 * half-captured is sent) and a one-time warning names the endpoint. A body
 * between the 10 MiB payload ceiling and this cap is still buffered and
 * captured, but the client then sends the oversize record instead (both
 * bodies omitted, `bodies_omitted: true`, shape recorded).
 */
export const MAX_CAPTURE_BODY_BYTES = 16 * 1024 * 1024;
const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * How long a response may sit with no reader attached before it is captured
 * with an empty body (Python streaming parity). A reader that attaches after
 * the grace period still gets every byte, but the capture was already made
 * with an empty body and is not made a second time; a debug log notes it.
 * Module state so tests can shorten it.
 */
let unreadGraceMs = 1000;
export function setUnreadGraceMsForTests(ms: number): void {
  unreadGraceMs = ms;
}

// ---------------------------------------------------------------------------
// Install singleton
// ---------------------------------------------------------------------------

interface InstallSlot {
  client: StubsmithClient | null;
  restore: Array<() => void>;
}
const slot = sharedSlot<InstallSlot>(CLIENT_KEY, () => ({ client: null, restore: [] }));

/**
 * Create the client and patch the hooks. Idempotent: returns the existing
 * client while it is not stopped and ignores the new options.
 */
export function install(options: StubsmithOptions = {}): StubsmithClient {
  const existing = slot.client;
  if (existing && !existing.stopped) return existing;
  const client = new StubsmithClient(options);
  slot.client = client;
  slot.restore = [];
  client.onClose(uninstall);
  // A client whose pipeline failed to initialise is disabled: nothing it could capture may be sent.
  if (client.enabled && client.pipeline !== null) {
    try {
      slot.restore.push(...patchHttp(client), ...patchFetch(client));
      syncBuiltinESMExports();
    } catch (err) {
      debugLog(`instrumentation failed: ${String(err)}`);
    }
  }
  return client;
}

/** True while an installed client exists and is not stopped. */
export function isInstalled(): boolean {
  return slot.client !== null && !slot.client.stopped;
}

/** Un-patch the hooks and clear the singleton. Does not flush; `close()` does that first. */
export function uninstall(): void {
  const restore = slot.restore;
  slot.restore = [];
  slot.client = null;
  for (const r of restore) {
    try {
      r();
    } catch {
      // un-patching must not throw
    }
  }
  try {
    syncBuiltinESMExports();
  } catch {
    // ignore
  }
}

function warnOversize(method: string, url: string): void {
  let hostPath = "unknown";
  try {
    const u = new URL(url);
    hostPath = `${u.host}${u.pathname}`;
  } catch {
    // keep the placeholder; never echo a URL that may carry credentials or a query
  }
  const key = `${method} ${hostPath}`;
  warnOnce(`oversize:${key}`, `stubsmith: ${key}: body over 16 MiB, capture dropped`);
}

/** Debug aid: report when another library replaced a patched function after we installed ours. */
function watchReplacement(client: StubsmithClient, label: string, current: () => unknown, wrapper: unknown): void {
  if (!isDebug()) return;
  const t = setImmediate(() => {
    if (slot.client !== client || client.stopped) return;
    if (current() !== wrapper) {
      debugLog(`${label} was replaced after stubsmith patched it; captures through the other wrapper may be missed or doubled`);
    }
  });
  t.unref();
}

/** Gate shared by both hooks. */
function shouldCapture(client: StubsmithClient): boolean {
  return !client.stopped && slot.client === client && captureGuard.getStore() === undefined && !replayActive();
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

type Fn = (this: unknown, ...args: unknown[]) => unknown;

/** Join repeated header values with `, ` keeping the first-seen name casing. */
function addHeader(out: HeaderRecord, lower: Map<string, string>, name: string, value: string): void {
  const key = name.toLowerCase();
  const prev = lower.get(key);
  if (prev === undefined) {
    lower.set(key, name);
    out[name] = value;
  } else {
    out[prev] = `${out[prev] ?? ""}, ${value}`;
  }
}

/** Decode a captured body for the pipeline: UTF-8, invalid bytes replaced. */
function decodeContent(body: Buffer, contentEncoding: string): string | null {
  if (body.length === 0) return "";
  try {
    let buf: Buffer = body;
    const codings = contentEncoding
      .toLowerCase()
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c && c !== "identity");
    for (const coding of codings.reverse()) {
      const opts = { maxOutputLength: MAX_DECODED_BYTES };
      if (coding === "gzip" || coding === "x-gzip") buf = gunzipSync(buf, opts);
      else if (coding === "br") buf = brotliDecompressSync(buf, opts);
      else if (coding === "deflate") {
        try {
          buf = inflateSync(buf, opts);
        } catch {
          buf = inflateRawSync(buf, opts);
        }
      } else return ""; // unknown coding: the bytes are not text
    }
    return utf8Decode(buf);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// http / https hook
// ---------------------------------------------------------------------------

function str(v: unknown): string | undefined {
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** Full request URL from the constructed ClientRequest plus the call arguments (for the port and userinfo). */
function requestUrl(req: http.ClientRequest, args: unknown[]): string {
  const a0 = args[0];
  const a1 = args[1];
  let base: URL | null = null;
  let opts: Record<string, unknown> = {};
  if (typeof a0 === "string") base = new URL(a0);
  else if (a0 instanceof URL) base = a0;
  else if (a0 !== null && typeof a0 === "object") opts = a0 as Record<string, unknown>;
  if (base && a1 !== null && typeof a1 === "object") opts = a1 as Record<string, unknown>;

  const overrides = ["protocol", "host", "hostname", "port", "path", "socketPath"].some((k) => opts[k] !== undefined);
  // Userinfo never reaches the pipeline (it would land in `domain`), and `options.auth` is never read.
  // The pipeline strips it as well.
  if (base && !overrides) {
    const u = new URL(base.href);
    u.hash = "";
    u.username = "";
    u.password = "";
    return u.href;
  }

  const protocol = req.protocol || str(opts["protocol"]) || base?.protocol || "http:";
  let host = req.host || str(opts["hostname"]) || str(opts["host"]) || base?.hostname.replace(/^\[|\]$/g, "") || "localhost";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const portRaw = opts["port"] ?? (base ? base.port : "");
  const port = portRaw === undefined || portRaw === null ? "" : String(portRaw);
  const isDefault = (protocol === "http:" && port === "80") || (protocol === "https:" && port === "443");
  let path = req.path || str(opts["path"]) || (base ? base.pathname + base.search : "/");
  if (!path.startsWith("/") && !/^https?:\/\//i.test(path)) path = `/${path}`;
  return `${protocol}//${host}${port && !isDefault ? `:${port}` : ""}${path}`;
}

function requestHeaders(req: http.ClientRequest): HeaderRecord {
  const out: HeaderRecord = {};
  const lower = new Map<string, string>();
  for (const name of req.getRawHeaderNames()) {
    const v = req.getHeader(name);
    if (v === undefined) continue;
    addHeader(out, lower, name, Array.isArray(v) ? v.join(", ") : String(v));
  }
  return out;
}

function responseHeaders(res: http.IncomingMessage): HeaderRecord {
  const out: HeaderRecord = {};
  const lower = new Map<string, string>();
  const raw = res.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) addHeader(out, lower, raw[i] as string, raw[i + 1] as string);
  return out;
}

/** Copy a written chunk into `sink`; returns false when the cap was exceeded. */
function bufferChunk(sink: { chunks: Buffer[]; bytes: number; over: boolean }, chunk: unknown, enc: unknown): void {
  if (sink.over || chunk === undefined || chunk === null || typeof chunk === "function") return;
  let b: Buffer;
  if (typeof chunk === "string") b = Buffer.from(chunk, Buffer.isEncoding(enc as string) ? (enc as BufferEncoding) : "utf8");
  else if (chunk instanceof Uint8Array) b = Buffer.from(chunk);
  else return;
  sink.bytes += b.length;
  if (sink.bytes > MAX_CAPTURE_BODY_BYTES) {
    sink.over = true;
    sink.chunks = [];
    return;
  }
  sink.chunks.push(b);
}

/** Start observing one ClientRequest. Everything here is best effort and silent. */
function track(client: StubsmithClient, req: http.ClientRequest, args: unknown[], source: "node-http"): void {
  const url = requestUrl(req, args);
  const method = (req.method || "GET").toUpperCase();
  const reqSink = { chunks: [] as Buffer[], bytes: 0, over: false };
  let reqHeaders: HeaderRecord | null = null;
  let endedAt = 0;
  let tapped = false;
  // Counts as in flight for flush() from request end until the capture is queued or dropped.
  let handle: PendingHandle | null = null;
  const ensurePending = (): PendingHandle => (handle ??= beginPending(client));
  // Set once the request emitted close or error: nothing can settle a handle begun after that.
  let closed = false;

  const origWrite = req.write as unknown as Fn;
  const origEnd = req.end as unknown as Fn;
  const origEmit = req.emit as unknown as Fn;

  (req as unknown as { write: Fn }).write = function (this: unknown, ...a: unknown[]) {
    try {
      bufferChunk(reqSink, a[0], a[1]);
    } catch {
      // never affect the caller
    }
    return origWrite.apply(this, a);
  };
  (req as unknown as { end: Fn }).end = function (this: unknown, ...a: unknown[]) {
    try {
      if (reqHeaders === null && !req.destroyed && !closed) {
        bufferChunk(reqSink, a[0], a[1]);
        reqHeaders = requestHeaders(req);
        endedAt = performance.now();
        ensurePending();
      }
    } catch {
      // never affect the caller
    }
    return origEnd.apply(this, a);
  };
  (req as unknown as { emit: Fn }).emit = function (this: unknown, ...a: unknown[]) {
    if (a[0] === "response" && !tapped) {
      tapped = true;
      try {
        tapResponse(client, a[1] as http.IncomingMessage, {
          url,
          method,
          source,
          reqSink,
          reqHeaders: () => reqHeaders ?? requestHeaders(req),
          startedAt: endedAt || performance.now(),
          pending: ensurePending(),
        });
      } catch (err) {
        debugLog(`response tap failed: ${String(err)}`);
      }
    } else if (a[0] === "close" || a[0] === "error") {
      closed = true;
      if (!tapped) handle?.settle(); // no response will ever arrive: nothing to wait for
    }
    return origEmit.apply(this, a);
  };
}

interface TapContext {
  url: string;
  method: string;
  source: "node-http";
  reqSink: { chunks: Buffer[]; bytes: number; over: boolean };
  reqHeaders: () => HeaderRecord;
  startedAt: number;
  pending: PendingHandle;
}

/**
 * Observe a response by wrapping `res.emit` on the instance. Every way a
 * caller can consume a Readable (data listener, pipe, async iterator,
 * `read()`) goes through `emit('data')`, so the tap sees exactly what the
 * caller reads without attaching a listener: no switch to flowing mode, no
 * change to back-pressure, and a response nobody listens for is still dumped
 * by Node. The cost is that a response the caller never reads never ends; a
 * timer captures that case with an empty body.
 */
function tapResponse(client: StubsmithClient, res: http.IncomingMessage, ctx: TapContext): void {
  const durationMs = performance.now() - ctx.startedAt;
  const sink = { chunks: [] as Buffer[], bytes: 0, over: false };
  let done = false;
  let dataSeen = false;
  let graceFired = false;
  let lateLogged = false;
  let timer: NodeJS.Timeout | null = null;

  const finish = (respBody: Buffer | null): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (respBody === null || sink.over || ctx.reqSink.over) {
      if (sink.over || ctx.reqSink.over) {
        debugLog(`capture skipped: body over ${MAX_CAPTURE_BODY_BYTES} bytes`);
        warnOversize(ctx.method, ctx.url);
      }
      ctx.pending.settle();
      return;
    }
    ctx.pending.finalizing();
    const headers = responseHeaders(res);
    const encoding = res.headers["content-encoding"];
    const status = res.statusCode ?? 0;
    // Pipeline CPU runs after the caller's own 'end' handlers and microtasks.
    setImmediate(() => {
      try {
        if (!shouldCaptureLate(client)) return;
        const text = decodeContent(respBody, typeof encoding === "string" ? encoding : "");
        client.capture({
          method: ctx.method,
          url: ctx.url,
          reqHeaders: ctx.reqHeaders(),
          reqBody: utf8Decode(Buffer.concat(ctx.reqSink.chunks)),
          status,
          respHeaders: headers,
          respBody: text ?? "",
          durationMs,
          source: ctx.source,
        });
      } catch (err) {
        debugLog(`capture failed: ${String(err)}`);
      } finally {
        ctx.pending.settle();
      }
    });
  };

  const origEmit = res.emit as unknown as Fn;
  (res as unknown as { emit: Fn }).emit = function (this: unknown, ...a: unknown[]) {
    const event = a[0];
    if (done && graceFired && !lateLogged && event === "data") {
      lateLogged = true;
      debugLog(`response read after the ${unreadGraceMs} ms grace period; the capture was already made with an empty body`);
    }
    if (!done && event === "data") {
      dataSeen = true;
      try {
        const chunk = a[1];
        if (typeof chunk === "string") {
          bufferChunk(sink, chunk, (res as unknown as { readableEncoding?: string | null }).readableEncoding ?? "utf8");
        } else {
          bufferChunk(sink, chunk, undefined);
        }
      } catch {
        // never affect the caller
      }
    }
    const ret = origEmit.apply(this, a);
    // The caller's handlers ran first.
    if (!done) {
      if (event === "end") finish(Buffer.concat(sink.chunks));
      else if (event === "close" || event === "error" || event === "aborted") finish(null);
    }
    return ret;
  };

  timer = setTimeout(() => {
    if (done) return;
    const reading = dataSeen || res.readableFlowing === true || res.listenerCount("readable") > 0;
    if (!reading) {
      graceFired = true;
      finish(Buffer.alloc(0)); // nobody reads this response: capture it as empty
    }
  }, unreadGraceMs);
  timer.unref();
}

function shouldCaptureLate(client: StubsmithClient): boolean {
  return !client.stopped && slot.client === client && !replayActive();
}

type RequestFn = typeof http.request;

function patchHttp(client: StubsmithClient): Array<() => void> {
  const restores: Array<() => void> = [];
  const patchModule = (mod: typeof http | typeof https): void => {
    const origRequest = mod.request as unknown as Fn;
    const origGet = mod.get;
    const wrappedRequest = function (this: unknown, ...args: unknown[]) {
      const req = origRequest.apply(this, args) as http.ClientRequest;
      try {
        if (shouldCapture(client)) track(client, req, args, "node-http");
      } catch (err) {
        debugLog(`http hook failed: ${String(err)}`);
      }
      return req;
    };
    // `get` is request plus an immediate end(); calling the patched request keeps one capture per call.
    const wrappedGet = function (this: unknown, ...args: unknown[]) {
      const req = wrappedRequest.apply(this, args);
      req.end();
      return req;
    };
    mod.request = wrappedRequest as unknown as RequestFn;
    mod.get = wrappedGet as unknown as typeof http.get;
    const label = mod === http ? "http" : "https";
    watchReplacement(client, `${label}.request`, () => mod.request, wrappedRequest);
    watchReplacement(client, `${label}.get`, () => mod.get, wrappedGet);
    restores.push(() => {
      // If something else wrapped on top of us, leave its chain alone; our wrapper is inert once uninstalled.
      if (mod.request === (wrappedRequest as unknown)) mod.request = origRequest as unknown as RequestFn;
      if (mod.get === (wrappedGet as unknown)) mod.get = origGet;
    });
  };
  patchModule(http);
  patchModule(https);
  return restores;
}

// ---------------------------------------------------------------------------
// fetch hook
// ---------------------------------------------------------------------------

interface Probe {
  url: string;
  method: string;
  headers: HeaderRecord;
  body: Promise<string>;
}

function headersToRecord(h: Headers): HeaderRecord {
  const out: HeaderRecord = {};
  const lower = new Map<string, string>();
  h.forEach((value, name) => addHeader(out, lower, name, value));
  return out;
}

function isStreamBody(body: unknown): boolean {
  if (body === null || typeof body !== "object") return false;
  const b = body as { getReader?: unknown; [Symbol.asyncIterator]?: unknown };
  return typeof b.getReader === "function" || typeof b[Symbol.asyncIterator] === "function";
}

/**
 * Describe the request without consuming the caller's inputs: a Request input
 * is cloned, a one-shot stream body (`duplex: 'half'`, ReadableStream, async
 * iterable) is skipped and captured as empty.
 */
function probeRequest(input: unknown, init: RequestInit | undefined): Probe {
  const initRec = init as (RequestInit & { duplex?: string }) | undefined;
  const streaming = initRec !== undefined && (initRec.duplex === "half" || isStreamBody(initRec.body));
  const base = input instanceof Request ? input.clone() : (input as string | URL);
  const probeInit: RequestInit | undefined = streaming ? { ...initRec, body: null, duplex: undefined } as RequestInit : init;
  const probe = new Request(base, probeInit);
  const body =
    probe.body === null
      ? Promise.resolve("")
      : readCapped(probe.body, MAX_CAPTURE_BODY_BYTES).then((b) => (b === null ? "" : utf8Decode(b)));
  return { url: probe.url, method: probe.method, headers: headersToRecord(probe.headers), body };
}

/** Read a web stream fully up to `cap` bytes; null when over the cap or on error. */
async function readCapped(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

function patchFetch(client: StubsmithClient): Array<() => void> {
  const original = globalThis.fetch;
  if (typeof original !== "function" || typeof Request !== "function") return [];

  const wrapper = async function stubsmithFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    if (!shouldCapture(client)) return original.call(globalThis, input, init);
    let probe: Probe | null = null;
    try {
      probe = probeRequest(input, init);
    } catch {
      probe = null; // the real fetch reports whatever is wrong with the arguments
    }
    // In flight for flush() from the call until the capture is queued or dropped.
    const pending = probe === null ? null : beginPending(client);
    const startedAt = performance.now();
    let response: Response;
    try {
      response = await captureGuard.run(true, () => original.call(globalThis, input, init));
    } catch (err) {
      pending?.settle();
      throw err;
    }
    if (probe === null || pending === null) return response;
    try {
      return watchResponse(client, probe, response, performance.now() - startedAt, pending);
    } catch (err) {
      pending.settle();
      debugLog(`fetch tap failed: ${String(err)}`);
      return response;
    }
  };
  globalThis.fetch = wrapper as typeof fetch;
  watchReplacement(client, "fetch", () => globalThis.fetch, wrapper);
  return [
    () => {
      if (globalThis.fetch === (wrapper as unknown)) globalThis.fetch = original;
    },
  ];
}

/**
 * Return a Response equivalent to `response` whose body records what the
 * caller pulls. No tee: the upstream reader is read only when the caller
 * reads (highWaterMark 0), and `cancel()` is forwarded upstream, so a caller
 * that stops reading closes the connection at once. A cancelled, failed or
 * over-cap body is dropped, never captured (aborted streams, like Python). A
 * body nobody pulls within the grace period is captured with an empty body; one
 * read in part and then left alone for the grace period is dropped. The body is
 * a byte stream (BYOB readers work) and `clone()` keeps `url`, `redirected`, `type`.
 * A null body (204, HEAD) is returned unchanged and captured empty.
 */
function watchResponse(
  client: StubsmithClient,
  probe: Probe,
  response: Response,
  durationMs: number,
  pending: PendingHandle,
): Response {
  const status = response.status;
  const respHeaders = headersToRecord(response.headers);

  const enqueue = (body: Uint8Array): void => {
    pending.finalizing();
    // The pipeline runs after the caller's own continuations.
    setImmediate(() => {
      void probe.body
        .then((reqBody) => {
          if (!shouldCaptureLate(client)) return;
          client.capture({
            method: probe.method,
            url: probe.url,
            reqHeaders: probe.headers,
            reqBody,
            status,
            respHeaders,
            respBody: utf8Decode(body),
            durationMs,
            source: "node-fetch",
          });
        })
        .catch((err: unknown) => debugLog(`fetch capture failed: ${String(err)}`))
        .finally(pending.settle);
    });
  };

  const upstream = response.body;
  if (upstream === null) {
    enqueue(new Uint8Array());
    return response;
  }

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const sink = { chunks: [] as Buffer[], bytes: 0, over: false };
  let done = false;
  let cancelled = false;
  let pulled = false;
  let graceFired = false;
  let abandoned = false;
  let lateLogged = false;
  let timer: NodeJS.Timeout | null = null;

  /** Stop recording without capturing. */
  const drop = (): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    pending.settle();
  };
  const complete = (): void => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    if (sink.over) {
      debugLog(`capture skipped: body over ${MAX_CAPTURE_BODY_BYTES} bytes`);
      warnOversize(probe.method, probe.url);
      pending.settle();
      return;
    }
    enqueue(Buffer.concat(sink.chunks));
  };

  /**
   * `grace` ms with no pull: an unread body is captured empty, a partly read
   * one is abandoned (dropped, never sent half-captured). Runs only between
   * pulls, never while an upstream read is in flight.
   */
  const armTimer = (): void => {
    if (timer) clearTimeout(timer);
    if (done) return;
    timer = setTimeout(() => {
      if (done) return;
      if (!pulled) {
        graceFired = true;
        complete(); // nobody reads this response: capture it as empty
      } else {
        abandoned = true;
        drop(); // read in part, then left alone: release it without a record
      }
    }, unreadGraceMs);
    timer.unref();
  };

  const stream = new ReadableStream<Uint8Array>(
    {
      type: "bytes" as unknown as undefined, // the DOM typings lack byte streams; Node has had them since 16.5
      async pull(controller) {
        pulled = true;
        if (timer) clearTimeout(timer);
        if ((graceFired || abandoned) && !lateLogged) {
          lateLogged = true;
          debugLog(
            graceFired
              ? `response read after the ${unreadGraceMs} ms grace period; the capture was already made with an empty body`
              : `response read after ${unreadGraceMs} ms without a read; the capture was dropped`,
          );
        }
        try {
          const r = await (reader as ReadableStreamDefaultReader<Uint8Array>).read();
          if (cancelled) return;
          if (r.done) {
            controller.close();
            // A pending BYOB read must be answered with an empty view once the stream is closed.
            (controller as unknown as { byobRequest: { respond(n: number): void } | null }).byobRequest?.respond(0);
            complete();
            return;
          }
          if (!done) bufferChunk(sink, r.value, undefined);
          // A byte stream transfers (detaches) what it is given; hand it a copy, the chunk may sit in a shared pool.
          controller.enqueue(new Uint8Array(r.value));
          armTimer();
        } catch (err) {
          drop();
          if (!cancelled) controller.error(err);
        }
      },
      cancel(reason) {
        cancelled = true;
        drop();
        return (reader as ReadableStreamDefaultReader<Uint8Array>).cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );

  // Everything that can throw happens before the upstream is locked.
  const out = new Response(stream, { status, statusText: response.statusText, headers: response.headers });
  // The constructor cannot set these; own non-enumerable data properties shadow the prototype getters.
  decorate(out, response.url, response.redirected, response.type);
  reader = upstream.getReader();

  // With the grace capture made `done` is set, so late chunks are forwarded but not recorded.
  armTimer();
  return out;
}

/**
 * Give a constructed Response the `url`, `redirected` and `type` of the real
 * one. They are non-enumerable like the native getters (`Object.keys` is
 * empty), and `clone()` re-applies them, recursively, since a native clone
 * reports `url === ''` and `type === 'default'`.
 */
function decorate(res: Response, url: string, redirected: boolean, type: Response["type"]): void {
  for (const [k, v] of [
    ["url", url],
    ["redirected", redirected],
    ["type", type],
  ] as const) {
    Object.defineProperty(res, k, { value: v, enumerable: false, configurable: true });
  }
  const nativeClone = res.clone;
  Object.defineProperty(res, "clone", {
    value: function clone(this: Response): Response {
      const copy = nativeClone.call(this);
      decorate(copy, url, redirected, type);
      return copy;
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}
