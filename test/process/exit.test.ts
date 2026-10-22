import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeBackend, startBackend, waitFor } from "../helpers/servers.js";
import { type Bundle, CAPTURE_JS, type StalledServer, buildSdk, runScript, startStalled } from "./helpers.js";

let bundle: Bundle;
let stalled: StalledServer;
/** Wall time of a subprocess that loads the SDK bundle and does nothing: machine speed and spawn cost. */
let baseline = 0;

beforeAll(async () => {
  bundle = buildSdk();
  stalled = await startStalled();
  await runScript(bundle, ""); // warm the disk cache
  baseline = (await runScript(bundle, "")).ms;
});
afterAll(async () => {
  await stalled.close();
  bundle.cleanup();
});

const INSTALL = (ingest: string, backend: string): string => `
const client = sdk.install({ apiKey: "k", url: ${JSON.stringify(ingest + "/v1/captures")}, backendUrl: ${JSON.stringify(backend)}, rulesPollInterval: 3600000 });
`;

describe("process exit behaviour (subprocess)", () => {
  it("waitForRules keeps the process alive until its timeout when the backend fails fast", async () => {
    const r = await runScript(
      bundle,
      `${INSTALL("http://127.0.0.1:9", "http://127.0.0.1:9")}
const t = Date.now();
const ok = await client.waitForRules(1500);
console.log(JSON.stringify({ ok, ms: Date.now() - t }));`,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { ok: boolean; ms: number };
    expect(out.ok).toBe(false);
    expect(out.ms).toBeGreaterThanOrEqual(1400);
    expect(r.ms).toBeGreaterThanOrEqual(1400);
  }, 10_000);

  it("(a) a stalled ingest with the default budget delays exit by about 1 s, not 5", async () => {
    const before = stalled.requests();
    const r = await runScript(bundle, `${INSTALL(stalled.url, stalled.url)}\nclient.capture(${CAPTURE_JS});`);
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(baseline + 1300);
    expect(r.ms).toBeGreaterThanOrEqual(900); // the budget was honoured, not skipped
    expect(stalled.requests()).toBeGreaterThan(before); // the ingest really was stalled mid-request
  }, 10_000);

  it("(b) a stalled ingest with STUBSMITH_FLUSH_TIMEOUT=0 exits promptly", async () => {
    const r = await runScript(bundle, `${INSTALL(stalled.url, stalled.url)}\nclient.capture(${CAPTURE_JS});`, {
      STUBSMITH_FLUSH_TIMEOUT: "0",
    });
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(baseline + 400);
  }, 10_000);

  it("(c) a stalled backend with nothing captured exits promptly", async () => {
    const r = await runScript(bundle, INSTALL(stalled.url, stalled.url));
    expect(r.code).toBe(0);
    expect(r.ms).toBeLessThan(baseline + 400);
  }, 10_000);

  describe("healthy ingest", () => {
    let backend: FakeBackend;
    beforeAll(async () => {
      backend = await startBackend();
    });
    afterAll(async () => {
      await backend.close();
    });

    it("(d) delivers the capture and exits promptly", async () => {
      const r = await runScript(bundle, `${INSTALL(backend.base, backend.base)}\nclient.capture(${CAPTURE_JS});`);
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(baseline + 400);
      await waitFor(() => backend.captures.length >= 1);
      expect(backend.captures).toHaveLength(1);
      expect(backend.captures[0]?.json?.["domain"]).toBe("api.example.com");
    }, 10_000);
  });

  describe("fetch bodies that are never consumed", () => {
    let backend: FakeBackend;
    let origin: http.Server;
    let base = "";
    beforeAll(async () => {
      backend = await startBackend();
      origin = http.createServer((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"a": 1, ');
        res.end('"b": 2}');
      });
      await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
      base = `http://127.0.0.1:${(origin.address() as { port: number }).port}`;
    });
    afterAll(async () => {
      origin.closeAllConnections();
      await new Promise<void>((r) => origin.close(() => r()));
      await backend.close();
    });

    it("(f) a fire-and-forget await fetch(url) with the body ignored does not tax exit by the grace period", async () => {
      const r = await runScript(
        bundle,
        `${INSTALL(backend.base, backend.base)}\nawait fetch(${JSON.stringify(base + "/x")});`,
      );
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(baseline + 400);
    }, 10_000);

    it("(g) a body read in part and then abandoned does not tax exit either", async () => {
      const r = await runScript(
        bundle,
        `${INSTALL(backend.base, backend.base)}
const res = await fetch(${JSON.stringify(base + "/x")});
const reader = res.body.getReader();
await reader.read();`,
      );
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(baseline + 400);
    }, 10_000);
  });

  it("(e) close() with a stalled ingest returns within 5.5 s and the process exits right after", async () => {
    const r = await runScript(
      bundle,
      `${INSTALL(stalled.url, stalled.url)}
client.capture(${CAPTURE_JS});
const t = Date.now();
await client.close();
console.log(JSON.stringify({ closeMs: Date.now() - t }));`,
    );
    expect(r.code).toBe(0);
    const out = JSON.parse(r.stdout.trim()) as { closeMs: number };
    expect(out.closeMs).toBeLessThan(5500);
    expect(out.closeMs).toBeGreaterThanOrEqual(4500); // default 5 s, not the 1 s exit budget
    expect(r.ms - out.closeMs).toBeLessThan(900); // process start plus the exit after close()
  }, 10_000);
});
