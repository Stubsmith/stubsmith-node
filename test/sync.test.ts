import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/_version.js";
import { PrivacyPipeline, RulesCache } from "../src/privacy/index.js";
import { RulesPoller } from "../src/sync.js";
import { syncResponseText } from "./helpers/pipeline.js";
import { type FakeBackend, sleep, startBackend, syncBody, waitFor } from "./helpers/servers.js";

let backend: FakeBackend;
let pollers: RulesPoller[] = [];

function make(over: { backendUrl?: string; intervalMs?: number } = {}): { cache: RulesCache; poller: RulesPoller } {
  const cache = new RulesCache();
  const poller = new RulesPoller(cache, {
    apiKey: "sync-key",
    backendUrl: over.backendUrl ?? backend.base,
    intervalMs: over.intervalMs ?? 3_600_000,
  });
  pollers.push(poller);
  return { cache, poller };
}

beforeEach(async () => {
  backend = await startBackend();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(async () => {
  for (const p of pollers) p.stop();
  pollers = [];
  await backend.close();
  vi.restoreAllMocks();
});

const rule = { domain: "api.example.com", method: "GET", path_template: "/v1/x", fingerprint: "abcdef0123456789" };

describe("RulesPoller", () => {
  it("syncs immediately with auth and user agent, then marks the first sync", async () => {
    backend.sync = { status: 200, body: syncBody("5", [rule]), delayMs: 0 };
    const { cache, poller } = make();
    poller.start();
    expect(await poller.waitForFirstSync(3000)).toBe(true);
    expect(cache.firstSyncDone).toBe(true);
    expect(cache.cursor).toBe("5");
    expect(cache.lookup("api.example.com|GET|/v1/x", rule.fingerprint)).not.toBeNull();
    const req = backend.syncRequests[0];
    expect(req?.url).toBe("/v1/sdk/sync?cursor=0");
    expect(req?.headers["authorization"]).toBe("Bearer sync-key");
    expect(req?.headers["user-agent"]).toBe(`stubsmith-node/${VERSION}`);
  });

  it("loads the curated templates from a sync", async () => {
    backend.sync = {
      status: 200,
      body: syncResponseText("abc", [], { pathTemplates: ["/users/{id}/orders", "/users/{id}"] }),
      delayMs: 0,
    };
    const { cache, poller } = make();
    await poller.pollOnce();
    expect(cache.pathTemplates.map((t) => t.template)).toContain("/users/{id}/orders");
  });

  it("keeps the previous cache after a network error", async () => {
    backend.sync = { status: 200, body: syncResponseText("fp1", [], { cursor: "5" }), delayMs: 0 };
    const { cache, poller } = make();
    await poller.pollOnce();
    expect(cache.cursor).toBe("5");
    // The backend goes away, so the next poll fails at the network.
    await backend.close();
    await poller.pollOnce();
    expect(cache.cursor).toBe("5");
  });

  it("returns true from waitForFirstSync once a poll has synced", async () => {
    backend.sync = { status: 200, body: syncResponseText("abc", [], { cursor: "7" }), delayMs: 0 };
    const { cache, poller } = make();
    expect(cache.firstSyncDone).toBe(false);
    await poller.pollOnce();
    expect(cache.firstSyncDone).toBe(true);
    expect(await poller.waitForFirstSync(1000)).toBe(true);
  });

  it("sends the current cursor on the next poll", async () => {
    backend.sync = { status: 200, body: syncBody("9", [rule]), delayMs: 0 };
    const { poller } = make();
    await poller.pollOnce();
    await poller.pollOnce();
    expect(backend.syncRequests.map((r) => r.url)).toEqual(["/v1/sdk/sync?cursor=0", "/v1/sdk/sync?cursor=9"]);
  });

  it("polls again on the interval and stop() clears the timer", async () => {
    backend.sync = { status: 200, body: syncBody("1", []), delayMs: 0 };
    const { poller } = make({ intervalMs: 30 });
    poller.start();
    await waitFor(() => backend.syncRequests.length >= 3);
    expect(backend.syncRequests.length).toBeGreaterThanOrEqual(3);
    poller.stop();
    await sleep(60);
    const n = backend.syncRequests.length;
    await sleep(120);
    expect(backend.syncRequests.length).toBe(n);
  });

  it("keeps the cache on a network error", async () => {
    const dead = http.createServer();
    await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r));
    const port = (dead.address() as AddressInfo).port;
    await new Promise<void>((r) => dead.close(() => r()));
    const { cache, poller } = make({ backendUrl: `http://127.0.0.1:${port}` });
    await poller.pollOnce();
    expect(cache.firstSyncDone).toBe(false);
    expect(cache.cursor).toBe("0");
    expect(await poller.waitForFirstSync(20)).toBe(false);
  });

  it("keeps the cache on a non-200 status and on a non-object body", async () => {
    const { cache, poller } = make();
    backend.sync = { status: 200, body: syncBody("3", [rule]), delayMs: 0 };
    await poller.pollOnce();
    expect(cache.cursor).toBe("3");
    for (const bad of [
      { status: 500, body: "oops" },
      { status: 403, body: "{}" },
      { status: 200, body: "[1,2]" },
      { status: 200, body: "not json" },
      { status: 200, body: "null" },
    ]) {
      backend.sync = { ...bad, delayMs: 0 };
      await poller.pollOnce();
      expect(cache.cursor).toBe("3");
      expect(cache.lookup("api.example.com|GET|/v1/x", rule.fingerprint)).not.toBeNull();
    }
  });

  it("a 500 on the first sync leaves firstSyncDone false", async () => {
    const { cache, poller } = make();
    await poller.pollOnce();
    expect(cache.firstSyncDone).toBe(false);
  });

  describe("404 from sync", () => {
    // Dummy values only. Everything below must leave the process masked.
    const dummyEmail = "ana@example.com";
    const dummyCard = "4111111111111111";
    const dummyPassword = "hunter2";
    const dummyToken = "tok_dummy_123";
    const orderReq = {
      method: "POST",
      url: `https://api.example.com/v1/orders?email=${dummyEmail}&page=2`,
      reqHeaders: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${dummyToken}`,
        "X-User": dummyEmail,
      },
      reqBody: JSON.stringify({ user: { email: dummyEmail, password: dummyPassword }, card: dummyCard, amount: 99, gift: true }),
      status: 200,
      respHeaders: { "Content-Type": "application/json", "Set-Cookie": `s=${dummyToken}` },
      respBody: JSON.stringify({ id: 7, receipt_email: dummyEmail }),
    };
    const beforeAnySync = "Every captured value is masked until sync succeeds.";
    const afterASync =
      "Rules from the last successful sync stay in effect; anything they do not cover is masked in full until sync succeeds again.";

    function warnings(): string[] {
      return vi.mocked(console.warn).mock.calls.map((c) => String(c[0]));
    }

    it("never fetches the legacy URL, does not mark the first sync done, and emits the payload fully masked and novel", async () => {
      backend.sync = { status: 404, body: "", delayMs: 0 };
      backend.legacy = {
        status: 200,
        body: JSON.stringify({ ok: true, field_masks: ["password"], regex_masks: [] }),
      };
      const { cache, poller } = make();
      await poller.pollOnce();
      expect(backend.syncRequests.map((r) => r.url)).toEqual(["/v1/sdk/sync?cursor=0"]);
      expect(backend.otherRequests).toEqual([]);
      expect(cache.firstSyncDone).toBe(false);
      expect(await poller.waitForFirstSync(10)).toBe(false);
      // The 404 branch is what warns; without it a 404 would fall through as an unexpected status, silently.
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]).toContain("HTTP 404");

      const out = new PrivacyPipeline(cache).process(orderReq);
      expect(out).not.toBeNull();
      const wire = JSON.stringify(out);
      for (const secret of [dummyEmail, "ana%40example.com", dummyCard, dummyPassword, dummyToken]) {
        expect(wire).not.toContain(secret);
      }
      const { req_fingerprint: reqFp, resp_fingerprint: respFp, sdk_version: sdkVersion, ...rest } = out as unknown as Record<string, unknown>;
      expect(reqFp).toMatch(/\S/);
      expect(respFp).toMatch(/\S/);
      // No sync has succeeded, so the private raw path rides along; the client's sender removes it before sending.
      expect(rest).toEqual({
        _raw_path: "/v1/orders",
        classifier_spec_version: 1,
        sdk_masked: true,
        sdk_rule_version: "0",
        domain: "api.example.com",
        path_template: "/v1/orders",
        path: "/v1/orders?email=%3Cmasked%3E&page=%3Cmasked%3E",
        method: "POST",
        status: 200,
        key_paths: ["user", "user.email", "user.password", "card", "amount", "gift"],
        resp_key_paths: ["id", "receipt_email"],
        req_header_names: ["authorization", "content-type", "x-user"],
        resp_header_names: ["content-type", "set-cookie"],
        query_names: ["email", "page"],
        headers: { "Content-Type": "application/json", Authorization: "<masked>", "X-User": "<masked>" },
        req_body: '{"user": {"email": "<masked>", "password": "<masked>"}, "card": "<masked>", "amount": 0, "gift": false}',
        resp_headers: { "Content-Type": "application/json", "Set-Cookie": "<masked>" },
        resp_body: '{"id": 0, "receipt_email": "<masked>"}',
        novel: true,
        req_value_types: { "user.email": "email", "user.password": "free_text", card: "integer_id", amount: "integer_id" },
        resp_value_types: { id: "integer_id", receipt_email: "email" },
      });
      expect(sdkVersion).toBe(VERSION);
    });

    it("warns exactly once across polls, naming HTTP 404, the sync URL and the backend URL", async () => {
      backend.sync = { status: 404, body: "", delayMs: 0 };
      const { poller } = make();
      await poller.pollOnce();
      await poller.pollOnce();
      await poller.pollOnce();
      expect(backend.syncRequests).toHaveLength(3);
      expect(backend.otherRequests).toEqual([]);
      expect(console.warn).toHaveBeenCalledTimes(1);
      const msg = warnings()[0] ?? "";
      expect(msg).toContain("HTTP 404");
      expect(msg).toContain(`${backend.base}/v1/sdk/sync`);
      expect(msg).toContain(`'${backend.base}'`);
    });

    it("before any sync, warns that every value is masked", async () => {
      backend.sync = { status: 404, body: "", delayMs: 0 };
      const { poller } = make();
      await poller.pollOnce();
      expect(warnings()).toHaveLength(1);
      expect(warnings()[0]?.endsWith(beforeAnySync)).toBe(true);
    });

    it("after a sync, warns that the cached rules still apply", async () => {
      backend.sync = { status: 200, body: syncBody("5", [rule]), delayMs: 0 };
      const { poller } = make();
      await poller.pollOnce();
      backend.sync = { status: 404, body: "", delayMs: 0 };
      await poller.pollOnce();
      expect(warnings()).toHaveLength(1);
      const msg = warnings()[0] ?? "";
      expect(msg).toContain("HTTP 404");
      expect(msg).toContain(`'${backend.base}'`);
      expect(msg.endsWith(afterASync)).toBe(true);
      expect(msg).not.toContain("Every captured value is masked");
    });

    it("a 404, then a sync, then a 404 warns again with the after-sync wording", async () => {
      backend.sync = { status: 404, body: "", delayMs: 0 };
      const { poller } = make();
      await poller.pollOnce();
      backend.sync = { status: 200, body: syncBody("1", [rule]), delayMs: 0 };
      await poller.pollOnce();
      backend.sync = { status: 404, body: "", delayMs: 0 };
      await poller.pollOnce();
      await poller.pollOnce();
      const msgs = warnings();
      expect(msgs).toHaveLength(2);
      expect(msgs[0]?.endsWith(beforeAnySync)).toBe(true);
      expect(msgs[1]?.endsWith(afterASync)).toBe(true);
    });

    it("keeps previously synced rules and does not undo the first sync", async () => {
      const reqBody = JSON.stringify({ id: 5 });
      const req = { ...orderReq, reqBody, reqHeaders: { "Content-Type": "application/json" }, url: "https://api.example.com/v1/orders" };
      const fp = new PrivacyPipeline(new RulesCache()).process(req)?.req_fingerprint as string;
      backend.sync = {
        status: 200,
        body: JSON.stringify({
          ok: true,
          cursor: "1",
          rules: [
            {
              seq: 1,
              request_type: { domain: "api.example.com", method: "POST", path_template: "/v1/orders" },
              fingerprint: fp,
              field_rules: [{ path: "body.id", action: "keep" }],
            },
          ],
          path_templates: [],
          project_defaults: null,
          request_type_value_config: {},
        }),
        delayMs: 0,
      };
      const { cache, poller } = make();
      await poller.pollOnce();
      backend.sync = { status: 404, body: "", delayMs: 0 };
      await poller.pollOnce();
      expect(cache.firstSyncDone).toBe(true);
      expect(cache.cursor).toBe("1");
      expect(backend.otherRequests).toEqual([]);

      const out = new PrivacyPipeline(cache).process(req);
      expect(out?.novel).toBe(false);
      expect(JSON.parse(out?.req_body as string)).toEqual({ id: 5 });
    });
  });

  it("does not run overlapping polls", async () => {
    backend.sync = { status: 200, body: syncBody("1", []), delayMs: 150 };
    const { poller } = make();
    const first = poller.pollOnce();
    await sleep(20);
    await poller.pollOnce(); // skipped while the first is in flight
    await first;
    expect(backend.syncRequests.length).toBe(1);
    await poller.pollOnce();
    expect(backend.syncRequests.length).toBe(2);
  });

  it("waitForFirstSync times out false and resolves false on stop", async () => {
    const { poller } = make();
    const t = Date.now();
    expect(await poller.waitForFirstSync(40)).toBe(false);
    expect(Date.now() - t).toBeLessThan(1000);
    const pending = poller.waitForFirstSync(5000);
    poller.stop();
    expect(await pending).toBe(false);
  });
});
