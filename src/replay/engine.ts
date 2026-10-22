/**
 * Replay matching engine: pure (no I/O, no globals). Port of the matching half
 * of stubsmith/replay.py: composite-key index, path templating against the
 * bundle's own templates, fingerprinting, near-miss diagnostics, response
 * flattening and the served-response shape.
 */
import { STATUS_CODES } from "node:http";
import { sortCodePoints } from "../internal/codepoint.js";
import { isJsonNumber, jsonNumber, stringifyJson } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { pyUrlParse } from "../internal/pyurl.js";
import { dictGet, isDict } from "../internal/pystr.js";
import { utf8Decode, utf8Encode } from "../internal/utf8.js";
import { computeFingerprint, extractKeypaths, normaliseContentType, uniqueQueryNames } from "../privacy/fingerprint.js";
import { loadCuratedTemplates, templatePath } from "../privacy/templating.js";
import type { CuratedTemplate } from "../privacy/templating.js";
import type { Bundle, BundleVariant } from "./bundle.js";

const REFRESH_HINT = "  refresh the bundle:  stubsmith pull";

/** Width the path column of a near-miss diff line is padded to. */
const PATH_COL_WIDTH = 36;

/** Hop-by-hop headers stripped before serving (testing.py `_HOP_BY_HOP`). */
export const HOP_BY_HOP: ReadonlySet<string> = new Set([
  "content-length",
  "transfer-encoding",
  "connection",
  "content-encoding",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Raised on a miss: the request matched no recorded stub. Replay never falls through to the network. */
export class StubNotFound extends Error {
  readonly method: string;
  readonly pathTemplate: string;
  readonly fingerprint: string;

  constructor(method: string, pathTemplate: string, fingerprint: string, message = "") {
    super(
      message ||
        `no recorded stub for ${method} ${pathTemplate}  (fingerprint ${fingerprint})\n\n${REFRESH_HINT}`,
    );
    this.name = "StubNotFound";
    this.method = method;
    this.pathTemplate = pathTemplate;
    this.fingerprint = fingerprint;
  }
}

/** What the engine needs to know about an outbound request. */
export interface ReplayRequest {
  method: string;
  /** Absolute URL, query string included. */
  url: string;
  /** Header names are matched case-insensitively; only `content-type` is read. */
  headers?: Record<string, string | string[] | number | undefined> | null;
  /** Bytes are decoded as UTF-8 (an undecodable body counts as empty). */
  body?: string | Uint8Array | null;
}

/**
 * One recorded response, as handed to a `select` callback: a variant (or one
 * sample of a variant) flattened to the unit a test iterates.
 */
export interface RecordedResponse {
  status: number;
  /** How often the variant's status was observed. */
  count: number;
  durationMs: number | null;
  headers: Record<string, string>;
  /** The stored body: a JSON-encoded string, null, or an object/array. */
  body: unknown;
  bodyEncoding: string | null;
  captureId: string | null;
  capturedAt: string | null;
  bodyCapped: boolean;
}

/**
 * Chooses which recorded response to serve. Receives the shape's recordings,
 * newest first within each status and ordered so the default choice is first.
 * Return one of them, or null to force a {@link StubNotFound}.
 */
export type SelectFn = (responses: RecordedResponse[]) => RecordedResponse | null | undefined;

/** A `select` that serves the first (newest) recording of `status`, or null when none exists. */
export function byStatus(status: number): SelectFn {
  return (responses) => responses.find((r) => r.status === status) ?? null;
}

/** The response the engine hands to a transport hook. */
export interface ServedPayload {
  status: number;
  statusText: string;
  /** Recorded headers minus hop-by-hop ones. */
  headers: Record<string, string>;
  body: Uint8Array;
  durationMs: number;
}

/** One recorded response a replay context served. */
export class ServedResponse {
  constructor(
    readonly domain: string,
    readonly method: string,
    readonly pathTemplate: string,
    readonly fingerprint: string,
    readonly status: number,
    readonly captureId: string | null,
    readonly capturedAt: string | null,
    /** Position of this response in its stub's recorded list. */
    readonly index: number,
    /** How many responses that stub has recorded in total. */
    readonly total: number,
  ) {}

  /** `"GET api.example.com/v1/orders/{id}"`, for test ids and messages. */
  get endpoint(): string {
    return `${this.method} ${this.domain}${this.pathTemplate}`;
  }

  /** True when this was the last recorded response for its stub (a clamped repeat, not a new recording). */
  get exhausted(): boolean {
    return this.index >= this.total - 1;
  }
}

type StubKey = readonly [string, string, string, string];

const keyOf = (...parts: string[]): string => JSON.stringify(parts);

// ---------------------------------------------------------------------------
// Pass state (replayAll)
// ---------------------------------------------------------------------------

/**
 * Cursor shared by the contexts `replayAll` yields. One cursor per request
 * shape (stub key), not one global pass index: which shapes a pass touches is
 * only discovered by running the caller's code, and a shape found late must
 * still be looped from its first recording. Each shape advances once per pass,
 * from the pass on which it was first served.
 */
export class PassState {
  /** 0-based index of the current pass. */
  passNo = 0;
  private readonly cursors = new Map<string, number>();
  private readonly totals = new Map<string, number>();
  private readonly servedPairs = new Set<string>();
  private touched = new Set<string>();

  /**
   * Which recording this shape serves in the current pass. Fixed for the whole
   * pass: a shape called twice in one pass serves the same recording both times.
   */
  indexFor(stubKey: StubKey, total: number): number {
    const k = keyOf(...stubKey);
    this.totals.set(k, total);
    if (!this.cursors.has(k)) this.cursors.set(k, 0);
    const index = Math.min(this.cursors.get(k) as number, total - 1);
    this.touched.add(k);
    this.servedPairs.add(`${k}#${index}`);
    return index;
  }

  /** End the pass; returns whether another is needed. */
  advance(): boolean {
    for (const k of this.touched) {
      const cursor = this.cursors.get(k) as number;
      if (cursor < (this.totals.get(k) as number) - 1) this.cursors.set(k, cursor + 1);
    }
    this.touched = new Set();
    this.passNo += 1;
    // Another pass is worth running only if a shape already served has an unseen
    // recording at its new cursor; a shape at its last recording is done.
    for (const [k, cursor] of this.cursors) if (!this.servedPairs.has(`${k}#${cursor}`)) return true;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

interface Candidate {
  fingerprint: string;
  keyPaths: string[];
  totalCount: number;
  variants: BundleVariant[];
  queryNames: string[] | null;
  contentType: string | null;
}

interface Index {
  stubs: Map<string, Candidate>;
  curated: Map<string, readonly CuratedTemplate[]>;
  valuePaths: Map<string, string[]>;
  byEndpoint: Map<string, Candidate[]>;
  /** Endpoint keys in bundle order (for the "other endpoints" listing). */
  endpointKeys: Array<readonly [string, string, string]>;
}

function buildIndex(bundle: Bundle): Index {
  const stubs = new Map<string, Candidate>();
  const templateMap = new Map<string, string[]>();
  const valuePaths = new Map<string, string[]>();
  const byEndpoint = new Map<string, Candidate[]>();
  const endpointKeys = new Map<string, readonly [string, string, string]>();

  for (const ep of bundle.endpoints ?? []) {
    const domain = ep.domain || "";
    const method = (ep.method || "").toUpperCase();
    const pathTemplate = ep.path_template || "";
    const epKey = keyOf(domain, method, pathTemplate);
    valuePaths.set(epKey, ep.fingerprint_value_paths ?? []);
    if (!byEndpoint.has(epKey)) byEndpoint.set(epKey, []);
    if (!endpointKeys.has(epKey)) endpointKeys.set(epKey, [domain, method, pathTemplate]);

    const mdKey = keyOf(method, domain);
    const templates = templateMap.get(mdKey) ?? [];
    if (!templateMap.has(mdKey)) templateMap.set(mdKey, templates);
    if (!templates.includes(pathTemplate)) templates.push(pathTemplate);

    for (const stub of ep.stubs ?? []) {
      const fp = stub.fingerprint || "";
      const variants = stub.variants ?? [];
      const keyPaths = stub.key_paths ?? [];
      const candidate: Candidate = {
        fingerprint: fp,
        keyPaths,
        totalCount: variants.reduce((n, v) => n + (v.count ?? 1), 0),
        variants,
        queryNames: stub.query_names != null ? [...stub.query_names] : null,
        contentType: stub.content_type ?? null,
      };
      stubs.set(keyOf(domain, method, pathTemplate, fp), candidate);
      (byEndpoint.get(epKey) as Candidate[]).push(candidate);
    }
  }

  const curated = new Map<string, readonly CuratedTemplate[]>();
  for (const [k, v] of templateMap) curated.set(k, loadCuratedTemplates(v));
  return { stubs, curated, valuePaths, byEndpoint, endpointKeys: [...endpointKeys.values()] };
}

// ---------------------------------------------------------------------------
// Response flattening
// ---------------------------------------------------------------------------

/** Python truthiness for the `a or b` header fallbacks: an empty object is falsy. */
function nonEmpty(h: Record<string, string> | undefined | null): Record<string, string> | null {
  return h && Object.keys(h).length > 0 ? h : null;
}

/** The variant a plain replay serves: highest count, ties broken by lowest status. */
function selectVariant(variants: readonly BundleVariant[]): BundleVariant | null {
  let best: BundleVariant | null = null;
  for (const v of variants) {
    if (best === null) {
      best = v;
      continue;
    }
    const c = (v.count ?? 1) - (best.count ?? 1);
    if (c > 0 || (c === 0 && (v.status ?? 0) < (best.status ?? 0))) best = v;
  }
  return best;
}

/**
 * Expand variants into a flat, ordered list of individual recordings: the
 * primary variant first (newest sample first), then the others by status.
 */
export function flattenResponses(variants: readonly BundleVariant[]): RecordedResponse[] {
  if (variants.length === 0) return [];
  const primary = selectVariant(variants);
  const ordered: BundleVariant[] = [];
  if (primary !== null) ordered.push(primary);
  ordered.push(...variants.filter((v) => v !== primary).sort((a, b) => (a.status ?? 0) - (b.status ?? 0)));

  const out: RecordedResponse[] = [];
  for (const v of ordered) {
    const status = v.status ?? 200;
    const count = v.count ?? 1;
    if (!v.samples || v.samples.length === 0) {
      out.push({
        status,
        count,
        durationMs: v.duration_ms ?? null,
        headers: v.headers ?? {},
        body: v.body ?? null,
        bodyEncoding: v.body_encoding ?? null,
        captureId: null,
        capturedAt: null,
        bodyCapped: Boolean(v.body_capped),
      });
      continue;
    }
    for (const s of v.samples) {
      out.push({
        status,
        count,
        durationMs: "duration_ms" in s ? (s.duration_ms ?? null) : (v.duration_ms ?? null),
        headers: nonEmpty(s.headers) ?? nonEmpty(v.headers) ?? {},
        body: s.body ?? null,
        // The sample's own encoding wins: recordings of one status can differ.
        bodyEncoding: ("body_encoding" in s ? s.body_encoding : v.body_encoding) ?? null,
        captureId: s.capture_id ?? null,
        capturedAt: s.captured_at ?? null,
        bodyCapped: Boolean(s.body_capped),
      });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

/** Plain JS values to the Map-based `JsonValue`; already-converted values pass through. */
function toJsonValue(v: unknown): JsonValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return jsonNumber(Number.isNaN(v) ? "NaN" : v === Infinity ? "Infinity" : v === -Infinity ? "-Infinity" : String(v));
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k as string, toJsonValue(x)]));
  if (Array.isArray(v)) return v.map(toJsonValue);
  if (isJsonNumber(v)) return v;
  const m = new Map<string, JsonValue>();
  for (const [k, x] of Object.entries(v as object)) m.set(k, toJsonValue(x));
  return m;
}

/** Python truthiness of a stored body (`variant.get("body") or ""`). */
function bodyIsEmpty(b: unknown): boolean {
  if (b === null || b === undefined || b === "" || b === false || b === 0) return true;
  if (b instanceof Map) return b.size === 0;
  if (Array.isArray(b)) return b.length === 0;
  if (typeof b === "object" && !isJsonNumber(b)) return Object.keys(b).length === 0;
  return false;
}

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64 (Python `b64decode(validate=True)`): alphabet only, correct padding; null when invalid. */
function strictBase64(text: string): Uint8Array | null {
  if (text.length % 4 !== 0 || !BASE64_RE.test(text)) return null;
  return new Uint8Array(Buffer.from(text, "base64"));
}

/**
 * The bytes the original response carried. `body_encoding: "base64"` means the
 * stored text is base64 of the real body; an undecodable or unknown encoding
 * falls back to the literal text, so a fixture problem never fails the request.
 */
export function decodeBody(stored: unknown, bodyEncoding: string | null | undefined): Uint8Array {
  if (bodyIsEmpty(stored)) return new Uint8Array(0);
  if (typeof stored !== "string") return utf8Encode(stringifyJson(toJsonValue(stored)));
  if (bodyEncoding === "base64") return strictBase64(stored) ?? utf8Encode(stored);
  return utf8Encode(stored);
}

function buildResponse(variant: RecordedResponse): ServedPayload {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(variant.headers)) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = String(v);
  }
  return {
    status: variant.status,
    statusText: STATUS_CODES[variant.status] ?? "",
    headers,
    body: decodeBody(variant.body, variant.bodyEncoding),
    durationMs: variant.durationMs || 0,
  };
}

// ---------------------------------------------------------------------------
// Near-miss diagnostics
// ---------------------------------------------------------------------------

const ctNorm = (ct: string | null | undefined): string => normaliseContentType(ct ?? "");

function symmetricDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let n = 0;
  for (const x of a) if (!b.has(x)) n++;
  for (const x of b) if (!a.has(x)) n++;
  return n;
}

