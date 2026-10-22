/**
 * Request/response masking: field masks, regex masks and fail-closed masking.
 * Port of stubsmith/privacy/masking.py.
 *
 * Masked JSON bodies are `stringifyJson` text (Python `json.dumps` layout,
 * `ensure_ascii`); form and query output is `urlencode(doseq=True)` text.
 * Header maps are returned as `Map`s in input order (a plain object would
 * reorder integer-like names and swallow `__proto__`).
 */
import { jsonNumber, isJsonNumber, isJsonObject, parseJson, stringifyJson } from "../internal/json.js";
import type { JsonValue } from "../internal/json.js";
import { translatePythonRegex } from "../internal/pyre.js";
import { parseForm, parseQs, urlencodeDoseq } from "../internal/pyqs.js";
import { dictGet, isDict, pyStrip, pyTruthy } from "../internal/pystr.js";
import { normaliseContentType } from "./fingerprint.js";

/** Headers as accepted by the maskers. */
export type HeaderInput = Record<string, string> | ReadonlyMap<string, string>;

/** Normalise a header record or map to an insertion-ordered `Map`. */
export function toHeaderMap(h: HeaderInput): Map<string, string> {
  return h instanceof Map ? new Map(h) : new Map(Object.entries(h));
}

/**
 * Header allowlist: values of these (lower-cased) headers are kept, every other value becomes `<masked>`.
 * It applies to request and response headers alike. `user-agent`, `cache-control` and `accept-language` are
 * not on it: their values are masked unless a `header.` or `resp_header.` keep rule keeps them.
 */
export const HEADER_ALLOWLIST: ReadonlySet<string> = new Set([
  "content-type",
  "content-length",
  "accept",
  "accept-encoding",
  "host",
  "transfer-encoding",
]);

// ---------------------------------------------------------------------------
// Replacement templates (Python re.sub repl syntax)
// ---------------------------------------------------------------------------

type TemplatePart = string | { group: number | string };

const ESCAPES: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\" };

/**
 * Parse a Python `re.sub` replacement string (`\1`, `\g<name>`, `\n`, octal
 * escapes). Throws like Python's `re.error`/`IndexError` on bad escapes and
 * unknown groups; Python raises these when `sub` runs, so callers invoke this
 * lazily.
 */
function parseTemplate(source: string, groupCount: number, names: ReadonlySet<string>): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let lit = "";
  const flush = (): void => {
    if (lit) parts.push(lit);
    lit = "";
  };
  const addGroup = (index: number): void => {
    if (index > groupCount) throw new Error(`invalid group reference ${index}`);
    flush();
    parts.push({ group: index });
  };
  const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";
  const isOct = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "7";
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch !== "\\") {
      lit += ch;
      i++;
      continue;
    }
    const c = source[i + 1];
    if (c === undefined) throw new Error("bad escape (end of pattern)");
    i += 2;
    if (c === "g") {
      if (source[i] !== "<") throw new Error("missing <");
      const end = source.indexOf(">", i + 1);
      if (end < 0) throw new Error("missing >, unterminated name");
      const name = source.slice(i + 1, end);
      i = end + 1;
      if (name === "") throw new Error("missing group name");
      if (/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) {
        if (!names.has(name)) throw new Error(`unknown group name '${name}'`);
        flush();
        parts.push({ group: name });
      } else if (/^[0-9]+$/.test(name)) {
        addGroup(parseInt(name, 10));
      } else {
        throw new Error("bad character in group name");
      }
    } else if (c === "0") {
      let oct = "0";
      if (isOct(source[i])) oct += source[i++];
      if (isOct(source[i])) oct += source[i++];
      lit += String.fromCharCode(parseInt(oct, 8) & 0xff);
    } else if (isDigit(c)) {
      let digits = c;
      let octal = false;
      if (isDigit(source[i])) {
        digits += source[i++];
        if (isOct(c) && isOct(digits[1]) && isOct(source[i])) {
          digits += source[i++];
          octal = true;
          const v = parseInt(digits, 8);
          if (v > 0o377) throw new Error(`octal escape value \\${digits} outside of range 0-0o377`);
          lit += String.fromCharCode(v);
        }
      }
      if (!octal) addGroup(parseInt(digits, 10));
    } else if (Object.prototype.hasOwnProperty.call(ESCAPES, c)) {
      lit += ESCAPES[c];
    } else {
      if (/[A-Za-z]/.test(c)) throw new Error(`bad escape \\${c}`);
      lit += "\\" + c;
    }
  }
  flush();
  return parts;
}

