import http from "node:http";
import type { AddressInfo } from "node:net";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubsmithClient } from "../src/client.js";
import { InsecureEndpointError, checkEndpoint } from "../src/endpoint.js";
import { fixtures } from "../src/fixtures.js";
import { RulesCache } from "../src/privacy/index.js";
import { fetchBundle } from "../src/pull.js";
import { ORIGINAL_REQUEST } from "../src/replayState.js";
import { RulesPoller } from "../src/sync.js";
import { sendRequest } from "../src/transport.js";
import type { CapturedExchange } from "../src/types.js";
import { waitFor } from "./helpers/servers.js";

const ENV = ["STUBSMITH_API_KEY", "STUBSMITH_URL", "STUBSMITH_BACKEND_URL", "STUBSMITH_API_URL", "STUBSMITH_FLUSH_TIMEOUT"];
const savedEnv: Record<string, string | undefined> = {};
let warn: MockInstance<typeof console.warn>;
let clients: StubsmithClient[] = [];
let pollers: RulesPoller[] = [];

beforeEach(() => {
  for (const n of ENV) {
    savedEnv[n] = process.env[n];
    delete process.env[n];
  }
  process.env["STUBSMITH_FLUSH_TIMEOUT"] = "1";
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const p of pollers) p.stop();
  pollers = [];
  for (const c of clients) await c.close();
  clients = [];
  vi.restoreAllMocks();
  for (const n of ENV) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
});

function ex(): CapturedExchange {
  return {
    method: "get",
    url: "https://api.example.com/v1/items",
    reqHeaders: {},
    reqBody: "",
    status: 200,
    respHeaders: { "content-type": "application/json" },
    respBody: '{"ok": true}',
    durationMs: 1,
    source: "node-fetch",
  };
}

/** Record every connection the SDK opens. The real requests still run, so a refused URL must open none. */
function connections(): string[] {
  const opened: string[] = [];
  for (const k of ["http", "https"] as const) {
    const orig = ORIGINAL_REQUEST[k];
    vi.spyOn(ORIGINAL_REQUEST, k).mockImplementation(((u: unknown, ...rest: unknown[]) => {
      opened.push(String(u));
      return (orig as (...a: unknown[]) => http.ClientRequest)(u, ...rest);
    }) as typeof http.request);
  }
  return opened;
}

describe("checkEndpoint", () => {
  it.each([
    "https://ingest.stubsmith.dev/v1/captures",
    "https://app.stubsmith.dev/api",
    "http://localhost:8081/v1/captures",
    "http://127.0.0.1:8081",
    "http://[::1]:8081",
  ])("accepts %s", (url) => {
    expect(() => checkEndpoint(url)).not.toThrow();
  });

  it.each(["http://ingest:8081/v1/captures", "http://api.example.com", "http://localhost.example.com", "ftp://app.stubsmith.dev", "not a url"])(
    "refuses %s",
    (url) => {
      expect(() => checkEndpoint(url)).toThrow(InsecureEndpointError);
    },
  );

  it("names scheme and host only, never credentials", () => {
    let msg = "";
    try {
      checkEndpoint("http://user:hunter2@api.example.com/path?key=sk-secret");
    } catch (err) {
      msg = (err as Error).message;
    }
    expect(msg).toContain("http://api.example.com");
    expect(msg).not.toContain("hunter2");
    expect(msg).not.toContain("sk-secret");
    expect(msg).not.toContain("user");
  });
});

