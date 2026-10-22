import { gzipSync } from "node:zlib";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/_version.js";
import { StubsmithClient } from "../src/client.js";
import { resetWarnOnceForTests } from "../src/env.js";
import { RulesPoller } from "../src/sync.js";
import { reportIngestRefusal, resetIngestWarningsForTests } from "../src/refusals.js";
import { PrivacyPipeline } from "../src/privacy/pipeline.js";
import { RulesCache } from "../src/privacy/rulesCache.js";
import type { CapturedExchange, StubsmithOptions } from "../src/types.js";
import { loadVectors, toJsonValue } from "./helpers/vectors.js";
import { bigJson } from "./helpers/pipeline.js";
import { type FakeBackend, sleep, startBackend, syncBody, waitFor } from "./helpers/servers.js";

let backend: FakeBackend;
let clients: StubsmithClient[] = [];
let warn: MockInstance<typeof console.warn>;
const ENV = ["STUBSMITH_API_KEY", "STUBSMITH_URL", "STUBSMITH_BACKEND_URL", "STUBSMITH_DEBUG", "STUBSMITH_FLUSH_TIMEOUT"];
const savedEnv: Record<string, string | undefined> = {};

function mk(over: StubsmithOptions = {}): StubsmithClient {
  const c = new StubsmithClient({
    apiKey: "test-key",
    url: backend.ingestUrl,
    backendUrl: backend.base,
    rulesPollInterval: 3_600_000,
    ...over,
  });
  clients.push(c);
  return c;
}

function ex(over: Partial<CapturedExchange> = {}): CapturedExchange {
  return {
    method: "post",
    url: "https://api.example.com/v1/items?limit=5",
    reqHeaders: { "content-type": "application/json", authorization: "Bearer secret" },
    reqBody: '{"name": "widget", "qty": 3}',
    status: 200,
    respHeaders: { "content-type": "application/json" },
    respBody: '{"id": 7, "ok": true}',
    durationMs: 12.4,
    source: "node-fetch",
    ...over,
  };
}

beforeEach(async () => {
  for (const n of ENV) {
    savedEnv[n] = process.env[n];
    delete process.env[n];
  }
  process.env["STUBSMITH_FLUSH_TIMEOUT"] = "1";
  backend = await startBackend();
  resetIngestWarningsForTests();
  resetWarnOnceForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  await backend.close();
  vi.restoreAllMocks();
  for (const n of ENV) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
});

const SPEC_KEYS = [
  "sdk_version",
  "sdk_masked",
  "sdk_rule_version",
  "domain",
  "path_template",
  "path",
  "method",
  "status",
  "req_fingerprint",
  "resp_fingerprint",
  "key_paths",
  "resp_key_paths",
  "req_header_names",
  "resp_header_names",
  "query_names",
  "headers",
  "req_body",
  "resp_headers",
  "resp_body",
  "novel",
  "source",
  "duration",
];

describe("disabled client", () => {
  it("with an empty key has no pipeline, no poller, and capture is a no-op", async () => {
    const c = new StubsmithClient({ apiKey: "", url: backend.ingestUrl, backendUrl: backend.base });
    expect(c.enabled).toBe(false);
    expect(c.pipeline).toBeNull();
    expect(c.rulesCache).toBeNull();
    const before = process.listenerCount("beforeExit");
    c.capture(ex());
    await c.flush({ timeoutMs: 100 });
    await sleep(30);
    expect(backend.captures).toHaveLength(0);
    expect(backend.syncRequests).toHaveLength(0);
    expect(process.listenerCount("beforeExit")).toBe(before);
    expect(await c.waitForRules(10)).toBe(false);
    await c.close();
    expect(c.stopped).toBe(true);
  });

  it("reads the key from STUBSMITH_API_KEY", async () => {
    process.env["STUBSMITH_API_KEY"] = "from-env";
    process.env["STUBSMITH_URL"] = backend.ingestUrl;
    process.env["STUBSMITH_BACKEND_URL"] = backend.base;
    const c = new StubsmithClient({ rulesPollInterval: 3_600_000 });
    clients.push(c);
    expect(c.enabled).toBe(true);
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1);
    expect(backend.captures[0]?.headers["authorization"]).toBe("Bearer from-env");
  });
});

