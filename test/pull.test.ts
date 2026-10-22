import { afterEach, describe, expect, it } from "vitest";
import { fetchBundle, pullBundle } from "../src/index.js";
import type { BundleEndpoint, BundleStub, BundleVariant } from "../src/replay/bundle.js";
import { mergeBundles, sortBundle, stringifyBundle } from "../src/pull.js";
import { startUpstream, type Upstream } from "./helpers/servers.js";

let srv: Upstream | null = null;
afterEach(async () => {
  await srv?.close();
  srv = null;
  delete process.env.STUBSMITH_API_URL;
  delete process.env.STUBSMITH_BACKEND_URL;
  delete process.env.STUBSMITH_API_KEY;
});

export const variant = (status: number, extra: Record<string, unknown> = {}) => ({
  status,
  count: 1,
  duration_ms: 5,
  headers: {},
  body: "x",
  ...extra,
});
export const stub = (fingerprint: string, variants: unknown[], extra: Record<string, unknown> = {}): BundleStub => ({
  fingerprint,
  key_paths: [],
  query_names: [],
  content_type: null,
  field_rules: [],
  degraded: false,
  variants: variants as BundleVariant[],
  ...extra,
});
export const endpoint = (domain: string, method: string, path_template: string, stubs: BundleStub[]): BundleEndpoint => ({
  domain,
  method,
  path_template,
  is_dynamic: false,
  fingerprint_value_paths: [],
  stubs,
});

describe("mergeBundles", () => {
  it("merges by (domain, METHOD, template), drops duplicate fingerprints, takes max numeric cursor, carries truncated", () => {
    const a = {
      ok: true,
      version: 1,
      cursor: "9",
      generated_at: "t1",
      truncated: { stubs: { dropped: 1, limit: 2 } },
      endpoints: [endpoint("a.com", "get", "/x", [stub("f1", [variant(200)])])],
    };
    const b = {
      ok: true,
      version: 1,
      cursor: "10",
      generated_at: "t2",
      truncated: { stubs: { dropped: 99, limit: 99 }, body_bytes: { capped: 1, limit: 2048 } },
      endpoints: [endpoint("a.com", "GET", "/x", [stub("f1", [variant(500)]), stub("f0", [variant(200)])])],
    };
    const m = mergeBundles([a, b]) as { cursor: string; generated_at: string; truncated: unknown; endpoints: Array<{ stubs: Array<{ fingerprint: string; variants: Array<{ status: number }> }> }> };
    expect(m.cursor).toBe("10");
    expect(m.generated_at).toBe("t2");
    expect(m.truncated).toEqual({ stubs: { dropped: 1, limit: 2 }, body_bytes: { capped: 1, limit: 2048 } });
    expect(m.endpoints).toHaveLength(1);
    expect(m.endpoints[0]!.stubs.map((s) => s.fingerprint)).toEqual(["f1", "f0"]);
    expect(m.endpoints[0]!.stubs[0]!.variants[0]!.status).toBe(200);
  });

  it("keeps project_settings from the parts", () => {
    const settings = { group_ids_in_paths: false };
    const m = mergeBundles([
      { cursor: "1", project_settings: { ...settings }, endpoints: [] },
      { cursor: "2", project_settings: { ...settings }, endpoints: [] },
    ]) as { project_settings?: unknown };
    expect(m.project_settings).toEqual(settings);
  });

  it("a part without the setting does not hide it", () => {
    const m = mergeBundles([
      { cursor: "1", project_settings: { group_ids_in_paths: false }, endpoints: [] },
      { cursor: "2", project_settings: {}, endpoints: [] },
    ]) as { project_settings?: unknown };
    expect(m.project_settings).toEqual({ group_ids_in_paths: false });
  });

  it("a merge of parts without project_settings has no such key", () => {
    const m = mergeBundles([{ cursor: "1", endpoints: [] }, { cursor: "2", endpoints: [] }]);
    expect("project_settings" in m).toBe(false);
  });

  it("an unparseable cursor is ignored", () => {
    const m = mergeBundles([{ cursor: "abc", endpoints: [] }, { cursor: "7", endpoints: [] }]);
    expect(m.cursor).toBe("7");
  });
});

