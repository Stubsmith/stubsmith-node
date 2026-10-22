/**
 * Replay transport hooks. `installReplay(engine)` patches `http.request`,
 * `http.get`, `https.request`, `https.get` and `globalThis.fetch` so every
 * outbound call is answered from the engine and never reaches the network.
 *
 * Replay wins over capture: the hooks never call the function they replaced,
 * so a capture hook installed earlier is never reached, and one installed
 * later sees `replayActive()` and steps aside.
 */
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { Duplex, Writable } from "node:stream";
import type { Socket } from "node:net";
import { enterReplay, exitReplay } from "./replayState.js";
import type { ReplayEngine, ReplayRequest, ServedPayload } from "./replay/engine.js";

type Fn = (...args: unknown[]) => unknown;
type Opts = Record<string, unknown>;

/** Handle for one installation; `restore()` is idempotent. */
export interface ReplayInstallation {
  readonly engine: ReplayEngine;
  /** False once restored; a wrapper left in a foreign chain then delegates to the function it replaced. */
  readonly active: boolean;
  restore(): void;
}

const stack: Installation[] = [];

/** Every wrapper we installed, with the installation it belongs to and the function it replaced. */
const wrappers = new WeakMap<object, { inst: Installation; prev: unknown }>();

/** Skip down through wrappers of restored installations to the first live function. */
function unwind<T>(fn: T): T {
  let cur: unknown = fn;
  for (let w = wrappers.get(cur as object); w !== undefined && !w.inst.active; w = wrappers.get(cur as object)) cur = w.prev;
  return cur as T;
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

/**
 * Socket stand-in: a real (unconnected) `Duplex`, so `stream.finished`,
 * `destroy()` and `'close'` behave as on a `net.Socket`. `IncomingMessage`
 * calls `finished(socket)` when a response is destroyed (follow-redirects does
 * this on every 3xx), which a bare EventEmitter cannot satisfy.
 */
class FakeSocket extends Duplex {
  connecting = false;
  encrypted: boolean;
  readyState = "open";
  remoteAddress = "127.0.0.1";
  remotePort = 0;
  remoteFamily = "IPv4";
  localAddress = "127.0.0.1";
  localPort = 0;
  _httpMessage: unknown = null;

  constructor(encrypted: boolean) {
    super();
    this.encrypted = encrypted;
  }
  override _read(): void {}
  override _write(_chunk: unknown, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    cb();
  }
  setKeepAlive(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
  setTimeout(_ms?: number, cb?: () => void): this {
    if (cb) this.once("timeout", cb);
    return this;
  }
  ref(): this {
    return this;
  }
  unref(): this {
    return this;
  }
  address(): Record<string, unknown> {
    return { address: this.remoteAddress, family: this.remoteFamily, port: this.remotePort };
  }
}

/**
 * Split a comma-joined `Set-Cookie` value into its cookies, the way
 * `set-cookie-parser`'s `splitCookiesString` does: a comma separates cookies
 * only when followed by a `name=` token, so `Expires=Wed, 21 Oct 2015` stays whole.
 */
export function splitSetCookie(value: string): string[] {
  const out: string[] = [];
  const n = value.length;
  let start = 0;
  let i = 0;
  while (i < n) {
    if (value[i] !== ",") {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < n && /\s/.test(value[j] as string)) j++;
    let k = j;
    while (k < n && value[k] !== "=" && value[k] !== ";" && value[k] !== ",") k++;
    if (k < n && value[k] === "=" && k > j) {
      out.push(value.slice(start, i));
      start = j;
      i = k;
    } else {
      i++;
    }
  }
  out.push(value.slice(start));
  return out;
}

interface Target {
  protocol: string;
  host: string;
  port: string;
  path: string;
  method: string;
  url: string;
  headers: Opts;
  auth: string | undefined;
  signal: AbortSignal | undefined;
}

function urlToOptions(u: URL): Opts {
  return {
    protocol: u.protocol,
    hostname: u.hostname.startsWith("[") ? u.hostname.slice(1, -1) : u.hostname,
    port: u.port,
    path: `${u.pathname}${u.search}`,
    auth: u.username || u.password ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}` : undefined,
  };
}

/** Argument shapes of `http.request`: `(url, options?, cb?)` or `(options, cb?)`. */
function parseArgs(defaultProtocol: string, args: unknown[]): { target: Target; cb: Fn | undefined } {
  const [input, second, third] = args;
  let opts: Opts;
  let cb: Fn | undefined;
  if (typeof input === "string" || input instanceof URL) {
    opts = urlToOptions(typeof input === "string" ? new URL(input) : input);
    if (typeof second === "function") cb = second as Fn;
    else {
      if (second !== null && typeof second === "object") opts = { ...opts, ...(second as Opts) };
      if (typeof third === "function") cb = third as Fn;
    }
  } else {
    opts = { ...((input ?? {}) as Opts) };
    if (typeof second === "function") cb = second as Fn;
  }

  const protocol = typeof opts["protocol"] === "string" && opts["protocol"] ? opts["protocol"] : defaultProtocol;
  let host = String(opts["hostname"] || opts["host"] || "localhost");
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  const port = opts["port"] === undefined || opts["port"] === null ? "" : String(opts["port"]);
  const isDefault = (protocol === "http:" && port === "80") || (protocol === "https:" && port === "443");
  let path = typeof opts["path"] === "string" && opts["path"] ? opts["path"] : "/";
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(path)
    ? path
    : `${protocol}//${host}${port && !isDefault ? `:${port}` : ""}${path.startsWith("/") ? "" : "/"}${path}`;
  if (!path.startsWith("/") && !/^[a-z][a-z0-9+.-]*:\/\//i.test(path)) path = `/${path}`;
  const headers = opts["headers"] !== null && typeof opts["headers"] === "object" && !Array.isArray(opts["headers"]) ? (opts["headers"] as Opts) : {};
  return {
    cb,
    target: {
      protocol,
      host,
      port,
      path,
      method: String(opts["method"] ?? "GET").toUpperCase(),
      url,
      headers,
      auth: typeof opts["auth"] === "string" ? opts["auth"] : undefined,
      signal: opts["signal"] instanceof AbortSignal ? opts["signal"] : undefined,
    },
  };
}

/** A `ClientRequest` look-alike: a Writable that collects the body and answers from the engine on `end()`. */
class FakeClientRequest extends Writable {
  method: string;
  path: string;
  host: string;
  protocol: string;
  aborted = false;
  reusedSocket = false;
  maxHeadersCount: number | null = null;
  res: http.IncomingMessage | null = null;
  socket: FakeSocket;
  connection: FakeSocket;
  agent: unknown = undefined;
  private readonly headers = new Map<string, { name: string; value: unknown }>();
  private readonly chunks: Buffer[] = [];

  constructor(
    private readonly inst: Installation,
    private readonly target: Target,
    cb: Fn | undefined,
  ) {
    super({ autoDestroy: false, emitClose: true });
    this.method = target.method;
    this.path = target.path;
    this.host = target.host.replace(/^\[|\]$/g, "");
    this.protocol = target.protocol;
    this.socket = this.connection = new FakeSocket(target.protocol === "https:");
    this.socket._httpMessage = this;

    for (const [k, v] of Object.entries(target.headers)) if (v !== undefined) this.setHeader(k, v as string);
    if (target.auth !== undefined && !this.hasHeader("authorization")) {
      this.setHeader("Authorization", `Basic ${Buffer.from(target.auth).toString("base64")}`);
    }
    if (cb) this.once("response", cb);

    process.nextTick(() => {
      if (!this.destroyed) this.emit("socket", this.socket);
    });
    this.once("finish", () => process.nextTick(() => this.answer()));

    const { signal } = target;
    if (signal !== undefined) {
      const onAbort = (): void => {
        const err = new Error("The operation was aborted") as Error & { code: string };
        err.name = "AbortError";
        err.code = "ABORT_ERR";
        this.destroy(err);
      };
      if (signal.aborted) process.nextTick(onAbort);
      else {
        signal.addEventListener("abort", onAbort, { once: true });
        this.once("close", () => signal.removeEventListener("abort", onAbort));
      }
    }
  }

  // -- headers (OutgoingMessage surface) ------------------------------------

  setHeader(name: string, value: unknown): this {
    this.headers.set(name.toLowerCase(), { name, value });
    return this;
  }
  getHeader(name: string): unknown {
    return this.headers.get(name.toLowerCase())?.value;
  }
  hasHeader(name: string): boolean {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string): void {
    this.headers.delete(name.toLowerCase());
  }
  getHeaders(): Record<string, unknown> {
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [k, v] of this.headers) out[k] = v.value;
    return out;
  }
  getHeaderNames(): string[] {
    return [...this.headers.keys()];
  }
  getRawHeaderNames(): string[] {
    return [...this.headers.values()].map((h) => h.name);
  }
  appendHeader(name: string, value: unknown): this {
    const cur = this.getHeader(name);
    if (cur === undefined) return this.setHeader(name, value);
    const joined = ([] as unknown[]).concat(cur, value);
    return this.setHeader(name, joined);
  }
  get headersSent(): boolean {
    return this.writableEnded;
  }
  get finished(): boolean {
    return this.writableEnded;
  }
  flushHeaders(): void {}
  setNoDelay(): void {}
  setSocketKeepAlive(): void {}
  setTimeout(_ms: number, cb?: () => void): this {
    if (cb) this.once("timeout", cb);
    return this;
  }
  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    process.nextTick(() => this.emit("abort"));
    this.destroy();
  }

  // -- body ------------------------------------------------------------------

  override _write(chunk: Buffer | string, encoding: BufferEncoding, cb: (err?: Error | null) => void): void {
    this.chunks.push(typeof chunk === "string" ? Buffer.from(chunk, encoding) : Buffer.from(chunk));
    cb();
  }

  // -- answering -------------------------------------------------------------

  private requestHeaders(): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [k, v] of this.headers) {
      out[k] = Array.isArray(v.value) ? v.value.map(String) : String(v.value);
    }
    return out;
  }

  private answer(): void {
    if (this.destroyed || this.aborted) return;
    let payload: ServedPayload;
    try {
      const req: ReplayRequest = {
        method: this.method,
        url: this.target.url,
        headers: this.requestHeaders(),
        body: Buffer.concat(this.chunks),
      };
      payload = this.inst.engine.serve(req);
    } catch (err) {
      this.destroy(err as Error);
      return;
    }
    const res = new http.IncomingMessage(this.socket as unknown as Socket);
    const rawHeaders: string[] = [];
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(payload.headers)) {
      rawHeaders.push(k, v);
      const lower = k.toLowerCase();
      if (lower === "set-cookie") {
        headers[lower] = [...((headers[lower] as string[] | undefined) ?? []), ...splitSetCookie(v)];
        continue;
      }
      headers[lower] = lower in headers ? `${headers[lower] as string}, ${v}` : v;
    }
    res.statusCode = payload.status;
    res.statusMessage = payload.statusText;
    res.httpVersion = "1.1";
    res.httpVersionMajor = 1;
    res.httpVersionMinor = 1;
    res.rawHeaders = rawHeaders;
    res.headers = headers as http.IncomingHttpHeaders;
    res.complete = true;
    (res as unknown as { req: unknown }).req = this;
    (res as unknown as { url: string }).url = "";
    this.res = res;
    if (payload.body.length > 0) res.push(Buffer.from(payload.body));
    res.push(null);

    res.once("end", () => process.nextTick(() => this.destroy()));
    if (this.listenerCount("response") === 0) res.resume();
    this.emit("response", res);
  }
}

