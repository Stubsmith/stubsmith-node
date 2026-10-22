/**
 * Fetch the replay bundle (`GET /v1/replay/bundle`): `fetchBundle` returns the
 * raw server bundle for one request (as Python `fetch_bundle`), `pullBundle`
 * merges, sorts and summarises several the way the Python `stubsmith pull`
 * does, and `writeBundle` serialises it identically.
 */
import { randomBytes } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";
import { VERSION } from "./_version.js";
import { DEFAULT_BACKEND_URL, resolveApiUrl } from "./env.js";
import { compareCodePoints } from "./internal/codepoint.js";
import type { Bundle } from "./replay/bundle.js";
import { sendRequest } from "./transport.js";

const TIMEOUT_MS = 30_000;
/*
 * Bundle response cap. The backend bounds a bundle at 2000 stubs, 10 variants
 * per fingerprint and 100 KB per body, so a real one is far below this. The
 * peak memory for a response of N bytes is roughly 3N to 4N: the collected
 * chunks, the concatenated Buffer, the utf8 string and the parsed object tree
 * all coexist briefly. 128 MiB therefore bounds the process near 0.5 GiB.
 */
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_MIB = MAX_BYTES / (1024 * 1024);

type Obj = Record<string, unknown>;

export interface FetchBundleOptions {
  /** Recordings per response; above one (or `"all"`) needs an endpoint. */
  samples?: number | "all" | string;
  /** Defaults to `STUBSMITH_API_URL`, then `STUBSMITH_BACKEND_URL`, then the hosted service. */
  apiUrl?: string;
  /** Defaults to `STUBSMITH_API_KEY`. */
  apiKey?: string;
}

export interface PullBundleOptions {
  /** Defaults to `STUBSMITH_API_URL`, then `STUBSMITH_BACKEND_URL`, then the hosted service. */
  apiUrl?: string;
  /** Defaults to `STUBSMITH_API_KEY`. */
  apiKey?: string;
  /** `"METHOD /path"` filters, one request each; omitted means one unfiltered request. */
  endpoints?: string[];
  /** Recordings per response; above one (or `"all"`) needs `endpoints`. */
  samples?: number | "all" | string;
  /** Called before each filtered request (the CLI prints progress). */
  onFetch?: (method: string, path: string) => void;
}

export interface BundleStubRef {
  domain: string;
  method: string;
  pathTemplate: string;
  fingerprint: string;
}

export interface BundleSummary {
  endpoints: number;
  stubs: number;
  variants: number;
  /** Every stub the server marked degraded. */
  degraded: BundleStubRef[];
  /** Variants with `body_capped` set. */
  bodyCapped: number;
}

export interface PullBundleResult {
  bundle: Bundle;
  summary: BundleSummary;
}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function arr(v: unknown): Obj[] {
  return Array.isArray(v) ? v.filter(isObj) : [];
}

/** Python `x or ""` for a string-ish field. */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/** Split `"METHOD /path"` on the first space; null when malformed. */
export function parseEndpoint(raw: string): { method: string; path: string } | null {
  const i = raw.indexOf(" ");
  if (i < 0) return null;
  const method = raw.slice(0, i).trim();
  const p = raw.slice(i + 1).trim();
  if (!method || !p) return null;
  return { method: method.toUpperCase(), path: p };
}

/** Validate a samples value; returns the normalised string or throws. `msg` builds the error from a reason. */
export function normaliseSamples(samples: number | string, endpointGiven: boolean): string {
  const raw = String(samples).trim().toLowerCase();
  if (raw !== "all" && !/^\d+$/.test(raw)) {
    throw new Error(`samples must be a positive integer or 'all', got: ${JSON.stringify(samples)}`);
  }
  if (raw !== "all" && Number(raw) < 1) throw new Error(`samples must be at least 1, got: ${JSON.stringify(samples)}`);
  if ((raw === "all" || Number(raw) > 1) && !endpointGiven) {
    throw new Error(
      "samples greater than 1 requires an endpoint. Fetching every recording for a whole project is not " +
        'supported; scope it, e.g. endpoints: ["GET /api/orders"].',
    );
  }
  return raw;
}

