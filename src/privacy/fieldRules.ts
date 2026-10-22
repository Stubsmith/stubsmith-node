/**
 * Per-fingerprint path-based field rule application.
 * Port of stubsmith/privacy/field_rules.py.
 *
 * Sync delivers `field_rules: [{path, action, type?}]` with namespaced paths:
 * `body.` `query.` `header.` `resp.` `resp_header.` and the status-scoped
 * `resp:NNN.sub` / `resp_header:NNN.sub` (NNN three ASCII digits, 100-599,
 * non-empty sub). `path.` entries are ignored. Generic namespaces record
 * `keep` only (absence means mask); scoped namespaces record keep and mask so
 * a scoped mask can override a generic keep. Every scalar is masked unless its
 * exact path is kept (a keep on `user` does not keep `user.x`).
 *
 * Synced project defaults may also carry `field_masks` (names). A name that
 * matches (stripped, lower-cased) a JSON object key, a form or query field or a
 * header name is masked even when a field rule keeps it; a matching JSON key
 * masks its whole subtree.
 */
import { isJsonNumber, isJsonObject, parseJson, stringifyJson, jsonNumber } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { pyStr } from "../internal/pyfloat.js";
import { parseForm, parseQs, urlencodeDoseq } from "../internal/pyqs.js";
import { dictGet, isDict, pyTruthy } from "../internal/pystr.js";
import { normaliseContentType } from "./fingerprint.js";
import { HEADER_ALLOWLIST, applyRegexes, compileRules, toHeaderMap } from "./masking.js";
import type { CompiledRules, HeaderInput } from "./masking.js";
import { generate, getSalt } from "./placeholders.js";

/**
 * Used when no project defaults are synced. The SDK has no built-in patterns:
 * what a keep rule keeps is sent as it is.
 */
const NO_PROJECT_RULES: CompiledRules = compileRules([], []);

/** `(status, path)` pair of a status-scoped rule. */
export type ScopedRule = readonly [number, string];

/** Immutable pre-compiled field rules. */
export class CompiledFieldRules {
  constructor(
    readonly keepBody: ReadonlySet<string>,
    readonly keepQuery: ReadonlySet<string>,
    /** Lower-cased request header names. */
    readonly keepHeader: ReadonlySet<string>,
    readonly keepResp: ReadonlySet<string>,
    /** Lower-cased response header names. */
    readonly keepRespHeader: ReadonlySet<string>,
    readonly keepRespStatus: readonly ScopedRule[],
    readonly maskRespStatus: readonly ScopedRule[],
    readonly keepRespHeaderStatus: readonly ScopedRule[],
    readonly maskRespHeaderStatus: readonly ScopedRule[],
    /** Semantic type hints of mask rules, keyed by namespace-relative path / name. */
    readonly bodyMaskTypes: ReadonlyMap<string, string>,
    readonly queryMaskTypes: ReadonlyMap<string, string>,
    readonly respMaskTypes: ReadonlyMap<string, string>,
  ) {}
}

/**
 * Build {@link CompiledFieldRules} from a raw `field_rules` list (parsed sync
 * JSON or plain objects). Malformed status scopes are ignored (fail closed).
 * Like Python, throws `TypeError` for a truthy non-string `path`.
 */