describe("sortBundle and stringifyBundle", () => {
  it("sorts by code point, not UTF-16 unit", () => {
    const s = sortBundle({
      endpoints: [endpoint("\u{1F600}", "GET", "/a", []), endpoint("～", "GET", "/a", [])],
    }) as { endpoints: Array<{ domain: string }> };
    expect(s.endpoints.map((e) => e.domain)).toEqual(["～", "\u{1F600}"]);
  });

  it("sorts keys as strings even when they look numeric, keeps non-ASCII, empty containers compact", () => {
    const text = stringifyBundle({ b: 1, a: { "2": [], "10": {}, é: "ü" } });
    expect(text).toBe('{\n  "a": {\n    "10": {},\n    "2": [],\n    "é": "ü"\n  },\n  "b": 1\n}');
  });
});

describe("pullBundle", () => {
  it("one request per endpoint with samples and User-Agent, merged, sorted, summarised", async () => {
    const byPath: Record<string, unknown> = {
      "/b": {
        ok: true, version: 1, cursor: "3", generated_at: "g",
        endpoints: [endpoint("z.com", "GET", "/b", [stub("fb", [variant(404), variant(200, { body_capped: true, body: null })], { degraded: true })])],
      },
      "/a": {
        ok: true, version: 1, cursor: "12", generated_at: "g2",
        endpoints: [endpoint("a.com", "POST", "/a", [stub("fa", [variant(201)])])],
      },
    };
    srv = await startUpstream((req, res) => {
      const p = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(byPath[p]));
    });
    const lines: string[] = [];
    const { bundle, summary } = await pullBundle({
      apiUrl: srv.base,
      apiKey: "k",
      endpoints: ["get /b", "POST /a"],
      samples: 3,
      onFetch: (m, p) => lines.push(`${m} ${p}`),
    });
    expect(lines).toEqual(["GET /b", "POST /a"]);
    expect(srv.requests).toHaveLength(2);
    const u = new URL(srv.requests[0]!.url, "http://x");
    expect(u.pathname).toBe("/v1/replay/bundle");
    expect(Object.fromEntries(u.searchParams)).toEqual({ method: "GET", path: "/b", samples: "3" });
    expect(srv.requests[0]!.headers.authorization).toBe("Bearer k");
    expect(srv.requests[0]!.headers["user-agent"]).toMatch(/^stubsmith-cli\//);
    const eps = (bundle as { endpoints: Array<{ domain: string; stubs: Array<{ variants: Array<{ status: number }> }> }> }).endpoints;
    expect(eps.map((e) => e.domain)).toEqual(["a.com", "z.com"]);
    expect(eps[1]!.stubs[0]!.variants.map((v) => v.status)).toEqual([200, 404]);
    expect(bundle.cursor).toBe("12");
    expect(summary).toEqual({
      endpoints: 2, stubs: 2, variants: 3, bodyCapped: 1,
      degraded: [{ domain: "z.com", method: "GET", pathTemplate: "/b", fingerprint: "fb" }],
    });
  });

  it("uses STUBSMITH_API_URL, then STUBSMITH_BACKEND_URL; one unfiltered request", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200);
      res.end('{"ok":true,"cursor":"1","endpoints":[]}');
    });
    process.env.STUBSMITH_BACKEND_URL = srv.base;
    await pullBundle({ apiKey: "k" });
    expect(srv.requests.map((r) => r.url)).toEqual(["/v1/replay/bundle"]);
  });

  it("rejects samples > 1 without endpoints before any request", async () => {
    srv = await startUpstream((_q, res) => res.end("{}"));
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k", samples: "all" })).rejects.toThrow(/requires an endpoint/);
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k", samples: 2 })).rejects.toThrow(/requires an endpoint/);
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k", samples: 0, endpoints: ["GET /a"] })).rejects.toThrow(/at least 1/);
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k", endpoints: ["bogus"] })).rejects.toThrow(/METHOD \/path/);
    expect(srv.requests).toHaveLength(0);
  });

  it("explains a 404, other HTTP errors and bad JSON", async () => {
    let status = 404;
    let body = "";
    srv = await startUpstream((_q, res) => {
      res.writeHead(status);
      res.end(body);
    });
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/backend was not found/);
    status = 500; body = "boom";
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k" })).rejects.toThrow("HTTP 500: boom");
    status = 200; body = "{";
    await expect(pullBundle({ apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/unparseable JSON/);
  });
});

