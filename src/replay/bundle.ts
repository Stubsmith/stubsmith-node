/**
 * Replay bundle: schema types (SPEC section 5), loading and resolution.
 * Port of the bundle half of stubsmith/replay.py (`_load_bundle_from_path`,
 * `_find_bundle_upward`, `_resolve_bundle`).
 */
import fs from "node:fs";
import path from "node:path";
import { isJsonObject, isJsonNumber, parseJson } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";

const DEFAULT_BUNDLE_ENV = "STUBSMITH_BUNDLE";
const DEFAULT_BUNDLE_PATH = ".stubsmith/bundle.json";

/** One stored response sample inside a variant (bundle fetched with `samples > 1`), newest first. */
export interface BundleSample {
  capture_id?: string | null;
  captured_at?: string | null;
  duration_ms?: number | null;
  headers?: Record<string, string>;
  /** A JSON-encoded string, or null. An object/array body is serialised like Python `json.dumps`. */
  body?: string | null | object;
  body_capped?: boolean;
  body_encoding?: string | null;
}

/** One recorded response status of a stub. */
export interface BundleVariant {
  status: number;
  count: number;
  duration_ms?: number | null;
  headers?: Record<string, string>;
  body?: string | null | object;
  body_capped?: boolean;
  body_encoding?: string | null;
  samples?: BundleSample[];
}

/** One request shape (fingerprint) of an endpoint. */
export interface BundleStub {
  fingerprint: string;
  key_paths: string[];
  query_names?: string[] | null;
  content_type?: string | null;
  field_rules?: unknown[];
  degraded?: boolean;
  variants: BundleVariant[];
}

export interface BundleEndpoint {
  domain: string;
  method: string;
  path_template: string;
  is_dynamic?: boolean;
  fingerprint_value_paths?: string[];
  stubs: BundleStub[];
}

export interface BundleTruncated {
  stubs?: { dropped: number; limit: number };
  variants?: Array<{ endpoint: string; fingerprint: string; dropped: number; limit: number }>;
  body_bytes?: { capped: number; limit: number };
}

/** The `.stubsmith/bundle.json` document produced by `stubsmith pull`. */
export interface Bundle {
  ok?: boolean;
  version?: number;
  cursor?: string;
  generated_at?: string;
  truncated?: BundleTruncated;
  /** Project settings as of the pull; absent in bundles from before the settings existed. */
  project_settings?: { group_ids_in_paths?: boolean };
  endpoints: BundleEndpoint[];
}

/** Anything `replay()` accepts as a bundle: the typed schema, a loosely typed parsed document (such as `fetchBundle().bundle`), or a file path. */
export type BundleSource = Bundle | Record<string, unknown> | string;

/** A bundle together with the file it was read from (null for an in-memory object). */
export interface ResolvedBundle {
  bundle: Bundle;
  path: string | null;
}

/**
 * Convert a parsed JSON document to plain objects, keeping every `body` that is
 * an object or array as a `JsonValue` (Map-based, numbers keep their source
 * token) so the engine can serialise it exactly like Python `json.dumps`.
 */
function toBundleValue(v: JsonValue, key: string): unknown {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (isJsonNumber(v)) return v.value;
  if (key === "body") return v;
  if (Array.isArray(v)) return v.map((x) => toBundleValue(x, ""));
  const out: Record<string, unknown> = {};
  for (const [k, val] of v) {
    Object.defineProperty(out, k, { value: toBundleValue(val, k), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

function parseBundleText(text: string, file: string): Bundle {
  let parsed: JsonValue;
  try {
    parsed = parseJson(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`Bundle file ${file} is not valid JSON: ${(err as Error).message}`);
  }
  if (!isJsonObject(parsed)) throw new Error(`Bundle file ${file} must contain a JSON object at the top level.`);
  return toBundleValue(parsed, "") as Bundle;
}

function loadBundleFromPath(file: string): Bundle {
  if (!fs.existsSync(file)) {
    throw new Error(`Bundle file not found: ${file}. Run 'stubsmith pull' to fetch the bundle from the server.`);
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`Cannot read bundle file ${file}: ${(err as Error).message}`);
  }
  return parseBundleText(text, file);
}

/** Load a bundle from an in-memory object (returned as-is) or a file path. */
export function loadBundle(source: BundleSource): Bundle {
  if (typeof source === "string") return loadBundleFromPath(source);
  if (source === null || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("loadBundle expects a bundle object or a path to a bundle file.");
  }
  return source as Bundle;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Walk upward from `start` looking for `.stubsmith/bundle.json`. The first
 * directory (inclusive) holding `.git` or `package.json` is the project
 * boundary: it is still checked for a bundle, but the walk never goes past it,
 * so a bundle outside the project is not picked up silently.
 */
export function findBundleUpward(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    const candidate = path.join(current, ".stubsmith", "bundle.json");
    if (isFile(candidate)) return candidate;
    if (fs.existsSync(path.join(current, ".git")) || fs.existsSync(path.join(current, "package.json"))) return null;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Resolve the bundle: the argument (object or path), else `$STUBSMITH_BUNDLE`,
 * else `.stubsmith/bundle.json` searched upward from the working directory up
 * to the first `.git` / `package.json` boundary. Throws when none is found.
 */
export function resolveBundle(arg?: BundleSource | null): ResolvedBundle {
  if (arg !== undefined && arg !== null) {
    if (typeof arg === "string") return { bundle: loadBundleFromPath(arg), path: path.resolve(arg) };
    return { bundle: loadBundle(arg), path: null };
  }
  const envPath = process.env[DEFAULT_BUNDLE_ENV];
  if (envPath) return { bundle: loadBundleFromPath(envPath), path: path.resolve(envPath) };

  const start = process.cwd();
  const found = findBundleUpward(start);
  if (found === null) {
    throw new Error(
      `No bundle found. Searched for '${DEFAULT_BUNDLE_PATH}' starting from ${start} up to the first .git / package.json boundary. ` +
        `Provide a path, set $${DEFAULT_BUNDLE_ENV}, or run 'stubsmith pull' to create the file.`,
    );
  }
  return { bundle: loadBundleFromPath(found), path: found };
}