// ---------------------------------------------------------------------------
// Compiled rule container
// ---------------------------------------------------------------------------

/** One compiled regex mask. */
export interface RegexMask {
  regex: RegExp;
  /** Python replacement template. */
  replace: string;
  groupCount: number;
  groupNames: ReadonlySet<string>;
  /** Parsed lazily, so an invalid template fails at apply time like Python. */
  parsed?: TemplatePart[];
}

/** Immutable pre-compiled masking rules. */
export class CompiledRules {
  constructor(
    /** Lower-cased, stripped field names. */
    readonly fieldMasks: ReadonlySet<string>,
    readonly regexMasks: readonly RegexMask[],
    /**
     * True when at least one synced regex mask cannot be used: Python rejects
     * it, or it has no JS translation. The rule's effect is unknown, so
     * {@link applyRegexes} masks every string it is given (as Python does).
     */
    readonly unusable: boolean = false,
  ) {}
}

/**
 * Kept strings longer than this many UTF-16 code units are replaced by
 * `<masked>` without running any regex. A customer pattern can backtrack
 * badly on long input (an email-shaped pattern is quadratic on
 * `"a-".repeat(n)`, about 4.8 s synchronous at 100k characters), and masking
 * runs on the host application's event loop. Python applies the same number
 * to code points.
 */
export const MAX_REGEX_SCAN_CHARS = 65536;

let warnedInvalidPattern = false;

/** Test hook: re-arm the once-per-process invalid-pattern warning. */
export function resetMaskingWarningsForTests(): void {
  warnedInvalidPattern = false;
}

/**
 * Build {@link CompiledRules} from raw rule data (parsed sync JSON or plain
 * objects). `field_masks` entries are lower-cased and stripped; each regex
 * mask is `{pattern, replace, flags}` where `"i" in flags` makes it
 * case-insensitive and an empty/absent `replace` becomes `<masked>`. A pattern
 * that fails to translate, or a malformed entry (a non-array, a non-string
 * field mask, a regex mask that is not an object, or has an empty or
 * non-string pattern or a non-string replacement or flags), sets
 * {@link CompiledRules.unusable}: the valid rules still apply and every string
 * is masked. The first one per process logs a warning naming it.
 */
