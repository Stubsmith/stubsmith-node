/**
 * Python float formatting. JS `Number#toExponential()` with no argument yields
 * the shortest round-trip digits (same digits as Python's `repr`), but JS
 * switches layout at 1e21 / 1e-7 while Python switches at 1e16 / 1e-4, so the
 * layout is rebuilt here.
 *
 * Python reference: `float.__repr__` (CPython Objects/floatobject.c
 * `float_repr`, `PyOS_double_to_string` with format code 'r'), as called by
 * `floatstr` in Lib/json/encoder.py:226-239.
 */

import type { JsonNumber, JsonValue } from "./json.js";

function layout(x: number): string {
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const neg = x < 0;
  const [mant, expStr] = Math.abs(x).toExponential().split("e") as [string, string];
  const exp = parseInt(expStr, 10);
  const digits = mant.replace(".", "");
  let out: string;
  if (exp >= -4 && exp < 16) {
    if (exp < 0) {
      out = "0." + "0".repeat(-exp - 1) + digits;
    } else if (digits.length <= exp + 1) {
      out = digits + "0".repeat(exp + 1 - digits.length) + ".0";
    } else {
      out = digits.slice(0, exp + 1) + "." + digits.slice(exp + 1);
    }
  } else {
    const m = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    const ae = Math.abs(exp);
    out = m + "e" + (exp < 0 ? "-" : "+") + (ae < 10 ? "0" + ae : String(ae));
  }
  return neg ? "-" + out : out;
}

/**
 * Format a JSON float token as Python `json.dumps(float(raw))` would
 * (float.__repr__ for finite values, json/encoder.py `floatstr` for the rest):
 * fixed notation for 1e-4 <= |x| < 1e16, else `d.ddde+XX`; `-0.0` kept;
 * non-finite values give `NaN`, `Infinity`, `-Infinity` (the json spellings,
 * not repr's `nan`/`inf`; see {@link pyFloatStr} for `str()` spellings).
 * Overflowing tokens such as `1e999` become `Infinity`, as in Python.
 */
export function pyFloatRepr(raw: string): string {
  const x = Number(raw);
  if (Number.isNaN(x)) return "NaN";
  if (x === Infinity) return "Infinity";
  if (x === -Infinity) return "-Infinity";
  return layout(x);
}

/**
 * Format a JSON float token as Python `str(float(raw))` / `repr`: identical to
 * {@link pyFloatRepr} for finite values, but `nan`, `inf`, `-inf` otherwise.
 */
export function pyFloatStr(raw: string): string {
  const x = Number(raw);
  if (Number.isNaN(x)) return "nan";
  if (x === Infinity) return "inf";
  if (x === -Infinity) return "-inf";
  return layout(x);
}

function isNumber(v: JsonValue): v is JsonNumber {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Map);
}

/**
 * Python `str(value)` for a parsed JSON scalar, used as the placeholder hash
 * input (stubsmith/privacy/placeholders.py:44, :198): strings raw, ints as
 * their token (`-0` becomes `0`), floats via {@link pyFloatStr}, `True`,
 * `False`, `None`. Containers are not supported by the Python caller; they
 * throw a `TypeError` here rather than guessing at dict/list repr.
 */
export function pyStr(value: JsonValue): string {
  if (typeof value === "string") return value;
  if (value === true) return "True";
  if (value === false) return "False";
  if (value === null) return "None";
  if (isNumber(value)) {
    if (value.isFloat) return pyFloatStr(value.raw);
    return value.raw === "-0" ? "0" : value.raw;
  }
  throw new TypeError("pyStr: containers are not supported");
}