/** Drop intermediate nodes: a path with another path beneath it in the same set. */
function filterLeafPaths(paths: string[]): string[] {
  const filtered = paths.filter((p) => !paths.some((o) => o.startsWith(p + ".")));
  return filtered.length > 0 ? filtered : paths;
}

function padEnd(s: string, width: number): string {
  const len = [...s].length;
  return len >= width ? s : s + " ".repeat(width - len);
}

function fmtDiffLine(sigil: string, p: string, annotation: string): string {
  return `    ${sigil} ${padEnd(p, PATH_COL_WIDTH)}  ${annotation}`;
}

interface MissContext {
  method: string;
  pathTemplate: string;
  fingerprint: string;
  domain: string;
  body: string;
  contentType: string;
  queryString: string;
  candidates: Candidate[];
  allEndpoints: ReadonlyArray<readonly [string, string, string]>;
}

function buildMissMessage(c: MissContext): string {
  const header = `no recorded stub for ${c.method} ${c.pathTemplate}  (fingerprint ${c.fingerprint})`;

  if (c.candidates.length === 0) {
    const lines: string[] = [header, ""];
    lines.push(`No traffic has been recorded for ${c.method} ${c.domain}.`);
    const sameMethod = c.allEndpoints.filter(([, m]) => m === c.method);
    if (sameMethod.length > 0) {
      lines.push(`\nEndpoints recorded with ${c.method} in this bundle:`);
      for (const [d, , pt] of sameMethod.slice(0, 6)) {
        lines.push(d === c.domain ? `  ${c.method} ${pt}` : `  ${c.method} ${d}${pt}`);
      }
      if (sameMethod.length > 6) lines.push(`  … and ${sameMethod.length - 6} more`);
    } else {
      lines.push(`\nNo ${c.method} endpoints are recorded in this bundle.`);
    }
    lines.push("");
    lines.push(REFRESH_HINT);
    return lines.join("\n");
  }

  const sentKps = new Set(extractKeypaths(c.body, c.contentType));
  const sentQns = new Set(uniqueQueryNames(c.queryString));
  const sentCt = ctNorm(c.contentType);

  const score = (cand: Candidate): number => {
    let s = symmetricDifference(sentKps, new Set(cand.keyPaths));
    if (cand.queryNames !== null) s += symmetricDifference(sentQns, new Set(cand.queryNames));
    if (cand.contentType !== null && ctNorm(cand.contentType) !== sentCt) s += 1;
    return s;
  };

  const scored = c.candidates.map((cand) => [score(cand), cand] as const).sort((a, b) => a[0] - b[0]).map(([, cand]) => cand);
  const total = scored.length;

  const lines: string[] = [header, ""];
  if (total > 2) lines.push(`${total} recordings found for this endpoint; showing the 2 closest.\n`);

  for (const cand of scored.slice(0, 2)) {
    const candKps = new Set(cand.keyPaths);
    // Scoring uses the full symmetric difference; display collapses parent paths.
    const rawOnlySent = sortCodePoints([...sentKps].filter((p) => !candKps.has(p)));
    const rawOnlyRec = sortCodePoints([...candKps].filter((p) => !sentKps.has(p)));
    const hasKpDiff = rawOnlySent.length > 0 || rawOnlyRec.length > 0;

    const qnDiffLines: string[] = [];
    if (cand.queryNames !== null) {
      const candQns = new Set(cand.queryNames);
      for (const q of sortCodePoints([...sentQns].filter((x) => !candQns.has(x)))) {
        qnDiffLines.push(fmtDiffLine("+", `?${q}`, "sent, not in the recording"));
      }
      for (const q of sortCodePoints([...candQns].filter((x) => !sentQns.has(x)))) {
        qnDiffLines.push(fmtDiffLine("-", `?${q}`, "in the recording, not sent"));
      }
    }

    const ctDiffLines: string[] = [];
    if (cand.contentType !== null) {
      const candCt = ctNorm(cand.contentType);
      if (candCt !== sentCt) {
        ctDiffLines.push(
          `    Content-Type:\n      sent:       ${sentCt || "(none)"}\n      recording:  ${candCt || "(none)"}`,
        );
      }
    }

    if (!(hasKpDiff || qnDiffLines.length > 0 || ctDiffLines.length > 0)) {
      const missing: string[] = [];
      if (cand.queryNames === null) missing.push("query-parameter names");
      if (cand.contentType === null) missing.push("content-type");

      if (missing.length === 0) {
        // All three fingerprint inputs compared and matched: a genuine anomaly.
        lines.push(
          `The request appears structurally identical to recording ${cand.fingerprint} but hashed differently.\n` +
            "This indicates a fingerprint symmetry bug in the SDK - please report it at " +
            "https://github.com/stubsmith/stubsmith-node/issues.",
        );
      } else {
        const missingStr = missing.join(" and ");
        const check: string[] = [];
        if (cand.queryNames === null) {
          check.push("  - query-parameter names: compare ?name=... in your request to what was captured");
        }
        if (cand.contentType === null) {
          check.push("  - content-type: compare the Content-Type header in your request to what was captured");
        }
        lines.push(
          `Closest recording  ${cand.fingerprint}  (seen ${cand.totalCount}x) - key-paths are identical.\n` +
            `The fingerprint difference likely lies in ${missingStr}, which this bundle does not record.\n` +
            "Check by hand:\n" +
            check.join("\n") +
            "\n" +
            `Re-pull with a newer server to get a bundle that includes ${missingStr}.`,
        );
      }
      lines.push("");
    } else {
      lines.push(`Closest recording  ${cand.fingerprint}  (seen ${cand.totalCount}x):`);
      for (const kp of filterLeafPaths(rawOnlySent)) lines.push(fmtDiffLine("+", kp, "sent, not in the recording"));
      for (const kp of filterLeafPaths(rawOnlyRec)) lines.push(fmtDiffLine("-", kp, "in the recording, not sent"));
      lines.push(...qnDiffLines, ...ctDiffLines, "");
    }
  }

  lines.push(REFRESH_HINT);
  return lines.join("\n");
}

