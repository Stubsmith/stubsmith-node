import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { Fixture, fixtures, fixturesBundle } from "../src/index.js";
import { startUpstream, type Upstream } from "./helpers/servers.js";

let srv: Upstream | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
  delete process.env.STUBSMITH_API_URL;
  delete process.env.STUBSMITH_BACKEND_URL;
  delete process.env.STUBSMITH_API_KEY;
});

const fx = (status: number, body: string | null = '{"ok":true}') => ({
  id: `c${status}`,
  captured_at: "2026-01-01T00:00:00Z",
  method: "POST",
  path: "/v1/charges/{id}",
  status,
  duration_ms: 12,
  request: { headers: { a: "b" }, body: null },
  response: { headers: { "content-type": "application/json" }, body },
});

function serve(status: number, body: unknown): Promise<Upstream> {
  return startUpstream((_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  });
}

describe("fixtures", () => {
  it("queries /v1/fixtures with bearer auth and returns Fixture objects", async () => {
    srv = await serve(200, { ok: true, request_type: { id: 1 }, count: 2, fixtures: [fx(201), fx(404, null)] });
    const out = await fixtures("post /v1/charges/{id}", { apiUrl: `${srv.base}/`, apiKey: "k", distinct: "status", limit: 5 });
    const req = srv.requests[0]!;
    expect(req.method).toBe("GET");
    const u = new URL(req.url, "http://x");
    expect(u.pathname).toBe("/v1/fixtures");
    expect(Object.fromEntries(u.searchParams)).toEqual({ method: "POST", path: "/v1/charges/{id}", distinct: "status", limit: "5" });
    expect(req.headers.authorization).toBe("Bearer k");
    expect(out).toHaveLength(2);
    expect(out[0]).toBeInstanceOf(Fixture);
    expect(out[0]!.capturedAt).toBe("2026-01-01T00:00:00Z");
    expect(out[0]!.durationMs).toBe(12);
    expect(out[0]!.response.json()).toEqual({ ok: true });
    expect(out[1]!.response.body).toBeNull();
    expect(() => out[1]!.response.json()).toThrow(/body is null/);
    expect(String(out[0])).toBe("<Fixture POST /v1/charges/{id} -> 201>");
  });

  it("reads the key and URL from the environment, and ignores STUBSMITH_BACKEND_URL", async () => {
    srv = await serve(200, { fixtures: [] });
    process.env.STUBSMITH_API_KEY = "envkey";
    process.env.STUBSMITH_API_URL = srv.base;
    process.env.STUBSMITH_BACKEND_URL = "http://127.0.0.1:1";
    expect(await fixtures("GET /x")).toEqual([]);
    expect(srv.requests[0]!.headers.authorization).toBe("Bearer envkey");
    expect(new URL(srv.requests[0]!.url, "http://x").searchParams.has("distinct")).toBe(false);
  });

  it("byStatus returns the match or lists the statuses present", async () => {
    srv = await serve(200, { fixtures: [fx(404), fx(200)] });
    const b = await fixturesBundle("POST /v1/charges/{id}", { apiUrl: srv.base, apiKey: "k" });
    expect(b.ok).toBe(true);
    expect(b.count).toBe(2);
    expect(b.requestType).toBeNull();
    expect(b.byStatus(200).status).toBe(200);
    expect(() => b.byStatus(500)).toThrow("No fixture with status 500 in bundle (present: [200, 404])");
  });

  it("rejects a missing key, a bad pattern, non-2xx and malformed bodies", async () => {
    await expect(fixtures("GET /x", { apiUrl: "http://127.0.0.1:1" })).rejects.toThrow(/API key is required/);
    await expect(fixtures("GET", { apiKey: "k" })).rejects.toThrow(/pattern must be 'METHOD \/path'/);
    srv = await serve(403, "nope");
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow("StubSmith API returned HTTP 403: nope");
    await srv.close();
    srv = await serve(200, "not json");
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/malformed response/);
    await srv.close();
    srv = await serve(200, "[1]");
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/not a JSON object/);
    await srv.close();
    srv = await serve(200, { fixtures: [{ id: "a" }] });
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/missing "captured_at"/);
  });

  it("reports a network failure", async () => {
    await expect(fixtures("GET /x", { apiUrl: "http://127.0.0.1:1", apiKey: "k" })).rejects.toThrow(/request to .* failed/);
  });

  it("reports a connection closed mid-body, not a JSON parse error", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write('{"ok": tr');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(
      "connection closed before the response completed",
    );
  });

  it("reports a body over the 64 MiB cap", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    srv = await startUpstream((_q, res) => {
      res.writeHead(200);
      let n = 0;
      const pump = (): void => {
        while (n < 66) {
          n++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await expect(fixtures("GET /x", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/exceeded 64 MiB/);
  }, 20_000);
});
