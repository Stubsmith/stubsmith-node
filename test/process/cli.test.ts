import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Bundle, buildSdk, runScript } from "./helpers.js";

const root = path.resolve(__dirname, "../..");
const BUNDLE_BODY = {
  ok: true,
  version: 1,
  cursor: "4",
  generated_at: "g",
  endpoints: [
    {
      domain: "api.example.com",
      method: "GET",
      path_template: "/orders",
      is_dynamic: false,
      fingerprint_value_paths: [],
      stubs: [{ fingerprint: "f1", key_paths: [], query_names: [], content_type: null, field_rules: {}, degraded: false, variants: [{ status: 200, count: 1, duration_ms: 1, headers: {}, body: "{}" }] }],
    },
  ],
};
const FIXTURES_BODY = { ok: true, request_type: null, count: 1, fixtures: [{ id: "c1", captured_at: "t", method: "GET", path: "/orders", status: 200, duration_ms: 1, request: { headers: {}, body: null }, response: { headers: {}, body: '{"a":1}' } }] };

let server: http.Server;
let url = "";
let work = "";
let sdk: Bundle;
let cliJs = "";

beforeAll(async () => {
  work = fs.mkdtempSync(path.join(tmpdir(), "stubsmith-cli-proc-"));
  // The server lives in this process; the clients are separate processes, so a client that
  // exits mid-request (an unref'd socket) is caught instead of masked by this event loop.
  server = http.createServer((req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.startsWith("/v1/fixtures") ? FIXTURES_BODY : BUNDLE_BODY));
    }, 300); // long enough for an event loop with nothing ref'd to give up
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cliJs = path.join(work, "cli.mjs");
  execFileSync(
    path.join(root, "node_modules/.bin/esbuild"),
    ["src/cli.ts", "--bundle", "--platform=node", "--format=esm", "--target=node18", `--outfile=${cliJs}`, "--log-level=error"],
    { cwd: root },
  );
  sdk = buildSdk();
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  sdk.cleanup();
  fs.rmSync(work, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STUBSMITH_")) env[k] = v;
  env.STUBSMITH_API_KEY = "test-key";
  env.STUBSMITH_API_URL = url;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliJs, ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe("standalone callers keep the process alive until the response arrives", () => {
  it("`stubsmith pull` writes the bundle and exits 0", async () => {
    const out = path.join(work, "out", "bundle.json");
    const r = await runCli(["pull", "--out", out]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`Wrote ${out}`);
    expect(r.stdout).toContain("  endpoints : 1");
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({ cursor: "4", endpoints: [{ path_template: "/orders" }] });
  }, 20_000);

  it("a plain script awaiting fixtures() exits 0 with the result", async () => {
    const r = await runScript(
      sdk,
      `const fx = await sdk.fixtures("GET /orders");
console.log(JSON.stringify({ n: fx.length, status: fx[0].status, body: fx[0].response.json() }));`,
      { STUBSMITH_API_KEY: "test-key", STUBSMITH_API_URL: url },
    );
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toEqual({ n: 1, status: 200, body: { a: 1 } });
  }, 20_000);

  it("a plain script awaiting fetchBundle() exits 0 with the bundle", async () => {
    const r = await runScript(sdk, `const b = await sdk.fetchBundle(); console.log(JSON.stringify(b.cursor));`, {
      STUBSMITH_API_KEY: "test-key",
      STUBSMITH_API_URL: url,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.trim())).toBe("4");
  }, 20_000);
});
