/**
 * Body key-path extraction and content fingerprinting.
 * Port of stubsmith/privacy/fingerprint.py (function names in camelCase).
 *
 * The fingerprint is a 16 hex blake2b digest (digest size 8) over the UTF-8
 * bytes of `sorted(keypaths) + "|" + sorted(query names) + "|" + content type`
 * (+ `"|" + sorted(value pairs)` when value discrimination yields a pair).
 * Sorting is by Unicode code point.
 */
import { blake2bHex } from "../internal/blake2b.js";
import { sortCodePoints } from "../internal/codepoint.js";
import { isJsonNumber, isJsonObject, parseJson, stringifyJson } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { parseForm, parseQs } from "../internal/pyqs.js";
import { pyStrip, utf8EncodeStrict } from "../internal/pystr.js";
import { JSON_FLOAT, JSON_INTEGER, VOCAB, classifyString } from "./classifiers.generated.js";

// ---------------------------------------------------------------------------
// Observed value type classifier
// ---------------------------------------------------------------------------

// The labels, their order and the string rules are generated from the shared
// classifier spec (tools/classifiers/classifiers.json) into classifiers.generated.ts.
// These patterns read the content of the real value, and the resulting label is sent. The dashboard shows labels and
// uses them to suggest a type for a mask rule; no masking decision in the SDK reads them.
export { VOCAB };

/**
 * Classify a scalar leaf into the shared semantic type vocabulary. Booleans,
 * null and containers yield `null`. Int vs float comes from the JSON token
 * (`1.0` is a float). Never throws.
 */
export function classifyScalar(value: JsonValue | undefined): string | null {
  try {
    if (value === null || value === undefined || typeof value === "boolean") return null;
    if (isJsonNumber(value)) return value.isFloat ? JSON_FLOAT : JSON_INTEGER;
    if (typeof value !== "string") return null; // object / array
    return classifyString(value);
  } catch {
    return null;
  }
}

/** Python `_normalise_ct`: lowercase, drop parameters, strip. */
export function normaliseContentType(contentType: string | null | undefined): string {
  return pyStrip((contentType || "").toLowerCase().split(";")[0] as string);
}

const FORM_CT = "application/x-www-form-urlencoded";

/** Python `not body or not body.strip()`. */
function isBlank(body: string | null | undefined): boolean {
  return !body || pyStrip(body) === "";
}

/**
 * Map of dot-path to semantic type label for every typed scalar leaf
 * (Python `extract_value_types`). Insertion order is first appearance of a
 * path; a repeated path keeps the last label. `{}` when unparseable. Never throws.
 */
export function extractValueTypes(body: string, contentType = ""): Map<string, string> {
  const result = new Map<string, string>();
  if (isBlank(body)) return result;
  const ct = normaliseContentType(contentType);
  try {
    if (ct === FORM_CT) {
      const form = parseForm(body);
      if (form === null) return result;
      for (const [key, vals] of form) {
        if (vals.length === 0) continue;
        const label = classifyScalar(vals[0]);
        if (label !== null) result.set(key, label);
      }
    } else {
      let parsed: JsonValue;
      try {
        parsed = parseJson(body);
      } catch {
        return new Map();
      }
      walkValues(parsed, "", result);
    }
  } catch {
    return new Map();
  }
  return result;
}