// ---------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/** Give a constructed Response the `url` of the request; `clone()` keeps it. */
function decorate(res: Response, url: string): void {
  for (const [k, v] of [
    ["url", url],
    ["redirected", false],
    ["type", "basic"],
  ] as const) {
    Object.defineProperty(res, k, { value: v, enumerable: false, configurable: true });
  }
  const nativeClone = res.clone;
  Object.defineProperty(res, "clone", {
    value: function clone(this: Response): Response {
      const copy = nativeClone.call(this);
      decorate(copy, url);
      return copy;
    },
    enumerable: false,
    configurable: true,
    writable: true,
  });
}

/** `data:` and `blob:` URLs never touch the network, so there is nothing to replay. */
function isLocalUrl(input: string | URL | Request): boolean {
  const url = input instanceof Request ? input.url : String(input);
  return /^(data|blob):/i.test(url);
}

async function replayFetch(
  inst: Installation,
  original: typeof fetch,
  input: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (isLocalUrl(input)) return original.call(globalThis, input, init);
  const request = new Request(input, init);
  if (request.signal.aborted) throw request.signal.reason;
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body = request.body === null ? null : new Uint8Array(await request.arrayBuffer());
  // Real fetch is asynchronous, so an abort fired right after the call still wins.
  await new Promise<void>((resolve) => setImmediate(resolve));
  if (request.signal.aborted) throw request.signal.reason;
  const payload = inst.engine.serve({ method: request.method, url: request.url, headers, body });
  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(payload.headers)) outHeaders.append(k, v);
  const res = new Response(NULL_BODY_STATUS.has(payload.status) || payload.body.length === 0 ? null : payload.body, {
    status: payload.status,
    statusText: payload.statusText,
    headers: outHeaders,
  });
  decorate(res, request.url);
  return res;
}