export function compileFieldRules(fieldRules: unknown): CompiledFieldRules {
  const keepBody: string[] = [];
  const keepQuery: string[] = [];
  const keepHeader: string[] = [];
  const keepResp: string[] = [];
  const keepRespHeader: string[] = [];
  const keepRespStatus: ScopedRule[] = [];
  const maskRespStatus: ScopedRule[] = [];
  const keepRespHeaderStatus: ScopedRule[] = [];
  const maskRespHeaderStatus: ScopedRule[] = [];
  const bodyMaskTypes = new Map<string, string>();
  const queryMaskTypes = new Map<string, string>();
  const respMaskTypes = new Map<string, string>();

  const rules = pyTruthy(fieldRules) && Array.isArray(fieldRules) ? fieldRules : [];
  for (const rule of rules as unknown[]) {
    if (!isDict(rule)) continue;
    const pathRaw = dictGet(rule, "path");
    const path = pyTruthy(pathRaw) ? pathRaw : "";
    if (typeof path !== "string") throw new TypeError("field rule path must be a string");
    const actionRaw = dictGet(rule, "action");
    const action = pyTruthy(actionRaw) ? actionRaw : "mask";
    const isKeep = action === "keep";
    // Semantic type hint, only meaningful on mask rules. A truthy non-string
    // scalar hint (e.g. 5) is an unknown label in Python's `generate`, which
    // falls back to `free_text`: with a salt that yields `text-<hex>`, without
    // one the constant. A truthy container is unhashable there, `generate`
    // raises and returns the constant, which is the same as no hint.
    const typeRaw = isKeep ? undefined : dictGet(rule, "type");
    let semType: string | undefined;
    if (typeof typeRaw === "string") semType = typeRaw !== "" ? typeRaw : undefined;
    else if (pyTruthy(typeRaw) && (typeRaw === true || typeof typeRaw === "number" || isJsonNumber(typeRaw))) semType = "free_text";

    if (path.startsWith("body.")) {
      const sub = path.slice(5);
      if (isKeep) keepBody.push(sub);
      else if (semType) bodyMaskTypes.set(sub, semType);
    } else if (path.startsWith("query.")) {
      const sub = path.slice(6);
      if (isKeep) keepQuery.push(sub);
      else if (semType) queryMaskTypes.set(sub, semType);
    } else if (path.startsWith("resp_header:")) {
      // Must be checked before "resp_header." (prefix collision).
      const parsed = parseStatusSuffix(path.slice(12));
      if (parsed !== null) {
        const [status, name] = parsed;
        const lowered = name.toLowerCase();
        if (isKeep) keepRespHeaderStatus.push([status, lowered]);
        else maskRespHeaderStatus.push([status, lowered]);
      }
    } else if (path.startsWith("resp_header.")) {
      if (isKeep) keepRespHeader.push(path.slice(12).toLowerCase());
    } else if (path.startsWith("header.")) {
      if (isKeep) keepHeader.push(path.slice(7).toLowerCase());
    } else if (path.startsWith("resp:")) {
      // Must be checked before "resp." (prefix collision).
      const parsed = parseStatusSuffix(path.slice(5));
      if (parsed !== null) {
        const [status, subPath] = parsed;
        if (isKeep) {
          keepRespStatus.push([status, subPath]);
        } else {
          maskRespStatus.push([status, subPath]);
          // Last write wins across statuses; the keep/mask set is resolved per status at call time.
          if (semType) respMaskTypes.set(subPath, semType);
        }
      }
    } else if (path.startsWith("resp.")) {
      const sub = path.slice(5);
      if (isKeep) keepResp.push(sub);
      else if (semType) respMaskTypes.set(sub, semType);
    }
    // path.{id} entries are metadata: ignored.
  }

  return new CompiledFieldRules(
    new Set(keepBody),
    new Set(keepQuery),
    new Set(keepHeader),
    new Set(keepResp),
    new Set(keepRespHeader),
    keepRespStatus,
    maskRespStatus,
    keepRespHeaderStatus,
    maskRespHeaderStatus,
    bodyMaskTypes,
    queryMaskTypes,
    respMaskTypes,
  );
}

/** Extra knobs for {@link applyFieldRules} / {@link applyRespFieldRules}. */
export interface ApplyOptions {
  /** Synced project defaults (field masks and regex masks); `null`/absent means none. */
  extraRules?: CompiledRules | null;
  /** Email placeholder domain; `null`/absent defers to the module default. */
  emailDomain?: string | null;
  /** Placeholder key. `undefined` reads `STUBSMITH_MASK_SALT` at call time (as Python does); `null` means no key. */
  salt?: Uint8Array | null;
}

/**
 * Apply `compiled` to a request body, headers and query string. Fail-closed:
 * a scalar is masked unless its namespaced path is kept; kept strings go
 * through the project's regex masks, if any.
 */
