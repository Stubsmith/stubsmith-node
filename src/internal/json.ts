import { pyFloatRepr } from "./pyfloat.js";

/** A JSON number keeping its source token so int vs float survives. */
export interface JsonNumber {
  kind: "number";
  /** Source token (`1`, `1.0`, `1e5`, `NaN`, ...). */
  raw: string;
  /** True when the token contains `.`, `e` or `E` or is NaN/Infinity (Python float). */
  isFloat: boolean;
  /** Lossy double value. */
  value: number;
}

/**
 * Parsed JSON value. Objects are `Map`s (insertion order, last duplicate key
 * wins in value but keeps the FIRST position, like a Python dict and a JS
 * object). A Map is used instead of a plain object so keys such as
 * `__proto__` or `constructor` are ordinary data and integer-like keys keep
 * insertion order.
 */
export type JsonValue =
  | null
  | boolean
  | string
  | JsonNumber
  | JsonValue[]
  | Map<string, JsonValue>;

/** Type guard for object nodes (Map). */
export function isJsonObject(v: unknown): v is Map<string, JsonValue> {
  return v instanceof Map;
}

/** Type guard for number nodes. */
export function isJsonNumber(v: unknown): v is JsonNumber {
  return typeof v === "object" && v !== null && (v as { kind?: unknown }).kind === "number" &&
    typeof (v as { raw?: unknown }).raw === "string";
}

/** Build a number node from a token, deriving `isFloat` and `value`. */
export function jsonNumber(raw: string): JsonNumber {
  return { kind: "number", raw, isFloat: /[.eEN]|Infinity/.test(raw), value: Number(raw) };
}

const MAX_DEPTH = 1000;
/** CPython `sys.int_info.default_max_str_digits` (int <-> str conversion cap). */
const MAX_INT_DIGITS = 4300;
const NUM_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?/y;

/**
 * Parse JSON like Python `json.loads(str)` (`Lib/json/decoder.py:340`
 * `JSONDecoder.decode` -> `raw_decode` :351; the C scanner `c_make_scanner`
 * is used when available, its pure-Python twin is `Lib/json/scanner.py`,
 * default arguments; string chunks follow `py_scanstring` :70, `NaN` /
 * `Infinity` constants :15-17):
 * `NaN`, `Infinity`, `-Infinity` accepted as floats; raw control characters
 * inside strings rejected; lone surrogate escapes accepted; a leading BOM
 * rejected; ASCII-only whitespace; trailing content rejected. An integer
 * token (no `.`/`e`/`E`) of more than 4300 digits, sign excluded, throws as
 * Python 3.11+ raises ValueError ("Exceeds the limit (4300 digits)"). Nesting
 * deeper than 1000 throws `SyntaxError`: the 1000 cap is this port's own
 * guard, while CPython raises RecursionError at a depth that varies by
 * version and build (both are treated as "not JSON" by the Python callers).
 * Throws `SyntaxError` on failure.
 */