async function fetchOne(
  apiUrl: string,
  apiKey: string,
  method: string | null,
  p: string | null,
  samples: string | null,
): Promise<Bundle> {
  const params = new URLSearchParams();
  if (method) params.set("method", method);
  if (p) params.set("path", p);
  if (samples !== null) params.set("samples", samples);
  const qs = [...params].length > 0 ? `?${params.toString()}` : "";
  const url = `${apiUrl.replace(/\/+$/, "")}/v1/replay/bundle${qs}`;

  let res;
  try {
    res = await sendRequest(url, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}`, "user-agent": `stubsmith-cli/${VERSION}` },
      timeoutMs: TIMEOUT_MS,
      holdProcess: true,
      maxBytes: MAX_BYTES,
    }).promise;
  } catch (err) {
    throw new Error(
      `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}\n` +
        `Check that the backend is reachable, or set STUBSMITH_API_URL to override (default: ${DEFAULT_BACKEND_URL}).`,
    );
  }
  if (res.truncated) throw new Error(`Bundle response exceeded ${MAX_MIB} MiB; narrow with --endpoint.`);
  const text = res.body.toString("utf8");
  if (res.status === 404) {
    throw new Error(
      `HTTP 404 from ${url}\n` +
        `The StubSmith backend was not found at that URL.\n` +
        `For the hosted service the URL is ${DEFAULT_BACKEND_URL}.\n` +
        `Override with STUBSMITH_API_URL, or unset it to use the default.`,
    );
  }
  if (res.status < 200 || res.status >= 300) throw new Error(`HTTP ${res.status}: ${text}`);
  if (!res.complete) throw new Error(`Connection closed before the response completed (${url}). Retry the pull.`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`Server returned unparseable JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(data)) throw new Error("Server returned an unexpected response (not a JSON object)");
  if (!Array.isArray(data.endpoints)) throw new Error("Server returned an unexpected response (no endpoints array)");
  return data as unknown as Bundle;
}

/** Python `int(x or 0)` for a cursor string; null when it does not parse. */
function cursorValue(v: unknown): bigint | null {
  if (v === undefined || v === null || v === "" || v === 0 || v === false) return 0n;
  if (typeof v === "number") return Number.isInteger(v) ? BigInt(v) : BigInt(Math.trunc(v));
  if (typeof v === "string" && /^\s*[+-]?\d+(?:_\d+)*\s*$/.test(v)) return BigInt(v.trim().replace(/_/g, ""));
  return null;
}

/** Merge per-endpoint bundles as if the server had returned one (cli.py `_merge_bundles`). */
export function mergeBundles(typed: Bundle[]): Bundle {
  // The merge works on loose records: servers add fields, and generated_at may be null.
  const parts = typed as unknown as Obj[];
  if (parts.length === 0) return { ok: true, version: 1, cursor: "0", endpoints: [] };
  if (parts.length === 1) return typed[0] as Bundle;

  const merged = new Map<string, Obj & { stubs: Obj[] }>();
  const seen = new Map<string, Set<string>>();
  const truncated = new Map<string, unknown>();
  let cursor = 0n;

  for (const part of parts) {
    const c = cursorValue(part.cursor);
    if (c !== null && c > cursor) cursor = c;
    if (isObj(part.truncated)) {
      for (const [k, v] of Object.entries(part.truncated)) if (!truncated.has(k)) truncated.set(k, v);
    }
    for (const ep of arr(part.endpoints)) {
      // JSON array of the key parts: unambiguous whatever the strings contain.
      const key = JSON.stringify([str(ep.domain), str(ep.method).toUpperCase(), str(ep.path_template)]);
      let m = merged.get(key);
      if (!m) {
        m = { ...ep, stubs: [] };
        merged.set(key, m);
        seen.set(key, new Set());
      }
      const fps = seen.get(key) as Set<string>;
      for (const stub of arr(ep.stubs)) {
        const fp = str(stub.fingerprint);
        if (fps.has(fp)) continue;
        fps.add(fp);
        m.stubs.push(stub);
      }
    }
  }

  const out: Obj = {
    ok: true,
    version: (parts[0] as Obj).version ?? 1,
    cursor: cursor.toString(),
    generated_at: (parts[parts.length - 1] as Obj).generated_at ?? null,
    endpoints: [...merged.values()],
  };
  // The server sends the same project_settings in every part, except that a
  // part served while it could not read them has none or an empty one. Replay
  // reads them, so keep the last part that holds the setting.
  for (let i = parts.length - 1; i >= 0; i--) {
    const ps = (parts[i] as Obj).project_settings;
    if (isObj(ps) && typeof ps.group_ids_in_paths === "boolean") {
      out.project_settings = ps;
      break;
    }
  }
  if (truncated.size > 0) out.truncated = Object.fromEntries(truncated);
  return out as unknown as Bundle;
}

/** Python `v.get("status") or 0` sort key. */
function statusKey(v: Obj): number {
  return typeof v.status === "number" ? v.status : 0;
}

/** Copy of `data` with endpoints by (domain, method, path_template), stubs by fingerprint, variants by status. */
export function sortBundle(typed: Bundle): Bundle {
  const data = typed as unknown as Obj;
  const endpoints = [...arr(data.endpoints)].sort(
    (a, b) =>
      compareCodePoints(str(a.domain), str(b.domain)) ||
      compareCodePoints(str(a.method), str(b.method)) ||
      compareCodePoints(str(a.path_template), str(b.path_template)),
  );
  return {
    ...data,
    endpoints: endpoints.map((ep) => ({
      ...ep,
      stubs: [...arr(ep.stubs)]
        .sort((a, b) => compareCodePoints(str(a.fingerprint), str(b.fingerprint)))
        .map((stub) => ({ ...stub, variants: [...arr(stub.variants)].sort((a, b) => statusKey(a) - statusKey(b)) })),
    })),
  } as unknown as Bundle;
}

