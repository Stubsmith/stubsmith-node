import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import axios from "axios";
import got from "got";
import nodeFetch from "node-fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { install } from "../../src/instrument.js";
import { replayActive } from "../../src/replayState.js";
import { ReplayEngine, StubNotFound } from "../../src/replay/engine.js";
import { replay } from "../../src/replay/index.js";
import { installReplay, uninstallReplay } from "../../src/replayHooks.js";
import { startBackend, startUpstream, sleep } from "../helpers/servers.js";
import type { FakeBackend, Upstream } from "../helpers/servers.js";
import { BASE_URL, FP_EMPTY_GET, bundle, endpoint, fp, simpleBundle, stub, variant } from "./helpers.js";

const originals = {
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  fetch: globalThis.fetch,
};

const sockets: string[] = [];

beforeEach(() => {
  sockets.length = 0;
  const refuse = (what: string) => (): never => {
    sockets.push(what);
    throw new Error(`network attempted: ${what}`);
  };
  vi.spyOn(net, "connect").mockImplementation(refuse("net.connect"));
  vi.spyOn(net, "createConnection").mockImplementation(refuse("net.createConnection"));
  vi.spyOn(tls, "connect").mockImplementation(refuse("tls.connect"));
  vi.spyOn(net.Socket.prototype, "connect").mockImplementation(refuse("Socket#connect"));
});

afterEach(() => {
  vi.restoreAllMocks();
  expect(sockets).toEqual([]);
  expect(replayActive()).toBe(false);
});

function readBody(res: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on("data", (c: Buffer) => chunks.push(c));
    res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    res.on("error", reject);
  });
}

function httpGet(url: string): Promise<{ res: http.IncomingMessage; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    mod
      .get(url, (res) => readBody(res).then((body) => resolve({ res, body }), reject))
      .on("error", reject);
  });
}

describe("restore", () => {
  it("returns http.request/get, https.request/get and fetch to the identical originals", () => {
    const r = replay({ bundle: simpleBundle() });
    expect(http.request).not.toBe(originals.httpRequest);
    expect(http.get).not.toBe(originals.httpGet);
    expect(https.request).not.toBe(originals.httpsRequest);
    expect(https.get).not.toBe(originals.httpsGet);
    expect(globalThis.fetch).not.toBe(originals.fetch);
    expect(replayActive()).toBe(true);
    r.restore();
    expect(http.request).toBe(originals.httpRequest);
    expect(http.get).toBe(originals.httpGet);
    expect(https.request).toBe(originals.httpsRequest);
    expect(https.get).toBe(originals.httpsGet);
    expect(globalThis.fetch).toBe(originals.fetch);
    expect(replayActive()).toBe(false);
  });

  it("is idempotent and does not unbalance the replay depth", () => {
    const outer = replay({ bundle: simpleBundle() });
    const inner = replay({ bundle: simpleBundle() });
    inner.restore();
    inner.restore();
    expect(replayActive()).toBe(true);
    outer.restore();
    expect(replayActive()).toBe(false);
  });

  it("nested contexts restore LIFO to the identical originals, and the inner one wins while active", async () => {
    const outer = replay({ bundle: bundle(endpoint("GET", "/who", [stub(FP_EMPTY_GET, [variant(200, '"outer"')])])) });
    const inner = replay({ bundle: bundle(endpoint("GET", "/who", [stub(FP_EMPTY_GET, [variant(200, '"inner"')])])) });
    expect(await (await fetch(`${BASE_URL}/who`)).json()).toBe("inner");
    inner.restore();
    expect(await (await fetch(`${BASE_URL}/who`)).json()).toBe("outer");
    outer.restore();
    expect(globalThis.fetch).toBe(originals.fetch);
    expect(http.request).toBe(originals.httpRequest);
  });

  it("out-of-order restore leaves an inert wrapper beneath, and restoring the top one unwinds to the true originals", () => {
    const a = replay({ bundle: simpleBundle() });
    const b = replay({ bundle: simpleBundle() });
    a.restore(); // not on top: b's wrapper stays installed
    expect(globalThis.fetch).not.toBe(originals.fetch);
    expect(replayActive()).toBe(true);
    b.restore();
    expect(replayActive()).toBe(false);
    expect(http.request).toBe(originals.httpRequest);
    expect(http.get).toBe(originals.httpGet);
    expect(https.request).toBe(originals.httpsRequest);
    expect(https.get).toBe(originals.httpsGet);
    expect(globalThis.fetch).toBe(originals.fetch);
  });

  it("uninstallReplay restores the most recent installation and is a no-op when none", () => {
    uninstallReplay();
    const inst = installReplay(new ReplayEngine(simpleBundle()));
    expect(inst.active).toBe(true);
    uninstallReplay();
    expect(inst.active).toBe(false);
    expect(globalThis.fetch).toBe(originals.fetch);
  });

  it("works with Symbol.dispose", () => {
    const r = replay({ bundle: simpleBundle() });
    if (typeof Symbol.dispose !== "symbol") return r.restore();
    r[Symbol.dispose]();
    expect(r.active).toBe(false);
    expect(globalThis.fetch).toBe(originals.fetch);
  });
});