export function parseJson(text: string): JsonValue {
  let i = 0;
  const n = text.length;

  const fail = (msg: string): never => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const ws = (): void => {
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) i++;
      else break;
    }
  };

  const parseString = (): string => {
    i++; // opening quote
    let out = "";
    let start = i;
    for (;;) {
      if (i >= n) fail("Unterminated string");
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        out += text.slice(start, i);
        i++;
        return out;
      }
      if (c < 0x20) fail("Invalid control character");
      if (c === 0x5c) {
        out += text.slice(start, i);
        i++;
        const e = text[i];
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(i + 1, i + 5);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("Invalid \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default:
            fail("Invalid escape");
        }
        i++;
        start = i;
      } else {
        i++;
      }
    }
  };

  const parseValue = (depth: number): JsonValue => {
    if (i >= n) return fail("Expecting value");
    const ch = text[i] as string;
    if (ch === '"') return parseString();
    if (ch === "{") {
      if (depth >= MAX_DEPTH) fail("Maximum nesting depth exceeded");
      i++;
      const obj = new Map<string, JsonValue>();
      ws();
      if (text[i] === "}") {
        i++;
        return obj;
      }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("Expecting property name enclosed in double quotes");
        const key = parseString();
        ws();
        if (text[i] !== ":") fail("Expecting ':' delimiter");
        i++;
        ws();
        obj.set(key, parseValue(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "}") {
          i++;
          return obj;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (ch === "[") {
      if (depth >= MAX_DEPTH) fail("Maximum nesting depth exceeded");
      i++;
      const arr: JsonValue[] = [];
      ws();
      if (text[i] === "]") {
        i++;
        return arr;
      }
      for (;;) {
        ws();
        arr.push(parseValue(depth + 1));
        ws();
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] === "]") {
          i++;
          return arr;
        }
        fail("Expecting ',' delimiter");
      }
    }
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    if (text.startsWith("NaN", i)) { i += 3; return jsonNumber("NaN"); }
    if (text.startsWith("Infinity", i)) { i += 8; return jsonNumber("Infinity"); }
    if (text.startsWith("-Infinity", i)) { i += 9; return jsonNumber("-Infinity"); }
    NUM_RE.lastIndex = i;
    const m = NUM_RE.exec(text);
    if (m) {
      const tok = m[0];
      if (!/[.eE]/.test(tok) && tok.length - (tok.charCodeAt(0) === 0x2d ? 1 : 0) > MAX_INT_DIGITS) {
        fail("Exceeds the limit (4300 digits) for integer string conversion");
      }
      i += tok.length;
      return jsonNumber(tok);
    }
    return fail("Expecting value");
  };

  ws();
  const v = parseValue(0);
  ws();
  if (i < n) fail("Extra data");
  return v;
}

/**
 * Python `json.encoder.ESCAPE_ASCII` (`Lib/json/encoder.py:19`) with the
 * ESCAPE_DCT short forms, as in `py_encode_basestring_ascii` (:49).
 */
function quote(s: string): string {
  let out = '"';
  for (let k = 0; k < s.length; k++) {
    const c = s.charCodeAt(k);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += "\\\\"; break;
      case 0x0a: out += "\\n"; break;
      case 0x0d: out += "\\r"; break;
      case 0x09: out += "\\t"; break;
      case 0x08: out += "\\b"; break;
      case 0x0c: out += "\\f"; break;
      default:
        if (c >= 0x20 && c <= 0x7e) out += s[k];
        else out += "\\u" + c.toString(16).padStart(4, "0");
    }
  }
  return out + '"';
}

/**
 * Serialise like Python `json.dumps(obj)` (`Lib/json/encoder.py:185`
 * `JSONEncoder.encode`, `iterencode` :207; floats via `floatstr` :226) with
 * default arguments
 * (separators `", "` / `": "`, `ensure_ascii=True` with lower-case `\uXXXX`
 * and UTF-16 surrogate pairs, 0x7f escaped). Ints are emitted from their raw
 * token (`-0` becomes `0`), floats via `pyFloatRepr`. Object keys keep Map
 * order.
 */
export function stringifyJson(value: JsonValue): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return "[" + value.map(stringifyJson).join(", ") + "]";
  if (value instanceof Map) {
    const parts: string[] = [];
    for (const [k, v] of value) parts.push(quote(k) + ": " + stringifyJson(v));
    return "{" + parts.join(", ") + "}";
  }
  if (value.isFloat) return pyFloatRepr(value.raw);
  return value.raw === "-0" ? "0" : value.raw;
}

/**
 * Convert to ordinary JS values: Map becomes a null-prototype-free plain
 * object via `Object.fromEntries` semantics (a `__proto__` key becomes an own
 * property), numbers become `number` (ints beyond 2^53 lose precision).
 */
export function toPlain(value: JsonValue): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Map) {
    const o: Record<string, unknown> = {};
    for (const [k, v] of value) {
      Object.defineProperty(o, k, { value: toPlain(v), enumerable: true, writable: true, configurable: true });
    }
    return o;
  }
  return value.value;
}