export function applyFieldRules(
  body: string,
  headers: HeaderInput,
  queryParams: string,
  contentType: string,
  compiled: CompiledFieldRules,
  opts: ApplyOptions = {},
): [string, Map<string, string>, string] {
  const regex = opts.extraRules ?? NO_PROJECT_RULES;
  const emailDomain = opts.emailDomain ?? null;
  const ct = normaliseContentType(contentType);
  const salt = opts.salt === undefined ? getSalt() : opts.salt;

  const maskedHeaders = applyHeaderRules(headers, compiled.keepHeader, regex.fieldMasks);
  const maskedQuery = applyQueryRules(queryParams, compiled.keepQuery, compiled.queryMaskTypes, regex, salt, emailDomain);
  const maskedBody = applyBodyRules(body, ct, compiled.keepBody, compiled.bodyMaskTypes, regex, salt, emailDomain);
  return [maskedBody, maskedHeaders, maskedQuery];
}

/**
 * Apply `compiled` to a response body and headers using the `resp.` /
 * `resp_header.` namespaces. With `respStatus`, status-scoped rules for that
 * status are resolved on top of the generic keep sets (scoped mask beats keep).
 */
export function applyRespFieldRules(
  respBody: string,
  respHeaders: HeaderInput,
  contentType: string,
  compiled: CompiledFieldRules,
  respStatus: number | null | undefined,
  opts: ApplyOptions = {},
): [string, Map<string, string>] {
  const regex = opts.extraRules ?? NO_PROJECT_RULES;
  const emailDomain = opts.emailDomain ?? null;
  const ct = normaliseContentType(contentType);
  const salt = opts.salt === undefined ? getSalt() : opts.salt;

  const effectiveKeepResp = resolveRespKeepSet(compiled.keepResp, compiled.keepRespStatus, compiled.maskRespStatus, respStatus);
  const effectiveKeepRespHeader = resolveRespKeepSet(
    compiled.keepRespHeader,
    compiled.keepRespHeaderStatus,
    compiled.maskRespHeaderStatus,
    respStatus,
  );
  const maskedHeaders = applyHeaderRules(respHeaders, effectiveKeepRespHeader, regex.fieldMasks);
  const maskedBody = applyBodyRules(respBody, ct, effectiveKeepResp, compiled.respMaskTypes, regex, salt, emailDomain);
  return [maskedBody, maskedHeaders];
}

// ---------------------------------------------------------------------------
// Status-scoped rule resolution
// ---------------------------------------------------------------------------

/**
 * Parse the `NNN.subpath` tail of a status-scoped rule. `null` when there is
 * no dot, the subpath is empty, the status is not exactly three ASCII digits
 * or falls outside 100-599.
 */
export function parseStatusSuffix(suffix: string): [number, string] | null {
  const dot = suffix.indexOf(".");
  if (dot === -1) return null;
  const statusStr = suffix.slice(0, dot);
  const subPath = suffix.slice(dot + 1);
  if (!subPath) return null;
  // Python: len == 3 and isascii() and isdigit(); only ASCII digits can pass.
  if (!/^[0-9]{3}$/.test(statusStr)) return null;
  const status = parseInt(statusStr, 10);
  if (!(status >= 100 && status <= 599)) return null;
  return [status, subPath];
}

/** Generic keeps, plus scoped keeps for `status`, minus scoped masks for `status` (mask wins). */
export function resolveRespKeepSet(
  genericKeep: ReadonlySet<string>,
  scopedKeep: readonly ScopedRule[],
  scopedMask: readonly ScopedRule[],
  status: number | null | undefined,
): ReadonlySet<string> {
  if (status === null || status === undefined) return genericKeep;
  const effective = new Set(genericKeep);
  for (const [s, p] of scopedKeep) if (s === status) effective.add(p);
  for (const [s, p] of scopedMask) if (s === status) effective.delete(p);
  return effective;
}

// ---------------------------------------------------------------------------
// Body
// ---------------------------------------------------------------------------

function applyBodyRules(
  body: string,
  ct: string,
  keepBody: ReadonlySet<string>,
  maskTypes: ReadonlyMap<string, string>,
  regex: CompiledRules,
  salt: Uint8Array | null,
  emailDomain: string | null,
): string {
  if (!body) return body || "";
  if (ct === "application/x-www-form-urlencoded") {
    return applyFormRules(body, keepBody, maskTypes, regex, salt, emailDomain);
  }
  let parsed: JsonValue;
  try {
    parsed = parseJson(body);
  } catch {
    // Non-JSON, non-form body: fail closed.
    return "<masked>";
  }
  return stringifyJson(walkAndMask(parsed, "", keepBody, maskTypes, regex, salt, emailDomain, false));
}