describe("native fetch", () => {
  it("serves status, headers, body and url, matching a templated path", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const res = await fetch(`${BASE_URL}/users/42`);
      expect(res.status).toBe(200);
      expect(res.statusText).toBe("OK");
      expect(res.headers.get("x-served")).toBe("replay");
      expect(res.url).toBe(`${BASE_URL}/users/42`);
      expect(await res.json()).toEqual({ id: 42, name: "Ada" });
      expect(r.served().map((s) => s.endpoint)).toEqual([`GET ${"api.example.com"}/users/{id}`]);
    } finally {
      r.restore();
    }
  });

  it("clone() keeps the url", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const res = await fetch(`${BASE_URL}/health`);
    expect(res.clone().url).toBe(`${BASE_URL}/health`);
  });

  it("fingerprints a POST body sent via a Request object: same key paths match, different ones miss", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const post = (body: string): Promise<Response> =>
      fetch(new Request(`${BASE_URL}/orders`, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    const ok = await post('{"sku": "zzz"}');
    expect(ok.status).toBe(201);
    const miss = await post('{"sku": "a", "extra": 1}').catch((e: unknown) => e);
    expect(miss).toBeInstanceOf(StubNotFound);
    expect((miss as StubNotFound).message).toContain("+ extra");
  });

  it("rejects a miss with StubNotFound carrying method, pathTemplate and fingerprint", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const err = await fetch(`${BASE_URL}/nope`).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StubNotFound);
    const e = err as StubNotFound;
    expect(e.method).toBe("GET");
    expect(e.pathTemplate).toBe("/nope");
    expect(e.fingerprint).toBe(FP_EMPTY_GET);
    expect(e.message).toContain("no recorded stub for GET /nope");
  });

  it("serves 204 and 304 with a null body", async () => {
    using_(replay({ bundle: bundle(endpoint("GET", "/empty", [stub(FP_EMPTY_GET, [variant(204, null)])])) }));
    const res = await fetch(`${BASE_URL}/empty`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("an aborted signal rejects with its reason", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const c = new AbortController();
    c.abort();
    await expect(fetch(`${BASE_URL}/health`, { signal: c.signal })).rejects.toBeDefined();
  });
});