/** Python `_walk_values`. */
function walkValues(obj: JsonValue, prefix: string, result: Map<string, string>): void {
  if (isJsonObject(obj)) {
    for (const [key, val] of obj) {
      const full = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(val) || isJsonObject(val)) {
        walkValues(val, full, result);
      } else {
        const label = classifyScalar(val);
        if (label !== null) result.set(full, label);
      }
    }
  } else if (Array.isArray(obj) && obj.length > 0) {
    const arrPrefix = prefix ? `${prefix}.[]` : "[]";
    for (const element of obj) {
      if (Array.isArray(element) || isJsonObject(element)) {
        walkValues(element, arrPrefix, result);
      } else {
        const label = classifyScalar(element);
        if (label !== null) result.set(arrPrefix, label);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Key paths found in `body`, in walk order (source order of keys). Empty when
 * the body is blank, unparseable or has no structured keys. Never throws on
 * bad input.
 */
export function extractKeypaths(body: string, contentType = ""): string[] {
  if (isBlank(body)) return [];
  const ct = normaliseContentType(contentType);
  if (ct === FORM_CT) {
    try {
      const form = parseForm(body);
      return form !== null ? [...form.keys()] : [];
    } catch {
      return [];
    }
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(body);
  } catch {
    return [];
  }
  return walk(parsed, "");
}

/** Python `_walk`: every element of an array is walked; union with dedup, first-seen order. */
function walk(obj: JsonValue, prefix: string): string[] {
  const paths: string[] = [];
  if (isJsonObject(obj)) {
    for (const [key, val] of obj) {
      const full = prefix ? `${prefix}.${key}` : key;
      paths.push(full);
      for (const p of walk(val, full)) paths.push(p);
    }
  } else if (Array.isArray(obj) && obj.length > 0) {
    const arrPrefix = prefix ? `${prefix}.[]` : "[]";
    const seen = new Set<string>();
    let hasScalar = false;
    for (const element of obj) {
      if (Array.isArray(element) || isJsonObject(element)) {
        for (const p of walk(element, arrPrefix)) {
          if (!seen.has(p)) {
            seen.add(p);
            paths.push(p);
          }
        }
      } else {
        hasScalar = true;
      }
    }
    if (hasScalar && !seen.has(arrPrefix)) paths.push(arrPrefix);
  }
  return paths;
}

/** Deduplicated query parameter names in first-occurrence order. */
export function uniqueQueryNames(queryString: string): string[] {
  if (!queryString) return [];
  try {
    return [...parseQs(queryString).keys()];
  } catch {
    return [];
  }
}

/** Result of {@link computeFingerprint}: the exact hash input and its 16-hex digest. */
export interface FingerprintResult {
  raw: string;
  fingerprint: string;
}

/**
 * Python `fingerprint`, also returning the hash input `raw`. Throws only where
 * Python raises (a lone surrogate cannot be UTF-8 encoded), which the pipeline
 * turns into a dropped capture.
 */
export function computeFingerprint(
  body: string,
  queryString: string,
  contentType: string,
  valuePaths?: readonly string[] | null,
): FingerprintResult {
  const keypaths = extractKeypaths(body, contentType);
  const ct = normaliseContentType(contentType);
  const queryNames = uniqueQueryNames(queryString);
  let raw = sortCodePoints(keypaths).join(",") + "|" + sortCodePoints(queryNames).join(",") + "|" + ct;
  if (valuePaths && valuePaths.length > 0) {
    const pairs = extractValuePairs(body, contentType, valuePaths);
    if (pairs.length > 0) raw += "|" + sortCodePoints(pairs).join(",");
  }
  return { raw, fingerprint: blake2bHex(utf8EncodeStrict(raw), { digestLength: 8 }) };
}

/** Python `fingerprint`: the 16-hex digest. */
export function fingerprint(
  body: string,
  queryString: string,
  contentType: string,
  valuePaths?: readonly string[] | null,
): string {
  return computeFingerprint(body, queryString, contentType, valuePaths).fingerprint;
}

/** Response variant: `String(status) + hex`; never uses value pairs. `raw` is the hash input of the hex part. */
export function computeRespFingerprint(
  status: number,
  body: string,
  queryString: string,
  contentType: string,
): FingerprintResult {
  const r = computeFingerprint(body, queryString, contentType);
  return { raw: r.raw, fingerprint: String(status) + r.fingerprint };
}

/** Python `resp_fingerprint`. */
export function respFingerprint(status: number, body: string, queryString: string, contentType: string): string {
  return computeRespFingerprint(status, body, queryString, contentType).fingerprint;
}

// ---------------------------------------------------------------------------
// Value discrimination
// ---------------------------------------------------------------------------

/**
 * Python `_canonical_scalar`: bool `true`/`false` (before number), string raw,
 * number as `json.dumps` (int token verbatim, float via Python repr, `NaN`,
 * `Infinity`), null `null`; object/array give `null` (skipped).
 */
export function canonicalScalar(v: JsonValue): string | null {
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return v;
  if (isJsonNumber(v)) return stringifyJson(v);
  if (v === null) return "null";
  return null;
}

/** Python `_get_scalar_at_path`; `undefined` is the absent sentinel. */
function getValueAtPath(parsed: JsonValue, dotPath: string): JsonValue | undefined {
  let node: JsonValue | undefined = parsed;
  for (const key of dotPath.split(".")) {
    if (!isJsonObject(node)) return undefined;
    node = node.get(key);
    if (node === undefined) return undefined;
  }
  return node;
}

/** Python `_extract_value_pairs`: `path=canonical` for each configured path holding a scalar. */
export function extractValuePairs(body: string, contentType: string, valuePaths: readonly string[]): string[] {
  if (isBlank(body) || valuePaths.length === 0) return [];
  const ct = normaliseContentType(contentType);
  const pairs: string[] = [];
  try {
    if (ct === FORM_CT) {
      const form = parseForm(body);
      if (form === null) return [];
      for (const path of valuePaths) {
        const vals = form.get(path);
        if (vals === undefined) continue;
        const canonical = canonicalScalar(vals[0] as string);
        if (canonical !== null) pairs.push(`${path}=${canonical}`);
      }
    } else {
      let parsed: JsonValue;
      try {
        parsed = parseJson(body);
      } catch {
        return [];
      }
      if (!isJsonObject(parsed)) return [];
      for (const path of valuePaths) {
        const val = getValueAtPath(parsed, path);
        if (val === undefined) continue;
        const canonical = canonicalScalar(val);
        if (canonical !== null) pairs.push(`${path}=${canonical}`);
      }
    }
  } catch {
    return [];
  }
  return pairs;
}