/**
 * Python `_walk_and_mask`: arrays go through the `[]` segment, scalars are kept only on an exact path match.
 * `forceMask` is set below a key named in the project `field_masks`: the keep set is ignored for that subtree.
 */
function walkAndMask(
  obj: JsonValue,
  prefix: string,
  keepSet: ReadonlySet<string>,
  maskTypes: ReadonlyMap<string, string>,
  regex: CompiledRules,
  salt: Uint8Array | null,
  emailDomain: string | null,
  forceMask: boolean,
): JsonValue {
  if (isJsonObject(obj)) {
    const out = new Map<string, JsonValue>();
    for (const [k, v] of obj) {
      const child = prefix ? `${prefix}.${k}` : k;
      const force = forceMask || regex.fieldMasks.has(k.toLowerCase());
      out.set(k, walkAndMask(v, child, keepSet, maskTypes, regex, salt, emailDomain, force));
    }
    return out;
  }
  if (Array.isArray(obj)) {
    const arrPath = prefix ? `${prefix}.[]` : "[]";
    return obj.map((e) => walkAndMask(e, arrPath, keepSet, maskTypes, regex, salt, emailDomain, forceMask));
  }
  if (obj === null) return null;
  if (!forceMask && keepSet.has(prefix)) {
    return typeof obj === "string" ? applyRegexes(obj, regex) : obj;
  }
  const semType = maskTypes.get(prefix);
  if (semType !== undefined) return generate(semType, obj, { salt, emailDomain });
  if (typeof obj === "boolean") return false;
  if (typeof obj === "object") return jsonNumber("0"); // number node
  return "<masked>";
}

function maskFormPairs(
  parsed: Map<string, string[]>,
  keep: ReadonlySet<string>,
  maskTypes: ReadonlyMap<string, string>,
  regex: CompiledRules,
  salt: Uint8Array | null,
  emailDomain: string | null,
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, vals] of parsed) {
    if (keep.has(k) && !regex.fieldMasks.has(k.toLowerCase())) {
      out.set(k, vals.map((v) => applyRegexes(v, regex)));
    } else {
      const semType = maskTypes.get(k);
      if (semType !== undefined) {
        out.set(k, vals.map((v) => pyStr(generate(semType, v, { salt, emailDomain }))));
      } else {
        out.set(k, vals.map(() => "<masked>"));
      }
    }
  }
  return out;
}

function applyFormRules(
  body: string,
  keepBody: ReadonlySet<string>,
  maskTypes: ReadonlyMap<string, string>,
  regex: CompiledRules,
  salt: Uint8Array | null,
  emailDomain: string | null,
): string {
  let parsed: Map<string, string[]> | null;
  try {
    parsed = parseForm(body);
  } catch {
    return "<masked>";
  }
  if (parsed === null) return "<masked>";
  return urlencodeDoseq(maskFormPairs(parsed, keepBody, maskTypes, regex, salt, emailDomain));
}

// ---------------------------------------------------------------------------
// Headers and query
// ---------------------------------------------------------------------------

/** Allowlist plus explicit keeps; everything else `<masked>`. A name in `fieldMasks` is masked regardless. */
function applyHeaderRules(headers: HeaderInput, keepHeader: ReadonlySet<string>, fieldMasks: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of toHeaderMap(headers)) {
    const lower = k.toLowerCase();
    out.set(k, !fieldMasks.has(lower) && (HEADER_ALLOWLIST.has(lower) || keepHeader.has(lower)) ? v : "<masked>");
  }
  return out;
}

function applyQueryRules(
  queryString: string,
  keepQuery: ReadonlySet<string>,
  maskTypes: ReadonlyMap<string, string>,
  regex: CompiledRules,
  salt: Uint8Array | null,
  emailDomain: string | null,
): string {
  if (!queryString) return queryString || "";
  let parsed: Map<string, string[]>;
  try {
    parsed = parseQs(queryString);
  } catch {
    return "<masked>";
  }
  return urlencodeDoseq(maskFormPairs(parsed, keepQuery, maskTypes, regex, salt, emailDomain));
}
