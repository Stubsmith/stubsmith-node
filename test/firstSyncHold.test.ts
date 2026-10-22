import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FIRST_SYNC_HOLD_MS, StubsmithClient } from "../src/client.js";
import { resetWarnOnceForTests } from "../src/env.js";
import type { CapturedExchange } from "../src/types.js";
import { type FakeBackend, sleep, startBackend, waitFor } from "./helpers/servers.js";

// A capture processed before the first rules sync is templated with ID grouping on, because the project's
// "Group IDs in paths automatically" setting is not yet known. The sender holds it, bounded, for the sync.

let backend: FakeBackend;
let clients: StubsmithClient[] = [];
let warn: ReturnType<typeof vi.spyOn>;
const ENV = ["STUBSMITH_API_KEY", "STUBSMITH_URL", "STUBSMITH_BACKEND_URL", "STUBSMITH_DEBUG", "STUBSMITH_FLUSH_TIMEOUT"];
const savedEnv: Record<string, string | undefined> = {};

function mk(): StubsmithClient {
  const c = new StubsmithClient({
    apiKey: "test-key",
    url: backend.ingestUrl,
    backendUrl: backend.base,
    rulesPollInterval: 3_600_000,
  });
  clients.push(c);
  return c;
}

function ex(): CapturedExchange {
  return {
    method: "get",
    url: "https://api.example.com/orders/123?page=2",
    reqHeaders: {},
    reqBody: "",
    status: 200,
    respHeaders: { "content-type": "application/json" },
    respBody: '{"ok": true}',
    durationMs: 1,
    source: "node-fetch",
  };
}

function syncWith(groupIds: boolean, delayMs: number): void {
  backend.sync = {
    status: 200,
    delayMs,
    body: JSON.stringify({
      ok: true,
      cursor: "1",
      rules: [],
      path_templates: [],
      project_settings: { group_ids_in_paths: groupIds },
    }),
  };
}

/** Serve the sync for `groupIds` now and run one poll, the moment the first sync arrives. */
async function syncNow(c: StubsmithClient, groupIds: boolean): Promise<void> {
  // Let the first poll (answered 500) finish, so this one is not skipped as overlapping.
  await waitFor(() => backend.syncRequests.length >= 1, 3000);
  await sleep(60);
  syncWith(groupIds, 0);
  await (c as unknown as { poller: { pollOnce(): Promise<void> } }).poller.pollOnce();
}

const processed = (c: StubsmithClient): Record<string, unknown> | null =>
  c.pipeline?.process({ method: "get", url: ex().url, reqHeaders: {}, reqBody: "", status: 200, respHeaders: { "content-type": "application/json" }, respBody: '{"ok": true}' }) as Record<string, unknown> | null;

beforeEach(async () => {
  for (const n of ENV) {
    savedEnv[n] = process.env[n];
    delete process.env[n];
  }
  backend = await startBackend();
  resetWarnOnceForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  StubsmithClient.firstSyncHoldMs = FIRST_SYNC_HOLD_MS;
});

afterEach(async () => {
  for (const c of clients) await c.close();
  clients = [];
  StubsmithClient.firstSyncHoldMs = 0;
  warn.mockRestore();
  await backend.close();
  for (const n of ENV) {
    if (savedEnv[n] === undefined) delete process.env[n];
    else process.env[n] = savedEnv[n];
  }
});

describe("hold for the first rules sync", () => {
  it("grouping off: sends the concrete path once the sync arrives", async () => {
    StubsmithClient.firstSyncHoldMs = 2000;
    const c = mk(); // sync answers 500 until syncNow: the capture is held
    const payload = processed(c);
    expect(payload?.["path_template"]).toBe("/orders/{id}");
    c.capture(ex());
    await sleep(300);
    expect(backend.captures).toHaveLength(0); // held, not sent with the wrong template
    await syncNow(c, false);
    await waitFor(() => backend.captures.length === 1, 3000);
    const sent = backend.captures[0]?.json as Record<string, unknown>;
    expect(sent["path_template"]).toBe("/orders/123");
    expect(String(sent["path"])).toMatch(/^\/orders\/123\?page=/);
  });

  it("grouping on: sends the templated path once the sync arrives", async () => {
    StubsmithClient.firstSyncHoldMs = 2000;
    const c = mk();
    c.capture(ex());
    await syncNow(c, true);
    await waitFor(() => backend.captures.length === 1, 3000);
    const sent = backend.captures[0]?.json as Record<string, unknown>;
    expect(sent["path_template"]).toBe("/orders/{id}");
    expect(String(sent["path"])).toMatch(/^\/orders\/\{id\}\?page=/);
  });

  it("no sync ever: sends the capture-time template once the bound runs out", async () => {
    StubsmithClient.firstSyncHoldMs = 300; // sync answers 500 by default
    const c = mk();
    const t0 = Date.now();
    c.capture(ex());
    await waitFor(() => backend.captures.length === 1, 3000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const sent = backend.captures[0]?.json as Record<string, unknown>;
    expect(sent["path_template"]).toBe("/orders/{id}");
    expect(String(sent["path"])).toMatch(/^\/orders\/\{id\}\?page=/);
  });

  it("never sends the private raw path", async () => {
    StubsmithClient.firstSyncHoldMs = 2000;
    const c = mk();
    expect(processed(c)).toHaveProperty("_raw_path");
    c.capture(ex());
    await syncNow(c, false);
    await waitFor(() => backend.captures.length === 1, 3000);
    expect(backend.captures[0]?.raw.toString("latin1")).not.toContain("_raw_path");
    expect(backend.captures[0]?.json).not.toHaveProperty("_raw_path");

    // The bound runs out without a sync (0.1 s): the raw path is stripped then too.
    StubsmithClient.firstSyncHoldMs = 100;
    backend.sync = { status: 500, body: "boom", delayMs: 0 };
    const d = mk();
    d.capture(ex());
    await waitFor(() => backend.captures.length === 2, 3000);
    expect(backend.captures[1]?.json).not.toHaveProperty("_raw_path");
  });

  it("a capture after the first sync carries no raw path", async () => {
    syncWith(false, 0);
    const c = mk();
    await c.waitForRules(3000);
    expect(c.pipeline?.process({ method: "get", url: ex().url, reqHeaders: {}, reqBody: "", status: 200, respHeaders: {}, respBody: "" })).not.toHaveProperty("_raw_path");
  });

  it("flush sends a held capture instead of waiting for the sync", async () => {
    // A short script's exit flush must not be spent waiting for a sync that may never come: flushing
    // ends the hold and the capture goes out with the capture-time template, as before the hold existed.
    StubsmithClient.firstSyncHoldMs = 2000;
    const c = mk(); // sync answers 500: the capture stays held
    c.capture(ex());
    await sleep(200);
    expect(backend.captures).toHaveLength(0); // held
    const t0 = Date.now();
    await c.flush({ timeoutMs: 1000 });
    expect(Date.now() - t0).toBeLessThan(800);
    expect(backend.captures).toHaveLength(1);
    expect((backend.captures[0]?.json as Record<string, unknown>)["path_template"]).toBe("/orders/{id}");
  });

  it("close is bounded while a capture is held, and the client stops", async () => {
    StubsmithClient.firstSyncHoldMs = 2000;
    const c = mk();
    c.capture(ex());
    await sleep(200);
    const started = Date.now();
    await c.close();
    // Bounded by the default close budget (5 s) plus one second; in practice the hold ends at once.
    expect(Date.now() - started).toBeLessThan(5000 + 1000);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(c.stopped).toBe(true);
  });
});
