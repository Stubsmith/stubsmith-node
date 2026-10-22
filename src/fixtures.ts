/**
 * Fixtures helper: fetch recorded response variants for a request type
 * (fixtures.py). Uses the SDK transport so the request is never captured; it holds
 * the process open until the response arrives, so a plain script can await it.
 *
 *     const fxs = await fixtures("POST /v1/charges/{id}", { distinct: "status" });
 *     fxs[0].response.json();
 */
import { resolveFixturesApiUrl } from "./env.js";
import { sendRequest } from "./transport.js";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

export interface FixturesOptions {
  /** Only `"status"`: at most one fixture per distinct HTTP status, newest first. */
  distinct?: "status";
  /** Maximum number of fixtures (1-100; server default 20). */
  limit?: number;
  /** Defaults to `STUBSMITH_API_URL`, then the hosted service. */
  apiUrl?: string;
  /** Defaults to `STUBSMITH_API_KEY`. */
  apiKey?: string;
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Headers and body for one side (request or response) of a {@link Fixture}. */
export class FixtureSide {
  readonly headers: Record<string, unknown>;
  readonly body: string | null;

  constructor(headers: Record<string, unknown> | null | undefined, body: string | null | undefined) {
    this.headers = headers ?? {};
    this.body = body ?? null;
  }

  /** Parse `body` as JSON. Throws when the body is null or not valid JSON. */
  json(): unknown {
    if (this.body === null) throw new Error("body is null - cannot parse as JSON");
    return JSON.parse(this.body);
  }
}

/** One recorded HTTP exchange from `/v1/fixtures`. */
export class Fixture {
  constructor(
    readonly id: string,
    readonly capturedAt: string,
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly durationMs: number | null,
    readonly request: FixtureSide,
    readonly response: FixtureSide,
  ) {}

  /** @internal */
  static fromObject(d: unknown): Fixture {
    if (!isObj(d)) throw new Error("StubSmith API returned a malformed fixture (not an object)");
    for (const k of ["id", "captured_at", "method", "path", "status"]) {
      if (d[k] === undefined || d[k] === null) throw new Error(`StubSmith API returned a malformed fixture (missing "${k}")`);
    }
    const side = (v: unknown): FixtureSide => {
      const s = isObj(v) ? v : {};
      return new FixtureSide(isObj(s.headers) ? s.headers : {}, typeof s.body === "string" ? s.body : null);
    };
    return new Fixture(
      String(d.id),
      String(d.captured_at),
      String(d.method),
      String(d.path),
      Number(d.status),
      typeof d.duration_ms === "number" ? d.duration_ms : null,
      side(d.request),
      side(d.response),
    );
  }

  toString(): string {
    return `<Fixture ${this.method} ${this.path} -> ${this.status}>`;
  }
}

/** The full `/v1/fixtures` envelope. */
export class FixtureBundle {
  readonly ok: boolean;
  readonly requestType: Record<string, unknown> | null;
  readonly fixtures: Fixture[];
  readonly count: number;

  constructor(data: Obj) {
    this.ok = typeof data.ok === "boolean" ? data.ok : true;
    this.requestType = isObj(data.request_type) ? data.request_type : null;
    const list = data.fixtures ?? [];
    if (!Array.isArray(list)) throw new Error('StubSmith API returned a malformed response ("fixtures" is not a list)');
    this.fixtures = list.map((f) => Fixture.fromObject(f));
    this.count = typeof data.count === "number" ? data.count : this.fixtures.length;
  }

  /** The fixture for `status`; throws an Error naming the statuses present when there is none. */
  byStatus(status: number): Fixture {
    const hit = this.fixtures.find((f) => f.status === status);
    if (hit) return hit;
    const present = [...new Set(this.fixtures.map((f) => f.status))].sort((a, b) => a - b);
    throw new Error(`No fixture with status ${status} in bundle (present: [${present.join(", ")}])`);
  }
}

/** Fetch the full `/v1/fixtures` envelope for `"METHOD /path"`. */
export async function fixturesBundle(spec: string, opts: FixturesOptions = {}): Promise<FixtureBundle> {
  const base = opts.apiUrl || resolveFixturesApiUrl();
  const key = opts.apiKey || process.env.STUBSMITH_API_KEY || "";
  if (!key) {
    throw new Error("StubSmith API key is required. Pass apiKey or set the STUBSMITH_API_KEY environment variable.");
  }

  const i = spec.indexOf(" ");
  const method = i < 0 ? "" : spec.slice(0, i).trim();
  const path = i < 0 ? "" : spec.slice(i + 1).trim();
  if (!method || !path) {
    throw new Error(`pattern must be 'METHOD /path' (e.g. 'POST /v1/charges/{id}'), got: ${JSON.stringify(spec)}`);
  }

  const params = new URLSearchParams({ method: method.toUpperCase(), path });
  if (opts.distinct !== undefined) params.set("distinct", opts.distinct);
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  const url = `${base.replace(/\/+$/, "")}/v1/fixtures?${params.toString()}`;

  let res;
  try {
    res = await sendRequest(url, {
      method: "GET",
      headers: { authorization: `Bearer ${key}` },
      timeoutMs: TIMEOUT_MS,
      holdProcess: true,
      maxBytes: MAX_BYTES,
    }).promise;
  } catch (err) {
    throw new Error(`StubSmith API request to ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  const text = res.body.toString("utf8");
  if (res.truncated) throw new Error(`StubSmith API response from ${url} exceeded ${MAX_BYTES / (1024 * 1024)} MiB`);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`StubSmith API returned HTTP ${res.status}: ${text}`);
  }
  if (!res.complete) throw new Error(`StubSmith API request to ${url} failed: connection closed before the response completed`);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`StubSmith API returned a malformed response: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!isObj(data)) throw new Error("StubSmith API returned a malformed response (not a JSON object)");
  return new FixtureBundle(data);
}

/** Fetch recorded fixtures for `"METHOD /path"`, newest first. */
export async function fixtures(spec: string, opts: FixturesOptions = {}): Promise<Fixture[]> {
  return (await fixturesBundle(spec, opts)).fixtures;
}
