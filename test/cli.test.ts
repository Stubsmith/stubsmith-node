import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../src/_version.js";
import { main } from "../src/cli.js";
import { startUpstream, type Upstream } from "./helpers/servers.js";

let srv: Upstream | null = null;
let dir = "";
let stdout = "";
let stderr = "";

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "stubsmith-cli-"));
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    stdout += String(s);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr += String(s);
    return true;
  });
  process.env.STUBSMITH_API_KEY = "k";
});
afterEach(async () => {
  vi.restoreAllMocks();
  await srv?.close();
  srv = null;
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.STUBSMITH_API_KEY;
  delete process.env.STUBSMITH_API_URL;
});

const stub = (fingerprint: string, variants: unknown[], extra: Record<string, unknown> = {}) => ({
  fingerprint, key_paths: [], query_names: [], content_type: null, field_rules: {}, degraded: false, variants, ...extra,
});
const ep = (domain: string, method: string, path_template: string, stubs: unknown[]) => ({
  domain, method, path_template, is_dynamic: false, fingerprint_value_paths: [], stubs,
});

const PARTS: Record<string, unknown> = {
  "/orders": {
    ok: true, version: 1, cursor: "5", generated_at: "g1",
    truncated: { stubs: { dropped: 3, limit: 2000 } },
    endpoints: [ep("api.example.com", "GET", "/orders", [
      stub("f2", [{ status: 500, count: 1, duration_ms: 1, headers: {}, body: "café \u{1F600}" }]),
      stub("f1", [{ status: 200, count: 2, duration_ms: 1, headers: { z: "1", a: "2" }, body: null, body_capped: true }], { degraded: true }),
    ])],
  },
  "/users": {
    ok: true, version: 1, cursor: "11", generated_at: "g2",
    endpoints: [ep("api.example.com", "GET", "/users", [stub("f1", [{ status: 200, count: 1, duration_ms: 1, headers: {}, body: "{}" }])]),
      ep("api.example.com", "GET", "/orders", [stub("f1", [{ status: 404, count: 1, duration_ms: 1, headers: {}, body: "dup" }])])],
  },
};

async function start(): Promise<Upstream> {
  srv = await startUpstream((req, res) => {
    const p = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(PARTS[p]));
  });
  process.env.STUBSMITH_API_URL = srv.base;
  return srv;
}

