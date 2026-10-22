/**
 * Small Python `str` helpers the privacy pipeline relies on. JS and Python
 * disagree on whitespace, `isdigit`, `$` and strict UTF-8 encoding, so each is
 * spelled out here once.
 */
import { utf8Encode } from "./utf8.js";

/**
 * Python `$` (no MULTILINE): end of input OR just before a final `\n`.
 * Use in place of `$` when translating a Python pattern by hand, e.g.
 * `new RegExp(`^[a-z]+${PY_END}`)`. It is a lookahead, so it consumes nothing.
 */
export const PY_END = "(?=\\n?$)";

/** `str.isspace()` characters (Python), which differ from JS `trim()`. */
const PY_SPACE = "\\t\\n\\v\\f\\r \\x1c-\\x1f\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const PY_STRIP_RE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, "g");

/** Python `str.strip()` (no argument). JS `trim()` strips U+FEFF and keeps U+001C-001F and U+0085. */
export function pyStrip(s: string): string {
  return s.replace(PY_STRIP_RE, "");
}

/**
 * Inclusive code point ranges (flat `[lo, hi, lo, hi, ...]`) for which Python
 * `str.isdigit()` is true: Unicode `Numeric_Type` of `Digit` or `Decimal`.
 * That is `\p{Nd}` plus the `No` code points with a digit value (superscripts
 * `² ³ ¹ ⁰ ⁴-⁹`, subscripts, circled and
 * parenthesised digits, dingbat digits, Ethiopic digits, ...); roman numerals
 * (`Ⅻ`) and fractions (`½`) are Numeric_Type=Numeric and are NOT digits.
 *
 * JS has no `Numeric_Type` property, and the `Nd` set moves with the engine's
 * Unicode version, so the table is embedded. Generated with
 * `[c for c in range(0x110000) if chr(c).isdigit()]` on Python 3.14.6
 * (Unicode 16.0.0), 888 code points in 90 ranges.
 */
const DIGIT_RANGES: readonly number[] = [
  0x30, 0x39, 0xb2, 0xb3, 0xb9, 0xb9, 0x660, 0x669, 0x6f0, 0x6f9, 0x7c0, 0x7c9, 0x966, 0x96f, 0x9e6, 0x9ef,
  0xa66, 0xa6f, 0xae6, 0xaef, 0xb66, 0xb6f, 0xbe6, 0xbef, 0xc66, 0xc6f, 0xce6, 0xcef, 0xd66, 0xd6f, 0xde6,
  0xdef, 0xe50, 0xe59, 0xed0, 0xed9, 0xf20, 0xf29, 0x1040, 0x1049, 0x1090, 0x1099, 0x1369, 0x1371, 0x17e0,
  0x17e9, 0x1810, 0x1819, 0x1946, 0x194f, 0x19d0, 0x19da, 0x1a80, 0x1a89, 0x1a90, 0x1a99, 0x1b50, 0x1b59,
  0x1bb0, 0x1bb9, 0x1c40, 0x1c49, 0x1c50, 0x1c59, 0x2070, 0x2070, 0x2074, 0x2079, 0x2080, 0x2089, 0x2460,
  0x2468, 0x2474, 0x247c, 0x2488, 0x2490, 0x24ea, 0x24ea, 0x24f5, 0x24fd, 0x24ff, 0x24ff, 0x2776, 0x277e,
  0x2780, 0x2788, 0x278a, 0x2792, 0xa620, 0xa629, 0xa8d0, 0xa8d9, 0xa900, 0xa909, 0xa9d0, 0xa9d9, 0xa9f0,
  0xa9f9, 0xaa50, 0xaa59, 0xabf0, 0xabf9, 0xff10, 0xff19, 0x104a0, 0x104a9, 0x10a40, 0x10a43, 0x10d30,
  0x10d39, 0x10d40, 0x10d49, 0x10e60, 0x10e68, 0x11052, 0x1105a, 0x11066, 0x1106f, 0x110f0, 0x110f9,
  0x11136, 0x1113f, 0x111d0, 0x111d9, 0x112f0, 0x112f9, 0x11450, 0x11459, 0x114d0, 0x114d9, 0x11650,
  0x11659, 0x116c0, 0x116c9, 0x116d0, 0x116e3, 0x11730, 0x11739, 0x118e0, 0x118e9, 0x11950, 0x11959,
  0x11bf0, 0x11bf9, 0x11c50, 0x11c59, 0x11d50, 0x11d59, 0x11da0, 0x11da9, 0x11f50, 0x11f59, 0x16130,
  0x16139, 0x16a60, 0x16a69, 0x16ac0, 0x16ac9, 0x16b50, 0x16b59, 0x16d70, 0x16d79, 0x1ccf0, 0x1ccf9,
  0x1d7ce, 0x1d7ff, 0x1e140, 0x1e149, 0x1e2f0, 0x1e2f9, 0x1e4f0, 0x1e4f9, 0x1e5f1, 0x1e5fa, 0x1e950,
  0x1e959, 0x1f100, 0x1f10a, 0x1fbf0, 0x1fbf9,
];

function isDigitCodePoint(cp: number): boolean {
  let lo = 0;
  let hi = DIGIT_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < (DIGIT_RANGES[mid * 2] as number)) hi = mid - 1;
    else if (cp > (DIGIT_RANGES[mid * 2 + 1] as number)) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Python `str.isdigit()`: non-empty and every code point has Numeric_Type Digit or Decimal. */
export function pyIsDigit(s: string): boolean {
  if (s === "") return false;
  for (const ch of s) {
    if (!isDigitCodePoint(ch.codePointAt(0) as number)) return false;
  }
  return true;
}

const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** True when `s` holds a lone UTF-16 surrogate (Python `str.encode("utf-8")` raises on it). */
export function hasLoneSurrogate(s: string): boolean {
  return LONE_SURROGATE.test(s);
}

/** Python `str.encode("utf-8")`: throws `TypeError` on lone surrogates instead of substituting U+FFFD. */
export function utf8EncodeStrict(s: string): Uint8Array {
  if (hasLoneSurrogate(s)) throw new TypeError("utf-8 codec can't encode lone surrogate");
  return utf8Encode(s);
}

/** True for a parsed-JSON object (`Map`) or a plain object (not an array, not null). */
export function isDict(v: unknown): v is Map<string, unknown> | Record<string, unknown> {
  return v instanceof Map || (typeof v === "object" && v !== null && !Array.isArray(v) && !isNumberNode(v));
}

function isNumberNode(v: object): boolean {
  return (v as { kind?: unknown }).kind === "number" && typeof (v as { raw?: unknown }).raw === "string";
}

/** `dict.get(key)` over a `Map` or a plain object; `undefined` when absent or `obj` is no dict. */
export function dictGet(obj: unknown, key: string): unknown {
  if (obj instanceof Map) return obj.get(key);
  if (isDict(obj)) return Object.prototype.hasOwnProperty.call(obj, key) ? (obj as Record<string, unknown>)[key] : undefined;
  return undefined;
}

/**
 * Python truthiness of a parsed JSON value (number nodes by their value, `NaN`
 * is truthy), as used by `x.get(k) or default`.
 */
export function pyTruthy(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === "") return false;
  if (v === true) return true;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === "object") {
    if (isNumberNode(v as object)) {
      const n = (v as { value: number }).value;
      return n !== 0;
    }
    return Object.keys(v as object).length > 0;
  }
  if (typeof v === "number") return v !== 0;
  return true;
}
