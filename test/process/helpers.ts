import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(__dirname, "../..");

export interface Bundle {
  /** Absolute path of the bundled SDK entry (ESM). */
  sdk: string;
  dir: string;
  cleanup(): void;
}

/**
 * Bundle `src/index.ts` with esbuild (already installed for tsup and vitest)
 * into a scratch directory, so the subprocess runs the real code without
 * touching `dist/`. Takes about 50 ms.
 */
export function buildSdk(): Bundle {
  const dir = mkdtempSync(path.join(tmpdir(), "stubsmith-proc-"));
  const sdk = path.join(dir, "sdk.mjs");
  execFileSync(
    path.join(root, "node_modules/.bin/esbuild"),
    ["src/index.ts", "--bundle", "--platform=node", "--format=esm", "--target=node18", `--outfile=${sdk}`, "--log-level=error"],
    { cwd: root },
  );
  return { sdk, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** Wall time from spawn to exit, ms. */
  ms: number;
}

/** Run `body` (an ES module body) with `SDK` bound to the bundle path; the clock starts at spawn. */
export function runScript(bundle: Bundle, body: string, env: Record<string, string> = {}, name = "script"): Promise<RunResult> {
  const file = path.join(bundle.dir, `${name}-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(file, `import * as sdk from ${JSON.stringify(bundle.sdk)};\n${body}`);
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("STUBSMITH_")) clean[k] = v;
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [file], { env: { ...clean, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const killer = setTimeout(() => child.kill("SIGKILL"), 9000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({ code, stdout, stderr, ms: Date.now() - t0 });
    });
  });
}

export interface StalledServer {
  url: string;
  /** Connections that sent at least one byte. */
  requests(): number;
  close(): Promise<void>;
}

/** Accepts connections and never answers. */
export async function startStalled(): Promise<StalledServer> {
  const socks = new Set<net.Socket>();
  let withData = 0;
  const server = net.createServer((s) => {
    socks.add(s);
    s.once("data", () => withData++);
    s.on("error", () => undefined);
    s.on("close", () => socks.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => withData,
    close: () =>
      new Promise<void>((r) => {
        for (const s of socks) s.destroy();
        server.close(() => r());
      }),
  };
}

/** A capture the scripts hand to `client.capture()` directly. */
export const CAPTURE_JS = `{ method: "GET", url: "https://api.example.com/v1/x", reqHeaders: {}, reqBody: "", status: 200, respHeaders: { "content-type": "application/json" }, respBody: '{"a": 1}', durationMs: 1, source: "node-fetch" }`;