describe("stubsmith pull", () => {
  it("fetches, merges, and writes the bundle atomically", async () => {
    const s = await start();
    const out = path.join(dir, "nested", "bundle.json");
    const code = await main(["pull", "--out", out, "--endpoint", "GET /orders", "--endpoint=GET /users", "--samples", "all"]);
    expect(code).toBe(0);
    expect(s.requests).toHaveLength(2);

    expect(fs.readdirSync(path.dirname(out))).toEqual(["bundle.json"]);
    expect(fs.statSync(out).mode & 0o777).toBe(0o644);
    const text = fs.readFileSync(out, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain("café \u{1F600}");
    expect(text).not.toContain("\\u");
    const bundle = JSON.parse(text) as { cursor: string; truncated: unknown; endpoints: Array<{ path_template: string; stubs: Array<{ fingerprint: string; variants: Array<{ status: number; headers: object }> }> }> };
    expect(bundle.cursor).toBe("11");
    expect(bundle.truncated).toEqual({ stubs: { dropped: 3, limit: 2000 } });
    expect(bundle.endpoints.map((e) => e.path_template)).toEqual(["/orders", "/users"]);
    expect(bundle.endpoints[0]!.stubs.map((x) => x.fingerprint)).toEqual(["f1", "f2"]);
    expect(Object.keys(bundle.endpoints[0]!.stubs[0]!.variants[0]!.headers)).toEqual(["a", "z"]);
    // sorted keys at every level: "cursor" precedes "endpoints" precedes "generated_at"
    expect(text.indexOf('"cursor"')).toBeLessThan(text.indexOf('"endpoints"'));
    expect(text.indexOf('"endpoints"')).toBeLessThan(text.indexOf('"generated_at"'));
    // duplicate fingerprint f1 across the two /orders parts was dropped (first wins: status 200)
    expect(text).not.toContain("dup");

    expect(stdout).toContain(`Wrote ${out}`);
    expect(stdout).toContain("  endpoints : 2");
    expect(stdout).toContain("  stubs     : 3");
    expect(stdout).toContain("  variants  : 3");
    expect(stdout).toContain("WARNING: bundle is truncated");
    expect(stdout).toContain("3 stubs dropped (server limit: 2000)");
    expect(stdout).toContain("WARNING: 1 stub(s) marked degraded");
    expect(stdout).toContain("WARNING: 1 variant(s) have body_capped=true");
    expect(stderr).toContain("Fetching GET /orders ...");
  });

  it("a failed rename exits 1, leaves the previous bundle untouched and no temp file behind", async () => {
    await start();
    // The target is a non-empty directory, so the final rename of the temp file onto it fails.
    const out = path.join(dir, "bundle.json");
    fs.mkdirSync(out);
    fs.writeFileSync(path.join(out, "keep"), "previous");
    expect(await main(["pull", "--out", out, "--endpoint", "GET /users"])).toBe(1);
    expect(stderr).toContain("Error writing bundle:");
    expect(stdout).not.toContain("Wrote ");
    expect(fs.readFileSync(path.join(out, "keep"), "utf8")).toBe("previous");
    expect(fs.readdirSync(out)).toEqual(["keep"]);
    expect(fs.readdirSync(dir).filter((f) => f.startsWith(".stubsmith-bundle-"))).toEqual([]);
  });

  it("a rename that rejects leaves an existing bundle file as it was", async () => {
    await start();
    const out = path.join(dir, "b.json");
    fs.writeFileSync(out, "old");
    vi.spyOn(fs.promises, "rename").mockRejectedValue(new Error("EXDEV simulated"));
    expect(await main(["pull", "--out", out, "--endpoint", "GET /users"])).toBe(1);
    expect(stderr).toContain("EXDEV simulated");
    expect(fs.readFileSync(out, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["b.json"]);
  });

  it("a 503 exits 1 and leaves an existing bundle file as it was", async () => {
    // The server answers 503 when it cannot read the project settings.
    srv = await startUpstream((_q, res) => {
      res.writeHead(503);
      res.end("project settings unavailable");
    });
    process.env.STUBSMITH_API_URL = srv.base;
    const out = path.join(dir, "bundle.json");
    fs.writeFileSync(out, "old");
    expect(await main(["pull", "--out", out])).toBe(1);
    expect(stderr).toContain("HTTP 503");
    expect(stdout).not.toContain("Wrote ");
    expect(fs.readFileSync(out, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["bundle.json"]);
  });

  it("a 503 on a later part of a multi-endpoint pull writes nothing and keeps the existing file", async () => {
    srv = await startUpstream((req, res) => {
      const p = new URL(req.url ?? "", "http://x").searchParams.get("path") ?? "";
      if (p === "/users") {
        res.writeHead(503);
        res.end("project settings unavailable");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(PARTS[p]));
    });
    process.env.STUBSMITH_API_URL = srv.base;
    const out = path.join(dir, "bundle.json");
    fs.writeFileSync(out, "old");
    expect(await main(["pull", "--out", out, "--endpoint", "GET /orders", "--endpoint", "GET /users"])).toBe(1);
    expect(stderr).toContain("HTTP 503");
    expect(fs.readFileSync(out, "utf8")).toBe("old");
    expect(fs.readdirSync(dir)).toEqual(["bundle.json"]);
    // No file is created when there was none before.
    const fresh = path.join(dir, "fresh.json");
    expect(await main(["pull", "--out", fresh, "--endpoint", "GET /orders", "--endpoint", "GET /users"])).toBe(1);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it("prints the stubs warning only when stubs were dropped, and a samples warning", async () => {
    srv = await startUpstream((_q, res) => {
      res.end(JSON.stringify({ ok: true, version: 1, cursor: "1", endpoints: [], truncated: { stubs: {}, samples: { limit: 25 } } }));
    });
    process.env.STUBSMITH_API_URL = srv.base;
    expect(await main(["pull", "--out", path.join(dir, "b.json")])).toBe(0);
    expect(stdout).toContain("WARNING: bundle is truncated");
    expect(stdout).not.toContain("undefined");
    expect(stdout).not.toContain("stubs dropped");
    expect(stdout).toContain("samples: clamped to the server limit of 25");
  });

  it("replaces an existing bundle", async () => {
    await start();
    const out = path.join(dir, "b.json");
    fs.writeFileSync(out, "old");
    expect(await main(["pull", "--out", out, "--endpoint", "GET /users"])).toBe(0);
    expect(fs.readFileSync(out, "utf8")).not.toBe("old");
  });

  it("--samples 2 without --endpoint exits 1 before any request", async () => {
    const s = await start();
    expect(await main(["pull", "--out", path.join(dir, "b.json"), "--samples", "2"])).toBe(1);
    expect(await main(["pull", "--samples", "all"])).toBe(1);
    expect(stderr).toContain("--samples greater than 1 requires --endpoint");
    expect(s.requests).toHaveLength(0);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("validates --samples and --endpoint", async () => {
    const s = await start();
    expect(await main(["pull", "--samples", "x", "--endpoint", "GET /a"])).toBe(1);
    expect(stderr).toContain("--samples must be a positive integer or 'all'");
    expect(await main(["pull", "--samples", "0", "--endpoint", "GET /a"])).toBe(1);
    expect(stderr).toContain("--samples must be at least 1.");
    expect(await main(["pull", "--endpoint", "nospace"])).toBe(1);
    expect(stderr).toContain('--endpoint must be "METHOD /path"');
    expect(s.requests).toHaveLength(0);
  });

  it("exits 1 without STUBSMITH_API_KEY", async () => {
    const s = await start();
    delete process.env.STUBSMITH_API_KEY;
    expect(await main(["pull"])).toBe(1);
    expect(stderr).toContain("Error: STUBSMITH_API_KEY is not set. Export your project API key before running stubsmith pull.");
    expect(s.requests).toHaveLength(0);
  });

  it("exits 1 on an HTTP error and writes nothing", async () => {
    srv = await startUpstream((_q, res) => {
      res.writeHead(500);
      res.end("boom");
    });
    process.env.STUBSMITH_API_URL = srv.base;
    const out = path.join(dir, "b.json");
    expect(await main(["pull", "--out", out])).toBe(1);
    expect(stderr).toContain("Error: HTTP 500: boom");
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("stubsmith CLI surface", () => {
  it("--version and -h", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(stdout).toBe(`stubsmith ${VERSION}\n`);
    stdout = "";
    expect(await main(["-h"])).toBe(0);
    expect(stdout).toContain("usage: stubsmith");
    stdout = "";
    expect(await main(["pull", "--help"])).toBe(0);
    expect(stdout).toContain("--endpoint");
  });

  it("unknown flags, unknown commands, missing command and missing flag values exit 1", async () => {
    expect(await main(["pull", "--bogus"])).toBe(1);
    expect(stderr).toContain("unrecognized arguments: --bogus");
    expect(await main(["nope"])).toBe(1);
    expect(await main([])).toBe(1);
    expect(await main(["pull", "--out"])).toBe(1);
    expect(stderr).toContain("argument --out: expected one argument");
  });
});

describe("stubsmith pull summary warnings", () => {
  const variant = (o: { status?: number; body_capped?: boolean } = {}) => ({
    body: '{"ok":true}',
    count: 3,
    duration_ms: 42,
    headers: { "content-type": "application/json" },
    status: o.status ?? 200,
    ...(o.body_capped ? { body_capped: true } : {}),
  });
  const mkStub = (o: { fingerprint?: string; degraded?: boolean; variants?: unknown[] } = {}) => ({
    degraded: o.degraded ?? false,
    field_rules: [],
    fingerprint: o.fingerprint ?? "abc123",
    key_paths: [],
    variants: o.variants ?? [variant()],
  });
  const mkEndpoint = (stubs: unknown[] = [mkStub()]) => ({
    domain: "api.example.com",
    fingerprint_value_paths: [],
    is_dynamic: false,
    method: "GET",
    path_template: "/api/users",
    stubs,
  });
  const mkBundle = (o: { endpoints?: unknown[]; truncated?: unknown } = {}) => ({
    cursor: "42",
    endpoints: o.endpoints ?? [mkEndpoint()],
    generated_at: "2024-01-15T10:00:00.000Z",
    ok: true,
    version: 1,
    ...(o.truncated !== undefined ? { truncated: o.truncated } : {}),
  });
  async function pull(bundle: unknown): Promise<number> {
    srv = await startUpstream((_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(bundle));
    });
    process.env.STUBSMITH_API_URL = srv.base;
    return main(["pull", "--out", path.join(dir, "bundle.json")]);
  }

  it("surfaces dropped stubs", async () => {
    expect(await pull(mkBundle({ truncated: { stubs: { dropped: 17, limit: 2000 } } }))).toBe(0);
    expect(stdout.toLowerCase()).toContain("truncated");
    expect(stdout).toContain("17 stubs dropped");
  });

  it("surfaces dropped variants", async () => {
    const truncated = {
      variants: [
        { endpoint: "||GET|/foo", fingerprint: "abc", dropped: 3, limit: 10 },
        { endpoint: "||GET|/bar", fingerprint: "def", dropped: 1, limit: 10 },
      ],
    };
    expect(await pull(mkBundle({ truncated }))).toBe(0);
    expect(stdout.toLowerCase()).toContain("truncated");
    expect(stdout).toContain("4 variant(s) dropped across");
  });

  it("surfaces omitted variant bodies", async () => {
    expect(await pull(mkBundle({ truncated: { body_bytes: { capped: 2, limit: 102400 } } }))).toBe(0);
    expect(stdout).toContain("2 variant body/bodies omitted");
  });

  it("surfaces degraded stubs", async () => {
    const endpoint = mkEndpoint([mkStub({ degraded: true }), mkStub({ degraded: true, fingerprint: "xyz" })]);
    expect(await pull(mkBundle({ endpoints: [endpoint] }))).toBe(0);
    expect(stdout).toContain("2 stub(s) marked degraded");
  });

  it("surfaces variants with body_capped", async () => {
    const stub = mkStub({ variants: [variant({ body_capped: true }), variant({ status: 500, body_capped: true })] });
    expect(await pull(mkBundle({ endpoints: [mkEndpoint([stub])] }))).toBe(0);
    expect(stdout).toContain("2 variant(s) have body_capped=true");
  });
});