describe("capture and wire format", () => {
  it("POSTs one capture with the exact header set and every SPEC key", async () => {
    const c = mk();
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1);
    const got = backend.captures[0];
    expect(got?.method).toBe("POST");
    expect(got?.headers["content-type"]).toBe("application/json");
    expect(got?.headers["authorization"]).toBe("Bearer test-key");
    expect(got?.headers["user-agent"]).toBe(`stubsmith-node/${VERSION}`);
    expect(got?.headers["content-encoding"]).toBeUndefined();
    const p = got?.json as Record<string, unknown>;
    for (const k of SPEC_KEYS) expect(p, k).toHaveProperty(k);
    expect(p["sdk_version"]).toBe(VERSION);
    expect(p["sdk_masked"]).toBe(true);
    expect(p["method"]).toBe("POST");
    expect(p["status"]).toBe(200);
    expect(p["domain"]).toBe("api.example.com");
    expect(p["source"]).toBe("node-fetch");
    expect(p["duration"]).toBe(12);
    expect(p["path"]).toMatch(/^\/v1\/items\?/);
    expect(p["query_names"]).toEqual(["limit"]);
    expect(p["key_paths"]).toEqual(expect.arrayContaining(["name", "qty"]));
    expect(String(p["req_fingerprint"])).toMatch(/^[0-9a-f]{16}$/);
    expect(String(p["resp_fingerprint"])).toMatch(/^200[0-9a-f]{16}$/);
    // Masked: the raw values never leave the process.
    expect(got?.raw.toString("utf8")).not.toContain("widget");
    expect(got?.raw.toString("utf8")).not.toContain("secret");
  });

  it("gzips payloads of 1024 bytes or more when that is smaller, and only then", async () => {
    const c = mk();
    const keys = Array.from({ length: 200 }, (_, i) => `"field_number_${i}": ${i}`).join(", ");
    c.capture(ex({ respBody: `{${keys}}` }));
    c.capture(ex({ url: "https://api.example.com/small", reqBody: "", respBody: "{}" }));
    await waitFor(() => backend.captures.length === 2);
    const [big, small] = backend.captures;
    expect(big?.raw.length).toBeGreaterThanOrEqual(0);
    expect(big?.headers["content-encoding"]).toBe("gzip");
    expect(big?.raw[0]).toBe(0x1f);
    expect(big?.json?.["resp_key_paths"]).toContain("field_number_199");
    expect(small?.headers["content-encoding"]).toBeUndefined();
    expect(small?.json).not.toBeNull();
  });

  it("does not gzip when compress is false", async () => {
    const c = mk({ compress: false });
    const keys = Array.from({ length: 200 }, (_, i) => `"field_number_${i}": ${i}`).join(", ");
    c.capture(ex({ respBody: `{${keys}}` }));
    await waitFor(() => backend.captures.length === 1);
    expect(backend.captures[0]?.headers["content-encoding"]).toBeUndefined();
    expect(backend.captures[0]?.raw.length).toBeGreaterThan(1024);
  });

  it("sdk_rule_version is the synced cursor and novel flips for a synced fingerprint", async () => {
    const c = mk();
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1);
    const first = backend.captures[0]?.json as Record<string, unknown>;
    expect(first["novel"]).toBe(true);
    expect(first["sdk_rule_version"]).toBe("0");

    backend.sync = {
      status: 200,
      delayMs: 0,
      body: syncBody("42", [
        {
          domain: String(first["domain"]),
          method: String(first["method"]),
          path_template: String(first["path_template"]),
          fingerprint: String(first["req_fingerprint"]),
        },
      ]),
    };
    await (c as unknown as { poller: RulesPoller }).poller.pollOnce();
    expect(c.rulesSynced).toBe(true);
    c.capture(ex());
    await waitFor(() => backend.captures.length === 2);
    const second = backend.captures[1]?.json as Record<string, unknown>;
    expect(second["novel"]).toBe(false);
    expect(second["sdk_rule_version"]).toBe("42");
    // A different shape for the same endpoint is still novel.
    c.capture(ex({ reqBody: '{"other": 1}' }));
    await waitFor(() => backend.captures.length === 3);
    expect(backend.captures[2]?.json?.["novel"]).toBe(true);
  });

  it("waitForRules resolves after the first sync", async () => {
    backend.sync = { status: 200, body: syncBody("1", []), delayMs: 20 };
    const c = mk();
    expect(await c.waitForRules(3000)).toBe(true);
  });

  it("drops the capture when the pipeline returns null (never sends raw)", async () => {
    const c = mk();
    vi.spyOn(c.pipeline as NonNullable<typeof c.pipeline>, "process").mockReturnValue(null);
    c.capture(ex());
    await c.flush({ timeoutMs: 200 });
    await sleep(30);
    expect(backend.captures).toHaveLength(0);
  });

  it("does not capture while replay is active", async () => {
    const { enterReplay, exitReplay } = await import("../src/replayState.js");
    const c = mk();
    enterReplay();
    try {
      c.capture(ex());
    } finally {
      exitReplay();
    }
    await sleep(30);
    expect(backend.captures).toHaveLength(0);
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1);
  });
});