export function compileRules(fieldMasks: unknown, regexMasks: unknown): CompiledRules {
  let unusable = false;
  // Dropping a rule would quietly send what it was meant to mask. Fail closed instead (as Python does).
  const failClosed = (what: string, reason: string): void => {
    unusable = true;
    if (!warnedInvalidPattern) {
      warnedInvalidPattern = true;
      console.warn(`stubsmith: ${what} cannot be used: ${reason}; every kept string will be masked (further invalid rules are reported silently)`);
    }
  };

  const fields = new Set<string>();
  if (pyTruthy(fieldMasks)) {
    if (!Array.isArray(fieldMasks)) failClosed("field_masks", "not a list");
    else {
      fieldMasks.forEach((f: unknown, index: number) => {
        if (f === null || f === undefined) return;
        if (typeof f !== "string") failClosed(`field mask at index ${index}`, "not a string");
        else fields.add(pyStrip(f.toLowerCase()));
      });
    }
  }
  const compiled: RegexMask[] = [];
  if (pyTruthy(regexMasks)) {
    if (!Array.isArray(regexMasks)) failClosed("regex_masks", "not a list");
    else {
      regexMasks.forEach((m: unknown, index: number) => {
        const what = `regex mask at index ${index}`;
        if (!isDict(m)) return failClosed(what, "not an object");
        const patternRaw = dictGet(m, "pattern");
        const pattern = pyTruthy(patternRaw) ? patternRaw : "";
        if (typeof pattern !== "string") return failClosed(what, "the pattern is not a string");
        if (pattern === "") return failClosed(what, "the pattern is empty");
        const replaceRaw = dictGet(m, "replace");
        const replace = replaceRaw === undefined || replaceRaw === null || replaceRaw === "" ? "<masked>" : replaceRaw;
        if (typeof replace !== "string") return failClosed(what, "the replacement is not a string");
        const flagsRaw = dictGet(m, "flags");
        const flags = pyTruthy(flagsRaw) ? flagsRaw : "";
        if (typeof flags !== "string" && !Array.isArray(flags)) return failClosed(what, "the flags are not a string");
        const t = translatePythonRegex(pattern, flags.includes("i") ? "i" : "");
        // Whether Python rejects the pattern too or it has no JS translation (for example `(?i:secret)`).
        if ("error" in t) return failClosed(what, t.error);
        const probe = new RegExp(t.regex.source + "|", t.regex.flags).exec("");
        const groups = probe?.groups ?? {};
        compiled.push({
          regex: t.regex,
          replace,
          groupCount: (probe?.length ?? 1) - 1,
          groupNames: new Set(Object.keys(groups)),
        });
      });
    }
  }
  return new CompiledRules(fields, compiled, unusable);
}