function statusFilterMessage(
  method: string,
  pathTemplate: string,
  fp: string,
  statuses: ReadonlySet<number>,
  available: number[],
): string {
  const wanted = [...statuses].sort((a, b) => a - b).join(", ");
  const got = [...new Set(available)].sort((a, b) => a - b).join(", ") || "none";
  return (
    `no recorded ${wanted} response for ${method} ${pathTemplate}  (fingerprint ${fp})\n\n` +
    `statuses recorded for this shape: ${got}\n\n` +
    "This shape is in the bundle, so the request matched; it has no recording " +
    "of the status you filtered to. Serving one of the statuses above instead " +
    "would make the loop assert against a response it was told to exclude.\n\n" +
    "Either widen statuses, or exclude this endpoint from the loop.\n\n" +
    REFRESH_HINT
  );
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export interface ReplayEngineOptions {
  select?: SelectFn;
  /** Serve only recordings with one of these statuses (used by `replayAll`). */
  statuses?: Iterable<number>;
  /** Cursor shared across passes (used by `replayAll`). */
  passState?: PassState;
  /** File the bundle came from; appended to miss messages. */
  bundlePath?: string | null;
}

/** The result of matching a request: the stub key and its ordered recordings. */
export interface Match {
  stubKey: StubKey;
  responses: RecordedResponse[];
}

/** Matches requests against a bundle and builds responses. Holds only the list of what it served. */
export class ReplayEngine {
  readonly bundlePath: string | null;
  private readonly index: Index;
  /** The project's "Group IDs in paths automatically" setting as of the pull; only an explicit false turns it off. */
  private readonly groupIds: boolean;
  private readonly select: SelectFn | undefined;
  private readonly statuses: ReadonlySet<number> | undefined;
  private readonly passState: PassState | undefined;
  private readonly log: ServedResponse[] = [];

  constructor(bundle: Bundle, opts: ReplayEngineOptions = {}) {
    this.index = buildIndex(bundle);
    // Replay groups paths the way capture did. Bundles from before the setting existed have no project_settings: on.
    const settings = dictGet(bundle, "project_settings");
    this.groupIds = !(isDict(settings) && dictGet(settings, "group_ids_in_paths") === false);
    this.select = opts.select;
    this.statuses = opts.statuses !== undefined ? new Set(opts.statuses) : undefined;
    this.passState = opts.passState;
    this.bundlePath = opts.bundlePath ?? null;
  }

  /** 1-based pass number under `replayAll`, else 1. */
  get passNumber(): number {
    return this.passState ? this.passState.passNo + 1 : 1;
  }

  /** Every response served through this engine, in call order. */
  served(): ServedResponse[] {
    return [...this.log];
  }

  private fail(method: string, pathTemplate: string, fp: string, message: string): StubNotFound {
    const suffix = this.bundlePath !== null ? `\n[bundle loaded from: ${this.bundlePath}]` : "";
    return new StubNotFound(method, pathTemplate, fp, message + suffix);
  }

  /** Find the stub for `request`. Throws {@link StubNotFound} on a miss; never reaches the network. */
  match(request: ReplayRequest): Match {
    const parsed = pyUrlParse(request.url);
    // Userinfo dropped, as in captures.
    const domain = parsed.netloc.slice(parsed.netloc.lastIndexOf("@") + 1);
    const path = parsed.path || "/";
    const queryString = parsed.query || "";
    const method = (request.method || "GET").toUpperCase();

    const curated = this.index.curated.get(keyOf(method, domain)) ?? [];
    const pathTemplate = templatePath(path, curated, this.groupIds);

    let body = "";
    if (typeof request.body === "string") body = request.body;
    else if (request.body instanceof Uint8Array) {
      try {
        body = utf8Decode(request.body, { fatal: true });
      } catch {
        body = "";
      }
    }

    let contentType = "";
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.toLowerCase() !== "content-type" || value === undefined) continue;
      contentType = Array.isArray(value) ? value.join(", ") : String(value);
      break;
    }

    const epKey = keyOf(domain, method, pathTemplate);
    const valuePaths = this.index.valuePaths.get(epKey) ?? [];

    let fp: string;
    try {
      fp = computeFingerprint(body, queryString, contentType, valuePaths.length > 0 ? valuePaths : null).fingerprint;
    } catch {
      // A body that cannot be UTF-8 encoded (lone surrogate): fingerprint it as empty.
      fp = computeFingerprint("", queryString, contentType, valuePaths.length > 0 ? valuePaths : null).fingerprint;
    }

    const entry = this.index.stubs.get(keyOf(domain, method, pathTemplate, fp));
    if (entry === undefined) {
      throw this.fail(
        method,
        pathTemplate,
        fp,
        buildMissMessage({
          method,
          pathTemplate,
          fingerprint: fp,
          domain,
          body,
          contentType,
          queryString,
          candidates: this.index.byEndpoint.get(epKey) ?? [],
          allEndpoints: this.index.endpointKeys,
        }),
      );
    }

    let responses = flattenResponses(entry.variants);
    const statuses = this.statuses;
    if (statuses !== undefined) {
      const kept = responses.filter((r) => statuses.has(r.status));
      if (kept.length === 0) {
        // The shape matched but has none of the wanted status. Raise rather than
        // substitute: a loop told to exercise 200s must not assert against a 500.
        throw this.fail(
          method,
          pathTemplate,
          fp,
          statusFilterMessage(method, pathTemplate, fp, statuses, responses.map((r) => r.status)),
        );
      }
      responses = kept;
    }
    return { stubKey: [domain, method, pathTemplate, fp], responses };
  }

  private choose(m: Match): RecordedResponse | null {
    const { responses, stubKey } = m;
    if (responses.length === 0) return null;
    let index: number;
    let chosen: RecordedResponse;
    if (this.select !== undefined) {
      const picked = this.select(responses);
      if (picked === null || picked === undefined) return null;
      chosen = picked;
      index = Math.max(0, responses.indexOf(picked));
    } else if (this.passState !== undefined) {
      index = this.passState.indexFor(stubKey, responses.length);
      chosen = responses[index] as RecordedResponse;
    } else {
      index = 0;
      chosen = responses[0] as RecordedResponse;
    }
    const [domain, method, pathTemplate, fingerprint] = stubKey;
    this.log.push(
      new ServedResponse(domain, method, pathTemplate, fingerprint, chosen.status, chosen.captureId, chosen.capturedAt, index, responses.length),
    );
    return chosen;
  }

  /** Match `request`, pick the recording, record it in `served()` and build the response. */
  serve(request: ReplayRequest): ServedPayload {
    const m = this.match(request);
    const chosen = this.choose(m);
    if (chosen === null) {
      // Degraded stub with no variants, or `select` returned null (e.g. byStatus on an unrecorded status).
      const [, method, pathTemplate, fp] = m.stubKey;
      const recorded = [...new Set(m.responses.map((r) => r.status))].sort((a, b) => a - b).join(", ");
      const detail = m.responses.length > 0 ? `\n\nselect returned no recording; statuses recorded for this shape: ${recorded}` : "";
      throw this.fail(
        method,
        pathTemplate,
        fp,
        `no recorded stub for ${method} ${pathTemplate}  (fingerprint ${fp})${detail}\n\n${REFRESH_HINT}`,
      );
    }
    return buildResponse(chosen);
  }
}