describe("node:http", () => {
  it("http.get gets status, headers, body; setEncoding and a pre-set listener both work", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const { res, body } = await httpGet(`${BASE_URL}/users/42`);
    expect(res).toBeInstanceOf(http.IncomingMessage);
    expect(res.statusCode).toBe(200);
    expect(res.statusMessage).toBe("OK");
    expect(res.headers["x-served"]).toBe("replay");
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.rawHeaders).toContain("x-served");
    expect(JSON.parse(body)).toEqual({ id: 42, name: "Ada" });
  });

  it("http.request with a body, options form, https default protocol and setEncoding", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const text = await new Promise<string>((resolve, reject) => {
      const req = https.request(
        { host: DOMAIN_, path: "/orders", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => {
          expect(res.statusCode).toBe(201);
          res.setEncoding("utf8");
          let out = "";
          res.on("data", (c: string) => (out += c));
          res.on("end", () => resolve(out));
        },
      );
      req.on("error", reject);
      req.write('{"sku"');
      req.end(': "a"}');
    });
    expect(JSON.parse(text)).toEqual({ order_id: 7 });
  });

  it("emits 'socket' and 'response', and the request closes after the response", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const events: string[] = [];
    await new Promise<void>((resolve) => {
      const req = http.request(`http://${DOMAIN_}/health`);
      req.on("socket", () => events.push("socket"));
      req.on("finish", () => events.push("finish"));
      req.on("response", (res) => {
        events.push("response");
        res.resume();
        res.on("end", () => events.push("end"));
      });
      req.on("close", () => {
        events.push("close");
        resolve();
      });
      req.end();
    });
    expect(events).toEqual(["socket", "finish", "response", "end", "close"]);
  });

  it("a miss emits 'error' with StubNotFound on the request (never throws synchronously)", async () => {
    using_(replay({ bundle: simpleBundle() }));
    let req!: http.ClientRequest;
    const err = await new Promise<unknown>((resolve) => {
      req = http.get(`${BASE_URL}/nope`);
      req.on("error", resolve);
    });
    expect(err).toBeInstanceOf(StubNotFound);
    expect((err as StubNotFound).pathTemplate).toBe("/nope");
    expect(req.destroyed).toBe(true);
  });

  it("serves the request headers it was given through getHeader and sends no network", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const req = http.request(`${BASE_URL}/health`, { headers: { "X-A": "1" } });
    req.setHeader("Content-Type", "text/plain");
    expect(req.getHeader("x-a")).toBe("1");
    expect(req.getHeaderNames().sort()).toEqual(["content-type", "x-a"]);
    req.on("error", () => undefined);
    req.destroy();
  });

  it("destroy() before the response suppresses it", async () => {
    using_(replay({ bundle: simpleBundle() }));
    let got = false;
    const req = http.get(`${BASE_URL}/health`, () => (got = true));
    req.on("error", () => undefined);
    req.destroy();
    await sleep(20);
    expect(got).toBe(false);
  });

  it("an aborted signal destroys the request with an AbortError", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const c = new AbortController();
    const p = new Promise<Error>((resolve) => http.get(`${BASE_URL}/health`, { signal: c.signal }).on("error", resolve));
    c.abort();
    expect((await p).name).toBe("AbortError");
  });

  it("an invalid URL throws synchronously like Node", () => {
    using_(replay({ bundle: simpleBundle() }));
    expect(() => http.get("http://")).toThrow();
  });
});

