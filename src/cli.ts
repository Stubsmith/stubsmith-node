import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "./_version.js";
import type { Bundle } from "./replay/bundle.js";
import { type PullBundleResult, parseEndpoint, pullBundle, writeBundle } from "./pull.js";

const DEFAULT_OUT = ".stubsmith/bundle.json";

const USAGE = `usage: stubsmith [-h] [--version] <command> ...

StubSmith command-line tools.

commands:
  pull    Fetch the replay bundle and write it to disk.

usage: stubsmith pull [-h] [--out PATH] [--endpoint "METHOD /path/template"]... [--samples N|all]

  --out PATH                       Destination file (default: ${DEFAULT_OUT})
  --endpoint "METHOD /path"        Filter to an endpoint, e.g. "GET /api/users/{id}".
                                   Repeat to pull several into one bundle. Each endpoint
                                   is one request; the responses are merged.
  --samples N|all                  Recordings to keep per response (default: 1, the newest).
                                   Requires --endpoint.

Environment: STUBSMITH_API_KEY (required), STUBSMITH_API_URL.
`;

interface PullArgs {
  out: string;
  endpoints: string[];
  samples: string | null;
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}
function err(s: string): void {
  process.stderr.write(`${s}\n`);
}

/** Parse `pull` flags; a string is an error message. Accepts `--flag value` and `--flag=value`. */
function parsePull(argv: string[]): PullArgs | "help" | string {
  const args: PullArgs = { out: DEFAULT_OUT, endpoints: [], samples: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === "-h" || a === "--help") return "help";
    const m = /^(--(?:out|endpoint|samples))(?:=([\s\S]*))?$/.exec(a);
    if (!m) return `unrecognized arguments: ${a}`;
    const flag = m[1] as string;
    let value = m[2];
    if (value === undefined) {
      if (i + 1 >= argv.length) return `argument ${flag}: expected one argument`;
      value = argv[++i] as string;
    }
    if (flag === "--out") args.out = value;
    else if (flag === "--endpoint") args.endpoints.push(value);
    else args.samples = value;
  }
  return args;
}

function printSummary(bundle: Bundle, outPath: string, s: PullBundleResult["summary"]): void {
  out(`Wrote ${outPath}`);
  out(`  endpoints : ${s.endpoints}`);
  out(`  stubs     : ${s.stubs}`);
  out(`  variants  : ${s.variants}`);
  out(`  cursor    : ${bundle.cursor ?? ""}`);
  out(`  generated : ${bundle.generated_at ?? ""}`);

  const t = bundle.truncated as Record<string, Record<string, unknown> | Array<Record<string, unknown>>> | null | undefined;
  if (t && typeof t === "object" && Object.keys(t).length > 0) {
    out("");
    out("WARNING: bundle is truncated - not all data was included.");
    const stubs = t.stubs as Record<string, unknown> | undefined;
    if (stubs && stubs.dropped) out(`  stubs: ${stubs.dropped} stubs dropped (server limit: ${stubs.limit})`);
    const variants = t.variants as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(variants) && variants.length > 0) {
      const dropped = variants.reduce((n, v) => n + (typeof v.dropped === "number" ? v.dropped : 0), 0);
      out(
        `  variants: ${dropped} variant(s) dropped across ${variants.length} fingerprint(s) ` +
          `(server limit per fingerprint: ${(variants[0] as Record<string, unknown>).limit})`,
      );
    }
    const samples = t.samples as Record<string, unknown> | undefined;
    if (samples && samples.limit) out(`  samples: clamped to the server limit of ${samples.limit} recordings per response`);
    const bb = t.body_bytes as Record<string, unknown> | undefined;
    if (bb) {
      const limitKb = Math.floor((typeof bb.limit === "number" ? bb.limit : 0) / 1024);
      out(
        `  body_bytes: ${bb.capped} variant body/bodies omitted (exceeded ${limitKb} KB cap) - ` +
          `these stubs will replay with an empty body`,
      );
    }
  }
  if (s.degraded.length > 0) {
    out(
      `WARNING: ${s.degraded.length} stub(s) marked degraded - ` +
        "no recorded captures are available; replay will fail for those stubs.",
    );
  }
  if (s.bodyCapped > 0) {
    out(
      `WARNING: ${s.bodyCapped} variant(s) have body_capped=true - ` +
        "body exceeded the server size cap and was omitted; " +
        "replay will return an empty body for those variants.",
    );
  }
}

async function cmdPull(args: PullArgs): Promise<number> {
  const apiKey = process.env.STUBSMITH_API_KEY ?? "";
  if (!apiKey) {
    err("Error: STUBSMITH_API_KEY is not set. Export your project API key before running stubsmith pull.");
    return 1;
  }

  for (const raw of args.endpoints) {
    if (!parseEndpoint(raw)) {
      err(`Error: --endpoint must be "METHOD /path" (e.g. "GET /api/users"), got: ${JSON.stringify(raw)}`);
      return 1;
    }
  }

  if (args.samples !== null) {
    const raw = args.samples.trim().toLowerCase();
    if (raw !== "all" && !/^\d+$/.test(raw)) {
      err(`Error: --samples must be a positive integer or 'all', got: ${JSON.stringify(args.samples)}`);
      return 1;
    }
    if (raw !== "all" && Number(raw) < 1) {
      err("Error: --samples must be at least 1.");
      return 1;
    }
    if ((raw === "all" || Number(raw) > 1) && args.endpoints.length === 0) {
      err(
        "Error: --samples greater than 1 requires --endpoint.\n" +
          "Fetching every recording for a whole project is not supported; " +
          'scope it, e.g. --endpoint "GET /api/orders". Repeat --endpoint ' +
          "to cover several in one bundle.",
      );
      return 1;
    }
  }

  let result;
  try {
    result = await pullBundle({
      apiKey,
      endpoints: args.endpoints,
      ...(args.samples !== null ? { samples: args.samples } : {}),
      onFetch: (method, path) => err(`Fetching ${method} ${path} ...`),
    });
  } catch (e) {
    err(`Error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  try {
    await writeBundle(args.out, result.bundle);
  } catch (e) {
    err(`Error writing bundle: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  printSummary(result.bundle, args.out, result.summary);
  return 0;
}

/** CLI entry point; `argv` excludes the node binary and script path. Returns the exit code. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const first = argv[0];
  if (first === "--version" || first === "-V") {
    out(`stubsmith ${VERSION}`);
    return 0;
  }
  if (first === "-h" || first === "--help") {
    out(USAGE);
    return 0;
  }
  if (first === undefined) {
    err(USAGE);
    err("stubsmith: error: the following arguments are required: <command>");
    return 1;
  }
  if (first !== "pull") {
    err(USAGE);
    err(`stubsmith: error: unrecognized command or argument: ${first}`);
    return 1;
  }
  const parsed = parsePull(argv.slice(1));
  if (parsed === "help") {
    out(USAGE);
    return 0;
  }
  if (typeof parsed === "string") {
    err(`stubsmith pull: error: ${parsed}`);
    return 1;
  }
  return cmdPull(parsed);
}

function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      err(`Error: ${e instanceof Error ? e.message : String(e)}`);
      process.exitCode = 1;
    },
  );
}