export function summarizeBundle(typed: Bundle): BundleSummary {
  const data = typed as unknown as Obj;
  const eps = arr(data.endpoints);
  const summary: BundleSummary = { endpoints: eps.length, stubs: 0, variants: 0, degraded: [], bodyCapped: 0 };
  for (const ep of eps) {
    for (const stub of arr(ep.stubs)) {
      summary.stubs++;
      if (stub.degraded) {
        summary.degraded.push({
          domain: str(ep.domain),
          method: str(ep.method),
          pathTemplate: str(ep.path_template),
          fingerprint: str(stub.fingerprint),
        });
      }
      for (const v of arr(stub.variants)) {
        summary.variants++;
        if (v.body_capped) summary.bodyCapped++;
      }
    }
  }
  return summary;
}

function resolveAuth(opts: { apiKey?: string; apiUrl?: string }): { apiKey: string; apiUrl: string } {
  const apiKey = opts.apiKey || process.env.STUBSMITH_API_KEY || "";
  if (!apiKey) throw new Error("No API key: pass apiKey or set $STUBSMITH_API_KEY.");
  return { apiKey, apiUrl: opts.apiUrl || resolveApiUrl() };
}

/**
 * Fetch the raw replay bundle for one request: the whole project, or the
 * `"METHOD /path"` endpoint. Returned as the server sent it, unmerged and
 * unsorted, so `replay(await fetchBundle())` works. Does not touch disk.
 */
export async function fetchBundle(endpoint?: string, opts: FetchBundleOptions = {}): Promise<Bundle> {
  const { apiKey, apiUrl } = resolveAuth(opts);
  let method: string | null = null;
  let p: string | null = null;
  if (endpoint !== undefined) {
    const ep = parseEndpoint(endpoint);
    if (!ep) throw new Error(`endpoint must be "METHOD /path" (e.g. "GET /api/orders"), got: ${JSON.stringify(endpoint)}`);
    method = ep.method;
    p = ep.path;
  }
  const samples = opts.samples === undefined ? null : normaliseSamples(opts.samples, endpoint !== undefined);
  return fetchOne(apiUrl, apiKey, method, p, samples);
}

/**
 * Fetch the replay bundle, one request per endpoint (or one unfiltered
 * request), merged and sorted. Does not touch disk.
 */
export async function pullBundle(opts: PullBundleOptions = {}): Promise<PullBundleResult> {
  const { apiKey, apiUrl } = resolveAuth(opts);

  const targets: Array<{ method: string | null; path: string | null }> = [];
  for (const raw of opts.endpoints ?? []) {
    const ep = parseEndpoint(raw);
    if (!ep) throw new Error(`endpoint must be "METHOD /path" (e.g. "GET /api/orders"), got: ${JSON.stringify(raw)}`);
    targets.push({ method: ep.method, path: ep.path });
  }
  const samples = opts.samples === undefined ? null : normaliseSamples(opts.samples, targets.length > 0);
  if (targets.length === 0) targets.push({ method: null, path: null });

  const fetched: Bundle[] = [];
  for (const t of targets) {
    if (t.method && t.path) opts.onFetch?.(t.method, t.path);
    fetched.push(await fetchOne(apiUrl, apiKey, t.method, t.path, samples));
  }
  const bundle = sortBundle(mergeBundles(fetched));
  return { bundle, summary: summarizeBundle(bundle) };
}

function compareKeys(a: string, b: string): number {
  return compareCodePoints(a, b);
}

/*
 * Numbers go through JSON.stringify, so a float would format differently from
 * Python (`12.0` vs `12`, `1e+16` vs `1e16`). The backend emits only integers
 * and strings today, so output matches; revisit if a float field is added.
 */
/** JSON as Python `json.dumps(sort_keys=True, indent=2, ensure_ascii=False)`: keys sorted by code point, non-ASCII kept. */
export function stringifyBundle(value: unknown, indent = ""): string {
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const inner = `${indent}  `;
    return `[\n${value.map((v) => inner + stringifyBundle(v === undefined ? null : v, inner)).join(",\n")}\n${indent}]`;
  }
  if (isObj(value)) {
    const keys = Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort(compareKeys);
    if (keys.length === 0) return "{}";
    const inner = `${indent}  `;
    return `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${stringifyBundle(value[k], inner)}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Write atomically: temp file in the same directory, chmod 0644, rename into place. */
export async function writeBundle(outPath: string, data: Bundle): Promise<void> {
  const dest = path.resolve(outPath);
  const dir = path.dirname(dest);
  await fsp.mkdir(dir, { recursive: true });
  const serialised = `${stringifyBundle(data)}\n`;
  const tmp = path.join(dir, `.stubsmith-bundle-${randomBytes(6).toString("hex")}`);
  try {
    await fsp.writeFile(tmp, serialised, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await fsp.chmod(tmp, 0o644);
    await fsp.rename(tmp, dest);
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