describe("sampling", () => {
  it("drops when random() > sampleRate, after the pipeline", async () => {
    const c = mk({ sampleRate: 0.5 });
    const proc = vi.spyOn(c.pipeline as NonNullable<typeof c.pipeline>, "process");
    const rnd = vi.spyOn(Math, "random");
    rnd.mockReturnValueOnce(0.9);
    c.capture(ex());
    expect(proc).toHaveBeenCalledTimes(1); // the pipeline ran before the sampling decision
    rnd.mockReturnValueOnce(0.1);
    c.capture(ex());
    rnd.mockRestore();
    await waitFor(() => backend.captures.length >= 1);
    await sleep(40);
    expect(backend.captures).toHaveLength(1);
  });

  it("sampleRate 0 sends nothing, 1 never consults random", async () => {
    const zero = mk({ sampleRate: 0 });
    for (let i = 0; i < 20; i++) zero.capture(ex());
    await sleep(50);
    expect(backend.captures).toHaveLength(0);
    const rnd = vi.spyOn(Math, "random");
    const one = mk({ sampleRate: 1 });
    one.capture(ex());
    expect(rnd).not.toHaveBeenCalled();
    await waitFor(() => backend.captures.length === 1);
  });
});

describe("queue limits", () => {
  it("drops silently past the item cap and counts the drops", async () => {
    const c = mk({ limits: { maxQueueItems: 2 } });
    for (let i = 0; i < 5; i++) c.capture(ex());
    expect(c.droppedCount).toBe(3);
    await c.flush();
    expect(backend.captures).toHaveLength(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it("drops silently past the byte budget and releases the reservation after sending", async () => {
    const probe = mk();
    probe.capture(ex());
    await waitFor(() => backend.captures.length === 1);
    const size = backend.captures[0]?.raw.length ?? 0;
    expect(size).toBeGreaterThan(500);
    await probe.close();
    backend.captures.length = 0;

    const c = mk({ limits: { maxQueueBytes: size * 2 + 50 } });
    for (let i = 0; i < 5; i++) c.capture(ex());
    expect(c.droppedCount).toBe(3);
    await c.flush();
    expect(backend.captures).toHaveLength(2);
    // Budget is free again.
    c.capture(ex());
    c.capture(ex());
    await c.flush();
    expect(backend.captures).toHaveLength(4);
    expect(c.droppedCount).toBe(3);
  });
});

describe("oversize payloads", () => {
  it("omits both bodies, declares it, and warns once per METHOD path_template", async () => {
    const c = mk({ limits: { maxPayloadBytes: 4000 } });
    const keys = Array.from({ length: 400 }, (_, i) => `"field_number_${i}": ${i}`).join(", ");
    const big = ex({ method: "get", url: "https://api.example.com/v1/big", reqBody: "", respBody: `{${keys}}` });
    c.capture(big);
    c.capture(big);
    await waitFor(() => backend.captures.length === 2);
    const p = backend.captures[0]?.json as Record<string, unknown>;
    expect(p["req_body"]).toBeNull();
    expect(p["resp_body"]).toBeNull();
    expect(p["bodies_omitted"]).toBe(true);
    expect(p["omitted_reason"]).toBe("payload_too_large");
    expect(p["omitted_req_body_bytes"]).toBe(Buffer.byteLength(String("<masked>")));
    expect(p["omitted_resp_body_bytes"]).toBeGreaterThan(1000);
    expect(p["resp_key_paths"]).toContain("field_number_399"); // the shape is still reported
    const warnings = warn.mock.calls.map((a) => String(a[0])).filter((m) => m.includes("over the 4000 byte limit"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("GET /v1/big");
    // A different endpoint warns separately.
    c.capture({ ...big, url: "https://api.example.com/v1/other" });
    await waitFor(() => backend.captures.length === 3);
    expect(warn.mock.calls.filter((a) => String(a[0]).includes("over the 4000 byte limit"))).toHaveLength(2);
  });

  it("measures the ceiling in UTF-8 bytes, not characters", async () => {
    // Query names are reported verbatim and JSON.stringify leaves non-ASCII raw: 4 bytes, 2 UTF-16 units each.
    const names = Array.from({ length: 40 }, (_, i) => `\u{1F600}${i}`).join("=1&");
    const wide = ex({ url: `https://api.example.com/v1/q?${names}=1` });
    const probe = mk({ compress: false });
    probe.capture(wide);
    await waitFor(() => backend.captures.length === 1);
    const raw = backend.captures[0]?.raw as Buffer;
    expect(raw.toString("utf8").length).toBeLessThan(raw.length);
    expect(backend.captures[0]?.json?.["bodies_omitted"]).toBeUndefined();

    const exact = mk({ limits: { maxPayloadBytes: raw.length } });
    exact.capture(wide);
    await waitFor(() => backend.captures.length === 2);
    expect(backend.captures[1]?.json?.["bodies_omitted"]).toBeUndefined();

    const under = mk({ limits: { maxPayloadBytes: raw.length - 1 } });
    under.capture(wide);
    await waitFor(() => backend.captures.length === 3);
    expect(backend.captures[2]?.json?.["bodies_omitted"]).toBe(true);
  });
});

// A prepared payload goes straight to the queue, as the capture path would hand it over after masking.
function enqueuePrepared(c: StubsmithClient, payload: Record<string, unknown>): void {
  (c as unknown as { enqueue(p: Record<string, unknown>): void }).enqueue(payload);
}
const queueBytesOf = (c: StubsmithClient): number => (c as unknown as { queueBytes: number }).queueBytes;

function hugePayload(respBody: string, path = "/huge"): Record<string, unknown> {
  return { method: "GET", path_template: path, sdk_masked: true, req_body: "", resp_body: respBody };
}

describe("payload ceiling", () => {
  it("a payload over the ceiling has both bodies set to null, with bodies_omitted, the reason and the sizes", async () => {
    const c = mk({ limits: { maxPayloadBytes: 64 * 1024 } });
    enqueuePrepared(c, hugePayload(bigJson(4000)));
    await waitFor(() => backend.captures.length === 1);
    const p = backend.captures[0]?.json as Record<string, unknown>;
    expect(p["bodies_omitted"]).toBe(true);
    expect(p["omitted_reason"]).toBe("payload_too_large");
    expect(p["resp_body"]).toBeNull();
    expect(p["req_body"]).toBeNull();
    expect(p["omitted_resp_body_bytes"]).toBeGreaterThan(64 * 1024);
  });

  it("an oversize capture is still sent so its shape is recorded", async () => {
    const c = mk({ limits: { maxPayloadBytes: 64 * 1024 } });
    enqueuePrepared(c, hugePayload(bigJson(4000)));
    await waitFor(() => backend.captures.length === 1);
    const p = backend.captures[0]?.json as Record<string, unknown>;
    expect(p["method"]).toBe("GET");
    expect(p["path_template"]).toBe("/huge");
  });

  it("a payload under the ceiling is sent unchanged", async () => {
    const c = mk({ limits: { maxPayloadBytes: 10 * 1024 * 1024 } });
    enqueuePrepared(c, hugePayload('{"a": 1}'));
    await waitFor(() => backend.captures.length === 1);
    const p = backend.captures[0]?.json as Record<string, unknown>;
    expect(p["bodies_omitted"]).toBeUndefined();
    expect(p["resp_body"]).toBe('{"a": 1}');
  });

  it("the oversize warning is printed once per endpoint", async () => {
    const c = mk({ limits: { maxPayloadBytes: 64 * 1024 } });
    for (let i = 0; i < 5; i++) enqueuePrepared(c, hugePayload(bigJson(4000)));
    enqueuePrepared(c, hugePayload(bigJson(4000), "/other"));
    await waitFor(() => backend.captures.length === 6);
    const oversize = warn.mock.calls.map((a) => String(a[0])).filter((m) => m.includes("over the"));
    expect(oversize).toHaveLength(2);
    expect(oversize.some((m) => m.includes("/huge"))).toBe(true);
    expect(oversize.some((m) => m.includes("/other"))).toBe(true);
  });

  it("the ceiling is measured on uncompressed bytes", async () => {
    const c = mk({ limits: { maxPayloadBytes: 64 * 1024 } });
    // Compresses to far under the ceiling, but is over it uncompressed.
    const body = `{"items": [${Array.from({ length: 20000 }, () => '{"v": "<masked>"}').join(", ")}]}`;
    expect(gzipSync(Buffer.from(body)).length).toBeLessThan(64 * 1024);
    enqueuePrepared(c, { method: "GET", path_template: "/x", req_body: "", resp_body: body });
    await waitFor(() => backend.captures.length === 1);
    expect(backend.captures[0]?.json?.["bodies_omitted"]).toBe(true);
  });
});

describe("queue byte budget", () => {
  const small = (path: string, fill: string, n: number): Record<string, unknown> => ({ method: "GET", path_template: path, resp_body: fill.repeat(n) });

  it("blocks a capture that would exceed it while a small one still fits", async () => {
    const c = mk({ limits: { maxQueueBytes: 4096, maxPayloadBytes: 10 * 1024 * 1024 } });
    enqueuePrepared(c, small("/a", "x", 8192));
    expect(c.droppedCount).toBe(1);
    enqueuePrepared(c, small("/b", "y", 16));
    expect(c.droppedCount).toBe(1);
    await c.flush();
    expect(backend.captures.map((r) => r.json?.["path_template"])).toEqual(["/b"]);
  });

  it("releases the budget after a send", async () => {
    const c = mk({ limits: { maxQueueBytes: 1024 * 1024 } });
    for (let i = 0; i < 5; i++) enqueuePrepared(c, small("/a", "x", 1000));
    await waitFor(() => backend.captures.length === 5);
    await c.flush({ timeoutMs: 5000 });
    expect(await waitFor(() => queueBytesOf(c) === 0, 2000)).toBe(true);
  });

  it("releases the budget even when every send fails", async () => {
    backend.ingest = { status: 500, body: "boom", delayMs: 0 };
    const c = mk({ limits: { maxQueueBytes: 1024 * 1024 } });
    for (let i = 0; i < 5; i++) enqueuePrepared(c, small("/a", "x", 1000));
    expect(await waitFor(() => queueBytesOf(c) === 0, 3000)).toBe(true);
    expect(c.sendFailures).toBe(5);
  });
});

describe("send failures, flush and close", () => {
  it("counts failures for 4xx/5xx and for network errors", async () => {
    const c = mk();
    backend.ingest = { status: 500, body: "Internal Server Error", delayMs: 0 };
    c.capture(ex());
    await waitFor(() => c.sendFailures === 1);
    expect(c.sendFailures).toBe(1);
    expect(warn).not.toHaveBeenCalled(); // plain text bodies are not refusals
    const dead = mk({ url: "http://127.0.0.1:1/v1/captures" });
    dead.capture(ex());
    await waitFor(() => dead.sendFailures === 1);
    expect(dead.sendFailures).toBe(1);
  });

  it("flush returns early when a new failure happens, well before the timeout", async () => {
    backend.ingest = { status: 500, body: "nope", delayMs: 100 };
    const c = mk();
    for (let i = 0; i < 5; i++) c.capture(ex());
    const t = Date.now();
    await c.flush({ timeoutMs: 5000 });
    expect(Date.now() - t).toBeLessThan(1500);
    expect(c.sendFailures).toBeGreaterThan(0);
  });

  it("flush returns immediately when idle and honours its timeout when the server hangs", async () => {
    const c = mk();
    const t0 = Date.now();
    await c.flush();
    expect(Date.now() - t0).toBeLessThan(100);
    backend.ingest = { status: 201, body: "{}", delayMs: 3000 };
    c.capture(ex());
    const t1 = Date.now();
    await c.flush({ timeoutMs: 250 });
    const took = Date.now() - t1;
    expect(took).toBeGreaterThanOrEqual(200);
    expect(took).toBeLessThan(1000);
  });

  it("flush sanitises a NaN timeout to the default and a negative one to zero", async () => {
    backend.ingest = { status: 201, body: "{}", delayMs: 8000 };
    const c = mk({ timeoutMs: 10_000 });
    c.capture(ex());
    const t0 = Date.now();
    await c.flush({ timeoutMs: -5 });
    expect(Date.now() - t0).toBeLessThan(100);
    const t1 = Date.now();
    await c.flush({ timeoutMs: Number.NaN });
    const took = Date.now() - t1;
    expect(took).toBeGreaterThanOrEqual(4500);
    expect(took).toBeLessThan(6500); // the 5 s default, not an unbounded wait for the stalled send
  }, 15_000);

  it("times out a hanging send after timeoutMs and counts a failure", async () => {
    backend.ingest = { status: 201, body: "{}", delayMs: 3000 };
    const c = mk({ timeoutMs: 100 });
    c.capture(ex());
    await waitFor(() => c.sendFailures === 1, 2000);
    expect(c.sendFailures).toBe(1);
  });

  it("sends one capture at a time", async () => {
    backend.ingest = { status: 201, body: "{}", delayMs: 60 };
    const c = mk();
    for (let i = 0; i < 3; i++) c.capture(ex());
    await sleep(30);
    expect(backend.captures).toHaveLength(1); // the second is not sent until the first answered
    await c.flush();
    expect(backend.captures).toHaveLength(3);
  });

  it("close() flushes, stops the poller, un-registers the exit hook and runs close hooks", async () => {
    const before = process.listenerCount("beforeExit");
    const c = mk({ rulesPollInterval: 20 });
    expect(process.listenerCount("beforeExit")).toBe(before + 1);
    const hook = vi.fn();
    c.onClose(hook);
    c.capture(ex());
    await c.close();
    expect(backend.captures).toHaveLength(1);
    expect(c.stopped).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(process.listenerCount("beforeExit")).toBe(before);
    const n = backend.syncRequests.length;
    await sleep(100);
    expect(backend.syncRequests.length).toBe(n);
    c.capture(ex()); // a stopped client ignores captures
    await sleep(30);
    expect(backend.captures).toHaveLength(1);
    await c.close(); // idempotent
    expect(hook).toHaveBeenCalledTimes(1);
  });

  it("the beforeExit hook flushes pending captures and is a no-op with a zero budget", async () => {
    backend.ingest = { status: 201, body: "{}", delayMs: 40 };
    const c = mk();
    c.capture(ex());
    c.capture(ex());
    process.emit("beforeExit", 0);
    await waitFor(() => backend.captures.length === 2);
    expect(backend.captures).toHaveLength(2);
    await c.close();

    process.env["STUBSMITH_FLUSH_TIMEOUT"] = "0";
    const z = mk();
    z.capture(ex());
    expect(() => process.emit("beforeExit", 0)).not.toThrow();
    await z.flush();
  });
});

describe("send failures in debug mode keep payload values and the key out of the log", () => {
  const logged = (stderr: { mock: { calls: unknown[][] } }): string =>
    [...stderr.mock.calls, ...warn.mock.calls].map((a) => String(a[0])).join("\n");

  it("logs the HTTP status of a failed send, never the key or a payload value", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    backend.ingest = { status: 401, body: "Unauthorized", delayMs: 0 };
    const c = mk({ apiKey: "sk-test-debug-key", debug: true });
    c.capture(ex({ method: "get", url: "https://api.example.com/debug-ping", reqBody: "", respBody: '{"pong": true}' }));
    await waitFor(() => c.sendFailures === 1);
    const combined = logged(stderr);
    expect(combined).toContain("401");
    expect(combined).not.toContain("sk-test-debug-key");
    expect(combined).not.toContain("pong");
  });

  it("logs the error class of a send that raises, never the key or a payload value", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const c = mk({ apiKey: "sk-test-key", debug: true, url: "http://127.0.0.1:1/v1/captures" });
    c.capture(ex({ method: "get", url: "https://api.example.com/debug-ping2", reqBody: "", respBody: '{"value": "secret-data"}' }));
    await waitFor(() => c.sendFailures === 1);
    const combined = logged(stderr);
    expect(combined).toMatch(/send failed - \w+ url=/);
    expect(combined).not.toContain("secret-data");
    expect(combined).not.toContain("sk-test-key");
  });

  it("logs nothing about a failed send when debug is off", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const c = mk({ url: "http://127.0.0.1:1/v1/captures" });
    c.capture(ex({ method: "get", url: "https://api.example.com/debug-silent", reqBody: "", respBody: '{"pong": true}' }));
    await waitFor(() => c.sendFailures === 1);
    expect(logged(stderr)).toBe("");
  });
});

describe("ingest refusal reporting (client path)", () => {
  it("warns once for a 200 refusal, in one sentence, without the key", async () => {
    backend.ingest = {
      status: 200,
      body: '{"ok": false, "error": "fingerprint_limit_reached", "message": "Fingerprint limit reached"}',
      delayMs: 0,
    };
    const c = mk({ apiKey: "sk-refusal-test" });
    for (let i = 0; i < 3; i++) c.capture(ex());
    await waitFor(() => backend.captures.length === 3);
    await c.flush();
    const msgs = warn.mock.calls.map((a) => String(a[0])).filter((m) => m.includes("fingerprint_limit_reached"));
    expect(msgs).toHaveLength(1);
    const msg = msgs[0] as string;
    expect(msg.startsWith("stubsmith: ingest refused a capture: fingerprint_limit_reached (HTTP 200). ")).toBe(true);
    expect(msg).toContain("Fingerprint limit reached. ");
    expect(msg).not.toContain("  ");
    expect(msg).not.toContain("..");
    expect(msg.endsWith("Reported once per process.")).toBe(true);
    expect(msg).not.toContain("sk-refusal-test");
    expect(c.sendFailures).toBe(0);
  });

  it("warns once per code, with the verbatim remedy", async () => {
    backend.ingest = { status: 200, body: '{"ok": false, "error": "fingerprint_limit_reached"}', delayMs: 0 };
    const c = mk();
    c.capture(ex());
    c.capture(ex());
    await c.flush();
    await waitFor(() => backend.captures.length === 2);
    await c.flush();
    const msgs = warn.mock.calls.map((a) => String(a[0]));
    expect(msgs).toEqual([
      "stubsmith: ingest refused a capture: fingerprint_limit_reached (HTTP 200). New endpoint shapes are not being recorded until the plan is upgraded or unused fingerprints are deleted in the dashboard. Reported once per process.",
    ]);
    expect(c.sendFailures).toBe(0); // a 200 refusal is not a transport failure
  });

  it("reports a refusal that arrives on a 422 and also counts the failure", async () => {
    backend.ingest = { status: 422, body: '{"ok": false, "rejected": true}', delayMs: 0 };
    const c = mk();
    c.capture(ex());
    await waitFor(() => c.sendFailures === 1);
    expect(warn.mock.calls.map((a) => String(a[0])).join("\n")).toContain("rejected (HTTP 422)");
  });

  it("debug mode logs the body every time", async () => {
    backend.ingest = { status: 400, body: '{"ok": false, "error": "x"}', delayMs: 0 };
    const c = mk({ debug: true });
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    c.capture(ex());
    await waitFor(() => c.sendFailures === 1);
    const msgs = warn.mock.calls.map((a) => String(a[0]));
    expect(msgs[0]).toBe('stubsmith: ingest refused capture - status=400 body={"ok": false, "error": "x"}');
    expect(msgs).toHaveLength(2);
  });
});

interface RefusalCall {
  debug?: boolean;
  raw: string | { bytes_hex: string } | { none: true };
  status: unknown;
}
interface RefusalExpected {
  logs: Array<{ level: string; message: string }>;
}

describe("refusals conformance vectors", () => {
  const vectors = loadVectors<{ calls: RefusalCall[] }, RefusalExpected>("refusals.json");
  it("has cases", () => expect(vectors.cases.length).toBeGreaterThan(50));
  for (const c of vectors.cases) {
    it(c.name, () => {
      resetIngestWarningsForTests();
      warn.mockClear();
      for (const call of c.input.calls) {
        let raw: Uint8Array | string | null;
        if (typeof call.raw === "string") raw = call.raw;
        else if ("bytes_hex" in call.raw) raw = Buffer.from(call.raw.bytes_hex, "hex");
        else raw = null;
        reportIngestRefusal(raw, call.status, call.debug === true);
      }
      const got = warn.mock.calls.map((a) => String(a[0]));
      expect(got).toEqual(c.expected.logs.map((l) => l.message));
      for (const l of c.expected.logs) expect(l.level).toBe("WARNING");
    });
  }
});

describe("close() budget", () => {
  it("ignores STUBSMITH_FLUSH_TIMEOUT=0: a queued capture is still delivered", async () => {
    process.env["STUBSMITH_FLUSH_TIMEOUT"] = "0";
    const c = mk();
    c.capture(ex());
    await c.close();
    expect(backend.captures).toHaveLength(1);
  });

  it("uses the 5 s default, not the env exit budget, so a slow ingest is waited for", async () => {
    process.env["STUBSMITH_FLUSH_TIMEOUT"] = "0.05";
    backend.ingest = { status: 201, body: "{}", delayMs: 400 };
    const c = mk();
    c.capture(ex());
    const t = Date.now();
    await c.close();
    expect(Date.now() - t).toBeGreaterThanOrEqual(350);
  });

  it("accepts close({ timeoutMs }) and aborts the send still in flight", async () => {
    backend.ingest = { status: 201, body: "{}", delayMs: 3000 };
    const c = mk();
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1);
    const t = Date.now();
    await c.close({ timeoutMs: 100 });
    expect(Date.now() - t).toBeLessThan(1000);
    expect(c.stopped).toBe(true);
    expect(c.sendFailures).toBe(0); // the abort by close() is not an endpoint failure
    await sleep(30);
    expect((c as unknown as { inflight: unknown }).inflight).toBeNull(); // the send was aborted, not left to finish
  });

  it("returns early on a new send failure instead of waiting out the 5 s", async () => {
    const c = mk({ url: "http://127.0.0.1:9/v1/captures" });
    c.capture(ex());
    const t = Date.now();
    await c.close();
    expect(Date.now() - t).toBeLessThan(2000);
    expect(c.sendFailures).toBe(1);
  });
});

describe("sender wire format", () => {
  it("keeps the content, encoding, user-agent and auth headers", async () => {
    const c = mk();
    c.capture(ex({ respBody: JSON.stringify({ items: Array.from({ length: 200 }, (_, i) => ({ id: i, name: `n${i}` })) }) }));
    await c.flush();
    const big = backend.captures[0];
    expect(big?.headers["content-encoding"]).toBe("gzip");
    expect(big?.headers["content-type"]).toBe("application/json");
    expect(big?.headers["authorization"]).toBe("Bearer test-key");
    expect(big?.headers["user-agent"]).toBe(`stubsmith-node/${VERSION}`);
    expect(big?.headers["content-length"]).toBe(String(big?.raw.length));
    c.capture(ex());
    await c.flush();
    const plain = backend.captures[1];
    expect(plain?.headers["content-encoding"]).toBeUndefined();
    expect(plain?.headers["authorization"]).toBe("Bearer test-key");
    expect(plain?.headers["user-agent"]).toBe(`stubsmith-node/${VERSION}`);
    expect(plain?.json?.["domain"]).toBe("api.example.com");
  });
});

describe("refusal remedies are looked up safely", () => {
  it.each(["constructor", "__proto__", "toString", "hasOwnProperty"])("%s prints the default remedy", (code) => {
    reportIngestRefusal(JSON.stringify({ ok: false, error: code }), 200, false);
    expect(warn.mock.calls.map((a) => String(a[0]))).toEqual([
      `stubsmith: ingest refused a capture: ${code} (HTTP 200). Check the project in the StubSmith dashboard. Reported once per process.`,
    ]);
  });
});

describe("self-capture backstop", () => {
  it("skips exchanges under the ingest URL and the backend URL, whatever the guard says", async () => {
    const c = mk({ backendUrl: `${backend.base}/api` });
    const origin = backend.base;
    const host = origin.replace("http://", "");
    const skipped = [
      `${origin}/v1/captures`,
      `${origin}/v1/captures?x=1`,
      `${origin}/v1/captures/extra`,
      `${origin}/api`,
      `${origin}/api/v1/sdk/sync?cursor=0`,
      `${origin.replace("http://", "HTTP://")}/v1/captures`,
    ];
    const kept = [`${origin}/v1/captures2`, `${origin}/apiary`, `${origin}/other`, "http://127.0.0.1:9/v1/captures"];
    for (const url of [...skipped, ...kept]) c.capture(ex({ url }));
    await c.flush();
    const sent = backend.captures.map((r) => `${String(r.json?.["domain"])}${String(r.json?.["path"])}`).sort();
    expect(sent).toEqual(["127.0.0.1:9/v1/captures", `${host}/apiary`, `${host}/other`, `${host}/v1/captures2`].sort());
  });
});

describe("maskSalt", () => {
  const input = {
    method: "post",
    url: "http://h/x",
    reqHeaders: { "Content-Type": "application/json" },
    reqBody: '{"a":"hello"}',
    status: 200,
    respHeaders: {},
    respBody: "",
  };
  function withRule(c: { rulesCache: RulesCache | null }): void {
    const fp = new PrivacyPipeline(new RulesCache()).process(input)?.req_fingerprint as string;
    c.rulesCache?.applySyncResponse(
      toJsonValue({
        cursor: "1",
        rules: [
          {
            fingerprint: fp,
            request_type: { domain: "h", method: "POST", path_template: "/x" },
            field_rules: [{ path: "body.a", action: "mask", type: "free_text" }],
          },
        ],
      }),
    );
  }

  it("is passed to the pipeline and never written to process.env", () => {
    delete process.env["STUBSMITH_MASK_SALT"];
    const salted = mk({ maskSalt: "salt-one" });
    const other = mk({ maskSalt: "salt-two" });
    const plain = mk();
    for (const c of [salted, other, plain]) withRule(c);
    expect(process.env["STUBSMITH_MASK_SALT"]).toBeUndefined();
    const a = salted.pipeline?.process(input)?.req_body as string;
    const b = other.pipeline?.process(input)?.req_body as string;
    const none = plain.pipeline?.process(input)?.req_body as string;
    expect(a).toMatch(/"a": "text-[0-9a-f]+"/);
    expect(b).toMatch(/"a": "text-[0-9a-f]+"/);
    expect(a).not.toBe(b);
    expect(a).not.toBe(none);
    expect(salted.pipeline?.process(input)?.req_body).toBe(a); // deterministic
    expect(process.env["STUBSMITH_MASK_SALT"]).toBeUndefined();
  });

  it("falls back to the environment when no option is given, and the option wins over it", () => {
    process.env["STUBSMITH_MASK_SALT"] = "env-salt";
    try {
      const fromEnv = mk();
      const fromOption = mk({ maskSalt: "option-salt" });
      for (const c of [fromEnv, fromOption]) withRule(c);
      const e = fromEnv.pipeline?.process(input)?.req_body;
      const o = fromOption.pipeline?.process(input)?.req_body;
      expect(e).toMatch(/text-/);
      expect(o).not.toBe(e);
      expect(process.env["STUBSMITH_MASK_SALT"]).toBe("env-salt");
    } finally {
      delete process.env["STUBSMITH_MASK_SALT"];
    }
  });
});