// ---------------------------------------------------------------------------
// install / uninstall
// ---------------------------------------------------------------------------

class Installation implements ReplayInstallation {
  active = true;
  private readonly undo: Array<() => void> = [];

  constructor(readonly engine: ReplayEngine) {
    for (const mod of [http, https]) this.patchModule(mod);
    this.patchFetch();
    enterReplay();
    syncBuiltinESMExports();
  }

  private patchModule(mod: typeof http | typeof https): void {
    const origRequest = mod.request as unknown as Fn;
    const origGet = mod.get as unknown as Fn;
    const defaultProtocol = mod === http ? "http:" : "https:";
    const isActive = (): boolean => this.active;
    const make = (target: Target, cb: Fn | undefined): http.ClientRequest =>
      new FakeClientRequest(this, target, cb) as unknown as http.ClientRequest;
    const wrappedRequest = (function (this: unknown, ...args: unknown[]) {
      if (!isActive()) return origRequest.apply(this, args);
      const { target, cb } = parseArgs(defaultProtocol, args);
      return make(target, cb);
    }) as Fn;
    const wrappedGet = (function (this: unknown, ...args: unknown[]) {
      if (!isActive()) return origGet.apply(this, args);
      const req = wrappedRequest.apply(this, args) as http.ClientRequest;
      req.end();
      return req;
    }) as Fn;
    wrappers.set(wrappedRequest, { inst: this, prev: origRequest });
    wrappers.set(wrappedGet, { inst: this, prev: origGet });
    mod.request = wrappedRequest as unknown as typeof http.request;
    mod.get = wrappedGet as unknown as typeof http.get;
    this.undo.push(() => {
      // Something installed on top of us keeps its chain; our wrappers delegate once inactive.
      // When we are on top, also drop wrappers an earlier out-of-order restore left beneath us.
      if (mod.request === (wrappedRequest as unknown)) mod.request = unwind(origRequest) as unknown as typeof http.request;
      if (mod.get === (wrappedGet as unknown)) mod.get = unwind(origGet) as unknown as typeof http.get;
    });
  }