describe("fetchBundle validation", () => {
  it("rejects a JSON object without an endpoints array", async () => {
    srv = await startUpstream((_q, res) => res.end('{"ok": true}'));
    await expect(fetchBundle(undefined, { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/no endpoints array/);
  });
});

describe("fetchBundle", () => {
  const raw = {
    ok: true, version: 1, cursor: "7", generated_at: "g",
    endpoints: [
      endpoint("z.com", "GET", "/b", [stub("fz", [variant(404), variant(200)]), stub("fa", [variant(200)])]),
      endpoint("a.com", "GET", "/a", [stub("fa", [variant(200)])]),
    ],
  };

  it("returns the server bundle for one request, unmerged and unsorted", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200);
      res.end(JSON.stringify(raw));
    });
    const bundle = await fetchBundle("get /b", { apiUrl: srv.base, apiKey: "k", samples: 3 });
    expect(bundle).toEqual(raw); // sortBundle would reorder domains, fingerprints and variants
    expect(srv.requests).toHaveLength(1);
    const u = new URL(srv.requests[0]!.url, "http://x");
    expect(Object.fromEntries(u.searchParams)).toEqual({ method: "GET", path: "/b", samples: "3" });
  });

  it("without an endpoint makes one unfiltered request; env supplies key and url", async () => {
    srv = await startUpstream((_q, res) => res.end(JSON.stringify(raw)));
    process.env.STUBSMITH_API_URL = srv.base;
    process.env.STUBSMITH_API_KEY = "envkey";
    await fetchBundle();
    expect(srv.requests.map((r) => r.url)).toEqual(["/v1/replay/bundle"]);
    expect(srv.requests[0]!.headers.authorization).toBe("Bearer envkey");
  });

  it("validates the endpoint, samples and key before any request", async () => {
    srv = await startUpstream((_q, res) => res.end("{}"));
    await expect(fetchBundle("bogus", { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/METHOD \/path/);
    await expect(fetchBundle(undefined, { apiUrl: srv.base, apiKey: "k", samples: 2 })).rejects.toThrow(/requires an endpoint/);
    await expect(fetchBundle("GET /a", { apiUrl: srv.base })).rejects.toThrow(/No API key/);
    expect(srv.requests).toHaveLength(0);
  });

  it("reports a body over the cap instead of a JSON parse error", async () => {
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    srv = await startUpstream((_q, res) => {
      res.writeHead(200);
      let n = 0;
      const pump = (): void => {
        while (n < 130) {
          n++;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      pump();
    });
    await expect(fetchBundle(undefined, { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(
      "response exceeded 128 MiB; narrow with --endpoint",
    );
  }, 20_000);

  it("reports a connection closed mid-body", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200, { "content-length": "1000" });
      res.write('{"ok": tr');
      setTimeout(() => res.socket?.destroy(), 20);
    });
    await expect(fetchBundle(undefined, { apiUrl: srv.base, apiKey: "k" })).rejects.toThrow(/closed before the response completed/);
  });
});