describe("third-party clients", () => {
  it("axios (GET, JSON parsing, headers, templated path)", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const res = await axios.get(`${BASE_URL}/users/42`);
      expect(res.status).toBe(200);
      expect(res.headers["x-served"]).toBe("replay");
      expect(res.data).toEqual({ id: 42, name: "Ada" });
      expect(r.served()).toHaveLength(1);
    } finally {
      r.restore();
    }
  });

  it("axios POST with a JSON body is fingerprinted by key paths", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const res = await axios.post(`${BASE_URL}/orders`, { sku: "anything" });
    expect(res.status).toBe(201);
    expect(res.data).toEqual({ order_id: 7 });
  });

  it("axios: a miss rejects with an error whose cause is StubNotFound, and a 404 recording rejects as an HTTP error", async () => {
    using_(
      replay({
        bundle: bundle(
          endpoint("GET", "/gone", [stub(FP_EMPTY_GET, [variant(404, '{"error": "gone"}')])]),
          endpoint("GET", "/health", [stub(FP_EMPTY_GET, [variant(200, "{}")])]),
        ),
      }),
    );
    // axios re-wraps the error as an AxiosError and keeps the original as `cause`.
    const miss = (await axios.get(`${BASE_URL}/nope`).catch((e: unknown) => e)) as { cause?: unknown };
    expect(miss.cause).toBeInstanceOf(StubNotFound);
    const gone = await axios.get(`${BASE_URL}/gone`).catch((e: unknown) => e as { response?: { status: number; data: unknown } });
    expect((gone as { response: { status: number } }).response.status).toBe(404);
    expect((gone as { response: { data: unknown } }).response.data).toEqual({ error: "gone" });
  });

  it("node-fetch (status, headers, text and json)", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const res = await nodeFetch(`${BASE_URL}/users/42`);
      expect(res.status).toBe(200);
      expect(res.ok).toBe(true);
      expect(res.headers.get("x-served")).toBe("replay");
      expect(await res.json()).toEqual({ id: 42, name: "Ada" });
      expect(r.served()).toHaveLength(1);
    } finally {
      r.restore();
    }
  });

  it("node-fetch: a miss rejects with a FetchError carrying the StubNotFound message", async () => {
    using_(replay({ bundle: simpleBundle() }));
    const err = (await nodeFetch(`${BASE_URL}/nope`).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("FetchError");
    expect(err.message).toContain("no recorded stub for GET /nope");
  });

  it("got (status, headers, json body)", async () => {
    const r = replay({ bundle: simpleBundle() });
    try {
      const res = await got(`${BASE_URL}/users/42`, { retry: { limit: 0 } });
      expect(res.statusCode).toBe(200);
      expect(res.headers["x-served"]).toBe("replay");
      expect(JSON.parse(res.body)).toEqual({ id: 42, name: "Ada" });
      expect(await got(`${BASE_URL}/users/42`, { retry: { limit: 0 } }).json()).toEqual({ id: 42, name: "Ada" });
      expect(r.served()).toHaveLength(2);
    } finally {
      r.restore();
    }
  });

  it("got: a miss rejects with a RequestError carrying the StubNotFound message", async () => {
    using_(replay({ bundle: simpleBundle() }));
    // got 13 (the newest major that still runs on Node 18) wraps the error
    // without setting `cause`; the StubNotFound text survives in the message.
    const err = (await got(`${BASE_URL}/nope`, { retry: { limit: 0 } }).catch((e: unknown) => e)) as {
      name?: string;
      code?: string;
      message?: string;
    };
    expect(err.name).toBe("RequestError");
    expect(err.code).toBe("ERR_GOT_REQUEST_ERROR");
    expect(err.message).toContain("no recorded stub for GET /nope");
  });
});

describe("a miss names the templated path", () => {
  async function missed(b: ReturnType<typeof bundle>, url: string, init?: RequestInit): Promise<StubNotFound> {
    const r = replay({ bundle: b });
    try {
      await fetch(url, init);
    } catch (err) {
      if (err instanceof StubNotFound) return err;
      throw err;
    } finally {
      r.restore();
    }
    throw new Error("expected a miss");
  }

  it("raises StubNotFound with the method, the path template and a fingerprint", async () => {
    const b = bundle(endpoint("GET", "/api/users/{id}", [stub(FP_EMPTY_GET, [variant(200, "{}")])], { is_dynamic: true }));
    const err = await missed(b, "http://api.example.com/api/users/1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ x: 1 }),
    });
    expect(err.method).toBe("POST");
    expect(err.pathTemplate).toContain("/api/users");
    expect(err.fingerprint).toBeTruthy();
  });

  it("names the method and the path in the message", async () => {
    const err = await missed(bundle(), "http://api.example.com/api/things/123");
    expect(err.message).toContain("GET");
    expect(err.message).toContain("/api/things");
  });
});