  private patchFetch(): void {
    const original = globalThis.fetch;
    if (typeof original !== "function" || typeof Request !== "function") return;
    const wrapper = ((input: string | URL | Request, init?: RequestInit) =>
      this.active ? replayFetch(this, original, input, init) : original.call(globalThis, input, init)) as typeof fetch;
    wrappers.set(wrapper, { inst: this, prev: original });
    globalThis.fetch = wrapper;
    this.undo.push(() => {
      if (globalThis.fetch === wrapper) globalThis.fetch = unwind(original);
    });
  }

  restore(): void {
    if (!this.active) return;
    this.active = false;
    for (const u of this.undo.reverse()) u();
    exitReplay();
    syncBuiltinESMExports();
    const i = stack.indexOf(this);
    if (i >= 0) stack.splice(i, 1);
  }
}

/**
 * Patch the four http/https functions and `globalThis.fetch` to answer from
 * `engine`. Installations nest; restore them in reverse order (LIFO). A
 * restored installation that is no longer on top leaves a wrapper in the chain
 * that delegates straight to the function it replaced.
 */
export function installReplay(engine: ReplayEngine): ReplayInstallation {
  const inst = new Installation(engine);
  stack.push(inst);
  return inst;
}

/** Restore the most recent installation (the originals, when it is the only one). No-op when none. */
export function uninstallReplay(): void {
  stack[stack.length - 1]?.restore();
}