/** Apply regex masks in declaration order (Python `_apply_regexes`). */
export function applyRegexes(s: string, rules: CompiledRules): string {
  if (rules.unusable) return "<masked>";
  // Cap only matters when a regex would run.
  if (rules.regexMasks.length > 0 && s.length > MAX_REGEX_SCAN_CHARS) return "<masked>";
  let out = s;
  for (const m of rules.regexMasks) {
    if (m.parsed === undefined) m.parsed = parseTemplate(m.replace, m.groupCount, m.groupNames);
    const parts = m.parsed;
    out = out.replace(m.regex, (...args: unknown[]) => {
      const last = args[args.length - 1];
      const hasNamed = typeof last === "object" && last !== null;
      const groups = hasNamed ? (last as Record<string, string | undefined>) : undefined;
      // args: match, p1..pn, offset, string[, groups]
      const matchGroups = args.slice(0, args.length - (hasNamed ? 3 : 2)) as Array<string | undefined>;
      let r = "";
      for (const p of parts) {
        if (typeof p === "string") r += p;
        else if (typeof p.group === "number") r += matchGroups[p.group] ?? "";
        else r += groups?.[p.group] ?? "";
      }
      return r;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rule-based masking (maskKnown)
// ---------------------------------------------------------------------------

/**
 * Apply `rules` to body, headers and query (Python `mask_known`). The pipeline no longer uses it.
 * Non-allowlisted headers are masked; JSON bodies get field and regex masks;
 * form bodies and queries get field masks plus regex masks on values; any
 * other body, including a form body that is not `key=value` pairs, has the
 * regex masks applied as plain text.
 */
export function maskKnown(
  body: string,
  headers: HeaderInput,
  queryParams: string,
  contentType: string,
  rules: CompiledRules,
): [string, Map<string, string>, string] {
  const maskedHeaders = maskHeaders(headers);
  const ct = normaliseContentType(contentType);
  let maskedBody: string;
  if (ct === "application/x-www-form-urlencoded") {
    const form = parseForm(body);
    maskedBody = form !== null ? urlencodeDoseq(maskKnownPairs(form, rules)) : applyRegexes(body, rules);
  } else {
    try {
      const parsed = parseJson(body);
      maskedBody = stringifyJson(maskObject(parsed, rules));
    } catch {
      // Plain text: still run the regex masks (e.g. card numbers).
      maskedBody = applyRegexes(body, rules);
    }
  }
  const maskedQuery = maskQueryKnown(queryParams, rules);
  return [maskedBody, maskedHeaders, maskedQuery];
}

function maskObject(obj: JsonValue, rules: CompiledRules): JsonValue {
  if (isJsonObject(obj)) {
    const out = new Map<string, JsonValue>();
    for (const [k, v] of obj) {
      out.set(k, rules.fieldMasks.has(k.toLowerCase()) ? "<masked>" : maskObject(v, rules));
    }
    return out;
  }
  if (Array.isArray(obj)) return obj.map((e) => maskObject(e, rules));
  if (typeof obj === "string") return applyRegexes(obj, rules);
  return obj;
}

// ---------------------------------------------------------------------------
// Fail-closed masking (maskAll)
// ---------------------------------------------------------------------------

/**
 * Fail-closed masking: header allowlist; JSON keeps structure with string to
 * `<masked>`, number to `0`, bool to `false`, null kept; form keeps names with
 * every value `<masked>` (a form body with a segment without `=` becomes
 * `<masked>`); any other body (including an empty one) becomes the
 * string `<masked>`; all query values `<masked>`.
 */
export function maskAll(
  body: string,
  headers: HeaderInput,
  queryParams: string,
  contentType: string,
): [string, Map<string, string>, string] {
  const maskedHeaders = maskHeaders(headers);
  const ct = normaliseContentType(contentType);
  let maskedBody: string;
  if (ct === "application/x-www-form-urlencoded") {
    try {
      const form = parseForm(body);
      maskedBody = form !== null ? urlencodeDoseq(maskedForm(form)) : "<masked>";
    } catch {
      maskedBody = "<masked>";
    }
  } else {
    try {
      maskedBody = stringifyJson(maskAllValues(parseJson(body)));
    } catch {
      maskedBody = "<masked>";
    }
  }
  return [maskedBody, maskedHeaders, maskQueryAll(queryParams)];
}

function maskedForm(parsed: Map<string, string[]>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, v] of parsed) out.set(k, v.map(() => "<masked>"));
  return out;
}

function maskAllValues(obj: JsonValue): JsonValue {
  if (isJsonObject(obj)) {
    const out = new Map<string, JsonValue>();
    for (const [k, v] of obj) out.set(k, maskAllValues(v));
    return out;
  }
  if (Array.isArray(obj)) return obj.map(maskAllValues);
  if (typeof obj === "boolean") return false;
  if (isJsonNumber(obj)) return jsonNumber("0");
  if (typeof obj === "string") return "<masked>";
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Header allowlist: non-allowlisted values become `<masked>`; names keep their case and order. */
export function maskHeaders(headers: HeaderInput): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of toHeaderMap(headers)) {
    out.set(k, HEADER_ALLOWLIST.has(k.toLowerCase()) ? v : "<masked>");
  }
  return out;
}

function maskKnownPairs(parsed: Map<string, string[]>, rules: CompiledRules): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [k, vals] of parsed) {
    if (rules.fieldMasks.has(k.toLowerCase())) out.set(k, vals.map(() => "<masked>"));
    else out.set(k, vals.map((v) => applyRegexes(v, rules)));
  }
  return out;
}

function maskQueryKnown(queryString: string, rules: CompiledRules): string {
  if (!queryString) return queryString || "";
  let parsed: Map<string, string[]>;
  try {
    parsed = parseQs(queryString);
  } catch {
    return queryString;
  }
  return urlencodeDoseq(maskKnownPairs(parsed, rules));
}

function maskQueryAll(queryString: string): string {
  if (!queryString) return queryString || "";
  let parsed: Map<string, string[]>;
  try {
    parsed = parseQs(queryString);
  } catch {
    return "<masked>";
  }
  return urlencodeDoseq(maskedForm(parsed));
}
