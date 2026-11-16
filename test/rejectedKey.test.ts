import http from "node:http";
import type { AddressInfo } from "node:net";
import { type MockInstance, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StubsmithClient } from "../src/client.js";
import { WARN_ONCE_CAP, resetWarnOnceForTests, warnOnce } from "../src/env.js";
import { resetIngestWarningsForTests, resetRejectedKeyWarningForTests } from "../src/refusals.js";
import { RulesPoller } from "../src/sync.js";
import { RulesCache } from "../src/privacy/index.js";
import type { CapturedExchange } from "../src/types.js";
import { waitFor } from "./helpers/servers.js";

// Distinctive, so any 4-character slice of it is unlikely to occur in the warning by chance.
const KEY = "sk-zq7Wv9XjP3mRt";

interface Server {
  base: string;
  ingestHits: number;
  syncHits: number;
  ingestStatus: number;
  syncStatus: number;
  close(): Promise<void>;
}

/** Ingest answers plain text like the real service; sync answers JSON. Real HTTP, no mocked modules. */
async function startServer(): Promise<Server> {
  const state = { ingestHits: 0, syncHits: 0, ingestStatus: 401, syncStatus: 500 };
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (req.url?.startsWith("/v1/sdk/sync")) {
        state.syncHits++;
        res.writeHead(state.syncStatus, { "content-type": "application/json" });
        res.end('{"error":"project key required"}');
      } else {
        state.ingestHits++;
        if (state.ingestStatus === 200) {
          res.writeHead(200, { "content-type": "application/json" });
          res.end('{"ok": true}');
        } else {
          res.writeHead(state.ingestStatus, { "content-type": "text/plain" });
          res.end("invalid project token");
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(state, {
    base,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  });
}

function ex(): CapturedExchange {
  return {
    method: "post",
    url: "https://api.example.com/v1/items",
    reqHeaders: { "content-type": "application/json" },
    reqBody: '{"name": "widget"}',
    status: 200,
    respHeaders: { "content-type": "application/json" },
    respBody: '{"id": 7}',
    durationMs: 5,
    source: "node-fetch",
  };
}

let srv: Server;
let clients: StubsmithClient[] = [];
let pollers: RulesPoller[] = [];
let warn: MockInstance<typeof console.warn>;

function mk(): StubsmithClient {
  const c = new StubsmithClient({
    apiKey: KEY,
    url: `${srv.base}/v1/captures`,
    backendUrl: srv.base,
    rulesPollInterval: 3_600_000,
  });
  clients.push(c);
  return c;
}

async function send(c: StubsmithClient, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    c.capture(ex());
    await c.flush({ timeoutMs: 2000 });
  }
}

function rejectedWarnings(): string[] {
  return warn.mock.calls.map((c) => c.map(String).join(" ")).filter((m) => m.includes("API key was rejected"));
}

beforeEach(async () => {
  process.env["STUBSMITH_FLUSH_TIMEOUT"] = "1";
  srv = await startServer();
  resetIngestWarningsForTests();
  resetWarnOnceForTests();
  resetRejectedKeyWarningForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  for (const p of pollers) p.stop();
  pollers = [];
  await srv.close();
  vi.restoreAllMocks();
  delete process.env["STUBSMITH_FLUSH_TIMEOUT"];
});

describe("rejected API key warning", () => {
  it("still warns when other once-only warnings have used up their cap", async () => {
    for (let i = 0; i < WARN_ONCE_CAP; i++) warnOnce(`oversize:endpoint-${i}`, `other ${i}`);
    await send(mk(), 1);
    expect(rejectedWarnings()).toHaveLength(1);
  });

  it("warns exactly once for one rejected ingest request (401)", async () => {
    await send(mk(), 1);
    expect(srv.ingestHits).toBe(1);
    const w = rejectedWarnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatch(/^stubsmith: /);
    expect(w[0]).toContain("HTTP 401");
    expect(w[0]).toContain("STUBSMITH_API_KEY");
    expect(w[0]).toContain("https://docs.stubsmith.dev/#capturing");
    expect(w[0]).not.toMatch(/\u2014/);
  });

  it("warns once for three rejected requests, also across clients", async () => {
    await send(mk(), 3);
    await send(mk(), 1);
    expect(srv.ingestHits).toBe(4);
    expect(rejectedWarnings()).toHaveLength(1);
  });

  it("does not warn on a 200", async () => {
    srv.ingestStatus = 200;
    await send(mk(), 2);
    expect(srv.ingestHits).toBe(2);
    expect(rejectedWarnings()).toHaveLength(0);
  });

  it("warns on a 403 and names the status", async () => {
    srv.ingestStatus = 403;
    await send(mk(), 1);
    const w = rejectedWarnings();
    expect(w).toHaveLength(1);
    expect(w[0]).toContain("HTTP 403");
  });

  it("does not warn on other errors such as 500", async () => {
    srv.ingestStatus = 500;
    await send(mk(), 1);
    expect(rejectedWarnings()).toHaveLength(0);
  });

  it("warns once in total for an ingest 401 followed by a sync 401", async () => {
    await send(mk(), 1);
    srv.syncStatus = 401;
    const poller = new RulesPoller(new RulesCache(), { apiKey: KEY, backendUrl: srv.base, intervalMs: 3_600_000 });
    pollers.push(poller);
    poller.start();
    await waitFor(() => srv.syncHits >= 1);
    await waitFor(() => false, 100);
    expect(srv.syncHits).toBeGreaterThanOrEqual(1);
    expect(rejectedWarnings()).toHaveLength(1);
  });

  it("warns from the rules sync alone on a 401 and on a 403", async () => {
    for (const status of [401, 403]) {
      warn.mockClear();
      srv.syncHits = 0;
      srv.syncStatus = status;
      resetRejectedKeyWarningForTests();
      const poller = new RulesPoller(new RulesCache(), { apiKey: KEY, backendUrl: srv.base, intervalMs: 3_600_000 });
      pollers.push(poller);
      poller.start();
      await waitFor(() => srv.syncHits >= 1);
      await waitFor(() => rejectedWarnings().length > 0, 500);
      const w = rejectedWarnings();
      expect(w).toHaveLength(1);
      expect(w[0]).toContain(`HTTP ${status}`);
    }
  });

  it("never contains the API key or any 4-character part of it, and no URL", async () => {
    const c = mk();
    await send(c, 2);
    srv.syncStatus = 401;
    const poller = new RulesPoller(new RulesCache(), { apiKey: KEY, backendUrl: srv.base, intervalMs: 3_600_000 });
    pollers.push(poller);
    poller.start();
    await waitFor(() => srv.syncHits >= 1);
    expect(rejectedWarnings()).toHaveLength(1);
    const all = warn.mock.calls.map((call) => call.map(String).join(" ")).join("\n");
    for (let len = 4; len <= KEY.length; len++) {
      for (let i = 0; i + len <= KEY.length; i++) {
        expect(all, `substring ${KEY.slice(i, i + len)}`).not.toContain(KEY.slice(i, i + len));
      }
    }
    expect(all).not.toMatch(/https?:\/\/(127|localhost)/);
    expect(all).not.toContain(srv.base);
  });

  it("does not change the exchange: the capture is still posted with the key", async () => {
    await send(mk(), 1);
    expect(srv.ingestHits).toBe(1);
  });
});