describe("plaintext endpoints", () => {
  it.each([
    ["url", { url: "http://ingest.example.com/v1/captures", backendUrl: "https://app.stubsmith.dev/api" }],
    ["backendUrl", { url: "https://ingest.stubsmith.dev/v1/captures", backendUrl: "http://app.example.com/api" }],
  ])("a plaintext %s turns capture off with a warning, and nothing is sent", async (_name, urls) => {
    const opened = connections();
    const c = new StubsmithClient({ apiKey: "sk-secret", rulesPollInterval: 3_600_000, ...urls });
    clients.push(c);
    expect(c.enabled).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Capture is off."));
    c.capture(ex());
    await c.flush();
    expect(opened).toEqual([]);
  });

  it("a plaintext STUBSMITH_URL turns capture off too", () => {
    process.env["STUBSMITH_URL"] = "http://ingest:8081/v1/captures";
    const c = new StubsmithClient({ apiKey: "sk-secret", rulesPollInterval: 3_600_000 });
    clients.push(c);
    expect(c.enabled).toBe(false);
  });

  it("the transport refuses a plaintext URL before it connects", async () => {
    const opened = connections();
    const t = sendRequest("http://api.example.com/v1/captures", { method: "POST", headers: {}, timeoutMs: 1000, maxBytes: 10 });
    await expect(t.promise).rejects.toBeInstanceOf(InsecureEndpointError);
    expect(opened).toEqual([]);
  });

  it("the rules sync sends nothing to a plaintext backend", async () => {
    const opened = connections();
    const poller = new RulesPoller(new RulesCache(), { apiKey: "sk-secret", backendUrl: "http://app.example.com/api", intervalMs: 3_600_000 });
    pollers.push(poller);
    await poller.pollOnce();
    expect(opened).toEqual([]);
  });

  it("fixtures() throws for a plaintext apiUrl", async () => {
    const opened = connections();
    await expect(fixtures("GET /v1/x", { apiKey: "sk-secret", apiUrl: "http://api.example.com" })).rejects.toBeInstanceOf(
      InsecureEndpointError,
    );
    expect(opened).toEqual([]);
  });

  it("pull throws for a plaintext apiUrl", async () => {
    const opened = connections();
    await expect(fetchBundle(undefined, { apiKey: "sk-secret", apiUrl: "http://api.example.com" })).rejects.toBeInstanceOf(
      InsecureEndpointError,
    );
    expect(opened).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Redirects: following one would re-send the authorization header to the target.
// ---------------------------------------------------------------------------

interface Server {
  base: string;
  port: number;
  seen: Array<{ method: string; url: string; auth: string | undefined }>;
  close(): Promise<void>;
}

async function serve(status: number, headers: () => Record<string, string>): Promise<Server> {
  const seen: Server["seen"] = [];
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", auth: req.headers.authorization });
      res.writeHead(status, { "content-type": "application/json", ...headers() });
      res.end(status === 200 ? '{"endpoints": [], "fixtures": []}' : "");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe("redirects", () => {
  let origin: Server;
  let target: Server;

  beforeEach(async () => {
    // The target is an allowed local host on purpose: no redirect is followed at
    // all, so a plaintext or foreign target can never receive the key either.
    target = await serve(200, () => ({}));
    origin = await serve(302, () => ({ location: `http://localhost:${target.port}/x` }));
  });

  afterEach(async () => {
    await origin.close();
    await target.close();
  });

  it("a capture send does not follow a 302, and counts it as a failure", async () => {
    const c = new StubsmithClient({
      apiKey: "sk-secret",
      url: `${origin.base}/v1/captures`,
      backendUrl: "https://127.0.0.1:1",
      rulesPollInterval: 3_600_000,
    });
    clients.push(c);
    expect(c.enabled).toBe(true);
    c.capture(ex());
    // flush() sends a capture held for the first rules sync at once.
    await c.flush();
    await waitFor(() => c.sendFailures === 1);
    expect(c.sendFailures).toBe(1);
    expect(origin.seen.filter((r) => r.url === "/v1/captures")).toHaveLength(1);
    expect(target.seen).toEqual([]);
  });

  it("the rules sync does not follow a 302", async () => {
    const cache = new RulesCache();
    const poller = new RulesPoller(cache, { apiKey: "sk-secret", backendUrl: origin.base, intervalMs: 3_600_000 });
    pollers.push(poller);
    await poller.pollOnce();
    expect(origin.seen).toHaveLength(1);
    expect(cache.firstSyncDone).toBe(false);
    expect(target.seen).toEqual([]);
  });

  it("fixtures() does not follow a 302", async () => {
    await expect(fixtures("GET /v1/x", { apiKey: "sk-secret", apiUrl: origin.base })).rejects.toThrow(/HTTP 302/);
    expect(origin.seen).toHaveLength(1);
    expect(target.seen).toEqual([]);
  });

  it("pull does not follow a 302", async () => {
    await expect(fetchBundle(undefined, { apiKey: "sk-secret", apiUrl: origin.base })).rejects.toThrow(/HTTP 302/);
    expect(origin.seen).toHaveLength(1);
    expect(target.seen).toEqual([]);
  });
});