describe("composition with capture", () => {
  let backend: FakeBackend;
  let upstream: Upstream;
  let client: ReturnType<typeof install>;

  beforeEach(async () => {
    backend = await startBackend();
    upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"real": true}');
    });
    // Capture talks to a real local backend; allow loopback sockets for this block only.
    vi.restoreAllMocks();
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
  });

  afterEach(async () => {
    await client.close();
    await upstream.close();
    await backend.close();
    globalThis.fetch = originals.fetch;
  });

  it("replayed exchanges (fetch and http) are not captured, and capture resumes after restore", async () => {
    const r = replay({ bundle: simpleBundle() });
    // Replay wins even though capture's wrappers were installed first.
    expect((await fetch(`${BASE_URL}/health`)).status).toBe(200);
    await httpGet(`${BASE_URL}/health`);
    await sleep(150);
    expect(backend.captures).toHaveLength(0);
    r.restore();

    // The original capture hooks are back and live.
    const res = await fetch(`${upstream.base}/x`);
    expect(await res.json()).toEqual({ real: true });
    await vi.waitFor(() => expect(backend.captures.length).toBe(1), { timeout: 3000 });
  });

  it("enqueues no capture while replay is active", async () => {
    const r = replay({ bundle: bundle(endpoint("GET", "/api/ping", [stub(FP_EMPTY_GET, [variant(200, '{"ok":true}')])])) });
    try {
      await fetch("http://api.example.com/api/ping");
      // A capture handed over directly is refused while replay is active, too.
      client.capture({
        method: "get",
        url: "http://api.example.com/api/ping",
        reqHeaders: {},
        reqBody: "",
        status: 200,
        respHeaders: { "content-type": "application/json" },
        respBody: '{"ok":true}',
        durationMs: 5,
        source: "node-fetch",
      });
    } finally {
      r.restore();
    }
    await client.flush();
    expect(backend.captures).toHaveLength(0);
  });

  it("captures again after replay ends", async () => {
    const r = replay({ bundle: bundle(endpoint("GET", "/api/ping", [stub(FP_EMPTY_GET, [variant(200, '{"ok":true}')])])) });
    r.restore();
    expect(replayActive()).toBe(false);
    // The capture is handed over directly, so no network is needed.
    client.capture({
      method: "get",
      url: "http://api.example.com/api/after-replay",
      reqHeaders: {},
      reqBody: "",
      status: 200,
      respHeaders: { "content-type": "application/json" },
      respBody: '{"ok":true}',
      durationMs: 5,
      source: "node-fetch",
    });
    await client.flush();
    expect(backend.captures).toHaveLength(1);
  });

  it("capture installed after replay also stays out of the way", async () => {
    await client.close();
    const r = replay({ bundle: simpleBundle() });
    client = install({ apiKey: "test-key", url: backend.ingestUrl, backendUrl: backend.base, rulesPollInterval: 3_600_000 });
    expect((await fetch(`${BASE_URL}/health`)).status).toBe(200);
    await sleep(150);
    expect(backend.captures).toHaveLength(0);
    await client.close();
    r.restore();
  });

  it("a miss under both is not captured either", async () => {
    const r = replay({ bundle: simpleBundle() });
    await expect(fetch(`${BASE_URL}/nope`)).rejects.toBeInstanceOf(StubNotFound);
    await sleep(100);
    expect(backend.captures).toHaveLength(0);
    r.restore();
  });
});

const DOMAIN_ = "api.example.com";

/** Restore automatically at the end of the test. */
const pending: Array<{ restore(): void }> = [];
function using_(r: { restore(): void }): void {
  pending.push(r);
}
afterEach(() => {
  for (const r of pending.splice(0).reverse()) r.restore();
});

// Silence "unused" for helpers kept for readability.
void fp;
